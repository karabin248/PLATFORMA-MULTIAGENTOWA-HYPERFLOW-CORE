"""
test_workflow_cancel_event.py

EX-1 regression tests: cancel_event stops workflow execution at DAG level
boundaries without corrupting already-completed node results.

Guarantees:
- cancel_event.set() before a level executes → all remaining nodes → "cancelled"
- cancel_event not set → normal execution, no interference
- already-started level completes fully (cancel only gates next level)
- status returned is "cancelled" with resumabilityReason="terminal"
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List

import pytest

from workflow.contracts import WorkflowRunRequest, WorkflowResumeRequest
from workflow.executors import run_workflow, resume_workflow


# ---------------------------------------------------------------------------
# Minimal mock run_edde — returns stub bundle, signals cancel after first call
# ---------------------------------------------------------------------------

def _make_stub_bundle(node_id: str) -> Dict[str, Any]:
    return {
        "result": {"output": f"ok:{node_id}"},
        "intent": "process",
        "mode": "analytical",
        "output_type": "text",
        "confidence": 0.8,
        "quality_score": 0.8,
        "should_reset": False,
        "source": "stub",
        "mps_context": {"level": 1, "name": "focused", "max_candidates": 3, "llm_temperature": 0.7},
        "phases": {},
        "canonical_trace": {
            "phases_completed": ["perceive","extract_essence","sense_direction",
                                 "synthesize","generate_options","choose"],
            "order_preserved": True,
            "canonical_combo_detected": False,
            "terminal_phase": "choose",
            "cycle_version": "1.0",
            "mps_level": 1,
            "mps_name": "focused",
            "canonical_combo": "🌈💎🔥🧠🔀⚡",
            "canonical_phases": ["perceive","extract_essence","sense_direction",
                                  "synthesize","generate_options","choose"],
        },
        "degraded": False,
    }


def _null_emit(*a: Any, **kw: Any) -> None:
    pass


def _null_phase(*a: Any) -> None:
    pass


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestCancelEvent:

    @pytest.mark.asyncio
    async def test_cancel_before_second_level_stops_execution(self):
        """Set cancel after step_a; step_b must be cancelled, not executed."""
        cancel_event = asyncio.Event()
        executed: List[str] = []

        async def _mock_run_edde(prompt, run_id, emit, call_llm,
                                  log_phase_entered, log_phase_completed,
                                  model_hint=None):
            executed.append(run_id)
            cancel_event.set()          # signal after first node
            return _make_stub_bundle(run_id)

        req = WorkflowRunRequest(
            workflowId="test-cancel-two-level",
            name="cancel test",
            steps=[
                {"id": "a", "type": "agent", "name": "A",
                 "prompt": "do A", "dependsOn": []},
                {"id": "b", "type": "agent", "name": "B",
                 "prompt": "do B", "dependsOn": ["a"]},
            ],
            edges=[],
        )

        result = await run_workflow(
            req,
            run_edde=_mock_run_edde,
            emit=_null_emit,
            call_llm=None,
            log_phase_entered=_null_phase,
            log_phase_completed=_null_phase,
            cancel_event=cancel_event,
        )

        assert result["status"] == "cancelled", f"expected cancelled, got {result['status']}"
        assert result["resumabilityReason"] == "terminal"
        assert "a" in executed
        assert "b" not in executed, "step_b must not have executed after cancel"

        node_map = {n["nodeId"]: n["status"] for n in result["nodes"]}
        assert node_map["b"] == "cancelled"

    @pytest.mark.asyncio
    async def test_no_cancel_event_runs_fully(self):
        """Without cancel_event, all nodes complete normally."""
        executed: List[str] = []

        async def _mock_run_edde(prompt, run_id, emit, call_llm,
                                  log_phase_entered, log_phase_completed,
                                  model_hint=None):
            executed.append(run_id)
            return _make_stub_bundle(run_id)

        req = WorkflowRunRequest(
            workflowId="test-no-cancel",
            name="full run",
            steps=[
                {"id": "x", "type": "agent", "name": "X",
                 "prompt": "do X", "dependsOn": []},
                {"id": "y", "type": "agent", "name": "Y",
                 "prompt": "do Y", "dependsOn": ["x"]},
            ],
            edges=[],
        )

        result = await run_workflow(
            req,
            run_edde=_mock_run_edde,
            emit=_null_emit,
            call_llm=None,
            log_phase_entered=_null_phase,
            log_phase_completed=_null_phase,
            cancel_event=None,
        )

        assert result["status"] == "completed"
        assert set(executed) == {"x", "y"}

    @pytest.mark.asyncio
    async def test_cancel_before_any_level_skips_all(self):
        """Pre-set cancel_event → all nodes cancelled, nothing executed."""
        cancel_event = asyncio.Event()
        cancel_event.set()              # set BEFORE run

        executed: List[str] = []

        async def _mock_run_edde(prompt, run_id, emit, call_llm,
                                  log_phase_entered, log_phase_completed,
                                  model_hint=None):
            executed.append(run_id)
            return _make_stub_bundle(run_id)

        req = WorkflowRunRequest(
            workflowId="test-pre-cancel",
            name="pre-cancel",
            steps=[
                {"id": "p", "type": "agent", "name": "P",
                 "prompt": "do P", "dependsOn": []},
            ],
            edges=[],
        )

        result = await run_workflow(
            req,
            run_edde=_mock_run_edde,
            emit=_null_emit,
            call_llm=None,
            log_phase_entered=_null_phase,
            log_phase_completed=_null_phase,
            cancel_event=cancel_event,
        )

        assert result["status"] == "cancelled"
        assert executed == [], "no steps should execute when cancel is pre-set"
        node_map = {n["nodeId"]: n["status"] for n in result["nodes"]}
        assert node_map["p"] == "cancelled"

    @pytest.mark.asyncio
    async def test_cancel_not_set_is_backward_compatible(self):
        """Omitting cancel_event entirely does not break existing callers."""
        req = WorkflowRunRequest(
            workflowId="test-compat",
            name="compat",
            steps=[
                {"id": "c", "type": "agent", "name": "C",
                 "prompt": "do C", "dependsOn": []},
            ],
            edges=[],
        )

        async def _mock(prompt, run_id, emit, call_llm,
                        log_phase_entered, log_phase_completed,
                        model_hint=None):
            return _make_stub_bundle(run_id)

        result = await run_workflow(
            req,
            run_edde=_mock,
            emit=_null_emit,
            call_llm=None,
            log_phase_entered=_null_phase,
            log_phase_completed=_null_phase,
            # cancel_event omitted intentionally
        )
        assert result["status"] == "completed"
