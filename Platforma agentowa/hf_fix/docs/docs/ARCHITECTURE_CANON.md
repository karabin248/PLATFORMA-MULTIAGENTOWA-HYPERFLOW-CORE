# Hyperflow — Canonical Architecture

**Updated:** 2026-05-01
**Status:** Canonical — verified against source (v6 audit)

---

## System Identity

Hyperflow is a TypeScript orchestration shell backed by a Python runtime core.
The TS shell owns HTTP routing, request validation, DB persistence, and operator
lifecycle. The Python core owns all live execution — prompt processing, step
sequencing, quality scoring, repository enrichment, and graph computation.

---

## Runtime Components

| Component | Language | Role |
|---|---|---|
| `artifacts/api-server` | TypeScript / Express 5 | HTTP API, agent/workflow registries, DB persistence, approval/checkpoint lifecycle, executor polling loop |
| `artifacts/hyperflow-core` | Python / FastAPI | Execution authority — EDDE pipeline, agent runs, workflow sequencing, repo scanning, graph derivation |
| `artifacts/operator-panel` | React / Vite | Operator UI — browse agents, view runs, inspect history, metrics |
| `lib/db` | TypeScript / Drizzle ORM | PostgreSQL schema and query layer |
| `lib/api-spec` | OpenAPI 3.1 + Orval | API contract; generates `@workspace/api-zod` validation schemas |

---

## Authority Partition (Canonical)

**Python core is the sole execution authority for:**

- Agent prompt execution (`POST /v1/run`, `POST /v1/agent/run`)
- Workflow step sequencing with topological sort (`POST /v1/workflow/run`)
- Workflow failure-resume with completed-node carry-forward (`POST /v1/workflow/resume`)
- Approval gate continuation (`POST /v1/workflow/continue/approval`)
- Human-input gate continuation (`POST /v1/workflow/continue/human-input`)
- Repository enrichment: language detection, classification, dependency counting, overlap scoring (`POST /v1/repositories/scan`)
- Repository graph derivation: overlap pairs + heuristic edges (`POST /v1/repositories/graph`)

**TypeScript shell owns:**

- Agent registry (`src/domain/agents.ts`) — agent definitions, capabilities, prompt templates
- Workflow registry (`src/domain/workflows.ts`) — workflow definitions, step graphs
- HTTP routing and request validation (`src/routes/*.ts`)
- DB persistence of all Python-returned values via:
  - `src/lib/workflowProjection.ts` — workflow run snapshots, checkpoints, state log
  - `src/routes/agentRuns.ts` — agent run records, retry chain, cancel
- Executor polling loop (`src/lib/workflowExecutor.ts`) — lease TTL, stale recovery, re-queue
- Checkpoint creation and supersede/resume lifecycle (`src/lib/workflowProjection.ts`)
- Run enrichment: joining `lastRunAt`/`lastRunStatus` from DB for agent and workflow listings
- Python Core HTTP client (`src/lib/pythonClient.ts`)

> **Note:** `src/orchestrator/storage.ts` is **deprecated**. It writes to the
> legacy `runs`/`run_nodes` schema which is preserved for historical compatibility
> only. All live agent and workflow runs use `agentRunsTable` and `workflowRunsTable`
> respectively. Do not add new writes via `storage.ts`.

---

## What TypeScript Does NOT Own

TypeScript does not compute any of the following:

- Prompt execution or LLM calls
- Workflow step ordering or dependency resolution
- EDDE phase sequencing or canonical combo detection
- Quality scoring
- Repository language/classification/overlap values
- Graph edge or overlap-pair computation

If any of these appear as local TS computations, that is a regression.

---

## Key Files

| File | Purpose |
|---|---|
| `artifacts/api-server/src/routes/agents.ts` | Agent CRUD routes |
| `artifacts/api-server/src/routes/agentRuns.ts` | Agent run execution, retry, cancel, metrics |
| `artifacts/api-server/src/routes/workflows.ts` | Workflow CRUD + run routes |
| `artifacts/api-server/src/routes/approvals.ts` | Approval decision routes → delegates to Python |
| `artifacts/api-server/src/routes/humanInputs.ts` | Human-input submission routes → delegates to Python |
| `artifacts/api-server/src/routes/repositories.ts` | Repository list, scan, graph routes |
| `artifacts/api-server/src/routes/health.ts` | Health check route |
| `artifacts/api-server/src/lib/workflowProjection.ts` | Atomic workflow DB writes (snapshot, checkpoint, stateLog) |
| `artifacts/api-server/src/lib/workflowExecutor.ts` | Executor polling loop — lease TTL, stale recovery |
| `artifacts/api-server/src/lib/pythonClient.ts` | Python Core HTTP client with typed payloads/responses |
| `artifacts/api-server/src/orchestrator/storage.ts` | **DEPRECATED** — legacy persistence (runsTable). Do not use. |
| `artifacts/api-server/src/orchestrator/types.ts` | Shared TS types (CheckpointStatus, etc.) |
| `artifacts/hyperflow-core/main.py` | Python core — all execution authority |
| `lib/db/src/schema/index.ts` | DB schema barrel export |

---

## Database Tables

| Table | Schema file | Owner | Purpose |
|---|---|---|---|
| `agents` | `lib/db/src/schema/agents.ts` | TS | Agent definitions with capabilities, policy, prompt template |
| `agent_runs` | `lib/db/src/schema/agentRuns.ts` | TS | Per-run records for agent executions (retry chain, quality score, canonical trace) |
| `agent_revisions` | `lib/db/src/schema/agentRevisions.ts` | TS | Agent spec snapshots on every PATCH |
| `workflows` | `lib/db/src/schema/workflows.ts` | TS | Workflow definitions |
| `workflow_runs` | `lib/db/src/schema/workflowRuns.ts` | TS | Workflow run records (status, lease, stateLog, executor lifecycle) |
| `workflow_run_nodes` | `lib/db/src/schema/workflowRunNodes.ts` | TS | Per-node results for each workflow run |
| `workflow_revisions` | `lib/db/src/schema/workflowRevisions.ts` | TS | Workflow spec snapshots on every update |
| `checkpoints` | `lib/db/src/schema/checkpoints.ts` | TS | Resumability markers per node (status: active/superseded/resumed/rolled_back) |
| `repositories` | `lib/db/src/schema/repositories.ts` | TS | Repository inventory with enrichment fields |
| `log_events` | `lib/db/src/schema/log-events.ts` | TS (legacy) | Structured log events (legacy system, still present) |
| `runs` | `lib/db/src/schema/runs.ts` | TS (legacy) | Legacy run records — superseded by agent_runs + workflow_runs |
| `run_nodes` | `lib/db/src/schema/run-nodes.ts` | TS (legacy) | Legacy node records — superseded by workflow_run_nodes |

---

## Environment

- `PYTHON_CORE_URL` — base URL for Python core (default: `http://localhost:8000`)
- `DATABASE_URL` — PostgreSQL connection string
- `API_TOKEN` — Bearer token for TS API (required in `HARDENED_MODE=true`)
- `HARDENED_MODE` — `"true"` (default) enforces auth; `"false"` bypasses all auth (dev only)
- `HYPERFLOW_CORE_TOKEN` — internal token TS sends to Python; Python validates on all write endpoints
- `OPENROUTER_API_KEY` — optional; Python core uses stub mode without it
- `OPENROUTER_MODEL` — model to use; overridable per-request via `modelHint`
