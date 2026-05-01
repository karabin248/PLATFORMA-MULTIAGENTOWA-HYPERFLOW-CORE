"""
test_patch_p1_p3_p4.py — Regression tests for patches P1, P3, P4.

P1: CompensationStep is routed by execute_step() → _execute_compensation()
    and is accepted by WorkflowRunRequest validation.

P3: _run_step() enforces per-step timeout via asyncio.wait_for().
    Timeout source priority: retryPolicy.timeoutSeconds → HYPERFLOW_STEP_TIMEOUT_S → 300s.

P4: /v1/repositories/scan returns 503 SCANNER_DISABLED when
    HYPERFLOW_SCANNER_ENABLED env var is absent or not "true".
"""
import asyncio
import os

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

import main
from main import app
from workflow.contracts import (
    AgentStep,
    CompensationStep,
    ExecutableWorkflowStep,
    WorkflowRunRequest,
    _normalize_step_payload,
)
from workflow.executors import execute_step


# ---------------------------------------------------------------------------
# Shared no-op helpers
# ---------------------------------------------------------------------------

async def _noop_run_edde(*, prompt, **_):
    return {"result": {"echo": prompt}}

async def _noop_call_llm(*_, **__):
    return {"text": "stub"}

def _noop_emit(*_, **__):
    pass

def _noop_log(*_, **__):
    pass


# ---------------------------------------------------------------------------
# P1-A  CompensationStep is a member of ExecutableWorkflowStep Union
# ---------------------------------------------------------------------------

def test_p1_compensation_in_union():
    """
    CompensationStep must be in ExecutableWorkflowStep Union after P1.
    Before the patch it was absent; Pydantic would reject compensation
    nodes at validation time.
    """
    import typing
    args = typing.get_args(ExecutableWorkflowStep)
    names = [a.__name__ for a in args]
    assert "CompensationStep" in names, (
        f"CompensationStep missing from ExecutableWorkflowStep Union. Got: {names}"
    )


# ---------------------------------------------------------------------------
# P1-B  _normalize_step_payload passes compensation through
# ---------------------------------------------------------------------------

def test_p1_normalize_passes_compensation():
    """
    _normalize_step_payload() must not raise for type='compensation'
    after P1 removes it from the rejection guard.
    """
    result = _normalize_step_payload({
        "id": "c1",
        "name": "compensate_step_a",
        "type": "compensation",
        "targetNodeId": "step-a",
        "dependsOn": ["step-a"],
    })
    assert result["type"] == "compensation"
    assert result["targetNodeId"] == "step-a"
    assert result.get("strategy") == "record"  # default filled by normalization


# ---------------------------------------------------------------------------
# P1-C  memory-write / memory-query are STILL rejected by guard
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("bad_type", ["memory-write", "memory-query", "parallel"])
def test_p1_guard_still_rejects_unsupported_types(bad_type):
    """
    Guard must continue to reject memory-write, memory-query, parallel
    after P1 (only compensation was removed from the guard set).
    """
    with pytest.raises(ValueError, match="not supported by the runtime executor"):
        _normalize_step_payload({
            "id": "x1", "name": "x", "type": bad_type,
            "key": "k", "value": "v", "dependsOn": [],
        })


# ---------------------------------------------------------------------------
# P1-D  WorkflowRunRequest accepts a compensation step
# ---------------------------------------------------------------------------

def test_p1_workflow_run_request_accepts_compensation():
    """
    WorkflowRunRequest with a compensation node must parse without error.
    """
    req = WorkflowRunRequest(
        workflowId="wf-comp",
        name="test compensation",
        steps=[
            {
                "id": "step-a",
                "name": "first agent",
                "type": "agent",
                "prompt": "do something",
                "dependsOn": [],
            },
            {
                "id": "comp-1",
                "name": "compensate step-a",
                "type": "compensation",
                "targetNodeId": "step-a",
                "dependsOn": ["step-a"],
            },
        ],
        edges=[
            {"from": "step-a", "to": "comp-1"},
        ],
    )
    assert len(req.steps) == 2
    assert req.steps[1].type == "compensation"
    assert req.steps[1].targetNodeId == "step-a"  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# P1-E  execute_step() dispatches compensation → _execute_compensation()
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_p1_execute_step_dispatches_compensation():
    """
    execute_step() must route a CompensationStep to _execute_compensation()
    and return status='compensated' with target result from state.
    """
    step = CompensationStep(
        id="comp-1",
        name="compensate_step_a",
        type="compensation",
        targetNodeId="step-a",
        strategy="record",
        dependsOn=["step-a"],
    )
    state = {
        "node_results": {"step-a": {"output": "previous_result", "score": 0.9}},
        "node_status": {"step-a": "succeeded"},
        "selected_branches": {},
        "active_nodes": {"step-a": True},
        "node_handoffs": {},
        "memory": {},
        "request_input": {},
    }

    result = await execute_step(
        step,
        state=state,
        active_parents=["step-a"],
        run_edde=_noop_run_edde,
        emit=_noop_emit,
        call_llm=_noop_call_llm,
        log_phase_entered=_noop_log,
        log_phase_completed=_noop_log,
    )

    assert result["nodeId"] == "comp-1"
    assert result["status"] == "compensated"
    assert result["result"]["targetNodeId"] == "step-a"
    assert result["result"]["strategy"] == "record"
    assert result["result"]["targetResult"] == {"output": "previous_result", "score": 0.9}


@pytest.mark.asyncio
async def test_p1_compensation_with_missing_target_returns_none():
    """
    If targetNodeId is not in state (target not yet run), compensation
    must still succeed — targetResult is None, not an exception.
    """
    step = CompensationStep(
        id="comp-orphan",
        name="orphan compensation",
        type="compensation",
        targetNodeId="nonexistent-step",
        strategy="record",
        dependsOn=[],
    )
    state = {
        "node_results": {},
        "node_status": {},
        "selected_branches": {},
        "active_nodes": {},
        "node_handoffs": {},
        "memory": {},
        "request_input": {},
    }

    result = await execute_step(
        step,
        state=state,
        active_parents=[],
        run_edde=_noop_run_edde,
        emit=_noop_emit,
        call_llm=_noop_call_llm,
        log_phase_entered=_noop_log,
        log_phase_completed=_noop_log,
    )

    assert result["status"] == "compensated"
    assert result["result"]["targetResult"] is None


# ---------------------------------------------------------------------------
# P1-F  Full workflow run with compensation node (API-level)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_p1_workflow_run_with_compensation_via_api(monkeypatch):
    """
    POST /v1/workflow/run with an agent + downstream compensation node
    must return status='completed' with the compensation node showing
    status='compensated'.
    """
    monkeypatch.setattr(main, "run_edde", _noop_run_edde)
    monkeypatch.setenv("HYPERFLOW_CORE_TOKEN", "")  # dev mode — no token required

    payload = {
        "workflowId": "wf-with-compensation",
        "name": "agent then compensate",
        "input": {},
        "steps": [
            {"id": "s1", "type": "agent", "name": "Agent", "prompt": "do work", "dependsOn": []},
            {"id": "comp-s1", "type": "compensation", "name": "Compensate S1",
             "targetNodeId": "s1", "strategy": "record", "dependsOn": ["s1"]},
        ],
        "edges": [{"from": "s1", "to": "comp-s1"}],
    }

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.post("/v1/workflow/run", json=payload)

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["status"] == "completed"
    nodes = {n["nodeId"]: n for n in data["nodes"]}
    assert nodes["s1"]["status"] == "succeeded"
    assert nodes["comp-s1"]["status"] == "compensated"
    assert nodes["comp-s1"]["result"]["targetNodeId"] == "s1"


# ---------------------------------------------------------------------------
# P3-A  retryPolicy.timeoutSeconds is enforced
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_p3_step_timeout_from_retry_policy(monkeypatch):
    """
    A step with retryPolicy.timeoutSeconds=0.05 must be cancelled and return
    failed_terminal with an error message containing 'exceeded timeout'.
    """
    async def _hanging_run_edde(*, prompt, **_):
        await asyncio.sleep(10)  # never completes within test budget
        return {"result": {}}  # pragma: no cover

    monkeypatch.setattr(main, "run_edde", _hanging_run_edde)
    monkeypatch.setenv("HYPERFLOW_CORE_TOKEN", "")

    payload = {
        "workflowId": "wf-timeout-retry-policy",
        "name": "timeout via retryPolicy",
        "input": {},
        "steps": [
            {
                "id": "slow-agent",
                "type": "agent",
                "name": "Slow Agent",
                "prompt": "hang forever",
                "retryPolicy": {"timeoutSeconds": 0.05},
                "dependsOn": [],
            },
        ],
        "edges": [],
    }

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.post("/v1/workflow/run", json=payload)

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["status"] == "failed"
    nodes = {n["nodeId"]: n for n in data["nodes"]}
    assert nodes["slow-agent"]["status"] == "failed_terminal"
    assert "exceeded timeout" in nodes["slow-agent"]["result"]["error"]
    assert "0.05" in nodes["slow-agent"]["result"]["error"]


@pytest.mark.asyncio
async def test_p3_step_timeout_from_env(monkeypatch):
    """
    When retryPolicy is absent, HYPERFLOW_STEP_TIMEOUT_S env var is used.
    A step that sleeps longer than the env timeout must return failed_terminal.
    """
    async def _hanging_run_edde(*, prompt, **_):
        await asyncio.sleep(10)
        return {"result": {}}  # pragma: no cover

    monkeypatch.setattr(main, "run_edde", _hanging_run_edde)
    monkeypatch.setenv("HYPERFLOW_CORE_TOKEN", "")
    monkeypatch.setenv("HYPERFLOW_STEP_TIMEOUT_S", "0.05")

    payload = {
        "workflowId": "wf-timeout-env",
        "name": "timeout via env",
        "input": {},
        "steps": [
            {
                "id": "slow-env",
                "type": "agent",
                "name": "Slow (env timeout)",
                "prompt": "hang",
                "dependsOn": [],
                # no retryPolicy — falls back to HYPERFLOW_STEP_TIMEOUT_S
            },
        ],
        "edges": [],
    }

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.post("/v1/workflow/run", json=payload)

    assert response.status_code == 200, response.text
    data = response.json()
    nodes = {n["nodeId"]: n for n in data["nodes"]}
    assert nodes["slow-env"]["status"] == "failed_terminal"
    assert "exceeded timeout" in nodes["slow-env"]["result"]["error"]


@pytest.mark.asyncio
async def test_p3_timeout_only_kills_slow_node_not_siblings(monkeypatch):
    """
    In a fan-out level, a timeout on one node must not prevent sibling nodes
    on the same topological level from completing. asyncio.gather() must
    continue after a TimeoutError in one task.
    """
    call_log = []

    async def _selective_run_edde(*, prompt, **_):
        if prompt == "hang":
            await asyncio.sleep(10)
        call_log.append(prompt)
        return {"result": {"echo": prompt}}

    monkeypatch.setattr(main, "run_edde", _selective_run_edde)
    monkeypatch.setenv("HYPERFLOW_CORE_TOKEN", "")

    payload = {
        "workflowId": "wf-fanout-timeout",
        "name": "fanout with one slow node",
        "input": {},
        "steps": [
            {"id": "fast-1", "type": "agent", "name": "Fast 1", "prompt": "fast",
             "dependsOn": []},
            {"id": "slow-1", "type": "agent", "name": "Slow 1", "prompt": "hang",
             "retryPolicy": {"timeoutSeconds": 0.05}, "dependsOn": []},
            {"id": "fast-2", "type": "agent", "name": "Fast 2", "prompt": "fast2",
             "dependsOn": []},
        ],
        "edges": [],
    }

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.post("/v1/workflow/run", json=payload)

    assert response.status_code == 200, response.text
    data = response.json()
    nodes = {n["nodeId"]: n for n in data["nodes"]}

    assert nodes["slow-1"]["status"] == "failed_terminal"
    assert nodes["fast-1"]["status"] == "succeeded"
    assert nodes["fast-2"]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_p3_step_within_timeout_completes_normally(monkeypatch):
    """
    A step that completes before the timeout must not be interrupted.
    """
    monkeypatch.setattr(main, "run_edde", _noop_run_edde)
    monkeypatch.setenv("HYPERFLOW_CORE_TOKEN", "")

    payload = {
        "workflowId": "wf-fast",
        "name": "fast step within timeout",
        "input": {},
        "steps": [
            {
                "id": "fast",
                "type": "agent",
                "name": "Fast",
                "prompt": "quick",
                "retryPolicy": {"timeoutSeconds": 30},
                "dependsOn": [],
            }
        ],
        "edges": [],
    }

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.post("/v1/workflow/run", json=payload)

    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "completed"
    assert data["nodes"][0]["status"] == "succeeded"


# ---------------------------------------------------------------------------
# P4-A  Scanner returns 503 when HYPERFLOW_SCANNER_ENABLED is unset
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_p4_scanner_disabled_when_env_unset(monkeypatch):
    """
    POST /v1/repositories/scan must return 503 SCANNER_DISABLED when
    HYPERFLOW_SCANNER_ENABLED is not set.
    """
    monkeypatch.delenv("HYPERFLOW_SCANNER_ENABLED", raising=False)
    monkeypatch.setenv("HYPERFLOW_CORE_TOKEN", "")

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.post(
            "/v1/repositories/scan",
            json={"repositories": [{"id": "r1", "name": "repo", "url": "https://github.com/test/repo"}]},
        )

    assert response.status_code == 503
    detail = response.json()["detail"]
    assert detail["code"] == "SCANNER_DISABLED"
    assert "HYPERFLOW_SCANNER_ENABLED" in detail["reason"]


@pytest.mark.asyncio
async def test_p4_scanner_disabled_when_env_false(monkeypatch):
    """
    POST /v1/repositories/scan must return 503 when
    HYPERFLOW_SCANNER_ENABLED is explicitly set to 'false'.
    """
    monkeypatch.setenv("HYPERFLOW_SCANNER_ENABLED", "false")
    monkeypatch.setenv("HYPERFLOW_CORE_TOKEN", "")

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.post(
            "/v1/repositories/scan",
            json={"repositories": [{"id": "r1", "name": "repo", "url": "https://github.com/test/repo"}]},
        )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "SCANNER_DISABLED"


@pytest.mark.asyncio
async def test_p4_scanner_passes_gate_when_enabled(monkeypatch):
    """
    When HYPERFLOW_SCANNER_ENABLED='true', the request must NOT return 503.
    It may fail for other reasons (network unavailable in CI) but must pass
    the feature-flag gate.
    """
    monkeypatch.setenv("HYPERFLOW_SCANNER_ENABLED", "true")
    monkeypatch.setenv("HYPERFLOW_CORE_TOKEN", "")

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        response = await client.post(
            "/v1/repositories/scan",
            json={"repositories": [{"id": "r1", "name": "repo", "url": "https://github.com/test/repo"}]},
        )

    # Must NOT be SCANNER_DISABLED — any other response is acceptable here
    assert response.status_code != 503 or response.json().get("detail", {}).get("code") != "SCANNER_DISABLED"


# ---------------------------------------------------------------------------
# P2 — Dead normalization branches are gone (no memory-write / memory-query
#       elif blocks reachable after the guard raise)
# ---------------------------------------------------------------------------

def test_p2_memory_write_error_message_updated():
    """
    The rejection error message for memory-write must contain the new
    descriptive text from the updated guard (not the old terse string).
    """
    with pytest.raises(ValueError) as exc_info:
        _normalize_step_payload({
            "id": "m1", "name": "mem", "type": "memory-write",
            "key": "k", "value": "v", "dependsOn": [],
        })
    msg = str(exc_info.value)
    assert "not supported by the runtime executor" in msg, (
        f"Expected updated error message, got: {msg}"
    )


def test_p2_memory_query_error_message_updated():
    """Same as above for memory-query."""
    with pytest.raises(ValueError, match="not supported by the runtime executor"):
        _normalize_step_payload({
            "id": "mq1", "name": "mq", "type": "memory-query",
            "key": "k", "dependsOn": [],
        })
