"""
API smoke tests for the Hyperflow FastAPI app.

Tests all endpoints end-to-end using httpx AsyncClient (no running server needed).
Covers: health, logs, session, mps-profiles, explore, run, workflow, repositories.
"""
from __future__ import annotations

import sys
import os
import pytest
import pytest_asyncio

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from httpx import AsyncClient, ASGITransport
from main import app


@pytest.fixture
def transport():
    return ASGITransport(app=app)


@pytest.fixture
def base_url():
    return "http://testserver"


class TestHealth:
    @pytest.mark.asyncio
    async def test_health_ok(self, transport, base_url):
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            r = await client.get("/v1/health")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "ok"
        assert data["service"] == "hyperflow-python-core"
        assert "version" in data
        assert "canonical_phases" in data
        assert len(data["canonical_phases"]) == 6
        assert data["mps_levels"] == 7

    @pytest.mark.asyncio
    async def test_health_canonical_combo_present(self, transport, base_url):
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            r = await client.get("/v1/health")
        data = r.json()
        assert "canonical_combo" in data
        assert len(data["canonical_combo"]) > 0


class TestObservability:
    @pytest.mark.asyncio
    async def test_logs_recent_default(self, transport, base_url):
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            r = await client.get("/v1/logs/recent")
        assert r.status_code == 200
        data = r.json()
        assert "items" in data
        assert isinstance(data["items"], list)

    @pytest.mark.asyncio
    async def test_logs_recent_with_limit(self, transport, base_url):
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            r = await client.get("/v1/logs/recent?limit=5")
        assert r.status_code == 200
        assert len(r.json()["items"]) <= 5

    @pytest.mark.asyncio
    async def test_session_returns_summary(self, transport, base_url):
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            r = await client.get("/v1/session")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, dict)

    @pytest.mark.asyncio
    async def test_mps_profiles_returns_all_levels(self, transport, base_url):
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            r = await client.get("/v1/mps-profiles")
        assert r.status_code == 200
        data = r.json()
        assert "profiles" in data
        assert len(data["profiles"]) == 7


class TestExplore:
    @pytest.mark.asyncio
    async def test_explore_basic(self, transport, base_url):
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            r = await client.post("/v1/explore", json={"prompt": "analyze the codebase"})
        assert r.status_code == 200
        data = r.json()
        assert "paths" in data
        assert "selected_path_label" in data
        assert "mps_context" in data
        assert isinstance(data["paths"], list)

    @pytest.mark.asyncio
    async def test_explore_canonical_combo(self, transport, base_url):
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            r = await client.post("/v1/explore", json={"prompt": "🌈💎🔥🧠🔀⚡ plan deployment"})
        assert r.status_code == 200
        data = r.json()
        assert data["emoji_parse"]["canonical_combo_detected"] is True
        assert data["mps_context"]["level"] == 4

    @pytest.mark.asyncio
    async def test_explore_with_mps_hint(self, transport, base_url):
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            r = await client.post("/v1/explore", json={"prompt": "monitor the system", "mps_level": 7})
        assert r.status_code == 200
        data = r.json()
        assert data["mps_context"]["level"] == 7


class TestRun:
    @pytest.mark.asyncio
    async def test_run_returns_required_fields(self, transport, base_url):
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            r = await client.post("/v1/run", json={"prompt": "analyze the system performance"})
        assert r.status_code == 200
        data = r.json()
        required = [
            "run_id", "intent", "mode", "output_type",
            "result", "contract", "quality_score", "should_reset",
            "canonical_trace", "status", "startedAt", "completedAt",
        ]
        for field in required:
            assert field in data, f"Missing field: {field}"

    @pytest.mark.asyncio
    async def test_run_canonical_trace_has_six_phases(self, transport, base_url):
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            r = await client.post("/v1/run", json={"prompt": "plan the migration"})
        data = r.json()
        trace = data["canonical_trace"]
        assert trace["terminal_phase"] == "choose"
        assert trace["order_preserved"] is True
        assert len(trace["phases_completed"]) == 6

    @pytest.mark.asyncio
    async def test_run_status_completed(self, transport, base_url):
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            r = await client.post("/v1/run", json={"prompt": "generate a report"})
        assert r.json()["status"] == "completed"

    @pytest.mark.asyncio
    async def test_run_quality_score_in_range(self, transport, base_url):
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            r = await client.post("/v1/run", json={"prompt": "validate the config"})
        q = r.json()["quality_score"]
        assert 0.0 <= q <= 1.0

    @pytest.mark.asyncio
    async def test_run_contract_has_version(self, transport, base_url):
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            r = await client.post("/v1/run", json={"prompt": "explain the system"})
        contract = r.json()["contract"]
        assert "version" in contract
        assert "mps_level" in contract
        assert "mps_name" in contract


class TestWorkflowRun:
    @pytest.mark.asyncio
    async def test_workflow_run_basic(self, transport, base_url):
        payload = {
            "workflowId": "wf-test-01",
            "name": "test workflow",
            "steps": [
                {"id": "s1", "name": "Step 1", "prompt": "analyze the data", "dependsOn": []},
                {"id": "s2", "name": "Step 2", "prompt": "generate report", "dependsOn": ["s1"]},
            ],
        }
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            r = await client.post("/v1/workflow/run", json=payload)
        assert r.status_code == 200
        data = r.json()
        assert "runId" in data
        assert "nodes" in data
        assert len(data["nodes"]) == 2
        assert data["status"] in ("completed", "failed")

    @pytest.mark.asyncio
    async def test_workflow_cycle_detection(self, transport, base_url):
        payload = {
            "workflowId": "wf-cycle",
            "name": "cycle workflow",
            "steps": [
                {"id": "s1", "name": "A", "prompt": "step a", "dependsOn": ["s2"]},
                {"id": "s2", "name": "B", "prompt": "step b", "dependsOn": ["s1"]},
            ],
        }
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            r = await client.post("/v1/workflow/run", json=payload)
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "failed"
        assert "cycle" in data.get("error", "").lower()



    @pytest.mark.asyncio
    async def test_workflow_unknown_dependency_reports_missing_step(self, transport, base_url):
        payload = {
            "workflowId": "wf-missing-dep",
            "name": "missing dependency workflow",
            "steps": [
                {"id": "s1", "name": "A", "prompt": "step a", "dependsOn": ["missing"]},
            ],
        }
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            r = await client.post("/v1/workflow/run", json=payload)
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "failed"
        assert "depends on unknown step 'missing'" in data.get("error", "")
        assert "cycle" not in data.get("error", "").lower()


class TestRepositoriesGraph:
    @pytest.mark.asyncio
    async def test_graph_empty(self, transport, base_url):
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            r = await client.post("/v1/repositories/graph", json={"repositories": []})
        assert r.status_code == 200
        data = r.json()
        assert "nodes" in data
        assert "edges" in data
        assert "overlapPairs" in data

    @pytest.mark.asyncio
    async def test_graph_nodes_present(self, transport, base_url):
        repos = [
            {"id": "r1", "name": "api", "language": "typescript",
             "classification": "service", "dependencyCount": 5},
            {"id": "r2", "name": "lib", "language": "typescript",
             "classification": "library", "dependencyCount": 2},
        ]
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            r = await client.post("/v1/repositories/graph", json={"repositories": repos})
        assert r.status_code == 200
        data = r.json()
        assert len(data["nodes"]) == 2

class TestRepositoriesScan:
    @pytest.mark.asyncio
    async def test_repositories_scan_disabled_by_default(self, transport, base_url):
        """Scanner is disabled unless HYPERFLOW_SCANNER_ENABLED=true (security default).

        Pre-existing tests assumed scanner was always on and expected 200 + url-rejection.
        After HIGH-01 / security hardening the scanner returns 503 SCANNER_DISABLED
        unless explicitly enabled. This test documents the secure default behaviour.
        The url-scheme rejection logic is covered by test_scanner.py unit tests
        which call _validate_repo_url() directly without the scanner gate.
        """
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            resp = await client.post("/v1/repositories/scan", json={
                "repositories": [{"id": "bad", "name": "bad", "url": "http://github.com/openai/hyperflow.git"}]
            })
        assert resp.status_code == 503
        data = resp.json()
        assert data["detail"]["code"] == "SCANNER_DISABLED"

    @pytest.mark.asyncio
    async def test_repositories_scan_file_scheme_disabled_by_default(self, transport, base_url):
        """Scanner disabled by default — file:// URL also receives 503, not 200+error.

        The actual file:// scheme rejection is unit-tested in test_scanner.py.
        """
        async with AsyncClient(transport=transport, base_url=base_url) as client:
            resp = await client.post("/v1/repositories/scan", json={
                "repositories": [{"id": "bad", "name": "bad", "url": "file:///tmp/evil.git"}]
            })
        assert resp.status_code == 503
        data = resp.json()
        assert data["detail"]["code"] == "SCANNER_DISABLED"


