"""Tests for intent resolver — emoji-aware weighted scoring."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from language.intent_resolver import resolve


def test_plan_keyword():
    intent, mode, output_type = resolve("plan the deployment roadmap")
    assert intent == "plan"
    assert mode == "planning"
    assert output_type == "execution_plan"


def test_analyze_keyword():
    intent, mode, _ = resolve("analyze the codebase for security issues")
    assert intent == "analyze"
    assert mode == "analytical"


def test_emoji_boost_fire_gives_plan():
    intent, mode, _ = resolve("do this task", emoji_tokens=["🔥"])
    assert intent == "plan"


def test_emoji_boost_rotate_gives_generate():
    intent, mode, _ = resolve("create something", emoji_tokens=["🔀"])
    # 🔀 boosts generate, keyword "create" also boosts generate
    assert intent == "generate"


def test_fallback_on_no_match():
    intent, mode, output_type = resolve("xyzzy quux blorp")
    assert intent == "process"
    assert mode == "analytical"
    assert output_type == "processed_output"


def test_tie_broken_by_priority():
    # Both "plan" and "monitor" at equal weight — plan has lower priority index → wins
    intent, _, _ = resolve("plan and monitor the system")
    assert intent == "plan"


def test_validate_keyword():
    intent, _, _ = resolve("validate the schema and verify constraints")
    assert intent == "validate"


def test_empty_string_fallback():
    intent, mode, _ = resolve("")
    assert intent == "process"
