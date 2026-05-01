"""Tests for emoji parser — merged from v0.2.0 test infrastructure."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from language.emoji_parser import (
    CANONICAL_COMBO,
    CANONICAL_PHASES,
    SYMBOL_TO_PHASE,
    parse,
)


def test_canonical_combo_detected():
    result = parse("🌈💎🔥🧠🔀⚡ analyze this system")
    assert result["canonical_combo_detected"] is True
    assert result["phase_names"] == CANONICAL_PHASES


def test_canonical_combo_prefix():
    result = parse("🌈💎 extract the key ideas")
    assert result["canonical_combo_prefix"] is True
    assert result["canonical_combo_detected"] is False
    assert result["phase_names"] == ["perceive", "extract_essence"]


def test_no_emoji():
    result = parse("plain text with no emoji")
    assert result["canonical_combo_detected"] is False
    assert result["raw_tokens"] == []
    assert result["cleaned_text"] == "plain text with no emoji"


def test_mps_numeric_marker():
    result = parse("5️⃣ run deep analysis")
    assert result["mps_level_hint"] == 5


def test_action_route_detected():
    result = parse("📊 show metrics dashboard")
    assert len(result["action_routes"]) == 1
    assert result["action_routes"][0]["action_id"] == "analyze.viz"


def test_cleaned_text_strips_emoji():
    result = parse("🌈💎 analyze the codebase")
    assert "🌈" not in result["cleaned_text"]
    assert "analyze" in result["cleaned_text"]


def test_phase_symbols_order():
    result = parse("🔥🧠⚡ plan now")
    assert result["phase_names"] == ["sense_direction", "synthesize", "choose"]


def test_output_hint_from_fire():
    result = parse("🔥 build a plan")
    assert "plan" in result["output_hints"]


def test_mode_hint_from_synthesize():
    result = parse("🧠 deep dive")
    assert result["mode_hint"] == "analytical"
