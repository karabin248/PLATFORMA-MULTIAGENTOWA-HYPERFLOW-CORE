"""
Hyperflow EDDE Orchestrator — merged from v0.2.0 + core-main.

Implements the canonical 6‑phase execution cycle:

  🌈 perceive         — input intake + emoji parse
  💎 extract_essence  — intent classification, essence extraction
  🔥 sense_direction  — MPS level resolution, trajectory commitment
  🧠 synthesize       — LLM call (or stub), core output generation
  🔀 generate_options — candidate paths enumeration
  ⚡ choose           — quality scoring, final selection

Phase order is fixed and enforced. Each phase emits telemetry to
the shared log store. All phases complete on every run — no skipping.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from language.emoji_parser import parse as parse_emoji, CANONICAL_PHASES
from language.intent_resolver import resolve as resolve_intent
from control.mps_controller import build_mps_context, get_profile


# Intent keyword table — used by extract-phase confidence scoring.
_INTENT_KEYWORDS: dict[str, list[str]] = {
    "analyze":   ["analyze", "analysis", "examine", "inspect", "review", "audit", "check", "evaluate"],
    "generate":  ["generate", "create", "write", "build", "produce", "make", "draft", "compose"],
    "transform": ["transform", "convert", "translate", "refactor", "rewrite", "migrate", "adapt"],
    "explain":   ["explain", "describe", "what", "how", "why", "clarify", "detail", "summarize"],
    "query":     ["find", "search", "get", "fetch", "list", "show", "retrieve", "lookup", "query"],
    "plan":      ["plan", "design", "architect", "outline", "schedule", "roadmap", "strategy"],
    "classify":  ["classify", "categorize", "tag", "label", "sort", "group", "identify"],
    "validate":  ["validate", "verify", "test", "check", "assert", "confirm", "ensure"],
    "optimize":  ["optimize", "improve", "speed", "performance", "reduce", "enhance", "fix"],
    "monitor":   ["monitor", "watch", "observe", "track", "alert", "measure", "log"],
    "process":   ["process", "run", "execute", "apply", "handle", "perform", "do"],
}


def _extract_confidence(prompt: str, cleaned: str, emoji_parse: dict[str, Any], intent: str) -> float:
    """Return a conservative confidence estimate for extract classification.

    Confidence should not rise merely because the prompt is longer. This
    heuristic blends structural signals (cleaning, emoji combo, intent known)
    with light keyword evidence for the resolved intent.
    """
    score = 0.50
    if cleaned.strip():
        score += 0.05
    if cleaned.strip() != prompt.strip():
        score += 0.03
    if emoji_parse.get("canonical_combo_detected"):
        score += 0.08
    raw_tokens = emoji_parse.get("raw_tokens") or []
    score += min(len(raw_tokens) * 0.015, 0.06)
    if intent and intent not in {"general", "unknown"}:
        score += 0.05
    if len(cleaned.split()) >= 3:
        score += 0.04

    prompt_lower = cleaned.lower()
    keywords = _INTENT_KEYWORDS.get(intent, _INTENT_KEYWORDS["process"])
    hits = sum(1 for kw in keywords if kw in prompt_lower)
    kw_ratio = min(hits / max(len(keywords), 1), 1.0)
    score += kw_ratio * 0.16

    return round(min(score, 0.88), 4)



# ---------------------------------------------------------------------------
# Candidate path templates (intent → 3 paths)
# ---------------------------------------------------------------------------

_PATH_TEMPLATES: dict[str, list[dict[str, Any]]] = {
    "analyze":   [
        {"label": "Deep Structural Analysis",       "base_score": 0.87},
        {"label": "Surface Heuristic Scan",         "base_score": 0.72},
        {"label": "Comparative Reference Analysis", "base_score": 0.79},
    ],
    "generate":  [
        {"label": "Template-Guided Generation",     "base_score": 0.85},
        {"label": "Free-Form Synthesis",            "base_score": 0.76},
        {"label": "Iterative Refinement Generation","base_score": 0.91},
    ],
    "transform": [
        {"label": "Lossless Structural Transform",  "base_score": 0.90},
        {"label": "Semantic-Preserving Simplification","base_score": 0.81},
        {"label": "Target-Format Projection",       "base_score": 0.78},
    ],
    "explain":   [
        {"label": "Layered Conceptual Explanation", "base_score": 0.88},
        {"label": "Example-Driven Walkthrough",     "base_score": 0.82},
        {"label": "Summary and Implications",       "base_score": 0.74},
    ],
    "query":     [
        {"label": "Indexed Term Retrieval",         "base_score": 0.83},
        {"label": "Semantic Similarity Search",     "base_score": 0.86},
        {"label": "Structured Filter Query",        "base_score": 0.77},
    ],
    "plan":      [
        {"label": "Sequential Milestone Plan",      "base_score": 0.89},
        {"label": "Parallel Execution Map",         "base_score": 0.84},
        {"label": "Risk-Weighted Priority Plan",    "base_score": 0.80},
    ],
    "classify":  [
        {"label": "Rule-Based Classification",      "base_score": 0.82},
        {"label": "Multi-Label Probabilistic Tagging","base_score": 0.87},
        {"label": "Hierarchical Category Mapping",  "base_score": 0.79},
    ],
    "validate":  [
        {"label": "Schema Conformance Check",       "base_score": 0.91},
        {"label": "Semantic Consistency Audit",     "base_score": 0.85},
        {"label": "Cross-Reference Verification",   "base_score": 0.78},
    ],
    "optimize":  [
        {"label": "Constraint-Aware Optimisation",  "base_score": 0.88},
        {"label": "Greedy Incremental Improvement", "base_score": 0.76},
        {"label": "Multi-Objective Pareto Search",  "base_score": 0.84},
    ],
    "monitor":   [
        {"label": "Real-Time Stream Observation",   "base_score": 0.83},
        {"label": "Historical Baseline Comparison", "base_score": 0.79},
        {"label": "Threshold-Based Alert Monitoring","base_score": 0.75},
    ],
    "process":   [
        {"label": "Standard Processing Pipeline",   "base_score": 0.80},
        {"label": "Adaptive Context Processing",    "base_score": 0.85},
        {"label": "Minimal-Overhead Fast Path",     "base_score": 0.71},
    ],
}


def _path_key(label: str) -> str:
    return "path_" + hashlib.sha256(label.encode()).hexdigest()[:8]


def _candidate_paths(intent: str, prompt: str, mps_max_candidates: int) -> list[dict[str, Any]]:
    templates = _PATH_TEMPLATES.get(intent, _PATH_TEMPLATES["process"])
    token_count = len(prompt.split())
    specificity_bonus = round(min(token_count / 120.0, 0.07), 4)
    paths = []
    for tmpl in templates[:mps_max_candidates]:
        score = round(min(tmpl["base_score"] + specificity_bonus, 1.0), 4)
        paths.append({
            "label":            tmpl["label"],
            "path_key":         _path_key(tmpl["label"]),
            "evaluation_score": score,
            "metadata":         {"intent": intent, "prompt_tokens": token_count},
        })
    return paths


def _quality_score(result: dict[str, Any], intent: str, confidence: float) -> float:
    """Compute a quality score in [0, 1].

    Stub output is useful fallback output, but it should never appear as a
    fully healthy high-confidence LLM run on dashboards. Penalize stub runs so
    degraded mode remains visible to operators.
    """
    score = 0.40
    if result.get("output"):
        score += 0.20
    if result.get("intent") == intent:
        score += 0.10
    if result.get("reasoning"):
        score += 0.10
    score += round(confidence * 0.20, 4)
    raw = round(min(score, 1.0), 4)
    if result.get("source") == "stub":
        return round(raw * 0.60, 4)
    return raw


# ---------------------------------------------------------------------------
# Stub output (used when LLM is unavailable)
# ---------------------------------------------------------------------------

def _stub_output(prompt: str, intent: str, mode: str, token_count: int, confidence: float) -> dict[str, Any]:
    return {
        "output":      f"Executed '{intent}' operation: {prompt[:120]}",
        "intent":      intent,
        "mode":        mode,
        "token_count": token_count,
        "reasoning":   (
            f"Prompt classified as '{intent}' via emoji+keyword analysis. "
            f"'{mode}' execution mode selected for {token_count} input tokens. "
            f"Confidence: {confidence}. (stub — OpenRouter unavailable)"
        ),
        "confidence": confidence,
        "source":     "stub",
        "model":      "stub",
        "degraded":   True,
        "degraded_reason": "openrouter_unavailable",
        "timestamp":  datetime.now(timezone.utc).isoformat(),
    }


# ---------------------------------------------------------------------------
# EDDE 6-phase orchestrator
# ---------------------------------------------------------------------------

async def run_edde(
    prompt: str,
    run_id: str,
    emit: Callable[..., None],
    call_llm: Callable,   # async (prompt, intent, mode, temperature, model_hint) -> (str, str) | raises
    log_phase_entered: Callable[[str, str], None],
    log_phase_completed: Callable[[str, str], None],
    model_hint: Optional[str] = None,
) -> dict[str, Any]:
    """
    Execute the full canonical 6-phase EDDE cycle.

    Returns a bundle dict with all phase outputs.
    Phases always complete in order — no skipping.
    """
    bundle: dict[str, Any] = {"run_id": run_id, "phases": {}}

    # ── 🌈 Phase 1: Perceive ────────────────────────────────────────────────
    log_phase_entered(run_id, "perceive")
    emoji_parse = parse_emoji(prompt)
    token_count = len(prompt.split())
    bundle["phases"]["perceive"] = {
        "prompt_tokens": token_count,
        "emoji_parse":   emoji_parse,
        "scope":         "global" if emoji_parse["canonical_combo_detected"] else "local",
    }
    log_phase_completed(run_id, "perceive")

    # ── 💎 Phase 2: Extract ─────────────────────────────────────────────────
    log_phase_entered(run_id, "extract_essence")
    cleaned = emoji_parse["cleaned_text"] or prompt
    intent, mode, output_type = resolve_intent(cleaned, emoji_parse["raw_tokens"])
    confidence = _extract_confidence(prompt, cleaned, emoji_parse, intent)
    bundle["phases"]["extract_essence"] = {
        "intent":      intent,
        "mode":        mode,
        "output_type": output_type,
        "confidence":  confidence,
        "cleaned_text": cleaned,
        "output_hints": emoji_parse["output_hints"],
    }
    log_phase_completed(run_id, "extract_essence")

    # ── 🔥 Phase 3: Direct ──────────────────────────────────────────────────
    log_phase_entered(run_id, "sense_direction")
    mps_ctx = build_mps_context(
        intent=intent,
        mode=mode,
        emoji_tokens=emoji_parse["raw_tokens"],
        mps_level_hint=emoji_parse["mps_level_hint"],
        canonical_combo_detected=emoji_parse["canonical_combo_detected"],
    )
    bundle["phases"]["sense_direction"] = {
        "mps_context":   mps_ctx,
        "trajectory":    f"{intent}:{mode}",
        "reasoning_depth": "high" if mps_ctx["level"] >= 4 else "medium",
        "action_routes": emoji_parse["action_routes"],
    }
    log_phase_completed(run_id, "sense_direction")

    # ── 🧠 Phase 4: Synthesize (LLM call) ────────────────────────────────────
    log_phase_entered(run_id, "synthesize")
    llm_text: Optional[str] = None
    model_used: Optional[str] = None
    source = "llm"

    try:
        llm_text, model_used = await call_llm(
            prompt, intent, mode, mps_ctx["llm_temperature"], model_hint
        )
        emit("model_called", run_id, model=model_used, source="llm", mps_level=mps_ctx["level"])
    except Exception as exc:
        source = "stub"
        emit("model_called", run_id, model="stub", source="stub", fallback_reason=str(exc))

    if source == "llm" and llm_text is not None:
        synth_result: dict[str, Any] = {
            "output":      llm_text,
            "intent":      intent,
            "mode":        mode,
            "token_count": token_count,
            "reasoning":   f"OpenRouter ({model_used}) responded in '{mode}' mode.",
            "confidence":  confidence,
            "source":      "llm",
            "model":       model_used,
            "degraded":    False,
            "timestamp":   datetime.now(timezone.utc).isoformat(),
        }
    else:
        synth_result = _stub_output(prompt, intent, mode, token_count, confidence)

    bundle["phases"]["synthesize"] = synth_result
    log_phase_completed(run_id, "synthesize")

    # ── 🔀 Phase 5: Generate (candidate paths) ──────────────────────────────
    log_phase_entered(run_id, "generate_options")
    paths = _candidate_paths(intent, prompt, mps_ctx["max_candidates"])
    bundle["phases"]["generate_options"] = {
        "paths":       paths,
        "path_count":  len(paths),
        "mps_limited": mps_ctx["max_candidates"] < 3,
    }
    log_phase_completed(run_id, "generate_options")

    # ── ⚡ Phase 6: Decide ──────────────────────────────────────────────────
    log_phase_entered(run_id, "choose")
    selected = max(paths, key=lambda p: p["evaluation_score"]) if paths else {}
    q_score = _quality_score(synth_result, intent, confidence)
    should_reset = q_score < 0.30
    bundle["phases"]["choose"] = {
        "selected_path":   selected.get("label", ""),
        "selected_key":    selected.get("path_key", ""),
        "quality_score":   q_score,
        "should_reset":    should_reset,
        "source":          source,
    }
    log_phase_completed(run_id, "choose")

    # ── Build canonical trace ────────────────────────────────────────────────
    phases_completed = list(bundle["phases"].keys())
    order_preserved = phases_completed == list(CANONICAL_PHASES)

    from language.emoji_parser import CANONICAL_COMBO
    bundle["canonical_trace"] = {
        "canonical_combo":  CANONICAL_COMBO,
        "canonical_phases": list(CANONICAL_PHASES),
        "phases_completed": phases_completed,
        "terminal_phase":   "choose",
        "order_preserved":  order_preserved,
        "cycle_version":    "1.0",
        "mps_level":        mps_ctx["level"],
        "mps_name":         mps_ctx["name"],
        "canonical_combo_detected": emoji_parse["canonical_combo_detected"],
    }
    bundle["intent"]       = intent
    bundle["mode"]         = mode
    bundle["output_type"]  = output_type
    bundle["confidence"]   = confidence
    bundle["quality_score"]= q_score
    bundle["should_reset"] = should_reset
    bundle["source"]       = source
    bundle["result"]       = synth_result
    bundle["mps_context"]  = mps_ctx
    bundle["degraded"]     = bool(synth_result.get("degraded", False))
    if bundle["degraded"]:
        bundle["degraded_reason"] = synth_result.get("degraded_reason", "stub_fallback")

    return bundle
