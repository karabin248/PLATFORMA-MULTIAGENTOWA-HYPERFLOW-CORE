"""
Regression tests for canonical phase naming.

These tests ensure that the canonical phase identifiers never drift back
to their old space-delimited forms.  They fail if the runtime or
configuration contains any of the deprecated names.
"""
from __future__ import annotations

import json
from pathlib import Path

from language.emoji_parser import CANONICAL_PHASES


def test_no_old_phase_names_in_runtime() -> None:
    """Verify that deprecated phase names do not appear in the runtime constants."""
    old_names = {"extract essence", "set direction", "generate options"}
    for name in CANONICAL_PHASES:
        assert name not in old_names, f"Deprecated phase name '{name}' found in CANONICAL_PHASES"


def test_no_old_phase_names_in_config() -> None:
    """Verify that deprecated phase names do not appear in the canonical semantics config."""
    # Determine the root relative to this test file
    root = Path(__file__).parent.parent
    config_path = root / "configs" / "canonical_semantics.json"
    config = json.loads(config_path.read_text())
    order = config["cycle"]["order"]
    old_names = {"extract essence", "set direction", "generate options"}
    for name in order:
        assert name not in old_names, f"Deprecated phase name '{name}' found in canonical_semantics.json"