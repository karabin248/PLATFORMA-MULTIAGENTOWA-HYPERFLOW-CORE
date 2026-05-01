"""
Integration tests: checkpoint/resume lifecycle.

Resume path: POST /runs/:id/resume
Semantics: same runId preserved, completed nodes immutable, atomic claim.
"""

import time
import pytest


def poll_run_status(api, run_id: str, target_statuses: list[str], timeout: float = 15.0, interval: float = 0.25) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        resp = api.get(f"/runs/{run_id}/status")
        if resp.status_code == 200:
            data = resp.json().get("data", {})
            if data.get("status") in target_statuses:
                return data
        time.sleep(interval)
    resp = api.get(f"/runs/{run_id}/status")
    return resp.json().get("data", {})


class TestResumeFromCheckpoint:
    def test_resume_nonexistent_run_returns_404(self, api):
        """POST /runs/nonexistent/resume returns 404."""
        resp = api.post("/runs/run-does-not-exist/resume")
        assert resp.status_code == 404, resp.text

    def test_resume_completed_run_returns_409(self, api):
        """POST /runs/:id/resume on a completed run returns 409."""
        resp = api.post("/workflows/run", json={"workflowId": "workflow-analysis-pipeline"})
        assert resp.status_code == 200, resp.text
        run_id = resp.json()["data"]["runId"]

        final = poll_run_status(api, run_id, ["completed", "failed"], timeout=15.0)
        if final.get("status") != "completed":
            pytest.skip("Run did not complete successfully")

        resume_resp = api.post(f"/runs/{run_id}/resume")
        assert resume_resp.status_code == 409, resume_resp.text

    def test_resume_preserves_run_id(self, api):
        """Resume continues the same runId (no new run created)."""
        resp = api.post("/workflows/run", json={"workflowId": "workflow-analysis-pipeline"})
        assert resp.status_code == 200, resp.text
        run_id = resp.json()["data"]["runId"]

        final = poll_run_status(api, run_id, ["completed", "failed"], timeout=15.0)
        if final.get("status") != "failed":
            pytest.skip("Run did not fail — no checkpoint to resume from")

        resume_resp = api.post(f"/runs/{run_id}/resume")
        if resume_resp.status_code == 409:
            pytest.skip("No active checkpoint available")

        assert resume_resp.status_code == 200, resume_resp.text
        data = resume_resp.json()["data"]
        assert data["runId"] == run_id, "Resume must preserve the original runId"

    def test_resume_response_envelope(self, api):
        """Resume response matches expected envelope schema."""
        resp = api.post("/workflows/run", json={"workflowId": "workflow-analysis-pipeline"})
        assert resp.status_code == 200, resp.text
        run_id = resp.json()["data"]["runId"]

        final = poll_run_status(api, run_id, ["completed", "failed"], timeout=15.0)
        if final.get("status") != "failed":
            pytest.skip("Run did not fail — no checkpoint to resume from")

        resume_resp = api.post(f"/runs/{run_id}/resume")
        if resume_resp.status_code == 409:
            pytest.skip("No active checkpoint available")

        assert resume_resp.status_code == 200, resume_resp.text
        body = resume_resp.json()
        assert body["status"] == "ok"
        data = body["data"]
        required = {"runId", "type", "name", "status", "progress", "startedAt"}
        missing = required - set(data.keys())
        assert not missing, f"Resume response missing fields: {missing}"

    def test_resume_agent_run_returns_400(self, api):
        """POST /runs/:id/resume on an agent run returns 400."""
        resp = api.post("/agents/run", json={"agentId": "agent-analyst"})
        assert resp.status_code == 200, resp.text
        run_id = resp.json()["data"]["runId"]

        poll_run_status(api, run_id, ["completed", "failed"], timeout=15.0)

        resume_resp = api.post(f"/runs/{run_id}/resume")
        assert resume_resp.status_code == 400, resume_resp.text
