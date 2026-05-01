"""
Integration tests: run lifecycle — start, poll status, completed state.

These tests start real workflow/agent runs against the live server and verify
the full lifecycle: pending → running → completed/failed.  Because runs execute
asynchronously we poll with a short timeout.
"""

import time
import pytest


def poll_run_status(api, run_id: str, target_statuses: list[str], timeout: float = 10.0, interval: float = 0.25) -> dict:
    """Poll GET /runs/:runId/status until status is one of target_statuses or timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        resp = api.get(f"/runs/{run_id}/status")
        if resp.status_code != 200:
            time.sleep(interval)
            continue
        data = resp.json().get("data", {})
        if data.get("status") in target_statuses:
            return data
        time.sleep(interval)
    resp = api.get(f"/runs/{run_id}/status")
    return resp.json().get("data", {})


class TestWorkflowRunLifecycle:
    def test_start_workflow_returns_run(self, api):
        """POST /workflows/run creates a run and returns a run summary."""
        resp = api.post("/workflows/run", json={"workflowId": "workflow-analysis-pipeline"})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        run = body["data"]
        assert "runId" in run
        assert run["status"] in ("pending", "running", "completed")

    def test_workflow_run_reaches_terminal_state(self, api):
        """A started workflow eventually reaches completed or failed."""
        resp = api.post("/workflows/run", json={"workflowId": "workflow-analysis-pipeline"})
        assert resp.status_code == 200, resp.text
        run_id = resp.json()["data"]["runId"]

        final = poll_run_status(api, run_id, ["completed", "failed"], timeout=15.0)
        assert final.get("status") in ("completed", "failed"), f"Run stuck in: {final.get('status')}"

    def test_workflow_run_progress_increases(self, api):
        """Progress reaches 100 on completed workflow."""
        resp = api.post("/workflows/run", json={"workflowId": "workflow-content-review"})
        assert resp.status_code == 200, resp.text
        run_id = resp.json()["data"]["runId"]

        final = poll_run_status(api, run_id, ["completed", "failed"], timeout=15.0)
        if final.get("status") == "completed":
            assert final.get("progress") == 100

    def test_run_status_has_node_list(self, api):
        """GET /runs/:runId/status includes nodes array."""
        resp = api.post("/workflows/run", json={"workflowId": "workflow-analysis-pipeline"})
        assert resp.status_code == 200, resp.text
        run_id = resp.json()["data"]["runId"]

        final = poll_run_status(api, run_id, ["completed", "failed"], timeout=15.0)
        assert "nodes" in final, "nodes key missing from run status"
        assert isinstance(final["nodes"], list)

    def test_run_appears_in_runs_list(self, api):
        """A newly started run appears in GET /runs."""
        resp = api.post("/workflows/run", json={"workflowId": "workflow-analysis-pipeline"})
        assert resp.status_code == 200, resp.text
        run_id = resp.json()["data"]["runId"]

        runs_resp = api.get("/runs")
        assert runs_resp.status_code == 200
        run_ids = [r["runId"] for r in runs_resp.json().get("data", [])]
        assert run_id in run_ids, f"{run_id} not found in /runs list"

    def test_invalid_workflow_returns_404(self, api):
        """POST /workflows/run with unknown workflowId returns 404."""
        resp = api.post("/workflows/run", json={"workflowId": "wf-does-not-exist"})
        assert resp.status_code == 404, resp.text


class TestAgentRunLifecycle:
    def test_start_agent_run(self, api):
        """POST /agents/run starts an agent and returns a run summary."""
        resp = api.post("/agents/run", json={"agentId": "agent-analyst"})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        run = body["data"]
        assert "runId" in run

    def test_agent_run_reaches_terminal_state(self, api):
        """A started agent run eventually reaches completed or failed."""
        resp = api.post("/agents/run", json={"agentId": "agent-classifier"})
        assert resp.status_code == 200, resp.text
        run_id = resp.json()["data"]["runId"]

        final = poll_run_status(api, run_id, ["completed", "failed"], timeout=15.0)
        assert final.get("status") in ("completed", "failed")

    def test_invalid_agent_returns_404(self, api):
        """POST /agents/run with unknown agentId returns 404."""
        resp = api.post("/agents/run", json={"agentId": "agent-does-not-exist"})
        assert resp.status_code == 404, resp.text


class TestRunsList:
    def test_list_runs_envelope(self, api):
        """GET /runs returns ok envelope with data array."""
        resp = api.get("/runs")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert isinstance(body["data"], list)

    def test_list_runs_filter_by_status(self, api):
        """GET /runs?status=completed returns only completed runs."""
        resp = api.get("/runs?status=completed")
        assert resp.status_code == 200
        runs = resp.json()["data"]
        for run in runs:
            assert run["status"] == "completed", f"Non-completed run returned: {run['status']}"

    def test_list_runs_limit(self, api):
        """GET /runs?limit=2 returns at most 2 runs."""
        resp = api.get("/runs?limit=2")
        assert resp.status_code == 200
        runs = resp.json()["data"]
        assert len(runs) <= 2
