"""
Integration test — full EDDE pipeline in stub mode (no OpenRouter key).
Verifies all 6 phases complete, canonical trace is present, MPS is applied.
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from engine.edde_orchestrator import run_edde

_EVENTS = []


def _emit(event, run_id, **extra):
    _EVENTS.append({"event": event, "run_id": run_id, **extra})


def _log_entered(run_id, phase):
    _EVENTS.append({"event": "phase_entered", "phase": phase})


def _log_completed(run_id, phase):
    _EVENTS.append({"event": "phase_completed", "phase": phase})


async def _stub_llm(prompt, intent, mode, temperature):
    raise RuntimeError("No LLM key in test")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_all_six_phases_complete():
    _EVENTS.clear()
    bundle = _run(run_edde(
        prompt="🌈💎🔥🧠🔀⚡ analyze this system architecture",
        run_id="test-001",
        emit=_emit,
        call_llm=_stub_llm,
        log_phase_entered=_log_entered,
        log_phase_completed=_log_completed,
    ))
    phases = bundle["canonical_trace"]["phases_completed"]
    assert phases == [
        "perceive",
        "extract_essence",
        "sense_direction",
        "synthesize",
        "generate_options",
        "choose",
    ]


def test_canonical_combo_detected():
    bundle = _run(run_edde(
        prompt="🌈💎🔥🧠🔀⚡ full cycle",
        run_id="test-002",
        emit=_emit,
        call_llm=_stub_llm,
        log_phase_entered=_log_entered,
        log_phase_completed=_log_completed,
    ))
    assert bundle["canonical_trace"]["canonical_combo_detected"] is True
    assert bundle["canonical_trace"]["mps_level"] == 4


def test_mps_level_in_bundle():
    bundle = _run(run_edde(
        prompt="5️⃣ plan the architecture",
        run_id="test-003",
        emit=_emit,
        call_llm=_stub_llm,
        log_phase_entered=_log_entered,
        log_phase_completed=_log_completed,
    ))
    assert bundle["mps_context"]["level"] == 5
    assert bundle["mps_context"]["name"] == "Dominant Core"


def test_stub_source_when_no_llm():
    bundle = _run(run_edde(
        prompt="generate a report",
        run_id="test-004",
        emit=_emit,
        call_llm=_stub_llm,
        log_phase_entered=_log_entered,
        log_phase_completed=_log_completed,
    ))
    assert bundle["source"] == "stub"
    assert bundle["result"]["source"] == "stub"


def test_quality_score_in_range():
    """quality_score must be in [0,1] and degraded stub runs must stay visibly lower."""
    bundle = _run(run_edde(
        prompt="validate the contract schema",
        run_id="test-005",
        emit=_emit,
        call_llm=_stub_llm,
        log_phase_entered=_log_entered,
        log_phase_completed=_log_completed,
    ))
    assert 0.0 <= bundle["quality_score"] <= 1.0
    assert bundle["source"] == "stub"
    assert bundle["quality_score"] < 0.70


def test_candidate_paths_generated():
    bundle = _run(run_edde(
        prompt="analyze performance metrics",
        run_id="test-006",
        emit=_emit,
        call_llm=_stub_llm,
        log_phase_entered=_log_entered,
        log_phase_completed=_log_completed,
    ))
    paths = bundle["phases"]["generate_options"]["paths"]
    assert len(paths) >= 1
    assert all("evaluation_score" in p for p in paths)


def test_order_preserved_flag():
    bundle = _run(run_edde(
        prompt="plan and execute",
        run_id="test-007",
        emit=_emit,
        call_llm=_stub_llm,
        log_phase_entered=_log_entered,
        log_phase_completed=_log_completed,
    ))
    assert bundle["canonical_trace"]["order_preserved"] is True


def test_order_preserved_matches_completed_phase_sequence():
    from language.emoji_parser import CANONICAL_PHASES

    async def _ok_llm(prompt, intent, mode, temperature):
        return "ok", "mock-model"

    bundle = asyncio.run(run_edde(
        prompt="check order sequence",
        run_id="order-seq-001",
        emit=lambda *a, **k: None,
        call_llm=_ok_llm,
        log_phase_entered=lambda *_: None,
        log_phase_completed=lambda *_: None,
    ))
    trace = bundle["canonical_trace"]
    assert trace["phases_completed"] == list(CANONICAL_PHASES)
    assert trace["order_preserved"] is (trace["phases_completed"] == list(CANONICAL_PHASES))
