from __future__ import annotations

import ast
import asyncio
import json
import os
import re
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence, Tuple

from .contracts import (
    AgentStep,
    ApprovalStep,
    CompensationStep,
    ConditionStep,
    ExecutableWorkflowStep,
    HumanStep,
    JoinStep,
    ToolStep,
    WorkflowResumeRequest,
    WorkflowRunRequest,
)
from .graph import WorkflowGraph, build_graph
# C-1 defence-in-depth: import the allowlist validator so that even if the
# openrouter.py call_model() check is somehow bypassed at the call-site, the
# hint is validated here before it reaches run_edde → call_model.
from openrouter import _validate_model_hint as _openrouter_validate_model_hint

RunEddeCallable = Callable[..., Awaitable[Dict[str, Any]]]

_ALLOWED_AST = (
    ast.Expression,
    ast.BoolOp,
    ast.BinOp,
    ast.UnaryOp,
    ast.Compare,
    ast.Name,
    ast.Load,
    ast.Constant,
    ast.List,
    ast.Tuple,
    ast.Dict,
    ast.Subscript,
    ast.IfExp,
    ast.And,
    ast.Or,
    ast.Not,
    ast.Eq,
    ast.NotEq,
    ast.Gt,
    ast.GtE,
    ast.Lt,
    ast.LtE,
    ast.In,
    ast.NotIn,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.Mod,
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_eval(expression: str, context: Dict[str, Any]) -> Any:
    tree = ast.parse(expression, mode="eval")
    for node in ast.walk(tree):
        if not isinstance(node, _ALLOWED_AST):
            raise ValueError(f"Unsupported expression element: {node.__class__.__name__}")
    return eval(compile(tree, "<workflow-condition>", "eval"), {"__builtins__": {}}, context)


def _normalize_condition_result(value: Any) -> List[str]:
    if isinstance(value, bool):
        return ["true"] if value else ["false"]
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple, set)):
        return [str(item) for item in value]
    if value is None:
        return []
    return [str(value)]


def _edge_is_active(edge, active_nodes: Dict[str, bool], selected_branches: Dict[str, List[str]]) -> bool:
    if not active_nodes.get(edge.from_id, False):
        return False
    if edge.condition:
        branches = selected_branches.get(edge.from_id, [])
        return edge.condition in branches
    return True


def _upstream_handoffs(state: Dict[str, Any], active_parents: List[str]) -> List[Dict[str, Any]]:
    handoffs = []
    for parent in active_parents:
        handoff = state.get("node_handoffs", {}).get(parent)
        if isinstance(handoff, dict):
            handoffs.append(handoff)
    return handoffs


def _build_routing(step: AgentStep) -> Dict[str, Any]:
    agent_ref = step.agentRef.model_dump() if step.agentRef else {}
    available_capabilities = list(agent_ref.get("capabilities") or [])
    missing = [cap for cap in step.requiredCapabilities if cap not in available_capabilities]
    if missing:
        raise ValueError(f"Agent '{agent_ref.get('id', step.id)}' missing required capabilities: {', '.join(missing)}")
    run_policy = dict(agent_ref.get("runPolicy") or {})
    model_hint_raw = run_policy.get("modelHint") or ""

    # C-1 FIX (defence-in-depth): validate the model hint at the routing layer
    # before it propagates downstream to run_edde → call_model.  The primary
    # enforcement is in openrouter.py::call_model via _validate_model_hint, but
    # catching it here surfaces the error earlier with a clearer node-level
    # message and prevents the hint from entering the prompt preamble.
    try:
        validated_hint = _openrouter_validate_model_hint(model_hint_raw or None)
    except ValueError as exc:
        raise ValueError(
            f"Agent '{agent_ref.get('id', step.id)}' supplied an invalid modelHint: {exc}"
        ) from exc

    return {
        "agentId": agent_ref.get("id", step.id),
        "agentVersion": agent_ref.get("version", "1.0.0"),
        "role": agent_ref.get("role", "assistant"),
        "availableCapabilities": available_capabilities,
        "requiredCapabilities": list(step.requiredCapabilities),
        "runtimeMode": run_policy.get("runtimeMode", "standard"),
        "modelHint": validated_hint,   # None if absent/empty/invalid
        "safeConstraintProfile": run_policy.get("safeConstraintProfile"),
        # runtimeMode and safeConstraintProfile have no execution logic keyed on them.
        # They are forwarded to the prompt preamble only. modelHint IS executable.
        "advisoryFields": ["runtimeMode", "safeConstraintProfile"],
        "capabilityCheck": {"satisfied": True, "missing": []},
    }


# ---------------------------------------------------------------------------
# H-1 FIX: prompt-injection sanitisation helpers
#
# The routing preamble is serialised into the LLM prompt before step.prompt.
# Any user-controlled free-text fields in the preamble are an injection
# surface.  We enforce two rules:
#
#   1. Only whitelisted ENUM-like fields from handoffContract are included
#      (schemaVersion, intent, targetHint, artifactKeys, successSignal).
#      openQuestions, note, and any other free-text fields are EXCLUDED.
#
#   2. Whitelisted string fields are validated against a strict safe-string
#      pattern before inclusion.  Strings that fail validation are replaced
#      with a sanitised placeholder so the preamble structure is preserved
#      but the injected content is discarded.
#
# This approach is conservative: when in doubt, exclude.
# ---------------------------------------------------------------------------

_PREAMBLE_SAFE_STRING_RE = re.compile(r'^[a-zA-Z0-9_\-/.: ]{0,200}$')


def _safe_preamble_str(value: Any, fallback: str = "") -> str:
    """Return value if it passes the safe-string check, else fallback."""
    if not isinstance(value, str):
        return fallback
    return value if _PREAMBLE_SAFE_STRING_RE.match(value) else fallback


def _sanitise_capability(cap: Any) -> Optional[str]:
    """Return a capability string only if it passes the safe-string check."""
    if not isinstance(cap, str):
        return None
    return cap if _PREAMBLE_SAFE_STRING_RE.match(cap) else None


def _build_agent_prompt(step: AgentStep, routing: Dict[str, Any], upstream_handoffs: List[Dict[str, Any]]) -> str:
    has_routing_context = bool(
        upstream_handoffs
        or step.handoffContract
        or step.requiredCapabilities
        or (step.agentRef and (step.agentRef.role or step.agentRef.capabilities or step.agentRef.runPolicy))
    )
    if not has_routing_context:
        return step.prompt

    # H-1 FIX: Only structured, enum-like fields are included in the preamble.
    # Free-text fields (openQuestions, note, metadata, etc.) are intentionally
    # excluded — they are the primary prompt-injection surface.
    #
    # Upstream handoffs: include only structural identity fields (fromNodeId,
    # intent, targetHint) as safe-validated strings.  Artifact keys are listed
    # by name only (no values).  openQuestions is excluded entirely.
    safe_capabilities = [
        c for c in (
            _sanitise_capability(cap)
            for cap in routing.get("requiredCapabilities", [])
        )
        if c is not None
    ]

    handoff_contract_summary: Optional[Dict[str, Any]] = None
    if step.handoffContract:
        raw = step.handoffContract.model_dump()
        # Only include non-free-text contract fields
        handoff_contract_summary = {
            "schemaVersion": _safe_preamble_str(raw.get("schemaVersion"), "1.0"),
            "intent":        _safe_preamble_str(raw.get("intent"), "node_result"),
            "targetHint":    _safe_preamble_str(raw.get("targetHint"), ""),
            # artifactKeys are structural identifiers — safe to list
            "artifactKeys":  [
                k for k in (raw.get("artifactKeys") or [])
                if isinstance(k, str) and _PREAMBLE_SAFE_STRING_RE.match(k)
            ],
            "successSignal": _safe_preamble_str(raw.get("successSignal"), ""),
            # openQuestions intentionally excluded — free-text injection surface
        }

    upstream_summary = [
        {
            "fromNodeId": _safe_preamble_str(h.get("fromNodeId"), ""),
            "intent":     _safe_preamble_str(h.get("intent"), ""),
            "targetHint": _safe_preamble_str(h.get("targetHint"), ""),
            # artifacts: include only the keys (structural), not the values (data)
            "artifactKeys": [
                k for k in (h.get("artifacts") or {}).keys()
                if isinstance(k, str) and _PREAMBLE_SAFE_STRING_RE.match(k)
            ],
            # openQuestions intentionally excluded — free-text injection surface
        }
        for h in upstream_handoffs
    ]

    preamble = {
        "routing": {
            "role":                          _safe_preamble_str(routing.get("role"), "assistant"),
            "runtimeMode":                   _safe_preamble_str(routing.get("runtimeMode"), "standard"),
            "runtimeModeAdvisory":           True,
            "modelHint":                     routing.get("modelHint"),  # already validated in _build_routing
            "safeConstraintProfile":         _safe_preamble_str(routing.get("safeConstraintProfile") or "", ""),
            "safeConstraintProfileAdvisory": True,
            "requiredCapabilities":          safe_capabilities,
        },
        "advisoryFields":  ["runtimeMode", "safeConstraintProfile"],
        "handoffContract": handoff_contract_summary,
        "upstreamHandoffs": upstream_summary,
    }
    return "[HYPERFLOW ROUTING CONTEXT]\n" + json.dumps(preamble, ensure_ascii=False, sort_keys=True) + "\n\n" + step.prompt


def _build_handoff(step: AgentStep, result: Dict[str, Any], routing: Dict[str, Any], upstream_handoffs: List[Dict[str, Any]]) -> Dict[str, Any]:
    contract = step.handoffContract.model_dump() if step.handoffContract else {"schemaVersion": "1.0", "intent": "node_result", "artifactKeys": [], "openQuestions": []}
    artifact_keys = contract.get("artifactKeys") or []
    artifacts = {key: result.get(key) for key in artifact_keys if key in result}
    return {
        "schemaVersion": contract.get("schemaVersion", "1.0"),
        "fromNodeId": step.id,
        "fromRole": routing.get("role"),
        "intent": contract.get("intent", "node_result"),
        "targetHint": contract.get("targetHint"),
        "artifacts": artifacts,
        "payload": result,
        "openQuestions": contract.get("openQuestions", []),
        "successSignal": contract.get("successSignal"),
        "inheritedFrom": [handoff.get("fromNodeId") for handoff in upstream_handoffs if isinstance(handoff, dict)],
        "routing": routing,
    }


async def _execute_agent(step: AgentStep, *, state: Dict[str, Any], active_parents: List[str], run_edde: RunEddeCallable, emit, call_llm, log_phase_entered, log_phase_completed) -> Dict[str, Any]:
    started = _now_iso()
    routing = _build_routing(step)
    model_hint: Optional[str] = routing.get("modelHint")  # None if not specified
    upstream_handoffs = _upstream_handoffs(state, active_parents)
    effective_prompt = _build_agent_prompt(step, routing, upstream_handoffs)
    bundle = await run_edde(
        prompt=effective_prompt,
        run_id=step.id,
        emit=emit,
        call_llm=call_llm,
        log_phase_entered=log_phase_entered,
        log_phase_completed=log_phase_completed,
        model_hint=model_hint,   # propagates → call_model() → OpenRouter payload
    )
    result = dict(bundle["result"])
    if step.agentRef:
        result["agentRef"] = step.agentRef.model_dump()
    result["routing"] = routing
    handoff_payload = dict(result)
    result["handoff"] = _build_handoff(step, handoff_payload, routing, upstream_handoffs)
    return {
        "nodeId": step.id,
        "name": step.name,
        "status": "succeeded",
        "result": result,
        "startedAt": started,
        "completedAt": _now_iso(),
    }


async def _execute_tool(step: ToolStep, *, state: Dict[str, Any]) -> Dict[str, Any]:
    started = _now_iso()
    action = step.action
    if action == "echo":
        result = {"echo": step.input}
    elif action == "select_keys":
        keys = step.input.get("keys", [])
        result = {"selected": {str(k): step.input.get(str(k)) for k in keys}}
    elif action == "merge_results":
        merged: Dict[str, Any] = {}
        for dep in step.dependsOn:
            dep_result = state["node_results"].get(dep, {})
            if isinstance(dep_result, dict):
                merged[dep] = dep_result
        result = {"merged": merged}
    elif action == "extract_field":
        field = str(step.input.get("field", ""))
        value = step.input.get(field)
        if value is None:
            for dep in step.dependsOn:
                dep_result = state["node_results"].get(dep, {})
                if isinstance(dep_result, dict) and field in dep_result:
                    value = dep_result[field]
                    break
        result = {"field": field, "value": value}
    else:
        raise ValueError(f"Unsupported tool action '{action}'")
    return {
        "nodeId": step.id,
        "name": step.name,
        "status": "succeeded",
        "result": result,
        "startedAt": started,
        "completedAt": _now_iso(),
    }


async def _execute_condition(step: ConditionStep, *, state: Dict[str, Any]) -> Dict[str, Any]:
    started = _now_iso()

    # H-2 / M-1 FIX: The condition expression context must NOT expose full
    # node result payloads.  Providing state["node_results"] verbatim allows
    # callers who control completed_nodes to inject arbitrary values that
    # downstream condition expressions then treat as authoritative (privilege
    # escalation via crafted resume payload).  It also allows expressions to
    # extract sensitive data from prior LLM outputs as a side-channel.
    #
    # We replace the full result dict with a narrow projection that contains:
    #   - "status": the node's terminal status string (scalar)
    #   - "ok": convenience boolean — True when status is "completed"/"succeeded"
    #
    # Condition expressions should branch on STATUS, not on payload content.
    # If a workflow genuinely needs payload routing, use a tool step with
    # action="extract_field" and expose only the specific scalar field needed.
    def _narrow_result(raw: Any) -> Dict[str, Any]:
        if isinstance(raw, dict):
            status_val = str(raw.get("status", "completed"))
        else:
            # raw is the raw node result, not a node envelope — treat as completed
            status_val = "completed"
        return {
            "status": status_val,
            "ok": status_val in {"completed", "succeeded"},
        }

    narrow_results = {
        node_id: _narrow_result(result)
        for node_id, result in state["node_results"].items()
    }

    context = {
        "input":   step.input,
        "memory":  state["memory"],
        "results": narrow_results,
        # "handoffs" intentionally excluded — full handoff payloads are a
        # data-exfiltration surface via side-channel branch selection.
    }
    raw = _safe_eval(step.expression, context)
    branches = _normalize_condition_result(raw)
    return {
        "nodeId": step.id,
        "name": step.name,
        "status": "succeeded",
        "result": {"expression": step.expression, "selected_branches": branches, "value": raw},
        "startedAt": started,
        "completedAt": _now_iso(),
    }


async def _execute_approval(step: ApprovalStep) -> Dict[str, Any]:
    started = _now_iso()
    return {
        "nodeId": step.id,
        "name": step.name,
        "status": "waiting_approval",
        "result": {
            "reason": step.reason,
            "objective": step.objective,
            "metadata": step.metadata,
        },
        "startedAt": started,
        "completedAt": _now_iso(),
    }


async def _execute_human(step: HumanStep) -> Dict[str, Any]:
    started = _now_iso()
    return {
        "nodeId": step.id,
        "name": step.name,
        "status": "waiting_input",
        "result": {
            "instruction": step.instruction,
            "expectedInputSchema": step.expectedInputSchema,
        },
        "startedAt": started,
        "completedAt": _now_iso(),
    }


async def _execute_join(step: JoinStep, *, state: Dict[str, Any], active_parents: List[str]) -> Dict[str, Any]:
    started = _now_iso()
    merged = {parent: state["node_results"].get(parent) for parent in active_parents}
    merged_handoffs = {parent: state.get("node_handoffs", {}).get(parent) for parent in active_parents if state.get("node_handoffs", {}).get(parent) is not None}
    return {
        "nodeId": step.id,
        "name": step.name,
        "status": "succeeded",
        "result": {"mergePolicy": step.mergePolicy, "merged": merged, "mergedHandoffs": merged_handoffs},
        "startedAt": started,
        "completedAt": _now_iso(),
    }


async def _execute_compensation(step: CompensationStep, *, state: Dict[str, Any]) -> Dict[str, Any]:
    started = _now_iso()
    target = state["node_results"].get(step.targetNodeId)
    return {
        "nodeId": step.id,
        "name": step.name,
        "status": "compensated",
        "result": {"targetNodeId": step.targetNodeId, "strategy": step.strategy, "targetResult": target},
        "startedAt": started,
        "completedAt": _now_iso(),
    }


async def execute_step(step: ExecutableWorkflowStep, *, state: Dict[str, Any], active_parents: List[str], run_edde: RunEddeCallable, emit, call_llm, log_phase_entered, log_phase_completed) -> Dict[str, Any]:
    if step.type == "agent":
        return await _execute_agent(step, state=state, active_parents=active_parents, run_edde=run_edde, emit=emit, call_llm=call_llm, log_phase_entered=log_phase_entered, log_phase_completed=log_phase_completed)
    if step.type == "tool":
        return await _execute_tool(step, state=state)
    if step.type == "condition":
        return await _execute_condition(step, state=state)
    if step.type == "approval":
        return await _execute_approval(step)
    if step.type == "human":
        return await _execute_human(step)
    if step.type == "join":
        return await _execute_join(step, state=state, active_parents=active_parents)
    if step.type == "compensation":
        return await _execute_compensation(step, state=state)
    raise ValueError(f"Unsupported workflow step type '{step.type}'")


def _prepare_state(completed_nodes: Sequence[Any]) -> Dict[str, Any]:
    state = {
        "memory": {},
        "node_results": {},
        "node_status": {},
        "selected_branches": {},
        "active_nodes": {},
        "node_handoffs": {},
    }
    for node in completed_nodes:
        result = node.result or {}
        state["node_results"][node.nodeId] = result
        state["node_status"][node.nodeId] = "succeeded"
        state["active_nodes"][node.nodeId] = True
        if isinstance(result, dict) and "selected_branches" in result:
            state["selected_branches"][node.nodeId] = [str(item) for item in result.get("selected_branches") or []]
        if isinstance(result, dict) and "key" in result and "value" in result:
            state["memory"][str(result["key"])] = result["value"]
        if isinstance(result, dict) and isinstance(result.get("handoff"), dict):
            state["node_handoffs"][node.nodeId] = result.get("handoff")
    return state


def _validate_resume_boundary(graph: WorkflowGraph, completed_node_ids: List[str], checkpoint_id: Optional[str]) -> Optional[str]:
    completed_ids = set(completed_node_ids)

    # Nothing completed yet — fresh resume, no boundary to validate.
    if not completed_ids:
        return None

    order_ids = list(graph.order)

    # Validate all claimed nodes exist in the graph before any index operation.
    unknown = [cid for cid in completed_ids if cid not in graph.step_map]
    if unknown:
        return f"Completed node(s) do not exist in the workflow definition: {', '.join(unknown)}"

    try:
        completed_indices = [order_ids.index(cid) for cid in completed_ids]
    except ValueError:
        return "Completed node does not exist in the workflow definition"

    max_index = max(completed_indices)

    # C-02 fix: when checkpoint_id is omitted, derive it implicitly from the last
    # completed node in topological order and still enforce the prefix invariant.
    # Previously this function returned None here, which silently accepted any
    # caller-supplied completedNodes list without verification.
    if checkpoint_id is None:
        checkpoint_id = order_ids[max_index]

    if checkpoint_id not in completed_ids:
        return "Checkpoint does not match any completed node"

    if checkpoint_id not in graph.step_map:
        return "Checkpoint node does not exist in the workflow definition"

    checkpoint_index = order_ids.index(checkpoint_id)
    if checkpoint_index != max_index:
        return "Checkpoint is not the last completed node"

    expected_prefix = set(order_ids[: max_index + 1])
    if completed_ids != expected_prefix:
        return "Completed nodes do not form a contiguous prefix up to the checkpoint"

    return None



_MAX_STEP_TIMEOUT_S: float = float(os.environ.get("HYPERFLOW_MAX_STEP_TIMEOUT_S", "600"))


# ---------------------------------------------------------------------------
# EX-2 + EX-4: step executor extracted from loop — explicit CancelledError re-raise
# ---------------------------------------------------------------------------

async def _run_step_impl(
    step: "ExecutableWorkflowStep",
    active_parents: List[str],
    *,
    state: Dict[str, Any],
    request_input: Dict[str, Any],
    run_edde: "RunEddeCallable",
    emit: Any,
    call_llm: Any,
    log_phase_entered: Any,
    log_phase_completed: Any,
) -> Dict[str, Any]:
    """Execute one workflow step with per-step timeout and error isolation.

    CancelledError is always re-raised so asyncio.gather() cancellation
    (from cancel_event or external task cancellation) propagates correctly.
    TimeoutError is caught and converted to a failed_terminal result.
    All other exceptions are caught and converted to failed_terminal results
    so a single bad step cannot abort sibling steps in the same DAG level.
    """
    _retry = getattr(step, "retryPolicy", None)
    _requested_timeout: float = (
        float(_retry["timeoutSeconds"])
        if isinstance(_retry, dict)
        and isinstance(_retry.get("timeoutSeconds"), (int, float))
        and _retry.get("timeoutSeconds", 0) > 0
        else float(os.environ.get("HYPERFLOW_STEP_TIMEOUT_S", "300"))
    )
    # H-02 fix: cap the timeout at _MAX_STEP_TIMEOUT_S regardless of what the
    # caller supplied in retryPolicy.timeoutSeconds. Without this cap a malicious
    # or misconfigured workflow step could hold an executor slot indefinitely.
    _timeout = min(_requested_timeout, _MAX_STEP_TIMEOUT_S)
    try:
        return await asyncio.wait_for(
            execute_step(
                step,
                state={**state, "request_input": request_input},
                active_parents=active_parents,
                run_edde=run_edde,
                emit=emit,
                call_llm=call_llm,
                log_phase_entered=log_phase_entered,
                log_phase_completed=log_phase_completed,
            ),
            timeout=_timeout,
        )
    except asyncio.CancelledError:
        # Re-raise immediately — cancellation must propagate out of gather().
        raise
    except asyncio.TimeoutError:
        return {
            "nodeId": step.id,
            "name": step.name,
            "status": "failed_terminal",
            "result": {"error": f"Step exceeded timeout of {_timeout}s"},
            "startedAt": None,
            "completedAt": _now_iso(),
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "nodeId": step.id,
            "name": step.name,
            "status": "failed_terminal",
            "result": {"error": str(exc)},
            "startedAt": None,
            "completedAt": _now_iso(),
        }

async def _execute_workflow(graph: WorkflowGraph, *, request_input: Dict[str, Any], precompleted_nodes: Sequence[Any], run_edde: RunEddeCallable, emit, call_llm, log_phase_entered, log_phase_completed, cancel_event: Optional[asyncio.Event] = None) -> Dict[str, Any]:
    state = _prepare_state(precompleted_nodes)
    nodes: List[Dict[str, Any]] = [
        {
            "nodeId": node.nodeId,
            "name": node.name,
            "status": "succeeded",
            "result": node.result,
            "startedAt": node.startedAt,
            "completedAt": node.completedAt,
        }
        for node in precompleted_nodes
    ]
    blocked_reason: Optional[str] = None
    blocked_node_id: Optional[str] = None
    failed = False

    for level in graph.levels:
        # EX-1: Cancel check at DAG level boundary.
        # Checked before each level so cancellation is honoured between levels
        # without interrupting steps already running in a gather() batch.
        if cancel_event is not None and cancel_event.is_set():
            remaining_ids = [
                sid for sid in graph.order
                if sid not in state["node_status"]
            ]
            for sid in remaining_ids:
                step = graph.step_map[sid]
                state["node_status"][sid] = "cancelled"
                nodes.append({
                    "nodeId": step.id,
                    "name": step.name,
                    "status": "cancelled",
                    "result": {"reason": "workflow_cancelled"},
                    "startedAt": None,
                    "completedAt": _now_iso(),
                })
            return {
                "status": "cancelled",
                "nodes": nodes,
                "checkpointId": None,
                "blockedNodeId": None,
                "resumabilityReason": "terminal",
            }

        # Snapshot the pre-level blocked/failed state. Within a single topological
        # level, sibling nodes are concurrency-eligible — none of them depend on
        # each other — so a mid-level failure cannot retroactively skip siblings
        # that were dispatched in the same gather() batch. Only blocking that
        # happened in PRIOR levels gates the current level.
        pre_blocked = blocked_reason is not None
        pre_failed  = failed

        # Pass 1 — classify each step in the level into "runnable" or "skipped"
        # based on its parent-edge activation and the pre-level gate. This pass
        # mutates state["active_nodes"] / state["node_status"] for skipped nodes
        # only; runnable nodes' final status is written in Pass 3.
        runnable: List[Tuple[Any, List[str]]] = []
        skipped_results_by_id: Dict[str, Dict[str, Any]] = {}
        ordered_step_ids: List[str] = []
        for step_id in level:
            if step_id in state["node_status"]:
                continue
            ordered_step_ids.append(step_id)
            step = graph.step_map[step_id]
            incoming_edges = graph.incoming.get(step_id, [])
            if not incoming_edges:
                active_parents: List[str] = []
                active = True
            else:
                active_parents = [edge.from_id for edge in incoming_edges if _edge_is_active(edge, state["active_nodes"], state["selected_branches"])]
                active = len(active_parents) > 0
            state["active_nodes"][step_id] = active
            if not active or pre_blocked or pre_failed:
                skipped = {
                    "nodeId": step.id,
                    "name": step.name,
                    "status": "skipped",
                    "result": None,
                    "startedAt": None,
                    "completedAt": None,
                }
                state["node_status"][step_id] = "skipped"
                state["node_results"][step_id] = None
                skipped_results_by_id[step_id] = skipped
            else:
                runnable.append((step, active_parents))

        # Pass 2 — execute all runnable steps in this level concurrently.
        # _run_step_impl (module-level) handles timeout + CancelledError re-raise.
        executed_results = await asyncio.gather(
            *[
                _run_step_impl(
                    s, ap,
                    state=state,
                    request_input=request_input,
                    run_edde=run_edde,
                    emit=emit,
                    call_llm=call_llm,
                    log_phase_entered=log_phase_entered,
                    log_phase_completed=log_phase_completed,
                )
                for s, ap in runnable
            ]
        ) if runnable else []
        executed_by_id: Dict[str, Dict[str, Any]] = {}
        for (step, _ap), result in zip(runnable, executed_results):
            executed_by_id[step.id] = result

        # Pass 3 — fold results back into shared state in deterministic level
        # order, then aggregate into the per-level result list. Blocking /
        # failure flags raised here gate FUTURE levels only.
        level_results: List[Dict[str, Any]] = []
        for step_id in ordered_step_ids:
            if step_id in skipped_results_by_id:
                level_results.append(skipped_results_by_id[step_id])
                continue
            result = executed_by_id[step_id]
            step = graph.step_map[step_id]
            state["node_status"][step_id] = result["status"]
            state["node_results"][step_id] = result.get("result")
            if step.type == "condition" and isinstance(result.get("result"), dict):
                state["selected_branches"][step_id] = [str(item) for item in result["result"].get("selected_branches", [])]
            if isinstance(result.get("result"), dict) and isinstance(result["result"].get("handoff"), dict):
                state["node_handoffs"][step_id] = result["result"]["handoff"]
            if result["status"] == "failed_terminal":
                failed = True
            elif result["status"] == "waiting_approval":
                blocked_reason = "pending_approval"
                blocked_node_id = step.id
            elif result["status"] == "waiting_input":
                blocked_reason = "pending_human_input"
                blocked_node_id = step.id
            level_results.append(result)

        nodes.extend(level_results)
        if blocked_reason or failed:
            # Continue outer loop to mark later nodes skipped in topo order.
            continue

    run_status = "failed" if failed else "waiting_approval" if blocked_reason == "pending_approval" else "waiting_input" if blocked_reason == "pending_human_input" else "completed"
    checkpoint_id: Optional[str] = None
    for entry in reversed(nodes):
        if entry.get("status") != "skipped":
            checkpoint_id = entry.get("nodeId")
            break
    return {
        "status": run_status,
        "nodes": nodes,
        "checkpointId": checkpoint_id,
        "blockedNodeId": blocked_node_id,
        "resumabilityReason": blocked_reason or "none",
    }


async def run_workflow(request: WorkflowRunRequest, *, run_edde: RunEddeCallable, emit, call_llm, log_phase_entered, log_phase_completed, cancel_event: Optional[asyncio.Event] = None) -> Dict[str, Any]:
    graph = build_graph(request.steps, request.edges)
    return await _execute_workflow(
        graph,
        request_input=request.input,
        precompleted_nodes=[],
        run_edde=run_edde,
        emit=emit,
        call_llm=call_llm,
        log_phase_entered=log_phase_entered,
        log_phase_completed=log_phase_completed,
        cancel_event=cancel_event,
    )


async def resume_workflow(request: WorkflowResumeRequest, *, run_edde: RunEddeCallable, emit, call_llm, log_phase_entered, log_phase_completed, cancel_event: Optional[asyncio.Event] = None) -> Dict[str, Any]:
    graph = build_graph(request.steps, request.edges)
    boundary_error = _validate_resume_boundary(graph, [node.nodeId for node in request.completedNodes], request.checkpointId)
    if boundary_error:
        return {
            "status": "failed",
            "error": boundary_error,
            "nodes": [
                {
                    "nodeId": node.nodeId,
                    "name": node.name,
                    "status": "succeeded",
                    "result": node.result,
                    "startedAt": node.startedAt,
                    "completedAt": node.completedAt,
                }
                for node in request.completedNodes
            ],
            "checkpointId": request.checkpointId,
        }
    return await _execute_workflow(
        graph,
        request_input=request.input,
        precompleted_nodes=request.completedNodes,
        run_edde=run_edde,
        emit=emit,
        call_llm=call_llm,
        log_phase_entered=log_phase_entered,
        log_phase_completed=log_phase_completed,
        cancel_event=cancel_event,
    )


async def continue_workflow_approval(
    request: "ApprovalContinuationRequest",
    *,
    run_edde: RunEddeCallable,
    emit,
    call_llm,
    log_phase_entered,
    log_phase_completed,
    cancel_event: Optional[asyncio.Event] = None,
) -> Dict[str, Any]:
    """
    Python-owned approval continuation handler.

    Marks the approval node as succeeded and advances workflow execution
    from that boundary. This is the sole authority for transitioning from
    waiting_approval → running/completed/next-blocked state.

    The returned snapshot is authoritative — TS must project it only.

    cancel_event — optional asyncio.Event; when set, execution stops at the
    next DAG level boundary (mirrors the semantics of run_workflow / resume_workflow).
    Propagated from main.py's disconnect monitor via the cancel_event kwarg.
    """
    from .contracts import ApprovalContinuationRequest, CompletedNode

    graph = build_graph(request.steps, request.edges)

    # Synthesise a completed node record for the approval boundary.
    # Include it only if not already present in the caller-supplied completedNodes.
    approval_completed = CompletedNode(
        nodeId=request.nodeId,
        name=request.nodeId,
        result={
            "approved": True,
            "approvedBy": request.approvedBy,
            "note": request.note,
        },
        completedAt=_now_iso(),
    )
    existing_ids = {n.nodeId for n in request.completedNodes}
    all_completed = list(request.completedNodes)
    if request.nodeId not in existing_ids:
        all_completed.append(approval_completed)

    # Validate boundary with the approval node included as completed.
    boundary_error = _validate_resume_boundary(
        graph,
        [n.nodeId for n in all_completed],
        request.nodeId,
    )
    if boundary_error:
        return {
            "status": "failed",
            "error": boundary_error,
            "nodes": [
                {
                    "nodeId": n.nodeId,
                    "name": n.name,
                    "status": "succeeded",
                    "result": n.result,
                    "startedAt": n.startedAt,
                    "completedAt": n.completedAt,
                }
                for n in all_completed
            ],
            "checkpointId": request.nodeId,
            "blockedNodeId": None,
            "resumabilityReason": "none",
        }

    return await _execute_workflow(
        graph,
        request_input=request.input,
        precompleted_nodes=all_completed,
        run_edde=run_edde,
        emit=emit,
        call_llm=call_llm,
        log_phase_entered=log_phase_entered,
        log_phase_completed=log_phase_completed,
        cancel_event=cancel_event,  # propagated from main.py disconnect monitor
    )


async def continue_workflow_human_input(
    request: "HumanInputContinuationRequest",
    *,
    run_edde: RunEddeCallable,
    emit,
    call_llm,
    log_phase_entered,
    log_phase_completed,
    cancel_event: Optional[asyncio.Event] = None,
) -> Dict[str, Any]:
    """
    Python-owned human-input continuation handler.

    Marks the human node as succeeded with the provided input and advances
    workflow execution from that boundary. This is the sole authority for
    transitioning from waiting_input → running/completed/next-blocked.

    The returned snapshot is authoritative — TS must project it only.

    cancel_event — optional asyncio.Event; when set, execution stops at the
    next DAG level boundary. Propagated from main.py's disconnect monitor.
    """
    from .contracts import HumanInputContinuationRequest, CompletedNode

    graph = build_graph(request.steps, request.edges)

    human_completed = CompletedNode(
        nodeId=request.nodeId,
        name=request.nodeId,
        result={
            "humanInput": request.humanInput,
            "actorId": request.actorId,
            "acceptedAt": _now_iso(),
        },
        completedAt=_now_iso(),
    )
    existing_ids = {n.nodeId for n in request.completedNodes}
    all_completed = list(request.completedNodes)
    if request.nodeId not in existing_ids:
        all_completed.append(human_completed)

    boundary_error = _validate_resume_boundary(
        graph,
        [n.nodeId for n in all_completed],
        request.nodeId,
    )
    if boundary_error:
        return {
            "status": "failed",
            "error": boundary_error,
            "nodes": [
                {
                    "nodeId": n.nodeId,
                    "name": n.name,
                    "status": "succeeded",
                    "result": n.result,
                    "startedAt": n.startedAt,
                    "completedAt": n.completedAt,
                }
                for n in all_completed
            ],
            "checkpointId": request.nodeId,
            "blockedNodeId": None,
            "resumabilityReason": "none",
        }

    return await _execute_workflow(
        graph,
        request_input=request.input,
        precompleted_nodes=all_completed,
        run_edde=run_edde,
        emit=emit,
        call_llm=call_llm,
        log_phase_entered=log_phase_entered,
        log_phase_completed=log_phase_completed,
        cancel_event=cancel_event,
    )
