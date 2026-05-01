"""
Hyperflow Memory — merged from v0.2.0.

knowledge_store: append-only JSONL of run knowledge objects.
traces:          append-only JSONL of structured run traces.
session_memory:  in-process ring buffer (no persistence, mirrors log store).

Storage location: HYPERFLOW_STORAGE_DIR env var (default: ./storage).
"""
from __future__ import annotations

import json
import os
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Deque

# ---------------------------------------------------------------------------
# Storage root
# ---------------------------------------------------------------------------

def _storage_root() -> Path:
    base = os.environ.get("HYPERFLOW_STORAGE_DIR", "storage")
    return Path(base)


def _knowledge_file() -> Path:
    return _storage_root() / "knowledge_store.jsonl"


def _trace_file() -> Path:
    return _storage_root() / "traces.jsonl"


def _safe_write(path: Path, record: dict[str, Any]) -> None:
    """Best-effort append — never raises, never breaks the run."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Knowledge store
# ---------------------------------------------------------------------------

def save_knowledge(run_id: str, intent: str, mode: str, output: str, confidence: float) -> None:
    record = {
        "timestamp":  datetime.now(timezone.utc).isoformat(),
        "run_id":     run_id,
        "intent":     intent,
        "mode":       mode,
        "output":     output[:500],
        "confidence": confidence,
    }
    _safe_write(_knowledge_file(), record)


# ---------------------------------------------------------------------------
# Run traces (rich structured record per run)
# ---------------------------------------------------------------------------

def save_trace(
    run_id: str,
    prompt: str,
    intent: str,
    mode: str,
    mps_context: dict[str, Any],
    phases_completed: list[str],
    canonical_combo_detected: bool,
    quality_score: float,
    source: str,
) -> None:
    record = {
        "timestamp":                datetime.now(timezone.utc).isoformat(),
        "run_id":                   run_id,
        "prompt_preview":           prompt[:120],
        "intent":                   intent,
        "mode":                     mode,
        "mps_level":                mps_context.get("level"),
        "mps_name":                 mps_context.get("name"),
        "canonical_combo_detected": canonical_combo_detected,
        "phases_completed":         phases_completed,
        "quality_score":            quality_score,
        "source":                   source,
    }
    _safe_write(_trace_file(), record)


# ---------------------------------------------------------------------------
# Session memory (in-process ring buffer, 100 entries)
# ---------------------------------------------------------------------------

_SESSION: Deque[dict[str, Any]] = deque(maxlen=100)


def push_session(run_id: str, intent: str, mode: str, quality_score: float) -> None:
    _SESSION.append({
        "run_id":        run_id,
        "intent":        intent,
        "mode":          mode,
        "quality_score": quality_score,
        "ts":            datetime.now(timezone.utc).isoformat(),
    })


def get_session_summary() -> dict[str, Any]:
    items = list(_SESSION)
    if not items:
        return {"count": 0, "avg_quality": None, "recent_intents": []}
    avg_q = round(sum(i["quality_score"] for i in items) / len(items), 4)
    recent_intents = [i["intent"] for i in items[-5:]]
    return {"count": len(items), "avg_quality": avg_q, "recent_intents": recent_intents}
