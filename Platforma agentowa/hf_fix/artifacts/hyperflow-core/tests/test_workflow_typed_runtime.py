import pytest
from httpx import ASGITransport, AsyncClient

import main
from main import app


async def _fake_run_edde(*, prompt, **_kwargs):
    return {"result": {"echo": prompt, "length": len(prompt)}}


@pytest.mark.asyncio
async def test_typed_workflow_runtime_supports_branching_and_join(monkeypatch):
    monkeypatch.setattr(main, "run_edde", _fake_run_edde)
    payload = {
        "workflowId": "wf-typed",
        "name": "typed runtime",
        "input": {"prompt": "alpha"},
        "steps": [
            {"id": "s1", "type": "agent", "name": "Agent", "prompt": "alpha"},
            {"id": "gate", "type": "condition", "name": "Gate", "expression": '"analysis" if results["s1"]["echo"] == "alpha" else "fallback"', "dependsOn": ["s1"]},
            {"id": "branchA", "type": "tool", "name": "Branch A", "action": "echo", "input": {"message": "A"}, "dependsOn": ["gate"]},
            {"id": "branchB", "type": "tool", "name": "Branch B", "action": "echo", "input": {"message": "B"}, "dependsOn": ["gate"]},
            {"id": "join", "type": "join", "name": "Join", "dependsOn": ["branchA", "branchB"]},
        ],
        "edges": [
            {"from": "s1", "to": "gate"},
            {"from": "gate", "to": "branchA", "condition": "analysis"},
            {"from": "gate", "to": "branchB", "condition": "fallback"},
            {"from": "branchA", "to": "join"},
            {"from": "branchB", "to": "join"},
        ],
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post("/v1/workflow/run", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "completed"
    nodes = {node["nodeId"]: node for node in data["nodes"]}
    assert nodes["gate"]["result"]["selected_branches"] == ["analysis"]
    assert nodes["branchA"]["status"] == "succeeded"
    assert nodes["branchB"]["status"] == "skipped"
    assert nodes["join"]["status"] == "succeeded"
    assert list(nodes["join"]["result"]["merged"].keys()) == ["branchA"]


@pytest.mark.asyncio
async def test_typed_workflow_runtime_blocks_on_approval(monkeypatch):
    monkeypatch.setattr(main, "run_edde", _fake_run_edde)
    payload = {
        "workflowId": "wf-approval",
        "name": "approval runtime",
        "steps": [
            {"id": "s1", "type": "agent", "name": "Agent", "prompt": "alpha"},
            {"id": "approve", "type": "approval", "name": "Approve", "reason": "Need operator signoff", "dependsOn": ["s1"]},
            {"id": "after", "type": "tool", "name": "After", "action": "echo", "input": {"ok": True}, "dependsOn": ["approve"]},
        ],
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post("/v1/workflow/run", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "waiting_approval"
    assert data["blockedNodeId"] == "approve"
    assert data["resumabilityReason"] == "pending_approval"
    nodes = {node["nodeId"]: node for node in data["nodes"]}
    assert nodes["approve"]["status"] == "waiting_approval"
    assert nodes["after"]["status"] == "skipped"


@pytest.mark.asyncio
async def test_typed_workflow_runtime_accepts_legacy_prompt_steps(monkeypatch):
    monkeypatch.setattr(main, "run_edde", _fake_run_edde)
    payload = {
        "workflowId": "wf-legacy",
        "name": "legacy runtime",
        "steps": [
            {"id": "s1", "name": "Step 1", "prompt": "first"},
            {"id": "s2", "name": "Step 2", "prompt": "second", "dependsOn": ["s1"]},
        ],
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post("/v1/workflow/run", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "completed"
    assert [node["nodeId"] for node in data["nodes"]] == ["s1", "s2"]


@pytest.mark.asyncio
async def test_typed_workflow_runtime_rejects_demoted_runtime_only_node_types(monkeypatch):
    monkeypatch.setattr(main, "run_edde", _fake_run_edde)
    payload = {
        "workflowId": "wf-unsupported",
        "name": "unsupported runtime",
        "steps": [
            {"id": "mw", "type": "memory-write", "name": "Memory", "key": "x", "value": "y"},
        ],
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post("/v1/workflow/run", json=payload)
    assert response.status_code == 422
    assert "memory-write" in response.text


@pytest.mark.asyncio
async def test_typed_workflow_runtime_emits_routing_and_handoff_and_passes_upstream_handoffs(monkeypatch):
    prompts = []

    async def fake_run_edde_capture(*, prompt, **_kwargs):
        prompts.append(prompt)
        return {"result": {"echo": prompt, "summary": "ok"}}

    monkeypatch.setattr(main, "run_edde", fake_run_edde_capture)
    payload = {
        "workflowId": "wf-handoff",
        "name": "handoff runtime",
        "steps": [
            {
                "id": "planner",
                "type": "agent",
                "name": "Planner",
                "prompt": "Plan the task",
                "requiredCapabilities": ["planning"],
                "handoffContract": {"intent": "plan_handoff", "artifactKeys": ["summary"], "openQuestions": ["Any risks?"], "targetHint": "reviewer"},
                "agentRef": {"id": "agent-planner", "role": "planner", "capabilities": ["planning", "decomposition"], "runPolicy": {"runtimeMode": "delegated", "modelHint": "gpt-routing", "safeConstraintProfile": "strict"}},
            },
            {
                "id": "reviewer",
                "type": "agent",
                "name": "Reviewer",
                "prompt": "Review the plan",
                "dependsOn": ["planner"],
                "agentRef": {"id": "agent-reviewer", "role": "reviewer", "capabilities": ["review"]},
            },
        ],
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post("/v1/workflow/run", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "completed"
    nodes = {node["nodeId"]: node for node in data["nodes"]}
    planner_result = nodes["planner"]["result"]
    assert planner_result["routing"]["role"] == "planner"
    assert planner_result["routing"]["runtimeMode"] == "delegated"
    assert planner_result["routing"]["modelHint"] == "gpt-routing"
    assert planner_result["handoff"]["intent"] == "plan_handoff"
    assert planner_result["handoff"]["artifacts"] == {"summary": "ok"}
    reviewer_prompt = prompts[-1]
    assert "HYPERFLOW ROUTING CONTEXT" in reviewer_prompt
    assert "plan_handoff" in reviewer_prompt
    assert "reviewer" in reviewer_prompt


@pytest.mark.asyncio
async def test_typed_workflow_runtime_rejects_missing_required_capabilities(monkeypatch):
    monkeypatch.setattr(main, "run_edde", _fake_run_edde)
    payload = {
        "workflowId": "wf-routing-mismatch",
        "name": "routing mismatch",
        "steps": [
            {
                "id": "planner",
                "type": "agent",
                "name": "Planner",
                "prompt": "Plan the task",
                "requiredCapabilities": ["planning"],
                "agentRef": {"id": "agent-general", "role": "assistant", "capabilities": ["analysis"]},
            },
        ],
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver") as client:
        response = await client.post("/v1/workflow/run", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "failed"
    assert "missing required capabilities" in data["nodes"][0]["result"]["error"]
