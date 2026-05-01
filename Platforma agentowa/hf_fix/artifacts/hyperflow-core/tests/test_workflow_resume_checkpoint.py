"""
Tests for workflow resume behaviour with checkpointId support in the Python core.

These tests exercise the minimal checkpoint-aware resume semantics added in
Special Mission #5.  The Python core should accept an optional `checkpointId`
field on the workflow resume request and echo it back in the response, without
altering execution semantics.  This allows the API layer to forward
checkpoint identifiers once they have been validated.

We use httpx.AsyncClient with ASGITransport to run the FastAPI app in memory.
"""

import pytest
from httpx import AsyncClient, ASGITransport

from main import app


@pytest.mark.asyncio
async def test_workflow_resume_echoes_checkpoint_id():
    """The resume endpoint should accept and echo the checkpointId field."""
    # Define a simple two-step workflow
    steps = [
        {"id": "s1", "name": "Step 1", "prompt": "1", "dependsOn": []},
        {"id": "s2", "name": "Step 2", "prompt": "2", "dependsOn": ["s1"]},
    ]
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        # Run the workflow to obtain a runId and initial node outputs
        run_resp = await client.post(
            "/v1/workflow/run",
            json={"workflowId": "wf-checkpoint", "name": "test wf", "steps": steps},
        )
        assert run_resp.status_code == 200
        run_data = run_resp.json()
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
        # Construct a resume request with an explicit checkpointId
        resume_request = {
            "runId": run_data["runId"],
            "workflowId": "wf-checkpoint",
            "name": "test wf",
            "steps": steps,
            "completedNodes": completed_nodes,
            "checkpointId": "chk-test",
        }
        resume_resp = await client.post("/v1/workflow/resume", json=resume_request)
        assert resume_resp.status_code == 200
        resume_data = resume_resp.json()
        # The checkpointId should be echoed back unchanged
        assert resume_data.get("checkpointId") == "chk-test"
