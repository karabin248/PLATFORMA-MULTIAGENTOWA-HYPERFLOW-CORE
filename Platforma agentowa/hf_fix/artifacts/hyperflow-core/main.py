"""
Hyperflow Python Core — canonical Python runtime

Serves as the canonical Python runtime for the Hyperflow TS shell.

Endpoints (contract-stable — TS shell depends on these):
  GET  /v1/health
  GET  /v1/logs/recent
  POST /v1/explore
  POST /v1/run          ← full 6-phase EDDE pipeline + LLM via OpenRouter
  POST /v1/agent/run    ← agent-native execution (Phase 2 Agent Platform)
  POST /v1/workflow/run
  POST /v1/workflow/resume
  POST /v1/workflow/continue/approval
  POST /v1/workflow/continue/human-input
  POST /v1/repositories/scan
  POST /v1/repositories/graph

New in v0.3.0:
  GET  /v1/session      ← session memory summary (in-process ring buffer)
  GET  /v1/mps-profiles ← MPS level profiles reference

Canonical phase names (source of truth: configs/canonical_semantics.json):
  perceive → extract_essence → sense_direction → synthesize → generate_options → choose
  🌈          💎                 🔥              🧠           🔀                 ⚡
"""

# NOTE: We intentionally avoid `from __future__ import annotations` here.
# Pydantic's schema generation relies on runtime evaluation of type hints,
# and postponed evaluation can cause unresolved forward references for
# common typing names (e.g. Optional).  Removing the future import ensures
# that annotations are actual types rather than strings.

import asyncio
import hmac
import json
import os
import re
import sys
import tempfile
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional

import typing  # ensure Optional and other typing symbols available for forward refs

import logging

from fastapi import Depends, FastAPI, HTTPException, Header, Query, Request as FastAPIRequest
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

core_logger = logging.getLogger("hyperflow.core")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

# Allow sibling module imports when running from this directory
sys.path.insert(0, str(Path(__file__).parent))

from hyperflow import __version__ as HYPERFLOW_VERSION
from openrouter import OpenRouterUnavailable, call_model as _call_openrouter, close_client as _close_openrouter_client
from language.emoji_parser import CANONICAL_COMBO, CANONICAL_PHASES, parse as parse_emoji
from language.intent_resolver import resolve as resolve_intent
from control.mps_controller import MPS_PROFILES, build_mps_context
from engine.edde_orchestrator import _candidate_paths, run_edde
from memory.store import (
    get_session_summary,
    push_session,
    save_knowledge,
    save_trace,
)
from workflow.contracts import WorkflowRunRequest, WorkflowResumeRequest, ApprovalContinuationRequest, HumanInputContinuationRequest
from workflow.executors import (
    run_workflow as execute_typed_workflow,
    resume_workflow as execute_typed_resume,
    continue_workflow_approval as execute_approval_continuation,
    continue_workflow_human_input as execute_human_input_continuation,
)
from workflow.graph import build_graph
from scanner.core import (
    _SCAN_MAX_DURATION_S,
    _SCAN_MAX_REPOS,
    analyze_repo_real,
    analyze_repo_stub,
    compute_overlap_scores,
)

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

def _cors_origins_from_env() -> List[str]:
    """Resolve allowed browser origins for the core service.

    The core normally sits behind the TS shell, so a permissive wildcard should
    not be the default. Support both the old and new env var names for
    compatibility and fall back to localhost dev origins only.
    """
    raw = (
        os.environ.get("HYPERFLOW_CORE_CORS_ORIGINS")
        or os.environ.get("CORS_ALLOW_ORIGINS")
        or "http://localhost:3000,http://localhost:3001"
    ).strip()
    origins = [origin.strip() for origin in raw.split(",") if origin.strip()]
    return origins or ["http://localhost:3000", "http://localhost:3001"]


app = FastAPI(title="Hyperflow Python Core", version=HYPERFLOW_VERSION)


@app.on_event("shutdown")
async def _shutdown_openrouter_client() -> None:
    await _close_openrouter_client()

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins_from_env(),
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Correlation-Id", "X-Timeout-Hint-Ms", "X-Internal-Token"],
)

# ---------------------------------------------------------------------------
# Internal token auth — CRIT-01 fix
# All non-health endpoints require X-Internal-Token to match
# HYPERFLOW_CORE_TOKEN env var (when the env var is set).
# In dev mode (env var unset) the check is skipped — explicitly documented.
# The TS shell must forward this header via pythonClient.ts.
# ---------------------------------------------------------------------------

_CORE_TOKEN: str = os.environ.get("HYPERFLOW_CORE_TOKEN", "").strip()
_RUNTIME_ENV: str = (
    os.environ.get("NODE_ENV")
    or os.environ.get("HYPERFLOW_ENV")
    or os.environ.get("ENV")
    or "development"
).strip().lower()
_LOCAL_DEV_MODE: bool = os.environ.get("HYPERFLOW_LOCAL_DEV_MODE", "").strip().lower() in {"1", "true", "yes", "on"}

if not _CORE_TOKEN:
    if not _LOCAL_DEV_MODE:
        core_logger.critical(
            "HYPERFLOW_CORE_TOKEN is required unless explicit local dev mode is enabled. "
            "Refusing to start without internal token auth (runtime env: %r).",
            _RUNTIME_ENV,
        )
        raise RuntimeError("HYPERFLOW_CORE_TOKEN must be set unless HYPERFLOW_LOCAL_DEV_MODE=true")
    core_logger.warning(
        "HYPERFLOW_CORE_TOKEN is not set — Python core is running WITHOUT "
        "internal token auth because HYPERFLOW_LOCAL_DEV_MODE is enabled."
    )


async def _require_internal_token(x_internal_token: str = Header(default="")) -> None:
    """FastAPI dependency: verify X-Internal-Token against HYPERFLOW_CORE_TOKEN.

    If HYPERFLOW_CORE_TOKEN is not configured the check is bypassed so local dev
    still works.  In any production or hardened deployment the env var MUST be set
    and the TS shell MUST forward the header on every call.
    """
    if not _CORE_TOKEN:
        # Token not configured — dev mode, allow all callers.
        return
    if not hmac.compare_digest(x_internal_token, _CORE_TOKEN):
        raise HTTPException(status_code=403, detail="Forbidden: invalid internal token")

# ---------------------------------------------------------------------------
# Log store — ring buffer (shared with EDDE orchestrator via _emit callback)
# ---------------------------------------------------------------------------

_LOG_STORE: Deque[Dict[str, Any]] = deque(maxlen=200)


def _emit(event: str, run_id: str, **extra: Any) -> None:
    _LOG_STORE.append({
        "event":     event,
        "run_id":    run_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        **extra,
    })


# ---------------------------------------------------------------------------
# Canonical phase logging
# ---------------------------------------------------------------------------

_PHASE_POSITIONS: Dict[str, int] = {p: i + 1 for i, p in enumerate(CANONICAL_PHASES)}


def _log_phase_entered(run_id: str, phase: str) -> None:
    _emit("canonical_phase_entered", run_id,
          phase=phase, position=_PHASE_POSITIONS.get(phase, 0))


def _log_phase_completed(run_id: str, phase: str) -> None:
    _emit("canonical_phase_completed", run_id,
          phase=phase, position=_PHASE_POSITIONS.get(phase, 0))


# ---------------------------------------------------------------------------
# LLM wrapper — passes MPS temperature hint to call site
# ---------------------------------------------------------------------------

async def _call_llm(prompt: str, intent: str, mode: str, temperature: float, model_hint: Optional[str] = None):
    return await _call_openrouter(prompt, intent, mode, temperature, model_hint=model_hint)


# ---------------------------------------------------------------------------
# Testing / inspection utilities — thin wrappers exposed for test imports
# ---------------------------------------------------------------------------

def _classify(text: str) -> tuple[str, str, str]:
    """
    Public-for-testing wrapper around the intent resolver.

    Returns (intent, mode, output_type) for the given text with no emoji
    tokens — equivalent to a plain-text call through the extract phase.
    Used by tests/test_classify.py for direct classification assertions.
    """
    ep = parse_emoji(text)
    cleaned = ep["cleaned_text"] or text
    return resolve_intent(cleaned, ep["raw_tokens"])



# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class ExploreRequest(BaseModel):
    prompt: str
    mps_level: typing.Optional[int] = None


class RunRequest(BaseModel):
    prompt: str
    type:   typing.Optional[str] = "agent"
    name:   typing.Optional[str] = None


class AgentExecutionRequest(BaseModel):
    agent_id: str
    agent_version: str = "1.0.0"
    prompt: str
    agent_role: typing.Optional[str] = "assistant"
    agent_capabilities: typing.Optional[List[str]] = []
    run_policy: typing.Optional[Dict[str, Any]] = {}
    context: typing.Optional[Dict[str, Any]] = {}


class RepositoryInput(BaseModel):
    id:   str
    name: str
    url:  str


class RepositoryScanRequest(BaseModel):
    repositories: List[RepositoryInput]


class GraphRepoInput(BaseModel):
    id:              str
    name:            str
    url:             typing.Optional[str] = None
    language:        str
    classification:  str
    dependencyCount: int
    dependencyNames: typing.Optional[List[str]] = None
    packageName:     typing.Optional[str] = None


class RepositoryGraphRequest(BaseModel):
    repositories: List[GraphRepoInput]


# ---------------------------------------------------------------------------
# Health + observability
# ---------------------------------------------------------------------------

@app.get("/v1/health")
def health(_: None = Depends(_require_internal_token)):
    return {
        "status":            "ok",
        "service":           "hyperflow-python-core",
        "version":           HYPERFLOW_VERSION,
        "runtime_authority": "python-core",
        "canonical_combo":   CANONICAL_COMBO,
        "canonical_phases":  CANONICAL_PHASES,
        "mps_levels":        len(MPS_PROFILES),
    }


@app.get("/v1/logs/recent")
def logs_recent(limit: int = Query(default=20, ge=1, le=200), _: None = Depends(_require_internal_token)):
    return {"items": list(_LOG_STORE)[-limit:]}


@app.get("/v1/session")
def session(_: None = Depends(_require_internal_token)):
    """In-process session memory summary. New in v0.3.0."""
    return get_session_summary()


@app.get("/v1/mps-profiles")
def mps_profiles_ref(_: None = Depends(_require_internal_token)):
    """MPS profile reference table. New in v0.3.0."""
    return {"profiles": MPS_PROFILES}


# ---------------------------------------------------------------------------
# /v1/explore — emoji-aware path exploration (no LLM call)
# ---------------------------------------------------------------------------

@app.post("/v1/explore")
def explore(req: ExploreRequest, _: None = Depends(_require_internal_token)):
    ep = parse_emoji(req.prompt)
    cleaned = ep["cleaned_text"] or req.prompt
    intent, mode, _ = resolve_intent(cleaned, ep["raw_tokens"])
    mps_ctx = build_mps_context(
        intent=intent,
        mode=mode,
        emoji_tokens=ep["raw_tokens"],
        mps_level_hint=req.mps_level or ep["mps_level_hint"],
        canonical_combo_detected=ep["canonical_combo_detected"],
    )
    paths = _candidate_paths(intent, req.prompt, mps_ctx["max_candidates"])
    selected = max(paths, key=lambda p: p["evaluation_score"]) if paths else {}
    return {
        "paths":               paths,
        "selected_path_label": selected.get("label", ""),
        "selected_path_key":   selected.get("path_key", ""),
        "selection_reason": (
            f"Score {selected.get('evaluation_score', 0)} — "
            f"intent '{intent}', MPS {mps_ctx['level']} ({mps_ctx['name']})."
        ),
        "emoji_parse": ep,
        "mps_context": mps_ctx,
    }


# ---------------------------------------------------------------------------
# /v1/run — FULL 6-PHASE EDDE PIPELINE
# ---------------------------------------------------------------------------

_KNOWLEDGE_FORMAT_MAP: Dict[str, str] = {
    "analytical":    "structured_insight",
    "generative":    "final_insight",
    "transformative":"structured_insight",
    "explanatory":   "final_insight",
    "retrieval":     "fragment_standard",
    "planning":      "structured_insight",
    "verification":  "structured_insight",
    "observational": "fragment_standard",
}


@app.post("/v1/run")
async def run(req: RunRequest, request: FastAPIRequest, _: None = Depends(_require_internal_token)):
    run_id     = str(uuid.uuid4())
    started_at = datetime.now(timezone.utc)
    correlation_id = request.headers.get("x-correlation-id", "")
    timeout_hint_ms = request.headers.get("x-timeout-hint-ms", "")
    if correlation_id:
        core_logger.info("run started run_id=%s correlation_id=%s", run_id, correlation_id)
    if timeout_hint_ms:
        core_logger.info("run timeout_hint run_id=%s timeout_hint_ms=%s", run_id, timeout_hint_ms)

    _emit("step_started", run_id, prompt_preview=req.prompt[:80], correlation_id=correlation_id)

    try:
        bundle = await run_edde(
            prompt=req.prompt,
            run_id=run_id,
            emit=_emit,
            call_llm=_call_llm,
            log_phase_entered=_log_phase_entered,
            log_phase_completed=_log_phase_completed,
            model_hint=None,  # /v1/run has no agentRef — no model hint
        )
    except Exception as exc:
        error_msg = f"{type(exc).__name__}: {exc}"
        _emit("run_failed", run_id, error=error_msg)
        return {
            "run_id":           run_id,
            "intent":           "unknown",
            "mode":             "unknown",
            "output_type":      "error",
            "result":           {},
            "contract":         {},
            "quality_score":    0.0,
            "should_reset":     True,
            "knowledge_format": "fragment_standard",
            "error":            error_msg,
            "runId":            run_id,
            "type":             req.type or "agent",
            "name":             req.name or "failed run",
            "status":           "failed",
            "progress":         0,
            "startedAt":        started_at.isoformat(),
            "completedAt":      datetime.now(timezone.utc).isoformat(),
        }

    intent     = bundle["intent"]
    mode       = bundle["mode"]
    output_type= bundle["output_type"]
    result     = bundle["result"]
    q_score    = bundle["quality_score"]
    source     = bundle["source"]
    mps_ctx    = bundle["mps_context"]

    contract = {
        "input_type":  "natural_language",
        "output_type": output_type,
        "mode":        mode,
        "intent":      intent,
        "runtime":     "python-core",
        "version":     HYPERFLOW_VERSION,
        "mps_level":   mps_ctx["level"],
        "mps_name":    mps_ctx["name"],
        "modelUsed":   result.get("model"),   # real runtime model, not inferred
        "constraints": {"max_tokens": 2048, "confidence_threshold": 0.60},
    }

    _emit("step_completed", run_id, source=source, quality_score=q_score,
          mps_level=mps_ctx["level"])
    _emit("run_completed",  run_id, intent=intent, mode=mode,
          source=source, quality_score=q_score, mps_level=mps_ctx["level"])

    # Best-effort memory persistence; JSONL writes are sync, so run them off the
    # event loop. Both are independent — gather() runs them concurrently to avoid
    # adding their sequential latency to the response time.
    await asyncio.gather(
        asyncio.to_thread(save_knowledge, run_id, intent, mode, str(result.get("output", "")), bundle["confidence"]),
        asyncio.to_thread(
            save_trace,
            run_id=run_id, prompt=req.prompt, intent=intent, mode=mode,
            mps_context=mps_ctx,
            phases_completed=bundle["canonical_trace"]["phases_completed"],
            canonical_combo_detected=bundle["canonical_trace"]["canonical_combo_detected"],
            quality_score=q_score, source=source,
        ),
    )
    push_session(run_id, intent, mode, q_score)

    return {
        # Contract fields — TS shell reads these
        "run_id":           run_id,
        "intent":           intent,
        "mode":             mode,
        "output_type":      output_type,
        "result":           result,
        "contract":         contract,
        "quality_score":    q_score,
        "should_reset":     bundle["should_reset"],
        "knowledge_format": _KNOWLEDGE_FORMAT_MAP.get(mode, "fragment_standard"),
        # Degradation flag — surfaced to operators so stub runs are never silently "successful"
        "degraded":         bundle.get("degraded", False),
        "degraded_reason":  bundle.get("degraded_reason"),
        # Phase trace — full per-phase outputs from the canonical 6-phase EDDE pipeline.
        # Persisted by the TS shell into agent_runs.phases for long-term observability.
        "phases":           bundle.get("phases", {}),
        # Canonical semantics — runtime-owned, never redefined by shell or panel
        "canonical_combo":  CANONICAL_COMBO,
        "canonical_phases": list(CANONICAL_PHASES),
        "canonical_trace":  bundle["canonical_trace"],
        # Run envelope — TS persistence layer
        "runId":            run_id,
        "type":             req.type or "agent",
        "name":             req.name or f"{intent} run",
        "status":           "completed",
        "progress":         100,
        "startedAt":        started_at.isoformat(),
        "completedAt":      datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# /v1/agent/run — AGENT-NATIVE EXECUTION (Phase 2 Agent Platform)
# ---------------------------------------------------------------------------

@app.post("/v1/agent/run")
async def agent_run(req: AgentExecutionRequest, request: FastAPIRequest, _: None = Depends(_require_internal_token)):
    run_id     = str(uuid.uuid4())
    started_at = datetime.now(timezone.utc)
    correlation_id = request.headers.get("x-correlation-id", "")
    timeout_hint_ms = request.headers.get("x-timeout-hint-ms", "")
    if correlation_id:
        core_logger.info("agent_run started run_id=%s agent_id=%s correlation_id=%s",
                         run_id, req.agent_id, correlation_id)
    if timeout_hint_ms:
        core_logger.info("agent_run timeout_hint run_id=%s timeout_hint_ms=%s", run_id, timeout_hint_ms)

    _emit("agent_run_started", run_id,
          agent_id=req.agent_id, agent_version=req.agent_version,
          agent_role=req.agent_role, correlation_id=correlation_id)

    # -------------------------------------------------------------------------
    # Agent-native routing: derive execution semantics from the agent's identity
    # fields. This mirrors the logic in workflow/executors.py _build_routing() so
    # that standalone /v1/agent/run runs carry the same semantic depth as
    # workflow-embedded agent steps.
    #
    # routing_context is injected as a structured preamble into the prompt when
    # any of the following are non-trivial:
    #   - agent_role     (non-default "assistant")
    #   - agent_capabilities  (non-empty list)
    #   - run_policy     (non-empty dict with runtimeMode / modelHint / etc.)
    #   - context        (caller-supplied execution context)
    # -------------------------------------------------------------------------
    run_policy      = req.run_policy or {}
    capabilities    = req.agent_capabilities or []
    role            = req.agent_role or "assistant"
    runtime_mode    = run_policy.get("runtimeMode", "standard")
    model_hint      = (run_policy.get("modelHint") or "").strip() or None  # None if absent/empty
    safe_profile    = run_policy.get("safeConstraintProfile")
    context_payload = req.context or {}

    routing = {
        "agentId":              req.agent_id,
        "agentVersion":         req.agent_version,
        "role":                 role,
        "availableCapabilities": capabilities,
        "runtimeMode":          runtime_mode,
        "modelHint":            model_hint,
        "safeConstraintProfile": safe_profile,
        # runtimeMode and safeConstraintProfile are advisory — no execution logic
        # is keyed on them. They appear in the prompt preamble only. modelHint
        # IS executable: it propagates to call_model() as model_hint.
        "advisoryFields":       ["runtimeMode", "safeConstraintProfile"],
    }

    has_routing_context = (
        role != "assistant"
        or bool(capabilities)
        or bool(model_hint)
        or bool(safe_profile)
        or runtime_mode != "standard"
        or bool(context_payload)
    )

    if has_routing_context:
        preamble = {
            "routing": {
                "role":                  role,
                "runtimeMode":           runtime_mode,
                "runtimeModeAdvisory":   True,
                "modelHint":             model_hint,
                "safeConstraintProfile": safe_profile,
                "safeConstraintProfileAdvisory": True,
                "availableCapabilities": capabilities,
            },
        }
        if context_payload:
            preamble["context"] = context_payload  # type: ignore[assignment]
        effective_prompt = (
            "[HYPERFLOW AGENT ROUTING CONTEXT]\n"
            + json.dumps(preamble, ensure_ascii=False, sort_keys=True)
            + "\n\n"
            + req.prompt
        )
    else:
        effective_prompt = req.prompt

    try:
        bundle = await run_edde(
            prompt=effective_prompt,
            run_id=run_id,
            emit=_emit,
            call_llm=_call_llm,
            log_phase_entered=_log_phase_entered,
            log_phase_completed=_log_phase_completed,
            model_hint=model_hint,  # propagates to call_model() → OpenRouter payload
        )
    except Exception as exc:
        error_msg = f"{type(exc).__name__}: {exc}"
        _emit("agent_run_failed", run_id, error=error_msg,
              agent_id=req.agent_id)
        return {
            "run_id":           run_id,
            "agent_id":         req.agent_id,
            "agent_version":    req.agent_version,
            "intent":           "unknown",
            "mode":             "unknown",
            "output_type":      "error",
            "result":           {},
            "quality_score":    0.0,
            "error":            error_msg,
            "status":           "failed",
            "startedAt":        started_at.isoformat(),
            "completedAt":      datetime.now(timezone.utc).isoformat(),
        }

    intent      = bundle["intent"]
    mode        = bundle["mode"]
    output_type = bundle["output_type"]
    result      = bundle["result"]
    q_score     = bundle["quality_score"]
    source      = bundle["source"]
    mps_ctx     = bundle["mps_context"]

    # Attach routing metadata to the result so callers can observe what routing
    # constraints were active for this run — mirrors the result["routing"] field
    # produced by workflow/executors.py _execute_agent().
    result = dict(result)
    result["routing"] = routing

    contract = {
        "input_type":  "agent_execution",
        "output_type": output_type,
        "mode":        mode,
        "intent":      intent,
        "runtime":     "python-core",
        "version":     HYPERFLOW_VERSION,
        "agent_id":    req.agent_id,
        "agent_version": req.agent_version,
        "agent_role":  req.agent_role,
        "mps_level":   mps_ctx["level"],
        "mps_name":    mps_ctx["name"],
        "modelUsed":   result.get("model"),   # real runtime model — reflects hint if provided
        "routing":     routing,
    }

    _emit("agent_run_completed", run_id,
          agent_id=req.agent_id, intent=intent, mode=mode,
          source=source, quality_score=q_score)

    # Best-effort memory persistence; run both writes concurrently off the event loop.
    await asyncio.gather(
        asyncio.to_thread(save_knowledge, run_id, intent, mode, str(result.get("output", "")), bundle["confidence"]),
        asyncio.to_thread(
            save_trace,
            run_id=run_id, prompt=req.prompt, intent=intent, mode=mode,
            mps_context=mps_ctx,
            phases_completed=bundle["canonical_trace"]["phases_completed"],
            canonical_combo_detected=bundle["canonical_trace"]["canonical_combo_detected"],
            quality_score=q_score, source=source,
        ),
    )
    push_session(run_id, intent, mode, q_score)

    completed_at = datetime.now(timezone.utc)
    return {
        "run_id":           run_id,
        "agent_id":         req.agent_id,
        "agent_version":    req.agent_version,
        "intent":           intent,
        "mode":             mode,
        "output_type":      output_type,
        "result":           result,
        "contract":         contract,
        "quality_score":    q_score,
        "knowledge_format": _KNOWLEDGE_FORMAT_MAP.get(mode, "fragment_standard"),
        # Degradation flag — surfaced to operators so stub runs are never silently "successful"
        "degraded":         bundle.get("degraded", False),
        "degraded_reason":  bundle.get("degraded_reason"),
        # Phase trace — full per-phase outputs from the canonical 6-phase EDDE pipeline.
        # Persisted by the TS shell into agent_runs.phases for long-term observability.
        "phases":           bundle.get("phases", {}),
        # Canonical semantics — runtime-owned, never redefined by shell or panel
        "canonical_combo":  CANONICAL_COMBO,
        "canonical_phases": list(CANONICAL_PHASES),
        "canonical_trace":  bundle["canonical_trace"],
        "status":           "completed",
        "startedAt":        started_at.isoformat(),
        "completedAt":      completed_at.isoformat(),
    }


def _make_disconnect_monitor(
    request: FastAPIRequest,
    cancel_event: asyncio.Event,
) -> asyncio.Task:
    """
    Start a background task that sets cancel_event when the HTTP client disconnects.

    EX-1: Uses a 1-second poll loop instead of a direct await on is_disconnected()
    to avoid false-positive cancellations in test environments where the method
    resolves immediately once the request body is fully consumed.  Production
    behaviour: cancel_event fires within ~1 s of actual disconnect.

    Returns the monitor Task.  Callers must cancel it (and await the result) in
    their finally block so it does not outlive the request handler.
    """
    async def _monitor() -> None:
        try:
            while True:
                await asyncio.sleep(1.0)
                if await request.is_disconnected():
                    cancel_event.set()
                    return
        except asyncio.CancelledError:
            pass   # cancelled by the request handler's finally block
        except Exception:
            pass   # best-effort — never let the monitor crash the handler

    return asyncio.ensure_future(_monitor())


# ---------------------------------------------------------------------------
# Workflow — typed executable runtime
# ---------------------------------------------------------------------------

def _build_dag(steps, edges=None):
    """Build and validate the workflow DAG once, returning flat order and level batches."""
    graph = build_graph(steps, edges or [])
    order = [graph.step_map[sid] for sid in graph.order]
    levels = [[graph.step_map[sid] for sid in level] for level in graph.levels]
    return order, levels


def _topo_sort(steps, edges=None):
    order, _ = _build_dag(steps, edges)
    return order


def _workflow_levels(steps, edges=None):
    _, levels = _build_dag(steps, edges)
    return levels


def _aggregate_degraded(nodes) -> tuple[bool, Optional[str]]:
    """Aggregate node-level degradation into a workflow-level flag.

    A workflow is degraded if ANY agent node ran in degraded mode (e.g. stub LLM
    fallback). Operators must see this at the workflow envelope so dashboards
    cannot report a fully-stub workflow as a healthy success.
    """
    reasons: list[str] = []
    for node in nodes or []:
        result = node.get("result") if isinstance(node, dict) else None
        if not isinstance(result, dict):
            continue
        if result.get("degraded") is True:
            reason = result.get("degraded_reason") or "stub_fallback"
            if reason not in reasons:
                reasons.append(reason)
    if not reasons:
        return False, None
    return True, ",".join(reasons)


@app.post("/v1/workflow/run")
async def workflow_run(req: WorkflowRunRequest, request: FastAPIRequest, _: None = Depends(_require_internal_token)):
    run_id = str(uuid.uuid4())
    started_at = datetime.now(timezone.utc)

    # EX-1: cancel_event signals execution to stop at the next DAG level boundary
    # when the HTTP client disconnects (TS AbortController.abort()).
    cancel_event = asyncio.Event()
    monitor_task = _make_disconnect_monitor(request, cancel_event)
    try:
        response = await execute_typed_workflow(
            req,
            run_edde=run_edde,
            emit=_emit,
            call_llm=_call_llm,
            log_phase_entered=_log_phase_entered,
            log_phase_completed=_log_phase_completed,
            cancel_event=cancel_event,
        )
    except ValueError as exc:
        return {
            "status": "failed",
            "error": str(exc),
            "nodes": [],
            "runId": run_id,
            "startedAt": started_at.isoformat(),
            "completedAt": datetime.now(timezone.utc).isoformat(),
        }
    finally:
        monitor_task.cancel()
        try:
            await monitor_task
        except asyncio.CancelledError:
            pass

    degraded, degraded_reason = _aggregate_degraded(response["nodes"])
    return {
        "runId": run_id,
        "workflowId": req.workflowId,
        "name": req.name,
        "status": response["status"],
        "nodes": response["nodes"],
        "startedAt": started_at.isoformat(),
        "completedAt": datetime.now(timezone.utc).isoformat(),
        "checkpointId": response.get("checkpointId"),
        "blockedNodeId": response.get("blockedNodeId"),
        "resumabilityReason": response.get("resumabilityReason", "none"),
        "degraded": degraded,
        "degraded_reason": degraded_reason,
    }


@app.post("/v1/workflow/resume")
async def workflow_resume(req: WorkflowResumeRequest, request: FastAPIRequest, _: None = Depends(_require_internal_token)):
    """
    Resume a workflow execution from a set of previously completed nodes. The
    completedNodes list must represent a contiguous prefix of the workflow's
    topological order when checkpointId is supplied.
    """
    started_at = datetime.now(timezone.utc)

    # EX-1: disconnect monitor for cancel propagation
    cancel_event = asyncio.Event()
    monitor_task = _make_disconnect_monitor(request, cancel_event)
    try:
        response = await execute_typed_resume(
            req,
            run_edde=run_edde,
            emit=_emit,
            call_llm=_call_llm,
            log_phase_entered=_log_phase_entered,
            log_phase_completed=_log_phase_completed,
            cancel_event=cancel_event,
        )
    except ValueError as exc:
        return {
            "status": "failed",
            "error": str(exc),
            "nodes": [],
            "checkpointId": req.checkpointId,
        }
    finally:
        monitor_task.cancel()
        try:
            await monitor_task
        except asyncio.CancelledError:
            pass

    degraded, degraded_reason = _aggregate_degraded(response["nodes"])
    return {
        "runId": req.runId,
        "workflowId": req.workflowId,
        "name": req.name,
        "status": response["status"],
        "nodes": response["nodes"],
        "startedAt": started_at.isoformat(),
        "completedAt": datetime.now(timezone.utc).isoformat(),
        "checkpointId": response.get("checkpointId"),
        **({"error": response["error"]} if "error" in response else {}),
        **({"blockedNodeId": response.get("blockedNodeId")} if response.get("blockedNodeId") else {}),
        "resumabilityReason": response.get("resumabilityReason", "none"),
        "degraded": degraded,
        "degraded_reason": degraded_reason,
    }


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Workflow continuation endpoints
# ---------------------------------------------------------------------------


@app.post("/v1/workflow/continue/approval")
async def workflow_continue_approval(req: ApprovalContinuationRequest, request: FastAPIRequest, _: None = Depends(_require_internal_token)):
    """
    Python-owned approval continuation.

    Accepts an approval decision (approved=True) with full workflow state and
    advances execution from the approved approval node boundary.
    Returns an authoritative execution snapshot that TS must project — TS must
    NOT invent blockedNodeId, run status, or checkpoint state independently.
    """
    started_at = datetime.now(timezone.utc)

    # EX-1: disconnect monitor
    cancel_event = asyncio.Event()
    monitor_task = _make_disconnect_monitor(request, cancel_event)
    try:
        response = await execute_approval_continuation(
            req,
            run_edde=run_edde,
            emit=_emit,
            call_llm=_call_llm,
            log_phase_entered=_log_phase_entered,
            log_phase_completed=_log_phase_completed,
            cancel_event=cancel_event,
        )
    except ValueError as exc:
        return {
            "status": "failed",
            "error": str(exc),
            "nodes": [],
            "runId": req.runId,
            "nodeId": req.nodeId,
        }
    finally:
        monitor_task.cancel()
        try:
            await monitor_task
        except asyncio.CancelledError:
            pass

    degraded, degraded_reason = _aggregate_degraded(response["nodes"])
    return {
        "runId": req.runId,
        "workflowId": req.workflowId,
        "name": req.name,
        "nodeId": req.nodeId,
        "continuationType": "approval",
        "status": response["status"],
        "nodes": response["nodes"],
        "startedAt": started_at.isoformat(),
        "completedAt": datetime.now(timezone.utc).isoformat(),
        "checkpointId": response.get("checkpointId"),
        "blockedNodeId": response.get("blockedNodeId"),
        "resumabilityReason": response.get("resumabilityReason", "none"),
        "degraded": degraded,
        "degraded_reason": degraded_reason,
        **({} if "error" not in response else {"error": response["error"]}),
    }


@app.post("/v1/workflow/continue/human-input")
async def workflow_continue_human_input(req: HumanInputContinuationRequest, request: FastAPIRequest, _: None = Depends(_require_internal_token)):
    """
    Python-owned human-input continuation.

    Accepts human-supplied input for a waiting_input node and advances
    execution from that boundary. Returns an authoritative execution snapshot
    that TS must project — TS must NOT invent node completion or checkpoint
    state independently.
    """
    started_at = datetime.now(timezone.utc)

    # EX-1: disconnect monitor
    cancel_event = asyncio.Event()
    monitor_task = _make_disconnect_monitor(request, cancel_event)
    try:
        response = await execute_human_input_continuation(
            req,
            run_edde=run_edde,
            emit=_emit,
            call_llm=_call_llm,
            log_phase_entered=_log_phase_entered,
            log_phase_completed=_log_phase_completed,
            cancel_event=cancel_event,
        )
    except ValueError as exc:
        return {
            "status": "failed",
            "error": str(exc),
            "nodes": [],
            "runId": req.runId,
            "nodeId": req.nodeId,
        }
    finally:
        monitor_task.cancel()
        try:
            await monitor_task
        except asyncio.CancelledError:
            pass

    degraded, degraded_reason = _aggregate_degraded(response["nodes"])
    return {
        "runId": req.runId,
        "workflowId": req.workflowId,
        "name": req.name,
        "nodeId": req.nodeId,
        "continuationType": "human_input",
        "status": response["status"],
        "nodes": response["nodes"],
        "startedAt": started_at.isoformat(),
        "completedAt": datetime.now(timezone.utc).isoformat(),
        "checkpointId": response.get("checkpointId"),
        "blockedNodeId": response.get("blockedNodeId"),
        "resumabilityReason": response.get("resumabilityReason", "none"),
        "degraded": degraded,
        "degraded_reason": degraded_reason,
        **({} if "error" not in response else {"error": response["error"]}),
    }


# ---------------------------------------------------------------------------
# Repository scanning
# ---------------------------------------------------------------------------


def _jaccard(a: str, b: str) -> float:
    ta = set(re.split(r"[_\-/.]", a.lower()))
    tb = set(re.split(r"[_\-/.]", b.lower()))
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


@app.post("/v1/repositories/scan")
async def repositories_scan(req: RepositoryScanRequest, _: None = Depends(_require_internal_token)):
    if os.environ.get("HYPERFLOW_SCANNER_ENABLED", "false").lower() != "true":
        raise HTTPException(
            status_code=503,
            detail={
                "error": "Repository scanner is disabled in this environment.",
                "code": "SCANNER_DISABLED",
                "reason": (
                    "HYPERFLOW_SCANNER_ENABLED is not set to 'true'. "
                    "Enable only after configuring a controlled egress proxy "
                    "(e.g. Squid/Tinyproxy with allowlist) to mitigate DNS rebinding. "
                    "See: docs/security/scanner-setup.md"
                ),
            },
        )
    # H-01 fix: require a proxy URL before accepting scan requests. Without a
    # controlled egress proxy, the double-resolve DNS rebinding mitigation in
    # analyze_repo_real is insufficient — git's own resolver makes an
    # independent DNS call that is outside our control window. Refusing to run
    # without HYPERFLOW_SCANNER_PROXY_URL ensures every clone goes through a
    # proxy whose resolver is the single authoritative source.
    _proxy_url = os.environ.get("HYPERFLOW_SCANNER_PROXY_URL", "").strip()
    if not _proxy_url:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "Repository scanner requires an egress proxy to be configured.",
                "code": "SCANNER_PROXY_REQUIRED",
                "reason": (
                    "HYPERFLOW_SCANNER_PROXY_URL is not set. "
                    "Set it to a Squid/Tinyproxy URL with an allowlist before enabling "
                    "the scanner in production. Without a proxy the DNS rebinding "
                    "mitigation in analyze_repo_real is insufficient. "
                    "See: docs/security/scanner-setup.md"
                ),
            },
        )
    results = []
    overlap_scores = compute_overlap_scores([repo.model_dump() for repo in req.repositories])
    scan_started = datetime.now(timezone.utc)

    with tempfile.TemporaryDirectory() as tmp:
        work_dir = Path(tmp)
        for repo in req.repositories:
            try:
                elapsed_s = (datetime.now(timezone.utc) - scan_started).total_seconds()
                remaining_s = max(5.0, 300.0 - elapsed_s)
                analyzed = await analyze_repo_real(
                    repo.model_dump(),
                    work_dir=work_dir,
                    overlap=overlap_scores.get(repo.id, 0.0),
                    remaining_s=remaining_s,
                )
                pkg_name = repo.name.replace(" ", "-").lower()
                results.append({
                    "id": repo.id,
                    "name": repo.name,
                    "url": repo.url,
                    "language": analyzed["language"],
                    "classification": analyzed["classification"],
                    "classificationRationale": analyzed.get("classificationRationale"),
                    "dependencyCount": analyzed["dependencyCount"],
                    "dependencyNames": analyzed["dependencyNames"],
                    "packageName": pkg_name,
                    "overlapScore": analyzed["overlapScore"],
                    "status": "scanned",
                    "cloneDurationMs": analyzed.get("cloneDurationMs"),
                    "analysisDurationMs": analyzed.get("analysisDurationMs"),
                })
            except Exception as exc:
                results.append({
                    "id": repo.id, "name": repo.name, "url": repo.url,
                    "language": "unknown", "classification": "unknown",
                    "dependencyCount": 0, "dependencyNames": [], "packageName": "",
                    "overlapScore": overlap_scores.get(repo.id, 0.0), "status": "failed", "error": str(exc),
                })
    return {"status": "completed", "repositories": results}


@app.post("/v1/repositories/graph")
def repositories_graph(req: RepositoryGraphRequest, _: None = Depends(_require_internal_token)):
    repos  = req.repositories
    nodes  = [{"id": r.id, "name": r.name, "language": r.language,
               "classification": r.classification, "dependencyCount": r.dependencyCount}
              for r in repos]
    pkg_map  = {r.packageName: r.id for r in repos if r.packageName}
    name_map = {r.name: r.id for r in repos}
    edges: List[Dict[str, Any]] = []
    overlap_pairs: List[Dict[str, Any]] = []

    for r in repos:
        for dep in (r.dependencyNames or []):
            tid = (
                pkg_map.get(dep)
                or pkg_map.get(dep.replace("_", "-"))
                or pkg_map.get(dep.replace("-", "_"))
                or name_map.get(dep)
            )
            if tid and tid != r.id:
                edges.append({"source": r.id, "target": tid,
                              "weight": 1.0, "matchType": "dependency"})

    for i, a in enumerate(repos):
        for b in repos[i + 1:]:
            score = _jaccard(a.name, b.name)
            if score > 0.2:
                overlap_pairs.append({"repoA": a.id, "repoB": b.id, "score": round(score, 4)})
            if a.language == b.language:
                edges.append({"source": a.id, "target": b.id,
                              "weight": 0.5, "matchType": "affinity"})

    return {"nodes": nodes, "edges": edges, "overlapPairs": overlap_pairs}


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("main:app", host=os.environ.get("HOST", "127.0.0.1"), port=port, reload=False)
