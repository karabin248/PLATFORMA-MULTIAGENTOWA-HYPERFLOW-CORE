"""
Canonical Semantics Preservation Tests

Ensures 🌈💎🔥🧠🔀⚡ remains the canonical execution cycle.
These tests guard against drift, redefinition, or bypass of the
canonical execution spine across the entire platform.
"""

import unicodedata
import pytest

EXPECTED_COMBO = "🌈💎🔥🧠🔀⚡"
EXPECTED_PHASES = [
    "perceive",
    "extract_essence",
    "sense_direction",
    "synthesize",
    "generate_options",
    "choose",
]
EXPECTED_SYMBOLS = {
    "🌈": "perceive",
    "💎": "extract_essence",
    "🔥": "sense_direction",
    "🧠": "synthesize",
    "🔀": "generate_options",
    "⚡": "choose",
}


class TestCanonicalSourceOfTruth:
    def test_canonical_combo_exact_value(self):
        from language.emoji_parser import CANONICAL_COMBO
        assert CANONICAL_COMBO == EXPECTED_COMBO

    def test_canonical_phases_exact_order(self):
        from language.emoji_parser import CANONICAL_PHASES
        assert CANONICAL_PHASES == EXPECTED_PHASES

    def test_canonical_combo_has_exactly_six_emoji(self):
        from language.emoji_parser import CANONICAL_COMBO
        emoji_chars = [c for c in CANONICAL_COMBO if unicodedata.category(c) == "So"]
        assert len(emoji_chars) == 6

    def test_symbol_to_phase_mapping_matches(self):
        from language.emoji_parser import SYMBOL_TO_PHASE
        for symbol, phase in EXPECTED_SYMBOLS.items():
            assert SYMBOL_TO_PHASE[symbol] == phase

    def test_phase_count_matches_combo_count(self):
        from language.emoji_parser import CANONICAL_COMBO, CANONICAL_PHASES
        emoji_count = sum(1 for c in CANONICAL_COMBO if unicodedata.category(c) == "So")
        assert emoji_count == len(CANONICAL_PHASES)


class TestCanonicalConfig:
    def test_canonical_semantics_json_matches_runtime(self):
        import json
        from pathlib import Path
        from language.emoji_parser import CANONICAL_PHASES

        config_path = Path(__file__).parent.parent / "configs" / "canonical_semantics.json"
        config = json.loads(config_path.read_text())
        assert config["cycle"]["order"] == CANONICAL_PHASES

    def test_config_symbols_match_runtime(self):
        import json
        from pathlib import Path
        from language.emoji_parser import SYMBOL_TO_PHASE

        config_path = Path(__file__).parent.parent / "configs" / "canonical_semantics.json"
        config = json.loads(config_path.read_text())
        for phase, symbol in config["cycle"]["symbols"].items():
            assert SYMBOL_TO_PHASE[symbol] == phase

    def test_config_authority_is_python_core(self):
        import json
        from pathlib import Path
        config_path = Path(__file__).parent.parent / "configs" / "canonical_semantics.json"
        config = json.loads(config_path.read_text())
        assert config["authority"]["execution"] == "python_core"

    def test_config_invariants_all_true(self):
        import json
        from pathlib import Path
        config_path = Path(__file__).parent.parent / "configs" / "canonical_semantics.json"
        config = json.loads(config_path.read_text())
        for key, value in config["invariants"].items():
            assert value is True, f"Invariant {key} must be True"


class TestEddeOrchestratorCanonical:
    @pytest.mark.asyncio
    async def test_edde_produces_canonical_trace(self):
        from engine.edde_orchestrator import run_edde
        from collections import deque

        log_store = deque(maxlen=50)
        def emit(event, run_id, **kw): log_store.append({"event": event, "run_id": run_id, **kw})
        async def mock_llm(prompt, intent, mode, temperature): return f"stub:{intent}", "mock-model"
        def noop_log(run_id, phase): pass

        bundle = await run_edde(
            prompt="test canonical trace",
            run_id="test-001",
            emit=emit,
            call_llm=mock_llm,
            log_phase_entered=noop_log,
            log_phase_completed=noop_log,
        )

        trace = bundle["canonical_trace"]
        assert trace["canonical_combo"] == EXPECTED_COMBO
        assert trace["canonical_phases"] == EXPECTED_PHASES
        assert trace["phases_completed"] == EXPECTED_PHASES
        assert trace["terminal_phase"] == "choose"
        assert trace["order_preserved"] is True
        assert "cycle_version" in trace
        assert "mps_level" in trace

    @pytest.mark.asyncio
    async def test_agent_execution_uses_same_spine(self):
        from engine.edde_orchestrator import run_edde
        from collections import deque

        log_store = deque(maxlen=50)
        def emit(event, run_id, **kw): pass
        async def mock_llm(prompt, intent, mode, temperature): return f"stub:{intent}", "mock-model"
        def noop_log(run_id, phase): pass

        bundle1 = await run_edde(prompt="baseline run", run_id="baseline-001",
                                  emit=emit, call_llm=mock_llm,
                                  log_phase_entered=noop_log, log_phase_completed=noop_log)

        bundle2 = await run_edde(prompt="agent run", run_id="agent-001",
                                  emit=emit, call_llm=mock_llm,
                                  log_phase_entered=noop_log, log_phase_completed=noop_log)

        assert bundle1["canonical_trace"]["canonical_combo"] == bundle2["canonical_trace"]["canonical_combo"]
        assert bundle1["canonical_trace"]["canonical_phases"] == bundle2["canonical_trace"]["canonical_phases"]
        assert bundle1["canonical_trace"]["phases_completed"] == bundle2["canonical_trace"]["phases_completed"]
        assert bundle1["canonical_trace"]["order_preserved"] == bundle2["canonical_trace"]["order_preserved"]
        assert bundle1["canonical_trace"]["terminal_phase"] == bundle2["canonical_trace"]["terminal_phase"]


class TestEndpointCanonicalFields:
    def test_health_exposes_canonical_fields(self):
        from main import app
        from fastapi.testclient import TestClient
        client = TestClient(app)
        resp = client.get("/v1/health")
        data = resp.json()
        assert data["canonical_combo"] == EXPECTED_COMBO
        assert data["canonical_phases"] == EXPECTED_PHASES

    def test_run_endpoint_returns_canonical_fields(self):
        from main import app
        from fastapi.testclient import TestClient
        client = TestClient(app)
        resp = client.post("/v1/run", json={"prompt": "test canonical"})
        data = resp.json()
        assert data["canonical_combo"] == EXPECTED_COMBO
        assert data["canonical_phases"] == EXPECTED_PHASES
        assert "canonical_trace" in data
        trace = data["canonical_trace"]
        assert trace["canonical_combo"] == EXPECTED_COMBO
        assert trace["canonical_phases"] == EXPECTED_PHASES
        assert trace["phases_completed"] == EXPECTED_PHASES
        assert trace["order_preserved"] is True

    def test_agent_run_endpoint_returns_canonical_fields(self):
        from main import app
        from fastapi.testclient import TestClient
        client = TestClient(app)
        resp = client.post("/v1/agent/run", json={
            "agent_id": "test-agent",
            "agent_version": "1.0.0",
            "prompt": "test agent canonical"
        })
        data = resp.json()
        assert data["canonical_combo"] == EXPECTED_COMBO
        assert data["canonical_phases"] == EXPECTED_PHASES
        assert "canonical_trace" in data
        trace = data["canonical_trace"]
        assert trace["canonical_combo"] == EXPECTED_COMBO
        assert trace["canonical_phases"] == EXPECTED_PHASES
        assert trace["phases_completed"] == EXPECTED_PHASES
        assert trace["order_preserved"] is True

    def test_run_and_agent_run_share_same_canonical_spine(self):
        from main import app
        from fastapi.testclient import TestClient
        client = TestClient(app)

        run_resp = client.post("/v1/run", json={"prompt": "spine check"})
        agent_resp = client.post("/v1/agent/run", json={
            "agent_id": "spine-agent",
            "agent_version": "1.0.0",
            "prompt": "spine check"
        })

        run_data = run_resp.json()
        agent_data = agent_resp.json()

        assert run_data["canonical_combo"] == agent_data["canonical_combo"]
        assert run_data["canonical_phases"] == agent_data["canonical_phases"]
        assert run_data["canonical_trace"]["canonical_combo"] == agent_data["canonical_trace"]["canonical_combo"]
        assert run_data["canonical_trace"]["phases_completed"] == agent_data["canonical_trace"]["phases_completed"]
        assert run_data["canonical_trace"]["order_preserved"] == agent_data["canonical_trace"]["order_preserved"]


class TestCanonicalNonBypass:
    @pytest.mark.asyncio
    async def test_all_six_phases_always_complete(self):
        from engine.edde_orchestrator import run_edde

        async def _mock_llm(p, i, m, t):
            return "stub", "mock-model"

        prompts = ["analyze this", "generate a report", "explain the system", "plan the migration"]
        for prompt in prompts:
            bundle = await run_edde(
                prompt=prompt,
                run_id=f"bypass-{prompt[:8]}",
                emit=lambda *a, **k: None,
                call_llm=_mock_llm,
                log_phase_entered=lambda r, p: None,
                log_phase_completed=lambda r, p: None,
            )
            trace = bundle["canonical_trace"]
            assert trace["phases_completed"] == EXPECTED_PHASES, \
                f"Prompt '{prompt}' did not complete all 6 canonical phases"
            assert trace["terminal_phase"] == "choose"
            assert trace["order_preserved"] is True
