"""
Hyperflow Intent Resolver — merged from v0.2.0 + core-main.

Weighted keyword scoring, emoji-aware, returns (intent, mode, output_type).
"""
from __future__ import annotations

import re
from typing import Any

_INTENT_RULES: list[dict[str, Any]] = [
    {"intent": "plan",      "mode": "planning",      "output_type": "execution_plan",
     "weight": 3, "patterns": [r"\b(plan|schedul|organiz|prioritiz|strateg|roadmap|outlin)\w*\b"]},
    {"intent": "monitor",   "mode": "observational", "output_type": "observation_log",
     "weight": 3, "patterns": [r"\b(monitor|track|observ|watch|record)\w*\b"]},
    {"intent": "analyze",   "mode": "analytical",    "output_type": "analysis_report",
     "weight": 2, "patterns": [r"\b(analyz|inspect|audit|review|assess|evaluat|diagnos)\w*\b"]},
    {"intent": "generate",  "mode": "generative",    "output_type": "generated_artifact",
     "weight": 2, "patterns": [r"\b(generat|creat|build|produc|mak|design|compos|writ)\w*\b"]},
    {"intent": "transform", "mode": "transformative","output_type": "transformed_output",
     "weight": 1, "patterns": [r"\b(transform|convert|translat|migrat|refactor|reformat|restructur)\w*\b"]},
    {"intent": "explain",   "mode": "explanatory",   "output_type": "explanation",
     "weight": 2, "patterns": [r"\b(explain|describ|summar|clarif|document|illustrat)\w*\b"]},
    {"intent": "query",     "mode": "retrieval",     "output_type": "query_result",
     "weight": 1, "patterns": [r"\b(search|find|look.?up|retriev|fetch|queri|scan|discover)\w*\b"]},
    {"intent": "classify",  "mode": "analytical",    "output_type": "classification",
     "weight": 2, "patterns": [r"\b(classif|categoriz|label|tag|group|cluster|sort|rank)\w*\b"]},
    {"intent": "validate",  "mode": "verification",  "output_type": "validation_report",
     "weight": 2, "patterns": [r"\b(validat|verif|check|test|confirm|assert|ensur)\w*\b"]},
    {"intent": "optimize",  "mode": "transformative","output_type": "optimization_result",
     "weight": 2, "patterns": [r"\b(optimiz|improv|enhanc|refin|calibrat)\w*\b"]},
]

_INTENT_PRIORITY: list[str] = [
    "plan", "monitor", "analyze", "generate", "transform",
    "explain", "query", "classify", "validate", "optimize",
]

_INTENT_META: dict[str, dict[str, str]] = {
    r["intent"]: {"mode": r["mode"], "output_type": r["output_type"]}
    for r in _INTENT_RULES
}

# Emoji-to-intent overrides: when canonical combo tokens appear standalone
EMOJI_INTENT_OVERRIDES: dict[str, str] = {
    "🔥": "plan",
    "🔀": "generate",
    "🧠": "analyze",
    "💎": "classify",
    "⚡": "validate",
}


def resolve(prompt: str, emoji_tokens: list[str] | None = None) -> tuple[str, str, str]:
    """
    Return (intent, mode, output_type).

    Emoji tokens (from emoji_parser.parse()) are used to boost scores
    before keyword scoring, giving emoji control signals priority.
    """
    lowered = prompt.lower()
    scores: dict[str, int] = {}

    # Emoji boost: each action/phase emoji adds weight 2 to its intent
    for token in (emoji_tokens or []):
        if token in EMOJI_INTENT_OVERRIDES:
            intent = EMOJI_INTENT_OVERRIDES[token]
            scores[intent] = scores.get(intent, 0) + 2

    # Keyword scoring
    for rule in _INTENT_RULES:
        for pattern in rule["patterns"]:
            if re.search(pattern, lowered):
                scores[rule["intent"]] = scores.get(rule["intent"], 0) + rule["weight"]

    if not scores:
        return "process", "analytical", "processed_output"

    max_score = max(scores.values())
    candidates = [i for i, s in scores.items() if s == max_score]
    winner = candidates[0] if len(candidates) == 1 else min(
        candidates, key=lambda i: _INTENT_PRIORITY.index(i) if i in _INTENT_PRIORITY else 99
    )
    meta = _INTENT_META.get(winner, {"mode": "analytical", "output_type": "processed_output"})
    return winner, meta["mode"], meta["output_type"]
