"""
Tests for workflow resume behaviour with checkpointId boundary semantics in the Python core.

These tests cover the minimal checkpoint-aware semantics introduced in
Special Mission #6.  The Python core now interprets the optional
`checkpointId` on resume requests as the identifier of the last completed
node.  The resume handler will reject incoherent combinations of
`checkpointId` and `completedNodes` (e.g., non‑contiguous prefixes or
mismatched boundary IDs) and will return a new checkpointId reflecting the
latest node executed.

We use httpx.AsyncClient with ASGITransport to run the FastAPI app in memory.
"""

import pytest
from httpx import AsyncClient, ASGITransport

from main import app


async def _run_two_step_workflow(client):
    """Helper to run a simple two-step workflow and return the response json."""
    steps = [
        {"id": "s1", "name": "Step 1", "prompt": "1", "dependsOn": []},
        {"id": "s2", "name": "Step 2", "prompt": "2", "dependsOn": ["s1"]},
    ]
    run_resp = await client.post(
        "/v1/workflow/run",
        json={"workflowId": "wf-checkpoint", "name": "test wf", "steps": steps},
    )
    assert run_resp.status_code == 200
    return run_resp.json(), steps


@pytest.mark.asyncio
async def test_workflow_resume_with_valid_checkpoint_boundary():
    """Resuming with a checkpointId equal to the last completed node should succeed.

    After resuming, the response checkpointId should advance to the last
    executed node in the resumed run (s2).
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        run_data, steps = await _run_two_step_workflow(client)
        # Mark the first node as completed for the resume request
        first_node = run_data["nodes"][0]
        completed_nodes = [
            {
                "nodeId": first_node["nodeId"],
                "name": first_node["name"],
                "result": first_node.get("result"),
                "startedAt": first_node.get("startedAt"),
                "completedAt": first_node.get("completedAt"),
            }
        ]
        # Use the node's ID as the checkpoint boundary
        resume_request = {
            "runId": run_data["runId"],
            "workflowId": "wf-checkpoint",
            "name": "test wf",
            "steps": steps,
            "completedNodes": completed_nodes,
            "checkpointId": first_node["nodeId"],
        }
        resume_resp = await client.post("/v1/workflow/resume", json=resume_request)
        assert resume_resp.status_code == 200
        resume_data = resume_resp.json()
        # The response should indicate success
        assert resume_data["status"] == "completed"
        # The new checkpoint boundary should be the identifier of the last node executed (s2)
        assert resume_data.get("checkpointId") == "s2"


@pytest.mark.asyncio
async def test_workflow_resume_rejects_mismatched_checkpoint():
    """Resuming with a checkpointId that does not match the last completed node should fail."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        run_data, steps = await _run_two_step_workflow(client)
        # Completed only the first node, but specify the second node as the checkpoint
        first_node = run_data["nodes"][0]
        completed_nodes = [
            {
                "nodeId": first_node["nodeId"],
                "name": first_node["name"],
                "result": first_node.get("result"),
                "startedAt": first_node.get("startedAt"),
                "completedAt": first_node.get("completedAt"),
            }
        ]
        resume_request = {
            "runId": run_data["runId"],
            "workflowId": "wf-checkpoint",
            "name": "test wf",
            "steps": steps,
            "completedNodes": completed_nodes,
            "checkpointId": "s2",  # Mismatched: s2 is not yet completed
        }
        resume_resp = await client.post("/v1/workflow/resume", json=resume_request)
        # The HTTP status remains 200 but the returned status field should be 'failed'
        assert resume_resp.status_code == 200
        resume_data = resume_resp.json()
        assert resume_data["status"] == "failed"
        assert "Checkpoint" in resume_data["error"]


@pytest.mark.asyncio
async def test_workflow_resume_rejects_non_contiguous_completed_nodes():
    """Resuming with non‑contiguous completedNodes should fail.

    If a later node is marked completed without completing its dependency, the
    request must be rejected.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        run_data, steps = await _run_two_step_workflow(client)
        # Intentionally mark only the second node as completed, skipping its dependency
        second_node = run_data["nodes"][1]
        completed_nodes = [
            {
                "nodeId": second_node["nodeId"],
                "name": second_node["name"],
                "result": second_node.get("result"),
                "startedAt": second_node.get("startedAt"),
                "completedAt": second_node.get("completedAt"),
            }
        ]
        resume_request = {
            "runId": run_data["runId"],
            "workflowId": "wf-checkpoint",
            "name": "test wf",
            "steps": steps,
            "completedNodes": completed_nodes,
            "checkpointId": second_node["nodeId"],
        }
        resume_resp = await client.post("/v1/workflow/resume", json=resume_request)
        assert resume_resp.status_code == 200
        resume_data = resume_resp.json()
        assert resume_data["status"] == "failed"
        assert "contiguous" in resume_data["error"] or "Completed node" in resume_data["error"]


@pytest.mark.asyncio
async def test_workflow_resume_without_checkpoint_computes_boundary():
    """When checkpointId is omitted, the resume endpoint should still compute a new boundary.

    The response checkpointId should equal the last node executed (s2).  This test
    confirms that the default semantics match the explicit boundary case.
    """
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        run_data, steps = await _run_two_step_workflow(client)
        first_node = run_data["nodes"][0]
        completed_nodes = [
            {
                "nodeId": first_node["nodeId"],
                "name": first_node["name"],
                "result": first_node.get("result"),
                "startedAt": first_node.get("startedAt"),
                "completedAt": first_node.get("completedAt"),
            }
        ]
        resume_request = {
            "runId": run_data["runId"],
            "workflowId": "wf-checkpoint",
            "name": "test wf",
            "steps": steps,
            "completedNodes": completed_nodes,
            # No checkpointId provided
        }
        resume_resp = await client.post("/v1/workflow/resume", json=resume_request)
        assert resume_resp.status_code == 200
        resume_data = resume_resp.json()
        assert resume_data["status"] == "completed"
        # Should compute boundary as s2
        assert resume_data.get("checkpointId") == "s2"