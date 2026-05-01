# Agent Platform Architecture (Phase 3)

## Overview

The Agent Platform extends Hyperflow's canonical EDDE pipeline with formal agent identity, persistent run history, operator visibility, execution policy, and full lifecycle management — without breaking the canonical core.

## Three-Layer Architecture

```
┌──────────────────────────────────┐
│      Operator Panel (React)      │  Browse agents, execute runs, inspect history,
│      artifacts/operator-panel    │  create/edit agents, view metrics & revisions
│                                  │  Port: dynamic (Vite dev server)
├──────────────────────────────────┤
│      API Server (Express 5)      │  Agent registry, run persistence, orchestration,
│      artifacts/api-server        │  metrics, revisions, retry/cancel lifecycle
│                                  │  Port: 8080
├──────────────────────────────────┤
│    Hyperflow Python Core         │  EDDE pipeline, MPS, intent resolution
│    artifacts/hyperflow-core      │  Port: 8000
└──────────────────────────────────┘
            │
     ┌──────┴──────┐
     │  PostgreSQL  │  agents + agent_runs + agent_revisions tables
     └─────────────┘
```

## Domain Model

### AgentSpec (agents table)
| Field | Type | Description |
|-------|------|-------------|
| id | text PK | Unique agent identifier (e.g., `agent-general-assistant`) |
| name | text | Human-readable name |
| version | text | Semantic version |
| description | text | What this agent does |
| status | text | `active` / `disabled` / `deprecated` |
| role | text | Agent role (assistant, analyst, planner) |
| capabilities | jsonb | Array of capability tags |
| inputSchema | jsonb | Optional JSON Schema for input validation |
| outputSchema | jsonb | Optional JSON Schema for output validation |
| runtimeMode | text | Execution mode hint (standard, fast, careful, creative) |
| executionPolicy | jsonb | Timeout, retries, model hint, constraint profile |
| promptTemplate | text | Mustache-style template with `{{input.prompt}}` |
| tags | jsonb | Searchable tags |
| owner | text | Who owns this agent |

### AgentRunRecord (agent_runs table)
| Field | Type | Description |
|-------|------|-------------|
| id | text PK | Run UUID |
| agentId | text FK | References agents.id |
| agentVersion | text | Version at execution time |
| status | text | `queued` → `running` → `completed` / `failed` / `cancelled` |
| input | jsonb | Original input payload |
| resolvedPrompt | text | Final prompt sent to core |
| runtimeRequest | jsonb | Request sent to Python Core |
| runtimeResponse | jsonb | Full response from Python Core |
| output | jsonb | Extracted result |
| normalizedOutput | jsonb | Normalized output (summary, structured, warnings, quality) |
| rawOutput | jsonb | Unprocessed runtime response |
| error | text | Error message if failed |
| runtimeRunId | text | Run ID from Python Core |
| qualityScore | real | EDDE quality score (0-1) |
| parentRunId | text | Links retry to direct parent run |
| originRunId | text | Links retry to original (root) run |
| retryCount | int | Number of retries from origin |
| retryReason | text | Reason for retry (optional) |
| requestedBy | text | Who triggered the run |
| correlationId | text | Correlation ID for tracing |
| durationMs | int | Wall-clock milliseconds |
| queuedAt | timestamp | When the run was queued |
| startedAt | timestamp | When execution began |
| completedAt | timestamp | When execution finished successfully |
| failedAt | timestamp | When execution failed |
| cancelledAt | timestamp | When execution was cancelled |

### AgentRevision (agent_revisions table)
| Field | Type | Description |
|-------|------|-------------|
| id | serial PK | Revision ID |
| agentId | text FK | References agents.id |
| revisionNumber | int | Sequential revision number per agent |
| spec | jsonb | Full agent spec snapshot at this revision |
| changedFields | jsonb | Array of field names that changed |
| changedBy | text | Who made the change |
| createdAt | timestamp | When the revision was created |

## API Endpoints

### Agent Management
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/agents` | GET | List agents (filter by status, role; pagination) |
| `/api/agents` | POST | Create a new agent |
| `/api/agents/:id` | GET | Get agent detail |
| `/api/agents/:id` | PATCH | Update agent (creates revision) |
| `/api/agents/:id/disable` | POST | Disable an agent |
| `/api/agents/:id/enable` | POST | Re-enable a disabled agent |
| `/api/agents/:id/revisions` | GET | Get revision history |
| `/api/agents/seed` | POST | Seed default agents |

### Agent Runs
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/agents/run` | POST | Execute an agent |
| `/api/agent-runs` | GET | List runs (full filter support) |
| `/api/agent-runs/metrics` | GET | Aggregate run metrics |
| `/api/agent-runs/:id` | GET | Get run detail (includes retry chain) |
| `/api/agent-runs/:id/retry` | POST | Retry a failed run |
| `/api/agent-runs/:id/cancel` | POST | Cancel a queued/running run |
| `/api/agent-runs/:id/resume` | POST | 405 — not supported (use retry) |

### Run List Filters
The `GET /api/agent-runs` endpoint supports:
- `agentId` — filter by agent
- `status` — filter by status (queued, running, completed, failed, cancelled)
- `requestedBy` — filter by requester
- `from` / `to` — date range (ISO-8601)
- `hasError` — only runs with errors
- `minQualityScore` — minimum quality threshold
- `retryOf` — runs retrying a specific origin
- `q` — full-text search across prompts, errors, IDs
- `limit` / `offset` — pagination

## Execution Flow

1. Operator submits run via Operator Panel or API
2. API Server validates agent exists and is active
3. API Server creates `agent_runs` record with status `running`
4. API Server calls Python Core `POST /v1/agent/run`
5. Python Core runs full EDDE pipeline, returns enriched result
6. API Server normalizes output and updates `agent_runs` with output, quality score, timing
7. Response returned to caller with normalized output and canonical trace

## Retry Flow

1. Only failed runs can be retried
2. A new run record is created with `parentRunId` pointing to the direct parent
3. `originRunId` points to the root of the retry chain
4. `retryCount` increments from the origin
5. The original run remains **unchanged** (its status stays `failed`)
6. The new child run follows the same execution flow as above
7. Response includes `originalRunId`, `retryRunId`, `originRunId`, and `retryCount`

## Cancel Flow

1. Only `queued` or `running` runs can be cancelled
2. Cancellation sets status to `cancelled` and records `cancelledAt`
3. Terminal runs (completed, failed, cancelled) cannot be cancelled (409)

## Agent Lifecycle

1. **Create** — `POST /api/agents` with spec; status defaults to `active`
2. **Update** — `PATCH /api/agents/:id`; creates a revision snapshot
3. **Disable** — `POST /api/agents/:id/disable`; prevents new runs
4. **Enable** — `POST /api/agents/:id/enable`; re-activates the agent
5. **Revisions** — `GET /api/agents/:id/revisions`; full history with changed fields

## Normalized Output

Every completed run produces a `normalizedOutput` alongside the raw output:

```json
{
  "summary": "Human-readable summary of the result",
  "structured": { ... },
  "artifacts": ["list", "of", "artifact", "references"],
  "qualityScore": 0.85,
  "warnings": ["any", "warnings"],
  "nextSuggestedAction": "optional next step"
}
```

## Metrics

`GET /api/agent-runs/metrics` returns:

```json
{
  "total": 150,
  "completed": 120,
  "failed": 15,
  "cancelled": 5,
  "retried": 10,
  "avgDurationMs": 1234,
  "avgQualityScore": 0.82
}
```

## Seed Agents

Three agents ship by default:

| ID | Name | Role | Capabilities |
|----|------|------|-------------|
| agent-general-assistant | General Assistant | assistant | natural_language, analysis, generation, explanation |
| agent-code-analyst | Code Analyst | analyst | code_analysis, code_review, transformation |
| agent-planner | Planning Agent | planner | planning, decomposition, workflow_generation |

## Canonical Semantics Ownership

The execution cycle `🌈💎🔥🧠🔀⚡` is the non-negotiable canonical spine of the platform.

### Authority Model

| Component | Role | May define | May consume | May store | May render |
|-----------|------|-----------|-------------|-----------|------------|
| Hyperflow Core | Execution authority | Yes | — | — | — |
| API Server | Observer/shell | No | Yes | Yes | No |
| Operator Panel | Display surface | No | Yes | No | Yes |

### Runtime Source of Truth

```
artifacts/hyperflow-core/language/emoji_parser.py
  CANONICAL_COMBO  = "🌈💎🔥🧠🔀⚡"
  CANONICAL_PHASES = ["perceive", "extract_essence", "sense_direction", "synthesize", "generate_options", "choose"]
```

`emoji_parser.py` is the **executable runtime source of truth** — all EDDE
execution reads combo and phases directly from this module at import time.

`configs/canonical_semantics.json` is a **reference/config mirror** — a
machine-readable copy used by CI assertions and documentation tooling. It
does **not** drive runtime behavior.

Drift between the two is prevented by `TestCanonicalConfig` in
`test_canonical_semantics.py`, which loads both the Python constants and the
JSON file and asserts exact equality on combo, phases, symbol mapping, and
authority field. The `make canonical-check` CI gate runs this on every push.

### Canonical Trace in Persistence

Every `agent_runs` record stores a `canonical_trace` JSONB column containing:
- `canonical_combo` — the emoji combo string
- `canonical_phases` — the 6-phase ordered list
- `phases_completed` — which phases actually ran
- `terminal_phase` — always `"choose"`
- `order_preserved` — boolean invariant
- `cycle_version`, `mps_level`, `mps_name`, `canonical_combo_detected`

### Protection Mechanism

CI gate `make canonical-check` validates:
1. Runtime combo and phases match expected values
2. Config file matches runtime
3. No redefinition patterns in api-server or operator-panel source
4. 21 canonical regression tests pass

## Core Principle

The Python Core remains the **canonical and sole owner** of all execution logic. The API Server never duplicates EDDE pipeline logic — it delegates to the Core and adds persistence, registry, and operator visibility on top.
