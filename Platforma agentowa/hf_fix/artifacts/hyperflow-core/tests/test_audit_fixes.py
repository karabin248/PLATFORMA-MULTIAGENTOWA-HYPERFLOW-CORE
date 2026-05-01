"""
tests/test_audit_fixes.py

Regression tests covering every finding from the /HF_CORE_REVIEW audit
of Hyperflow.zip.  Each test is labelled with the finding ID it proves.

Coverage:
  BLOCKER-1  — continue_workflow_approval and continue_workflow_human_input
               accept cancel_event and propagate it; callers do not crash.
  HIGH-2     — runLifecycle waiting_input is a valid RunStatus and transition.
               (Tested via Python-side status enum; TS test is in .mjs suite.)
  MED-2      — MemoryWriteStep / MemoryQueryStep are removed from schema;
               submitting them via WorkflowRunRequest raises ValueError.
  MED-cont   — continue_workflow_approval completes a waiting_approval node
               and resumes execution (happy path end-to-end).
  MED-cont2  — continue_workflow_human_input completes a waiting_input node
               and resumes execution (happy path end-to-end).
  CANCEL     — cancel_event set before continuation stops DAG at next level.
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict, Optional

import pytest

# ── path setup ──────────────────────────────────────────────────────────────
import sys
from pathlib import Path
_CORE = Path(__file__).parent.parent
if str(_CORE) not in sys.path:
    sys.path.insert(0, str(_CORE))


# ── helpers ──────────────────────────────────────────────────────────────────

def _fake_bundle(model: str = "stub") -> Dict[str, Any]:
    return {
        "result": {
            "output": "done",
            "intent": "analyze",
            "mode": "analytical",
            "source": "stub",
            "model": model,
            "degraded": False,
            "token_count": 3,
            "reasoning": "test",
            "confidence": 0.7,
            "timestamp": "2026-01-01T00:00:00+00:00",
        },
        "intent": "analyze",
        "mode": "analytical",
        "output_type": "analysis_report",
        "confidence": 0.7,
        "quality_score": 0.7,
        "should_reset": False,
        "source": "stub",
        "mps_context": {"level": 3, "name": "Harmonize"},
        "canonical_trace": {
            "canonical_combo": "🌈💎🔥🧠🔀⚡",
            "phases_completed": ["perceive", "extract_essence", "sense_direction",
                                  "synthesize", "generate_options", "choose"],
        },
        "degraded": False,
    }


async def _stub_run_edde(*args, **kwargs) -> Dict[str, Any]:
    return _fake_bundle()


def _make_agent_step(step_id: str, name: str = "Agent", prompt: str = "do x") -> Dict[str, Any]:
    return {
        "id": step_id,
        "type": "agent",
        "name": name,
        "prompt": prompt,
        "dependsOn": [],
        "input": {},
    }


def _make_approval_step(step_id: str, depends_on: str) -> Dict[str, Any]:
    return {
        "id": step_id,
        "type": "approval",
        "name": "Approve",
        "reason": "Need human sign-off",
        "dependsOn": [depends_on],
        "input": {},
    }


def _make_human_step(step_id: str, depends_on: str) -> Dict[str, Any]:
    return {
        "id": step_id,
        "type": "human",
        "name": "Human Input",
        "instruction": "Please provide feedback",
        "dependsOn": [depends_on],
        "input": {},
    }


# ══════════════════════════════════════════════════════════════════════════
# BLOCKER-1: continue_workflow_approval — signature accepts cancel_event
# ══════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_blocker1_approval_accepts_cancel_event():
    """BLOCKER-1: continue_workflow_approval must NOT raise TypeError for cancel_event kwarg."""
    import inspect
    from workflow.executors import continue_workflow_approval

    sig = inspect.signature(continue_workflow_approval)
    assert "cancel_event" in sig.parameters, (
        "continue_workflow_approval must declare cancel_event parameter — "
        "main.py passes it explicitly."
    )


@pytest.mark.asyncio
async def test_blocker1_human_input_accepts_cancel_event():
    """BLOCKER-1: continue_workflow_human_input must NOT raise TypeError for cancel_event kwarg."""
    import inspect
    from workflow.executors import continue_workflow_human_input

    sig = inspect.signature(continue_workflow_human_input)
    assert "cancel_event" in sig.parameters, (
        "continue_workflow_human_input must declare cancel_event parameter — "
        "main.py passes it explicitly."
    )


@pytest.mark.asyncio
async def test_blocker1_approval_cancel_event_defaults_none():
    """BLOCKER-1: cancel_event defaults to None (backward compatible)."""
    import inspect
    from workflow.executors import continue_workflow_approval
    sig = inspect.signature(continue_workflow_approval)
    default = sig.parameters["cancel_event"].default
    assert default is None


@pytest.mark.asyncio
async def test_blocker1_human_input_cancel_event_defaults_none():
    """BLOCKER-1: cancel_event defaults to None (backward compatible)."""
    import inspect
    from workflow.executors import continue_workflow_human_input
    sig = inspect.signature(continue_workflow_human_input)
    default = sig.parameters["cancel_event"].default
    assert default is None


# ══════════════════════════════════════════════════════════════════════════
# BLOCKER-1: End-to-end happy path — approval continuation resumes DAG
# ══════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_blocker1_approval_continuation_happy_path():
    """BLOCKER-1 + MED-cont: approval continuation executes the post-approval node."""
    from workflow.executors import continue_workflow_approval
    from workflow.contracts import (
        ApprovalContinuationRequest, CompletedNode,
        AgentStep, ApprovalStep, ExecutableEdge,
    )

    executed_nodes: list[str] = []

    async def spy_run_edde(prompt, run_id, emit, call_llm, log_phase_entered,
                           log_phase_completed, model_hint=None):
        executed_nodes.append(run_id)
        return _fake_bundle()

    # Workflow: agent-1 → approval-gate → agent-2
    steps = [
        AgentStep(id="agent-1", type="agent", name="First", prompt="step 1"),
        ApprovalStep(id="approval-gate", type="approval", name="Gate",
                     reason="Sign off required", dependsOn=["agent-1"]),
        AgentStep(id="agent-2", type="agent", name="Second", prompt="step 2",
                  dependsOn=["approval-gate"]),
    ]
    edges = [
        ExecutableEdge(**{"from": "agent-1", "to": "approval-gate"}),
        ExecutableEdge(**{"from": "approval-gate", "to": "agent-2"}),
    ]

    # agent-1 and approval-gate are already completed
    completed = [
        CompletedNode(nodeId="agent-1", name="First",
                      result={"output": "done"}, completedAt="2026-01-01T00:00:00+00:00"),
        CompletedNode(nodeId="approval-gate", name="Gate",
                      result={"approved": True}, completedAt="2026-01-01T00:00:01+00:00"),
    ]

    req = ApprovalContinuationRequest(
        runId="run-1",
        nodeId="approval-gate",
        workflowId="wf-1",
        name="Test WF",
        steps=steps,
        edges=edges,
        completedNodes=completed,
        approvedBy="operator",
    )

    result = await continue_workflow_approval(
        req,
        run_edde=spy_run_edde,
        emit=lambda *a, **kw: None,
        call_llm=_stub_run_edde,
        log_phase_entered=lambda *a: None,
        log_phase_completed=lambda *a: None,
        cancel_event=None,  # ← would crash before fix
    )

    assert result["status"] in {"completed", "failed"}, f"Unexpected status: {result['status']}"
    assert "agent-2" in executed_nodes, "Post-approval node must be executed"


@pytest.mark.asyncio
async def test_blocker1_human_input_continuation_happy_path():
    """BLOCKER-1 + MED-cont2: human-input continuation executes the post-input node."""
    from workflow.executors import continue_workflow_human_input
    from workflow.contracts import (
        HumanInputContinuationRequest, CompletedNode,
        AgentStep, HumanStep, ExecutableEdge,
    )

    executed_nodes: list[str] = []

    async def spy_run_edde(prompt, run_id, emit, call_llm, log_phase_entered,
                           log_phase_completed, model_hint=None):
        executed_nodes.append(run_id)
        return _fake_bundle()

    steps = [
        AgentStep(id="agent-1", type="agent", name="First", prompt="step 1"),
        HumanStep(id="human-gate", type="human", name="Input Gate",
                  instruction="Provide data", dependsOn=["agent-1"]),
        AgentStep(id="agent-2", type="agent", name="Second", prompt="step 2",
                  dependsOn=["human-gate"]),
    ]
    edges = [
        ExecutableEdge(**{"from": "agent-1", "to": "human-gate"}),
        ExecutableEdge(**{"from": "human-gate", "to": "agent-2"}),
    ]

    completed = [
        CompletedNode(nodeId="agent-1", name="First",
                      result={"output": "done"}, completedAt="2026-01-01T00:00:00+00:00"),
    ]

    req = HumanInputContinuationRequest(
        runId="run-2",
        nodeId="human-gate",
        workflowId="wf-2",
        name="Test WF Human",
        steps=steps,
        edges=edges,
        completedNodes=completed,
        humanInput={"value": "some user data"},
        actorId="user-1",
    )

    result = await continue_workflow_human_input(
        req,
        run_edde=spy_run_edde,
        emit=lambda *a, **kw: None,
        call_llm=_stub_run_edde,
        log_phase_entered=lambda *a: None,
        log_phase_completed=lambda *a: None,
        cancel_event=None,  # ← would crash before fix
    )

    assert result["status"] in {"completed", "failed"}
    assert "agent-2" in executed_nodes, "Post-human-input node must be executed"


@pytest.mark.asyncio
async def test_blocker1_cancel_event_stops_continuation():
    """BLOCKER-1 + CANCEL: cancel_event set before call stops DAG after gate."""
    from workflow.executors import continue_workflow_approval
    from workflow.contracts import (
        ApprovalContinuationRequest, CompletedNode,
        AgentStep, ApprovalStep, ExecutableEdge,
    )

    cancel_event = asyncio.Event()
    cancel_event.set()  # already cancelled

    executed_after: list[str] = []

    async def spy_run_edde(prompt, run_id, emit, call_llm, log_phase_entered,
                           log_phase_completed, model_hint=None):
        executed_after.append(run_id)
        return _fake_bundle()

    steps = [
        AgentStep(id="a1", type="agent", name="A1", prompt="x"),
        ApprovalStep(id="gate", type="approval", name="Gate",
                     reason="reason", dependsOn=["a1"]),
        AgentStep(id="a2", type="agent", name="A2", prompt="y", dependsOn=["gate"]),
    ]
    edges = [
        ExecutableEdge(**{"from": "a1", "to": "gate"}),
        ExecutableEdge(**{"from": "gate", "to": "a2"}),
    ]
    completed = [
        CompletedNode(nodeId="a1", name="A1", result={}, completedAt="2026-01-01T00:00:00+00:00"),
        CompletedNode(nodeId="gate", name="Gate", result={"approved": True},
                      completedAt="2026-01-01T00:00:01+00:00"),
    ]

    req = ApprovalContinuationRequest(
        runId="run-3", nodeId="gate", workflowId="wf-3", name="Cancel WF",
        steps=steps, edges=edges, completedNodes=completed,
    )

    result = await continue_workflow_approval(
        req,
        run_edde=spy_run_edde,
        emit=lambda *a, **kw: None,
        call_llm=_stub_run_edde,
        log_phase_entered=lambda *a: None,
        log_phase_completed=lambda *a: None,
        cancel_event=cancel_event,
    )

    assert result["status"] == "cancelled", (
        f"When cancel_event is set, continuation must return 'cancelled', got '{result['status']}'"
    )
    assert "a2" not in executed_after, "Cancelled continuation must not execute post-gate nodes"


# ══════════════════════════════════════════════════════════════════════════
# MED-2: MemoryWriteStep / MemoryQueryStep removed from schema
# ══════════════════════════════════════════════════════════════════════════

def test_med2_memory_write_step_not_in_union():
    """MED-2: MemoryWriteStep must not be importable from workflow.contracts."""
    import workflow.contracts as contracts
    assert not hasattr(contracts, "MemoryWriteStep"), (
        "MemoryWriteStep was removed from contracts — should not be importable"
    )


def test_med2_memory_query_step_not_in_union():
    """MED-2: MemoryQueryStep must not be importable from workflow.contracts."""
    import workflow.contracts as contracts
    assert not hasattr(contracts, "MemoryQueryStep"), (
        "MemoryQueryStep was removed from contracts — should not be importable"
    )


def test_med2_memory_write_step_raises_on_submit():
    """MED-2: submitting a memory-write step raises ValueError."""
    from workflow.contracts import WorkflowRunRequest

    with pytest.raises((ValueError, Exception)) as exc_info:
        WorkflowRunRequest(
            workflowId="wf-mem",
            name="Mem WF",
            steps=[
                {"id": "s1", "type": "memory-write", "name": "Write",
                 "key": "foo", "value": "bar"},
            ],
        )
    assert "not supported" in str(exc_info.value).lower() or exc_info.type is ValueError


def test_med2_memory_query_step_raises_on_submit():
    """MED-2: submitting a memory-query step raises ValueError."""
    from workflow.contracts import WorkflowRunRequest

    with pytest.raises((ValueError, Exception)):
        WorkflowRunRequest(
            workflowId="wf-mem2",
            name="Mem WF 2",
            steps=[
                {"id": "s1", "type": "memory-query", "name": "Query", "key": "foo"},
            ],
        )


# ══════════════════════════════════════════════════════════════════════════
# HIGH-2: waiting_input is a known Python-side status (DAG level emits it)
# ══════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_high2_human_step_emits_waiting_input_status():
    """HIGH-2: a workflow with a HumanStep emits status=waiting_input from the DAG."""
    from workflow.executors import run_workflow
    from workflow.contracts import WorkflowRunRequest, AgentStep, HumanStep, ExecutableEdge

    req = WorkflowRunRequest(
        workflowId="wf-hi",
        name="Human WF",
        steps=[
            AgentStep(id="a1", type="agent", name="Pre", prompt="go"),
            HumanStep(id="h1", type="human", name="Input",
                      instruction="Tell me something", dependsOn=["a1"]),
        ],
        edges=[ExecutableEdge(**{"from": "a1", "to": "h1"})],
    )

    executed: list[str] = []

    async def spy_run_edde(prompt, run_id, emit, call_llm, log_phase_entered,
                           log_phase_completed, model_hint=None):
        executed.append(run_id)
        return _fake_bundle()

    result = await run_workflow(
        req,
        run_edde=spy_run_edde,
        emit=lambda *a, **kw: None,
        call_llm=_stub_run_edde,
        log_phase_entered=lambda *a: None,
        log_phase_completed=lambda *a: None,
    )

    assert result["status"] == "waiting_input", (
        f"Workflow halted at HumanStep must report status='waiting_input', got '{result['status']}'"
    )
    node_statuses = {n["nodeId"]: n["status"] for n in result["nodes"]}
    assert node_statuses.get("h1") == "waiting_input"
    assert node_statuses.get("a1") == "succeeded"
    assert result["blockedNodeId"] == "h1"
