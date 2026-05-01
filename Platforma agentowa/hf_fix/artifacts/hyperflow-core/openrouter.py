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
    api_key = _api_key()
    # model_hint takes priority over the env-configured default.
    # An empty string or whitespace-only hint is treated as absent.
    model = (model_hint.strip() if model_hint and model_hint.strip() else None) or _model()
    retries = _max_retries()
    backoff = 1.0

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
                await asyncio.sleep(backoff * (2 ** attempt))
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
                await asyncio.sleep(backoff * (2 ** attempt))
                continue
            raise last_exc from exc

        except httpx.RequestError as exc:
            last_exc = OpenRouterUnavailable(f"OpenRouter request error: {exc}")
            if attempt < retries:
                await asyncio.sleep(backoff * (2 ** attempt))
                continue
            raise last_exc from exc

    raise last_exc or OpenRouterUnavailable("call_model failed after retries")
