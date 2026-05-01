"""
OpenRouter adapter for Hyperflow Python Core.

Exposes a single async function:
    call_model(prompt, intent, mode) -> tuple[str, str]

Reads environment variables:
    OPENROUTER_API_KEY   — required; raises OpenRouterUnavailable if absent
    OPENROUTER_MODEL     — optional; defaults to "openai/gpt-4o-mini"
    OPENROUTER_TIMEOUT   — optional; request timeout in seconds (default: 30)

FIX #6: Added retry logic with exponential backoff for transient errors:
  - Retries on HTTP 429, 500, 502, 503 and network-level RequestError
  - Default: 2 retries with 1s base backoff (doubles each attempt)
  - Configurable via OPENROUTER_RETRIES env var

Raises OpenRouterUnavailable on missing key, persistent HTTP error, or
unexpected response so the caller can fall back to the deterministic stub.
"""

from __future__ import annotations

import asyncio
import os
import random
import re
from typing import Optional

import httpx

_OPENROUTER_BASE = "https://openrouter.ai/api/v1"
_DEFAULT_MODEL = "openai/gpt-4o-mini"
_RETRY_STATUSES = {429, 500, 502, 503}
_CLIENT: Optional[httpx.AsyncClient] = None
_CLIENT_TIMEOUT: Optional[float] = None
# EX-3: Lock prevents concurrent recreation of the shared httpx client
# when two coroutines call _get_client() with the same (or different) timeout.
_CLIENT_LOCK: Optional[asyncio.Lock] = None


def _get_lock() -> asyncio.Lock:
    """Return the process-local asyncio.Lock, lazily created inside the event loop."""
    global _CLIENT_LOCK
    if _CLIENT_LOCK is None:
        _CLIENT_LOCK = asyncio.Lock()
    return _CLIENT_LOCK


_SYSTEM_PROMPT = (
    "You are the Hyperflow execution engine — a concise, precise AI runtime. "
    "When given a prompt and its classified intent + mode, produce a focused, "
    "actionable result. Reply with plain prose only (no markdown headings). "
    "Keep the response under 300 words."
)


class OpenRouterUnavailable(Exception):
    """Raised when OpenRouter is not configured or the API call fails."""


def _api_key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        raise OpenRouterUnavailable("OPENROUTER_API_KEY is not set")
    return key


def _model() -> str:
    return os.environ.get("OPENROUTER_MODEL", _DEFAULT_MODEL).strip() or _DEFAULT_MODEL


def _timeout() -> float:
    try:
        return float(os.environ.get("OPENROUTER_TIMEOUT", "30"))
    except ValueError:
        return 30.0


def _max_retries() -> int:
    try:
        return max(0, int(os.environ.get("OPENROUTER_RETRIES", "2")))
    except ValueError:
        return 2


# ---------------------------------------------------------------------------
# C-1 FIX: model hint allowlist
#
# HYPERFLOW_ALLOWED_MODEL_HINTS is a comma-separated list of permitted model
# identifiers (e.g. "openai/gpt-4o-mini,openai/gpt-4o").  When set, any hint
# outside the list is rejected before the API call.  When absent, all hints
# are permitted — existing behaviour is preserved — but a startup warning
# prompts operators to configure the allowlist before production exposure.
#
# The format guard (regex) rejects injected or malformed strings regardless
# of whether an explicit allowlist is configured.
# ---------------------------------------------------------------------------

_MODEL_HINT_FORMAT_RE = re.compile(r'^[a-zA-Z0-9_\-/.:]+$')
_MODEL_HINT_MAX_LEN = 120


def _load_model_hint_allowlist() -> frozenset:
    raw = os.environ.get("HYPERFLOW_ALLOWED_MODEL_HINTS", "").strip()
    if not raw:
        return frozenset()
    return frozenset(e.strip() for e in raw.split(",") if e.strip())


_MODEL_HINT_ALLOWLIST: frozenset = _load_model_hint_allowlist()
if not _MODEL_HINT_ALLOWLIST:
    import logging as _logging
    _logging.getLogger("hyperflow.core").warning(
        "HYPERFLOW_ALLOWED_MODEL_HINTS is not set. "
        "Any model hint supplied by callers will be accepted. "
        "Set this env var in production to restrict model selection to an approved list."
    )


def _validate_model_hint(hint: Optional[str]) -> Optional[str]:
    """Validate and return a model hint, or raise ValueError if disallowed.

    Rejects hints that:
      - Contain characters outside the safe format allowlist (alphanumerics,
        hyphens, underscores, slashes, dots, colons).
      - Exceed _MODEL_HINT_MAX_LEN characters.
      - Are not in HYPERFLOW_ALLOWED_MODEL_HINTS (when that list is configured).

    Returns None when hint is None or whitespace-only (treated as absent).
    """
    if not hint or not hint.strip():
        return None
    hint = hint.strip()
    if len(hint) > _MODEL_HINT_MAX_LEN:
        raise ValueError(
            f"Model hint is too long ({len(hint)} chars, max {_MODEL_HINT_MAX_LEN}): {hint!r}"
        )
    if not _MODEL_HINT_FORMAT_RE.match(hint):
        raise ValueError(
            f"Model hint contains disallowed characters: {hint!r}. "
            "Only alphanumerics, hyphens, underscores, forward-slashes, dots, "
            "and colons are permitted."
        )
    if _MODEL_HINT_ALLOWLIST and hint not in _MODEL_HINT_ALLOWLIST:
        raise ValueError(
            f"Model hint {hint!r} is not in the allowed list. "
            f"Permitted hints: {sorted(_MODEL_HINT_ALLOWLIST)}"
        )
    return hint


async def _get_client(timeout: float) -> httpx.AsyncClient:
    """Reuse a process-local HTTP client so repeated LLM calls share a pool.

    EX-3: Lock serialises client recreation so concurrent coroutines with
    different timeout values cannot race on aclose() + AsyncClient() creation.
    """
    global _CLIENT, _CLIENT_TIMEOUT
    async with _get_lock():
        if _CLIENT is None or _CLIENT.is_closed or _CLIENT_TIMEOUT != timeout:
            if _CLIENT is not None and not _CLIENT.is_closed:
                await _CLIENT.aclose()
            _CLIENT = httpx.AsyncClient(timeout=timeout)
            _CLIENT_TIMEOUT = timeout
    return _CLIENT


async def close_client() -> None:
    """Close the process-local HTTP client during explicit shutdown/tests."""
    global _CLIENT, _CLIENT_TIMEOUT
    if _CLIENT is not None and not _CLIENT.is_closed:
        await _CLIENT.aclose()
    _CLIENT = None
    _CLIENT_TIMEOUT = None

async def call_model(
    prompt: str,
    intent: str,
    mode: str,
    temperature: float = 0.7,
    model_hint: Optional[str] = None,
) -> tuple[str, str]:
    """
    Call the OpenRouter chat completions endpoint with retry on transient errors.

    model_hint — when provided and non-empty, OVERRIDES the OPENROUTER_MODEL env var.
    This is the execution-level hook for agentRef.runPolicy.modelHint: the hint must
    reach this function to actually change which model is called.

    Returns:
        (output_text, model_used)

    Raises:
        OpenRouterUnavailable on persistent failure.
    """
    # C-1 FIX: validate and allowlist-check the model hint before it reaches
    # the OpenRouter payload.  _validate_model_hint raises ValueError (which
    # the caller maps to OpenRouterUnavailable) on format violations or
    # non-allowlisted values.  This is the single enforcement point for C-1.
    try:
        validated_hint = _validate_model_hint(model_hint)
    except ValueError as exc:
        raise OpenRouterUnavailable(f"Model hint rejected: {exc}") from exc

    api_key = _api_key()

    model = validated_hint or _model()
    retries = _max_retries()

    user_message = (
        f"Intent: {intent}\n"
        f"Mode: {mode}\n"
        f"Prompt: {prompt}"
    )

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user",   "content": user_message},
        ],
        "max_tokens": 512,
        "temperature": temperature,
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type":  "application/json",
        "HTTP-Referer":  "https://hyperflow-operator.replit.app",
        "X-Title":       "Hyperflow Python Core",
    }

    last_exc: Optional[Exception] = None

    # L-4 FIX: full-jitter backoff prevents thundering-herd on concurrent 429s.
    # sleep = random.uniform(0, min(cap, base * 2**attempt))
    _BACKOFF_BASE = 1.0
    _BACKOFF_CAP = 30.0

    def _jittered_sleep_s(attempt: int) -> float:
        return random.uniform(0.0, min(_BACKOFF_CAP, _BACKOFF_BASE * (2 ** attempt)))

    client = await _get_client(_timeout())
    for attempt in range(retries + 1):
        try:
            resp = await client.post(
                f"{_OPENROUTER_BASE}/chat/completions",
                json=payload,
                headers=headers,
            )
            # Retry on transient server-side errors
            if resp.status_code in _RETRY_STATUSES and attempt < retries:
                await asyncio.sleep(_jittered_sleep_s(attempt))
                continue
            resp.raise_for_status()
            data = resp.json()

            try:
                text: str = data["choices"][0]["message"]["content"]
                model_used: str = data.get("model", model)
            except (KeyError, IndexError, TypeError) as exc:
                raise OpenRouterUnavailable(
                    f"Unexpected OpenRouter response shape: {exc}"
                ) from exc

            return text.strip(), model_used

        except httpx.HTTPStatusError as exc:
            last_exc = OpenRouterUnavailable(
                f"OpenRouter HTTP {exc.response.status_code}: {exc.response.text[:200]}"
            )
            if attempt < retries:
                await asyncio.sleep(_jittered_sleep_s(attempt))
                continue
            raise last_exc from exc

        except httpx.RequestError as exc:
            last_exc = OpenRouterUnavailable(f"OpenRouter request error: {exc}")
            if attempt < retries:
                await asyncio.sleep(_jittered_sleep_s(attempt))
                continue
            raise last_exc from exc

    raise last_exc or OpenRouterUnavailable("call_model failed after retries")
