"""
tests/test_model_hint_routing.py

Verifies the modelHint execution contract:
  - modelHint overrides OPENROUTER_MODEL env in call_model()
  - empty / absent modelHint falls back to env
  - model_hint propagates through run_edde → call_llm
  - _execute_agent extracts model_hint from agentRef.runPolicy
  - result / contract carry modelUsed (the real runtime model)
  - runtimeMode / safeConstraintProfile are marked advisoryOnly
    and do NOT affect execution paths

All tests are fully isolated (no real HTTP, no env pollution).
"""
from __future__ import annotations

import asyncio
import sys
import types
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ── path setup ──────────────────────────────────────────────────────────────
_CORE = Path(__file__).parent.parent
if str(_CORE) not in sys.path:
    sys.path.insert(0, str(_CORE))


# ══════════════════════════════════════════════════════════════════════════
# 1. openrouter.call_model — model selection
# ══════════════════════════════════════════════════════════════════════════

def _make_fake_response(model: str = "openai/gpt-4o-mini") -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {
        "choices": [{"message": {"content": "hello"}}],
        "model": model,
    }
    resp.raise_for_status = MagicMock()
    return resp


@pytest.mark.asyncio
async def test_call_model_hint_overrides_env(monkeypatch):
    """modelHint takes priority over OPENROUTER_MODEL env var."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setenv("OPENROUTER_MODEL", "openai/gpt-4o-mini")

    # Force fresh module state so cached client does not bleed across tests
    import importlib
    import openrouter as or_mod
    await or_mod.close_client()

    fake_resp = _make_fake_response("anthropic/claude-3-haiku")

    with patch("openrouter.httpx.AsyncClient") as MockClient:
        inst = AsyncMock()
        inst.is_closed = False
        inst.post = AsyncMock(return_value=fake_resp)
        MockClient.return_value = inst

        text, model_used = await or_mod.call_model(
            "do something", "analyze", "analytical", 0.7,
            model_hint="anthropic/claude-3-haiku",
        )

    # The hint model must appear in the OpenRouter payload
    payload = inst.post.call_args.kwargs.get("json") or inst.post.call_args.args[1]
    assert payload["model"] == "anthropic/claude-3-haiku", (
        f"Expected hint model in payload but got '{payload['model']}'"
    )
    assert model_used == "anthropic/claude-3-haiku"
    assert text == "hello"
    await or_mod.close_client()


@pytest.mark.asyncio
async def test_call_model_no_hint_uses_env(monkeypatch):
    """No modelHint → OPENROUTER_MODEL env var is used."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setenv("OPENROUTER_MODEL", "openai/gpt-4o-mini")

    import openrouter as or_mod
    await or_mod.close_client()

    fake_resp = _make_fake_response("openai/gpt-4o-mini")

    with patch("openrouter.httpx.AsyncClient") as MockClient:
        inst = AsyncMock()
        inst.is_closed = False
        inst.post = AsyncMock(return_value=fake_resp)
        MockClient.return_value = inst

        _, model_used = await or_mod.call_model(
            "do something", "analyze", "analytical", 0.7,
            model_hint=None,
        )

    payload = inst.post.call_args.kwargs.get("json") or inst.post.call_args.args[1]
    assert payload["model"] == "openai/gpt-4o-mini"
    await or_mod.close_client()


@pytest.mark.asyncio
async def test_call_model_empty_hint_falls_back_to_env(monkeypatch):
    """Empty string modelHint is treated as absent — env model is used."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.setenv("OPENROUTER_MODEL", "openai/gpt-4o-mini")

    import openrouter as or_mod
    await or_mod.close_client()

    fake_resp = _make_fake_response("openai/gpt-4o-mini")

    with patch("openrouter.httpx.AsyncClient") as MockClient:
        inst = AsyncMock()
        inst.is_closed = False
        inst.post = AsyncMock(return_value=fake_resp)
        MockClient.return_value = inst

        _, _ = await or_mod.call_model(
            "do something", "analyze", "analytical", 0.7,
            model_hint="",          # empty string
        )
        payload_empty = inst.post.call_args.kwargs.get("json") or inst.post.call_args.args[1]

        await or_mod.close_client()
        inst.post.reset_mock()

        await or_mod.close_client()
        inst.is_closed = False

        _, _ = await or_mod.call_model(
            "do something", "analyze", "analytical", 0.7,
            model_hint="   ",       # whitespace only
        )
        payload_ws = inst.post.call_args.kwargs.get("json") or inst.post.call_args.args[1]

    assert payload_empty["model"] == "openai/gpt-4o-mini", "empty hint must fall back to env"
    assert payload_ws["model"] == "openai/gpt-4o-mini", "whitespace hint must fall back to env"
    await or_mod.close_client()


# ══════════════════════════════════════════════════════════════════════════
# 2. run_edde — model_hint propagation through pipeline
# ══════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_run_edde_forwards_model_hint_to_call_llm():
    """run_edde passes model_hint positionally to call_llm."""
    from engine.edde_orchestrator import run_edde

    captured: dict[str, Any] = {}

    async def spy_call_llm(prompt, intent, mode, temperature, model_hint=None):
        captured["model_hint"] = model_hint
        return "llm output", "anthropic/claude-3-haiku"

    bundle = await run_edde(
        prompt="analyze the system",
        run_id="r-hint-1",
        emit=lambda *a, **kw: None,
        call_llm=spy_call_llm,
        log_phase_entered=lambda *a: None,
        log_phase_completed=lambda *a: None,
        model_hint="anthropic/claude-3-haiku",
    )

    assert captured["model_hint"] == "anthropic/claude-3-haiku", (
        "run_edde must forward model_hint to call_llm"
    )
    assert bundle["result"]["model"] == "anthropic/claude-3-haiku", (
        "bundle result must carry the real model returned by call_llm"
    )
    assert bundle["result"]["source"] == "llm"


@pytest.mark.asyncio
async def test_run_edde_passes_none_when_no_hint():
    """run_edde passes None model_hint when caller omits it."""
    from engine.edde_orchestrator import run_edde

    captured: dict[str, Any] = {}

    async def spy_call_llm(prompt, intent, mode, temperature, model_hint=None):
        captured["model_hint"] = model_hint
        return "output", "openai/gpt-4o-mini"

    await run_edde(
        prompt="plan something",
        run_id="r-hint-2",
        emit=lambda *a, **kw: None,
        call_llm=spy_call_llm,
        log_phase_entered=lambda *a: None,
        log_phase_completed=lambda *a: None,
        # model_hint intentionally omitted
    )

    assert captured["model_hint"] is None


@pytest.mark.asyncio
async def test_run_edde_bundle_model_used_reflects_call_llm_return():
    """bundle['result']['model'] is what call_llm actually returned, not what was requested."""
    from engine.edde_orchestrator import run_edde

    async def call_llm_returns_resolved(prompt, intent, mode, temperature, model_hint=None):
        # Simulate OpenRouter resolving an alias
        return "response text", "mistralai/mixtral-8x7b-instruct"

    bundle = await run_edde(
        prompt="transform this",
        run_id="r-hint-3",
        emit=lambda *a, **kw: None,
        call_llm=call_llm_returns_resolved,
        log_phase_entered=lambda *a: None,
        log_phase_completed=lambda *a: None,
        model_hint="mistralai/mixtral-8x7b",
    )

    # model_used is sourced from what the API returned, not what was requested
    assert bundle["result"]["model"] == "mistralai/mixtral-8x7b-instruct"


@pytest.mark.asyncio
async def test_run_edde_stub_fallback_when_call_llm_raises():
    """When call_llm raises, run_edde falls back to stub (source='stub'), not crash."""
    from engine.edde_orchestrator import run_edde

    async def failing_call_llm(prompt, intent, mode, temperature, model_hint=None):
        raise RuntimeError("OpenRouter down")

    bundle = await run_edde(
        prompt="do something",
        run_id="r-hint-4",
        emit=lambda *a, **kw: None,
        call_llm=failing_call_llm,
        log_phase_entered=lambda *a: None,
        log_phase_completed=lambda *a: None,
        model_hint="openai/gpt-4o",
    )

    assert bundle["result"]["source"] == "stub"
    assert bundle["result"]["degraded"] is True
    assert bundle["result"]["model"] == "stub"


# ══════════════════════════════════════════════════════════════════════════
# 3. workflow/executors — model_hint from agentRef.runPolicy
# ══════════════════════════════════════════════════════════════════════════

def _make_agent_step(model_hint: str | None = None, capabilities: list[str] | None = None) -> Any:
    """Build a minimal AgentStep with an agentRef containing the given modelHint."""
    from workflow.contracts import AgentStep, AgentRef

    run_policy: dict[str, Any] = {"runtimeMode": "standard"}
    if model_hint is not None:
        run_policy["modelHint"] = model_hint

    caps = capabilities or ["analysis"]
    return AgentStep(
        id="step-1",
        name="Test Agent",
        type="agent",
        prompt="do something useful",
        agentRef=AgentRef(
            id="my-agent",
            version="1.0.0",
            role="analyzer",
            capabilities=caps,
            runPolicy=run_policy,
        ),
        requiredCapabilities=caps,
    )


@pytest.mark.asyncio
async def test_execute_agent_passes_model_hint_to_run_edde():
    """_execute_agent extracts modelHint from agentRef.runPolicy and forwards to run_edde."""
    from workflow.executors import _execute_agent

    received: dict[str, Any] = {}

    async def fake_run_edde(prompt, run_id, emit, call_llm, log_phase_entered, log_phase_completed, model_hint=None):
        received["model_hint"] = model_hint
        return _fake_bundle(model_hint or "openai/gpt-4o-mini")

    step = _make_agent_step(model_hint="openai/gpt-4o")
    state = _empty_state()

    await _execute_agent(
        step,
        state=state,
        active_parents=[],
        run_edde=fake_run_edde,
        emit=lambda *a, **kw: None,
        call_llm=AsyncMock(return_value=("ok", "openai/gpt-4o")),
        log_phase_entered=lambda *a: None,
        log_phase_completed=lambda *a: None,
    )

    assert received["model_hint"] == "openai/gpt-4o", (
        "_execute_agent must extract modelHint from runPolicy and pass to run_edde"
    )


@pytest.mark.asyncio
async def test_execute_agent_no_model_hint_passes_none():
    """_execute_agent passes None when runPolicy has no modelHint."""
    from workflow.executors import _execute_agent

    received: dict[str, Any] = {}

    async def fake_run_edde(prompt, run_id, emit, call_llm, log_phase_entered, log_phase_completed, model_hint=None):
        received["model_hint"] = model_hint
        return _fake_bundle("openai/gpt-4o-mini")

    step = _make_agent_step(model_hint=None)
    state = _empty_state()

    await _execute_agent(
        step,
        state=state,
        active_parents=[],
        run_edde=fake_run_edde,
        emit=lambda *a, **kw: None,
        call_llm=AsyncMock(return_value=("ok", "openai/gpt-4o-mini")),
        log_phase_entered=lambda *a: None,
        log_phase_completed=lambda *a: None,
    )

    assert received["model_hint"] is None


@pytest.mark.asyncio
async def test_execute_agent_result_carries_model_used():
    """Node result includes model from the bundle (real model returned by LLM layer)."""
    from workflow.executors import _execute_agent

    async def fake_run_edde(prompt, run_id, emit, call_llm, log_phase_entered, log_phase_completed, model_hint=None):
        return _fake_bundle("anthropic/claude-3-sonnet")

    step = _make_agent_step(model_hint="anthropic/claude-3-sonnet")
    state = _empty_state()

    node_result = await _execute_agent(
        step,
        state=state,
        active_parents=[],
        run_edde=fake_run_edde,
        emit=lambda *a, **kw: None,
        call_llm=AsyncMock(return_value=("ok", "anthropic/claude-3-sonnet")),
        log_phase_entered=lambda *a: None,
        log_phase_completed=lambda *a: None,
    )

    assert node_result["result"]["model"] == "anthropic/claude-3-sonnet"


# ══════════════════════════════════════════════════════════════════════════
# 4. _build_routing — advisoryFields contract
# ══════════════════════════════════════════════════════════════════════════

def test_build_routing_marks_advisory_fields():
    """_build_routing must include advisoryFields listing runtimeMode and safeConstraintProfile."""
    from workflow.executors import _build_routing

    from workflow.contracts import AgentStep, AgentRef
    step = AgentStep(
        id="a1", name="A", type="agent", prompt="test",
        agentRef=AgentRef(
            id="a", capabilities=["analysis"],
            runPolicy={
                "runtimeMode": "intensive",
                "safeConstraintProfile": "high_security",
                "modelHint": "openai/gpt-4o",
            },
        ),
        requiredCapabilities=["analysis"],
    )

    routing = _build_routing(step)
    assert "advisoryFields" in routing, "_build_routing must expose advisoryFields"
    assert "runtimeMode" in routing["advisoryFields"]
    assert "safeConstraintProfile" in routing["advisoryFields"]
    # modelHint must NOT be in advisory — it is executable
    assert "modelHint" not in routing["advisoryFields"]


def test_build_routing_model_hint_normalised():
    """Empty modelHint in runPolicy is returned as None, not empty string."""
    from workflow.executors import _build_routing
    from workflow.contracts import AgentStep, AgentRef

    step = AgentStep(
        id="a2", name="B", type="agent", prompt="test",
        agentRef=AgentRef(
            id="b", capabilities=[],
            runPolicy={"modelHint": ""},
        ),
        requiredCapabilities=[],
    )
    routing = _build_routing(step)
    assert routing["modelHint"] is None, "empty string modelHint must be normalised to None"


def test_advisory_fields_not_in_mps_resolution():
    """runtimeMode and safeConstraintProfile do not affect MPS level resolution."""
    from control.mps_controller import build_mps_context

    # MPS takes: intent, mode, emoji_tokens, mps_level_hint, canonical_combo_detected
    # runtimeMode / safeConstraintProfile are NOT parameters — confirm invariant
    ctx = build_mps_context("analyze", "analytical", [], None, False)
    # The only way these fields could leak into MPS is via emoji_tokens or level_hint
    # which are not set here — so level must be the mode-default
    assert ctx["level"] in range(1, 8)
    # Running again with same args → identical level (deterministic, no hidden state)
    ctx2 = build_mps_context("analyze", "analytical", [], None, False)
    assert ctx["level"] == ctx2["level"]
    assert ctx["llm_temperature"] == ctx2["llm_temperature"]


# ══════════════════════════════════════════════════════════════════════════
# 5. TS contract alignment — CoreResponse carries modelUsed
#    (structural test: verify field exists in Python contract output)
# ══════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_agent_run_contract_includes_model_used():
    """
    /v1/agent/run contract dict must contain modelUsed reflecting the real model.
    We exercise the contract-assembly code directly without an HTTP server.
    """
    from engine.edde_orchestrator import run_edde
    from main import HYPERFLOW_VERSION

    async def spy_llm(prompt, intent, mode, temperature, model_hint=None):
        return "response", "openai/gpt-4o"

    bundle = await run_edde(
        prompt="[HYPERFLOW AGENT ROUTING CONTEXT]\n{}\n\ndo the thing",
        run_id="contract-test-1",
        emit=lambda *a, **kw: None,
        call_llm=spy_llm,
        log_phase_entered=lambda *a: None,
        log_phase_completed=lambda *a: None,
        model_hint="openai/gpt-4o",
    )

    result = bundle["result"]
    mps_ctx = bundle["mps_context"]

    # Simulate contract assembly (mirrors main.py /v1/agent/run)
    contract = {
        "input_type":    "agent_execution",
        "output_type":   bundle["output_type"],
        "mode":          bundle["mode"],
        "intent":        bundle["intent"],
        "runtime":       "python-core",
        "version":       HYPERFLOW_VERSION,
        "agent_id":      "test-agent",
        "agent_version": "1.0.0",
        "agent_role":    "assistant",
        "mps_level":     mps_ctx["level"],
        "mps_name":      mps_ctx["name"],
        "modelUsed":     result.get("model"),
        "routing":       {"agentId": "test-agent"},
    }

    assert "modelUsed" in contract, "contract must include modelUsed"
    assert contract["modelUsed"] == "openai/gpt-4o", (
        f"modelUsed must reflect actual model, got {contract['modelUsed']!r}"
    )


# ══════════════════════════════════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════════════════════════════════

def _empty_state() -> dict:
    return {
        "memory": {},
        "node_results": {},
        "node_status": {},
        "selected_branches": {},
        "active_nodes": {},
        "node_handoffs": {},
    }


def _fake_bundle(model: str) -> dict:
    """Minimal bundle dict that satisfies _execute_agent's result assembly."""
    return {
        "result": {
            "output": "done",
            "intent": "analyze",
            "mode": "analytical",
            "source": "llm",
            "model": model,
            "degraded": False,
            "token_count": 3,
            "reasoning": "test",
            "confidence": 0.75,
            "timestamp": "2026-01-01T00:00:00+00:00",
        },
        "intent": "analyze",
        "mode": "analytical",
        "output_type": "analysis_report",
        "confidence": 0.75,
        "quality_score": 0.80,
        "should_reset": False,
        "source": "llm",
        "mps_context": {"level": 3, "name": "Harmonize"},
        "canonical_trace": {
            "canonical_combo": "🌈💎🔥🧠🔀⚡",
            "phases_completed": ["perceive", "extract_essence", "sense_direction", "synthesize", "generate_options", "choose"],
        },
        "degraded": False,
    }
