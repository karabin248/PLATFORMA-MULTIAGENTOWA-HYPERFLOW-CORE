# Hyperflow — Canonical Architecture

**Frozen:** 2026-04-04
**Status:** Canonical — verified by source audit

---

## System Identity

Hyperflow is a TypeScript orchestration shell backed by a Python runtime core.
The TS shell owns persistence, manifests (agent/workflow registries), HTTP routing,
and request validation. The Python core owns all live execution — prompt processing,
step sequencing, quality scoring, repository enrichment, and graph computation.

---

## Runtime Components

| Component | Language | Role |
|---|---|---|
| `artifacts/api-server` | TypeScript / Express 5 | HTTP API, manifest registries, DB persistence, checkpoint lifecycle |
| `artifacts/hyperflow-core` | Python / FastAPI | Execution authority — agent runs, workflow sequencing, repo scanning, graph derivation |
| `lib/db` | TypeScript / Drizzle ORM | PostgreSQL schema and query layer |
| `lib/api-spec` | OpenAPI 3.1 + Orval | API contract; generates `@workspace/api-zod` validation schemas |

---

## Authority Partition (Canonical)

**Python core is the sole execution authority for:**

- Agent prompt execution (`POST /v1/run`)
- Workflow step sequencing with topological sort (`POST /v1/workflow/run`)
- Workflow failure-resume with completed-node carry-forward (`POST /v1/workflow/resume`)
- Repository enrichment: language detection, classification, dependency counting, overlap scoring (`POST /v1/repositories/scan`)
- Repository graph derivation: overlap pairs + heuristic edges (`POST /v1/repositories/graph`)

**TypeScript shell owns:**

- Agent registry (`src/registry/agentRegistry.ts`) — agent definitions, capabilities, prompt templates
- Workflow registry (`src/registry/workflowRegistry.ts`) — workflow definitions, step graphs
- HTTP routing and request validation (`src/routes/*.ts`)
- DB persistence of all Python-returned values (`src/orchestrator/storage.ts`)
- Checkpoint creation and claim/revert lifecycle
- Run enrichment: joining `lastRunAt`/`lastRunStatus` from DB for agent and workflow listings
- Python Core HTTP client (`src/lib/pythonClient.ts`)

---

## What TypeScript Does NOT Own

TypeScript does not compute any of the following:

- Prompt execution or LLM calls
- Workflow step ordering or dependency resolution
- Quality scoring
- Repository language/classification/overlap values
- Graph edge or overlap-pair computation

If any of these appear as local TS computations, that is a regression.

---

## Key Files

| File | Purpose |
|---|---|
| `artifacts/api-server/src/routes/agents.ts` | Agent list + agent run routes |
| `artifacts/api-server/src/routes/workflows.ts` | Workflow list + workflow run routes |
| `artifacts/api-server/src/routes/runs.ts` | Run list, run status, checkpoint/resume routes |
| `artifacts/api-server/src/routes/repositories.ts` | Repository list, scan, graph routes |
| `artifacts/api-server/src/routes/health.ts` | Health check route |
| `artifacts/api-server/src/registry/agentRegistry.ts` | In-memory agent manifest |
| `artifacts/api-server/src/registry/workflowRegistry.ts` | In-memory workflow manifest |
| `artifacts/api-server/src/orchestrator/storage.ts` | DB persistence layer (runs, nodes, checkpoints, logs) |
| `artifacts/api-server/src/lib/pythonClient.ts` | Python Core HTTP client with typed payloads/responses |
| `artifacts/api-server/src/orchestrator/types.ts` | Shared TS types (RunRecord, RunNodeRecord, etc.) |
| `artifacts/hyperflow-core/main.py` | Python core — all execution authority |
| `lib/db/src/schema/index.ts` | DB schema barrel: runs, run-nodes, log-events, checkpoints, repositories |
| `lib/api-spec/openapi.yaml` | OpenAPI 3.1 contract |

---

## Database Tables

| Table | Schema file | Purpose |
|---|---|---|
| `runs` | `lib/db/src/schema/runs.ts` | Run records (agent, workflow, scan) |
| `run_nodes` | `lib/db/src/schema/run-nodes.ts` | Per-step node records for workflow runs |
| `log_events` | `lib/db/src/schema/log-events.ts` | Structured log events |
| `checkpoints` | `lib/db/src/schema/checkpoints.ts` | Resumability markers for failed workflow runs |
| `repositories` | `lib/db/src/schema/repositories.ts` | Repository inventory with enrichment fields |

---

## Environment

- `PYTHON_CORE_URL` — base URL for Python core (default: `http://localhost:8000`)
- `DATABASE_URL` — PostgreSQL connection string
- `OPENROUTER_API_KEY` — optional; Python core uses stub mode without it
- `SESSION_SECRET` — session secret
