# Hyperflow Runtime Contract

**Version:** 0.3.0
**Authority:** `artifacts/hyperflow-core/`
**Updated:** 2026-05-01

This document defines the canonical output shape of the Hyperflow Python runtime.
Every field listed here is part of the stable contract. The TypeScript shell reads
these fields by name — changes require coordinated migration.

---

## Contract version

```
contract_version: "0.3.0"
```

Reported in `GET /v1/health` and in `contract.version` of `POST /v1/run` responses.
One canonical version string in `hyperflow/__init__.py` as `__version__`.

---

## Canonical phase names

Defined in `language/emoji_parser.py` (runtime source of truth), mirrored in
`configs/canonical_semantics.json` (reference config).

| Position | Phase | Emoji |
|---|---|---|
| 1 | `perceive` | 🌈 |
| 2 | `extract_essence` | 💎 |
| 3 | `sense_direction` | 🔥 |
| 4 | `synthesize` | 🧠 |
| 5 | `generate_options` | 🔀 |
| 6 | `choose` | ⚡ |

Phase order is fixed and enforced by construction. All 6 phases complete on every
run — no skipping.

---

## Endpoint contract table

| Endpoint | Method | Stable | Notes |
|---|---|---|---|
| `/v1/health` | GET | ✅ | Health shape below |
| `/v1/logs/recent` | GET | ✅ | Query param: `limit` (1–200) |
| `/v1/session` | GET | ✅ | In-process session ring buffer summary |
| `/v1/mps-profiles` | GET | ✅ | MPS level reference table |
| `/v1/explore` | POST | ✅ | Emoji-aware path exploration, no LLM call |
| `/v1/run` | POST | ✅ | Full 6-phase EDDE pipeline (basic path) |
| `/v1/agent/run` | POST | ✅ | Agent-platform execution with identity context |
| `/v1/workflow/run` | POST | ✅ | Multi-step workflow with DAG topo sort |
| `/v1/workflow/resume` | POST | ✅ | Resume from completed node set (failure recovery) |
| `/v1/workflow/continue/approval` | POST | ✅ | Resume workflow past approval gate |
| `/v1/workflow/continue/human-input` | POST | ✅ | Resume workflow past human-input gate |
| `/v1/repositories/scan` | POST | ✅ | Clone + classify + extract deps |
| `/v1/repositories/graph` | POST | ✅ | Build dependency + affinity graph |

---

## `GET /v1/health` response shape

```json
{
  "status": "ok",
  "service": "hyperflow-python-core",
  "version": "0.3.0",
  "runtime_authority": "python-core",
  "canonical_combo": "🌈💎🔥🧠🔀⚡",
  "canonical_phases": ["perceive", "extract_essence", "sense_direction", "synthesize", "generate_options", "choose"],
  "mps_levels": 7
}
```

---

## `POST /v1/run` — request

```json
{
  "prompt": "string (required)",
  "type":   "string (optional, default: 'agent')",
  "name":   "string (optional)"
}
```

## `POST /v1/run` — response (success)

```json
{
  "run_id":           "uuid4",
  "intent":           "plan | analyze | generate | transform | explain | query | classify | validate | optimize | monitor | process",
  "mode":             "planning | analytical | generative | transformative | explanatory | retrieval | verification | observational",
  "output_type":      "execution_plan | analysis_report | generated_artifact | ...",
  "result": {
    "output":      "string",
    "intent":      "string",
    "mode":        "string",
    "token_count": "integer",
    "reasoning":   "string",
    "confidence":  "float 0–1",
    "source":      "llm | stub",
    "model":       "string — actual runtime model used",
    "timestamp":   "ISO-8601"
  },
  "contract": {
    "input_type":  "natural_language",
    "output_type": "string",
    "mode":        "string",
    "intent":      "string",
    "runtime":     "python-core",
    "version":     "0.3.0",
    "mps_level":   "integer 1–7",
    "mps_name":    "string",
    "modelUsed":   "string — real runtime model (reflects modelHint if provided)",
    "constraints": {
      "max_tokens":           2048,
      "confidence_threshold": 0.60
    }
  },
  "quality_score":    "float 0–1",
  "should_reset":     "boolean",
  "knowledge_format": "structured_insight | final_insight | fragment_standard",
  "modelUsed":        "string — top-level alias for contract.modelUsed",
  "canonical_combo":  "🌈💎🔥🧠🔀⚡",
  "canonical_phases": ["perceive", "extract_essence", "sense_direction", "synthesize", "generate_options", "choose"],
  "canonical_trace": {
    "canonical_combo":          "🌈💎🔥🧠🔀⚡",
    "canonical_phases":         ["perceive", "extract_essence", "sense_direction", "synthesize", "generate_options", "choose"],
    "phases_completed":         ["perceive", "extract_essence", "sense_direction", "synthesize", "generate_options", "choose"],
    "terminal_phase":           "choose",
    "order_preserved":          true,
    "cycle_version":            "1.0",
    "mps_level":                "integer 1–7",
    "mps_name":                 "string",
    "canonical_combo_detected": "boolean"
  },
  "runId":       "uuid4 (same as run_id — TS persistence layer alias)",
  "type":        "string",
  "name":        "string",
  "status":      "completed",
  "progress":    100,
  "startedAt":   "ISO-8601",
  "completedAt": "ISO-8601"
}
```

---

## `POST /v1/agent/run` — Agent Platform Execution

Agent execution uses the same canonical EDDE pipeline as `/v1/run` but accepts
a formal `AgentExecutionRequest` with agent identity, version, role, capabilities,
and execution policy.

### Request

```json
{
  "agent_id":           "string (required)",
  "agent_version":      "string (default: '1.0.0')",
  "prompt":             "string (required)",
  "agent_role":         "string (optional, default: 'assistant')",
  "agent_capabilities": ["string"],
  "run_policy": {
    "runtimeMode":           "standard | intensive  (advisory — no execution logic)",
    "modelHint":             "string — overrides OPENROUTER_MODEL in OpenRouter payload",
    "safeConstraintProfile": "string (advisory — no enforcement logic)"
  },
  "context": {}
}
```

### Response (success)

Same envelope as `/v1/run` plus:

```json
{
  "agent_id":      "string",
  "agent_version": "string",
  "contract": {
    "input_type":    "agent_execution",
    "agent_id":      "string",
    "agent_version": "string",
    "agent_role":    "string",
    "modelUsed":     "string — actual model used (reflects modelHint if provided)",
    "routing": {
      "agentId":               "string",
      "modelHint":             "string | null",
      "runtimeMode":           "string",
      "advisoryFields":        ["runtimeMode", "safeConstraintProfile"],
      "safeConstraintProfile": "string | null"
    }
  },
  "modelUsed": "string"
}
```

### modelHint execution semantics

`run_policy.modelHint` is **executable** — it propagates through:
```
agentRef.runPolicy.modelHint
  → _build_routing() → model_hint (None if empty/absent)
  → _execute_agent() → run_edde(model_hint=...)
  → call_llm(model_hint=...)
  → call_model(model_hint=...) → OpenRouter API payload["model"]
```

`runtimeMode` and `safeConstraintProfile` are **advisory** — they appear in the
prompt preamble context only and have no execution logic keyed on them.

### Agent execution guarantees

- Uses the same EDDE 6-phase pipeline as baseline `/v1/run`
- Same `canonical_combo` and `canonical_phases` — never reinterpreted
- Agent identity is attached to the response but does not alter the execution spine
- All 6 phases complete on every run — no skipping or bypassing
- `modelUsed` reflects the actual OpenRouter model returned by the API

---

## `POST /v1/workflow/run` — Workflow Sequencing

### Request

```json
{
  "workflowId": "string",
  "name":       "string",
  "steps": [
    {
      "id":         "string",
      "type":       "agent | tool | condition | approval | human | join | compensation",
      "name":       "string",
      "prompt":     "string (for agent steps)",
      "dependsOn":  ["string"],
      "agentRef": {
        "id":         "string",
        "version":    "string",
        "role":       "string",
        "capabilities": ["string"],
        "runPolicy":  { "modelHint": "string", "runtimeMode": "string" }
      },
      "requiredCapabilities": ["string"],
      "handoffContract": { "artifactKeys": ["string"], "openQuestions": ["string"] }
    }
  ],
  "edges": [
    { "from": "string", "to": "string", "condition": "string (optional)" }
  ],
  "input": {}
}
```

### Response (success)

```json
{
  "status":        "completed | failed | waiting_approval | waiting_input | cancelled",
  "nodes": [
    {
      "nodeId":      "string",
      "name":        "string",
      "status":      "succeeded | failed | skipped | waiting_approval | waiting_input",
      "result":      {},
      "startedAt":   "ISO-8601",
      "completedAt": "ISO-8601"
    }
  ],
  "blockedNodeId":   "string | null",
  "blockedNodeType": "approval | human | null",
  "snapshot":        {}
}
```

---

## `POST /v1/workflow/continue/approval` — Approval Continuation

### Request

```json
{
  "runId":          "string",
  "nodeId":         "string",
  "workflowId":     "string",
  "name":           "string",
  "steps":          [],
  "edges":          [],
  "completedNodes": [],
  "approvedBy":     "string (optional)"
}
```

### Response

Same shape as `/v1/workflow/run` response. After successful approval, execution
resumes from the node past the approval gate.

---

## `POST /v1/workflow/continue/human-input` — Human-Input Continuation

### Request

```json
{
  "runId":          "string",
  "nodeId":         "string",
  "workflowId":     "string",
  "name":           "string",
  "steps":          [],
  "edges":          [],
  "completedNodes": [],
  "humanInput":     {},
  "actorId":        "string (optional)"
}
```

### Response

Same shape as `/v1/workflow/run` response. After successful input submission,
execution resumes from the node past the human-input gate.

---

## Normalized Output Contract

The API Server produces a `normalizedOutput` for every completed agent run:

```json
{
  "summary":             "string",
  "structured":          {},
  "artifacts":           ["string"],
  "qualityScore":        "float 0–1 | null",
  "warnings":            ["string"],
  "nextSuggestedAction": "string | null"
}
```

---

## MPS levels

| Level | Name | Temperature | Max candidates |
|---|---|---|---|
| 1 | Observation | 0.3 | 1 |
| 2 | Stabilize | 0.5 | 2 |
| 3 | Harmonize | 0.65 | 3 |
| 4 | Amplify | 0.75 | 3 |
| 5 | Dominant Core | 0.85 | 3 |
| 6 | Satellite Ops | 0.90 | 3 |
| 7 | Emergency | 0.2 | 1 |

---

## Stability guarantees

- All fields in the response tables above are **stable** in v0.3.x
- `modelUsed` is present on every completed run (both `/v1/run` and `/v1/agent/run`)
- `canonical_trace` is **additive** — present on success, absent on error fallback
- `runId` (camelCase) is an alias for `run_id` maintained for TS persistence compatibility
- `normalizedOutput` is guaranteed present for all completed agent runs; absent for failed/cancelled

---

## Breaking change policy

No field in the stable contract above may be removed or renamed without:
1. A new contract version bump in `pyproject.toml`
2. A migration note in this document
3. A corresponding update to `artifacts/api-server/src/lib/pythonClient.ts`
4. Verified passing tests in both `artifacts/hyperflow-core/tests/` and `artifacts/api-server/tests/`
