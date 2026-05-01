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
import hashlib
import logging
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Deque

_logger = logging.getLogger("hyperflow.memory.store")
_write_failures: dict[str, int] = {}


def _rotation_threshold_bytes() -> int:
    try:
        mb = float(os.environ.get("HYPERFLOW_STORAGE_MAX_MB", "5"))
    except ValueError:
        mb = 5.0
    return max(1, int(mb * 1024 * 1024))


def _alert_threshold() -> int:
    try:
        return max(1, int(os.environ.get("HYPERFLOW_STORAGE_ALERT_THRESHOLD", "10")))
    except ValueError:
        return 10


def _rotate_if_needed(path: Path) -> None:
    if not path.exists():
        return
    if path.stat().st_size < _rotation_threshold_bytes():
        return
    backup = path.with_suffix(path.suffix + ".1")
    try:
        if backup.exists():
            backup.unlink()
        path.replace(backup)
    except OSError:
        pass


def _prompt_token(prompt: str) -> str:
    if os.environ.get("HYPERFLOW_PERSIST_PROMPTS", "false").strip().lower() == "true":
        return prompt[:120]
    digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"

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
    key = str(path)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        _rotate_if_needed(path)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
        _write_failures[key] = 0
    except Exception:
        count = _write_failures.get(key, 0) + 1
        _write_failures[key] = count
        if count >= _alert_threshold():
            _logger.critical(
                "Persistent JSONL write failures for %s (count=%s)",
                key,
                count,
            )
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
        "prompt_token":             _prompt_token(prompt),
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
