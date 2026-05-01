"""
Hyperflow MPS Controller — merged from v0.2.0.

Multi-Pulse System: 7 levels controlling execution depth,
observer rigor, risk tolerance, and LLM temperature.

Level resolution priority:
  1. Explicit numeric marker from emoji parser (highest)
  2. Mode-based heuristic from intent
  3. Combo detection (full canonical combo → level 4)
  4. Default (level 2 = Stabilize)
"""
from __future__ import annotations

from typing import Any

# ---------------------------------------------------------------------------
# MPS Profile definitions
# ---------------------------------------------------------------------------

MPS_PROFILES: dict[int, dict[str, Any]] = {
    1: {
        "name": "Observation",
        "depth": "low",
        "observer_rigor": "high",
        "risk_state": "low",
        "execution_policy": "observe",
        "llm_temperature": 0.3,
        "max_candidates": 1,
        "notes": "Passive — gather telemetry, minimal compute.",
    },
    2: {
        "name": "Stabilize",
        "depth": "medium",
        "observer_rigor": "high",
        "risk_state": "low",
        "execution_policy": "stabilize",
        "llm_temperature": 0.5,
        "max_candidates": 2,
        "notes": "Soft corrections, low-impact output.",
    },
    3: {
        "name": "Harmonize",
        "depth": "high",
        "observer_rigor": "medium",
        "risk_state": "medium",
        "execution_policy": "coordinate",
        "llm_temperature": 0.65,
        "max_candidates": 3,
        "notes": "Coordinate agents, balanced output.",
    },
    4: {
        "name": "Amplify",
        "depth": "high",
        "observer_rigor": "medium",
        "risk_state": "medium",
        "execution_policy": "amplify",
        "llm_temperature": 0.75,
        "max_candidates": 3,
        "notes": "Scale compute, push workflows, full canonical cycle.",
    },
    5: {
        "name": "Dominant Core",
        "depth": "deep",
        "observer_rigor": "low",
        "risk_state": "high",
        "execution_policy": "core_dominant",
        "llm_temperature": 0.85,
        "max_candidates": 3,
        "notes": "Core-dominant — activate when 💎 + plan intent.",
    },
    6: {
        "name": "Satellite Ops",
        "depth": "deep",
        "observer_rigor": "low",
        "risk_state": "high",
        "execution_policy": "satellite",
        "llm_temperature": 0.90,
        "max_candidates": 3,
        "notes": "Satellite agent orchestration.",
    },
    7: {
        "name": "Emergency",
        "depth": "low",
        "observer_rigor": "high",
        "risk_state": "critical",
        "execution_policy": "fallback",
        "llm_temperature": 0.2,
        "max_candidates": 1,
        "notes": "Full mitigation — fallback to safe-core, constrain all.",
    },
}

# ---------------------------------------------------------------------------
# Mode-to-MPS mapping (heuristic, used when no explicit marker present)
# ---------------------------------------------------------------------------

_MODE_TO_LEVEL: dict[str, int] = {
    "observational": 1,
    "verification":  2,
    "retrieval":     2,
    "analytical":    3,
    "explanatory":   3,
    "planning":      4,
    "transformative":4,
    "generative":    4,
}

_INTENT_BOOST: dict[str, int] = {
    "plan":     1,   # push one level up
    "optimize": 1,
    "generate": 0,
    "monitor":  -1,  # pull one level down
}


def resolve_mps_level(
    intent: str,
    mode: str,
    emoji_tokens: list[str],
    mps_level_hint: int | None,
    canonical_combo_detected: bool,
) -> int:
    """Return MPS level 1–7."""

    # Priority 1: explicit numeric marker from emoji
    if mps_level_hint is not None:
        return max(1, min(7, mps_level_hint))

    # Priority 2: emergency signal
    if "🛑" in emoji_tokens:
        return 7

    # Priority 3: full canonical combo → amplify
    if canonical_combo_detected:
        return 4

    # Priority 4: mode heuristic + intent boost
    base = _MODE_TO_LEVEL.get(mode, 2)
    boost = _INTENT_BOOST.get(intent, 0)
    level = max(1, min(6, base + boost))

    # 💎 in tokens with plan/build intent → dominant core
    if "💎" in emoji_tokens and intent in {"plan", "generate"}:
        level = max(level, 5)

    return level


def get_profile(level: int) -> dict[str, Any]:
    return MPS_PROFILES.get(level, MPS_PROFILES[2])


def build_mps_context(
    intent: str,
    mode: str,
    emoji_tokens: list[str],
    mps_level_hint: int | None,
    canonical_combo_detected: bool,
) -> dict[str, Any]:
    """Build complete MPS context dict attached to run state."""
    level = resolve_mps_level(intent, mode, emoji_tokens, mps_level_hint, canonical_combo_detected)
    profile = get_profile(level)
    return {
        "level":            level,
        "name":             profile["name"],
        "depth":            profile["depth"],
        "observer_rigor":   profile["observer_rigor"],
        "risk_state":       profile["risk_state"],
        "execution_policy": profile["execution_policy"],
        "llm_temperature":  profile["llm_temperature"],
        "max_candidates":   profile["max_candidates"],
    }
