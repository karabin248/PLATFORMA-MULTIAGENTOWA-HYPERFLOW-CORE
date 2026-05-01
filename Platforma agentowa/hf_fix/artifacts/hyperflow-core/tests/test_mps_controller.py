"""Tests for MPS controller."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from control.mps_controller import MPS_PROFILES, build_mps_context, resolve_mps_level


def test_explicit_numeric_marker_takes_priority():
    level = resolve_mps_level(
        intent="analyze", mode="analytical",
        emoji_tokens=[], mps_level_hint=6,
        canonical_combo_detected=False,
    )
    assert level == 6


def test_emergency_signal():
    level = resolve_mps_level(
        intent="monitor", mode="observational",
        emoji_tokens=["🛑"], mps_level_hint=None,
        canonical_combo_detected=False,
    )
    assert level == 7


def test_canonical_combo_gives_level_4():
    level = resolve_mps_level(
        intent="process", mode="analytical",
        emoji_tokens=[], mps_level_hint=None,
        canonical_combo_detected=True,
    )
    assert level == 4


def test_planning_mode_gives_level_4():
    level = resolve_mps_level(
        intent="plan", mode="planning",
        emoji_tokens=[], mps_level_hint=None,
        canonical_combo_detected=False,
    )
    assert level >= 4


def test_diamond_with_plan_gives_level_5():
    level = resolve_mps_level(
        intent="plan", mode="planning",
        emoji_tokens=["💎"], mps_level_hint=None,
        canonical_combo_detected=False,
    )
    assert level == 5


def test_build_mps_context_returns_all_fields():
    ctx = build_mps_context(
        intent="analyze", mode="analytical",
        emoji_tokens=[], mps_level_hint=None,
        canonical_combo_detected=False,
    )
    for key in ("level", "name", "depth", "observer_rigor", "risk_state",
                "execution_policy", "llm_temperature", "max_candidates"):
        assert key in ctx, f"Missing key: {key}"


def test_all_profiles_have_required_fields():
    required = ("name", "depth", "observer_rigor", "risk_state",
                "execution_policy", "llm_temperature", "max_candidates")
    for lvl, profile in MPS_PROFILES.items():
        for field in required:
            assert field in profile, f"Level {lvl} missing field: {field}"


def test_level_range_clamped():
    level = resolve_mps_level(
        intent="monitor", mode="observational",
        emoji_tokens=[], mps_level_hint=99,
        canonical_combo_detected=False,
    )
    assert level == 7
