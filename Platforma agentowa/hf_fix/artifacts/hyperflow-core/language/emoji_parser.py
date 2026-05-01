"""
Hyperflow Emoji Parser — merged from v0.2.0 language layer.

Detects:
  - Canonical combo: 🌈💎🔥🧠🔀⚡  (exact or prefix)
  - MPS level markers embedded in input
  - Action route signals (🎯, 📊, 🧠 standalone, etc.)
  - Per-token phase hints

Self-contained — no external config file required.
"""
from __future__ import annotations

import re
from functools import lru_cache
from typing import Any

# ---------------------------------------------------------------------------
# Canonical constants
# ---------------------------------------------------------------------------

CANONICAL_COMBO     = "🌈💎🔥🧠🔀⚡"
# Canonical phase names (hyperflow non-negotiables)
CANONICAL_PHASES    = [
    "perceive",
    "extract_essence",
    "sense_direction",
    "synthesize",
    "generate_options",
    "choose",
]

# Symbol → phase name mapping (authoritative)
# Symbol → phase name mapping (authoritative).  Underscore-style names are
# used throughout the core to avoid drift (e.g. 'extract_essence' not 'extract essence').
SYMBOL_TO_PHASE: dict[str, str] = {
    "🌈": "perceive",
    "💎": "extract_essence",
    "🔥": "sense_direction",
    "🧠": "synthesize",
    "🔀": "generate_options",
    "⚡": "choose",
}

# Phase name → canonical symbol
PHASE_TO_SYMBOL: dict[str, str] = {v: k for k, v in SYMBOL_TO_PHASE.items()}

# MPS level markers: number emoji → level int
MPS_NUMERIC_MARKERS: dict[str, int] = {
    "1️⃣": 1, "2️⃣": 2, "3️⃣": 3, "4️⃣": 4,
    "5️⃣": 5, "6️⃣": 6, "7️⃣": 7,
}

# Standalone action signals
ACTION_SIGNALS: dict[str, dict[str, Any]] = {
    "🎯": {"action_id": "target.set",        "safe": True},
    "📊": {"action_id": "analyze.viz",        "safe": False},
    "📈": {"action_id": "metrics.compute",    "safe": False},
    "🤖": {"action_id": "agent.run_main",     "safe": False},
    "📁": {"action_id": "data.load",          "safe": False},
    "🔄": {"action_id": "pipeline.replay",    "safe": True},
    "💾": {"action_id": "checkpoint.save",    "safe": True},
    "🛑": {"action_id": "execution.halt",     "safe": True},
}

# Output-type hints from single tokens
OUTPUT_HINTS: dict[str, str] = {
    # Note: output hints are semantic labels, not necessarily phase names.  For
    # the extract phase we keep the underscore form to align with the
    # canonical name.
    "💎": "extract_essence",
    "🔥": "plan",
    "🧠": "analysis",
    "🔀": "generated_artifact",
    "⚡": "decision",
    "🌈": "full_cycle",
}

# Mode hints from single tokens
MODE_HINTS: dict[str, str] = {
    "💎": "analytical",
    "🔥": "planning",
    "🧠": "analytical",
    "🔀": "generative",
    "⚡": "verification",
    "🌈": "analytical",
}


# ---------------------------------------------------------------------------
# Trie builder (single-pass, handles multi-codepoint emoji)
# ---------------------------------------------------------------------------

def _build_trie(symbols: list[str]) -> dict[str, Any]:
    root: dict[str, Any] = {}
    for sym in symbols:
        node = root
        for ch in sym:
            node = node.setdefault(ch, {})
        node["$"] = sym
    return root


@lru_cache(maxsize=1)
def _canonical_trie() -> dict[str, Any]:
    all_symbols = (
        list(SYMBOL_TO_PHASE.keys())
        + list(MPS_NUMERIC_MARKERS.keys())
        + list(ACTION_SIGNALS.keys())
    )
    return _build_trie(all_symbols)


def _trie_scan(text: str, trie: dict[str, Any]) -> list[tuple[int, int, str]]:
    """Return list of (start, end, matched_symbol) found in text."""
    matches: list[tuple[int, int, str]] = []
    i = 0
    chars = list(text)  # iterate by Unicode scalar, not bytes
    n = len(chars)
    while i < n:
        node = trie
        j = i
        last_match: tuple[int, str] | None = None
        while j < n and chars[j] in node:
            node = node[chars[j]]
            j += 1
            if "$" in node:
                last_match = (j, node["$"])
        if last_match:
            end_idx, sym = last_match
            matches.append((i, end_idx, sym))
            i = end_idx
        else:
            i += 1
    return matches


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def parse(text: str) -> dict[str, Any]:
    """
    Parse emoji signals from input text.

    Returns:
        {
            "canonical_combo_detected": bool,
            "canonical_combo_prefix": bool,
            "phase_symbols": [str],          # canonical 🌈💎… symbols found in order
            "phase_names": [str],            # corresponding phase names
            "mps_level_hint": int | None,    # from numeric marker
            "action_routes": [dict],         # action signals found
            "output_hints": [str],           # output type hints from tokens
            "mode_hint": str | None,         # dominant mode hint
            "cleaned_text": str,             # text with emoji stripped
            "raw_tokens": [str],             # all emoji tokens found
        }
    """
    trie = _canonical_trie()
    matches = _trie_scan(text, trie)

    phase_symbols: list[str] = []
    mps_level_hint: int | None = None
    action_routes: list[dict[str, Any]] = []
    raw_tokens: list[str] = []
    output_hints: list[str] = []

    for _start, _end, sym in matches:
        raw_tokens.append(sym)
        if sym in SYMBOL_TO_PHASE:
            phase_symbols.append(sym)
            if sym in OUTPUT_HINTS:
                output_hints.append(OUTPUT_HINTS[sym])
        elif sym in MPS_NUMERIC_MARKERS:
            mps_level_hint = MPS_NUMERIC_MARKERS[sym]
        elif sym in ACTION_SIGNALS:
            action_routes.append({"emoji": sym, **ACTION_SIGNALS[sym]})

    phase_names = [SYMBOL_TO_PHASE[s] for s in phase_symbols]

    # Canonical combo check
    canonical_combo_detected = "".join(phase_symbols) == CANONICAL_COMBO
    # Prefix: first N symbols match start of canonical combo
    canonical_combo_prefix = CANONICAL_COMBO.startswith("".join(phase_symbols)) and len(phase_symbols) > 0

    # Mode hint: take the first phase symbol's mode hint
    mode_hint: str | None = None
    for sym in phase_symbols:
        if sym in MODE_HINTS:
            mode_hint = MODE_HINTS[sym]
            break

    # Strip emoji from text for cleaned version
    cleaned = re.sub(
        r"[\U0001F000-\U0001FFFF\u2600-\u27FF\uFE00-\uFE0F\u200D]|"
        r"[\U0001F1E0-\U0001F1FF]|[\U0001F3FB-\U0001F3FF]|"
        r"[0-9]\uFE0F\u20E3",
        "",
        text,
    ).strip()

    return {
        "canonical_combo_detected": canonical_combo_detected,
        "canonical_combo_prefix": canonical_combo_prefix,
        "phase_symbols": phase_symbols,
        "phase_names": phase_names,
        "mps_level_hint": mps_level_hint,
        "action_routes": action_routes,
        "output_hints": output_hints,
        "mode_hint": mode_hint,
        "cleaned_text": cleaned,
        "raw_tokens": raw_tokens,
    }
