# Hyperflow — Authority Boundary

**Updated:** 2026-05-01
**Status:** Canonical — verified against source (v6 audit)

---

## Purpose

This document states exactly which system owns each operation. It is the
reference for regression review. If TS code appears to perform an operation
listed under Python authority, that is a regression.

---

## Python Core — Execution Authority

All execution below happens in `artifacts/hyperflow-core/main.py` and is
returned via HTTP. TypeScript reads and persists these values; it does not
recompute them.

### 1. Basic Agent Run

**Python endpoint:** `POST /v1/run`
**TS caller:** `callPythonRun()` in `pythonClient.ts`
**TS route:** `POST /api/agents/run` (legacy path via `routes/agents.ts`)
**Flow:** TS resolves agentId → prompt, sends `{ prompt, type, name }` to
Python. Python runs full EDDE 6-phase pipeline, returns run envelope with
`canonical_trace`, `quality_score`, `modelUsed`. TS persists result to
`runsTable` via deprecated `storage.saveRun()` — this path is legacy.

### 2. Agent Platform Run (primary path)

**Python endpoint:** `POST /v1/agent/run`
**TS caller:** `pythonClient.ts:fetchCore("/v1/agent/run", ...)`
**TS route:** `POST /api/agents/run` via `routes/agentRuns.ts`
**Flow:** TS validates agent exists and is active, builds `AgentExecutionRequest`
(agent_id, agent_version, prompt, role, capabilities, run_policy, context),
calls Python. Python runs EDDE pipeline with agent identity context, returns
enriched response including `modelUsed`. TS normalizes output and persists to
`agentRunsTable` with canonical_trace, quality_score, retry chain fields.

### 3. Workflow Step Sequencing

**Python endpoint:** `POST /v1/workflow/run`
**TS caller:** `callPythonWorkflowRun()` in `pythonClient.ts`
**TS route:** `POST /api/workflows/run` in `routes/workflows.ts`
**Flow:** TS resolves workflow definition, builds step payloads with
`agentRef`, `dependsOn`, `handoffContract`, sends to Python. Python performs
topological sort, executes each step via `asyncio.gather` per DAG level,
returns execution snapshot with per-node status/result. TS persists via
`projectExecutionSnapshot()` → `workflowRunsTable` + `workflowRunNodesTable`
+ `checkpointsTable`. Executor polling loop (`workflowExecutor.tick()`) drives
the run lifecycle with lease TTL and stale recovery.

### 4. Workflow Resume

**Python endpoint:** `POST /v1/workflow/resume`
**TS caller:** `callPythonWorkflowResume()` in `pythonClient.ts`
**TS route:** `POST /api/runs/:id/resume` in `routes/runs.ts`
**Flow:** TS validates run (status=failed), claims checkpoint atomically,
re-builds workflow steps, sends `{ runId, workflowId, name, steps[], completedNodes[], edges[] }`
to Python. Python carries forward completed nodes unchanged, re-executes
failed/skipped. TS persists updated snapshot via `projectExecutionSnapshot()`.

### 5. Approval Gate Continuation

**Python endpoint:** `POST /v1/workflow/continue/approval`
**TS caller:** `pythonClient.continueApproval()` in `pythonClient.ts`
**TS route:** `POST /api/approvals/:id/decide` in `routes/approvals.ts`
**Flow:** TS validates approval exists and is pending, loads runtime workflow
request, calls Python with `ApprovalContinuationRequest` (runId, nodeId,
completedNodes[], steps[], edges[], approvedBy). Python marks approval node
as succeeded and resumes DAG execution from that boundary. TS persists
continuation snapshot via `projectContinuationSnapshot()`.

### 6. Human-Input Gate Continuation

**Python endpoint:** `POST /v1/workflow/continue/human-input`
**TS caller:** `pythonClient.continueHumanInput()` in `pythonClient.ts`
**TS route:** `POST /api/human-inputs/:id/submit` in `routes/humanInputs.ts`
**Flow:** TS validates human-input node is in waiting_input state, calls Python
with `HumanInputContinuationRequest` (runId, nodeId, completedNodes[], steps[],
edges[], humanInput, actorId). Python marks human node as succeeded with the
provided input and resumes DAG execution. TS persists continuation snapshot
via `projectContinuationSnapshot()`.

### 7. Repository Scan Enrichment

**Python endpoint:** `POST /v1/repositories/scan`
**TS caller:** `callPythonRepositoryScan()` in `pythonClient.ts`
**TS route:** `POST /api/repositories/scan` in `routes/repositories.ts`
**Flow:** TS reads all repos from DB, sends `{ repositories: [{id, name, url}] }`
to Python. Python enriches with language, classification, dependencyCount,
overlapScore. TS validates returned IDs and classifications, persists atomically
in one DB transaction (run insert + repository updates).

### 8. Repository Graph Derivation

**Python endpoint:** `POST /v1/repositories/graph`
**TS caller:** `callPythonRepositoryGraph()` in `pythonClient.ts`
**TS route:** `GET /api/repositories/graph` in `routes/repositories.ts`
**Flow:** TS reads repos from DB, sends to Python. Python computes overlap pairs
(name-token similarity) and heuristic edges (classification affinity + language
match). TS wraps and returns. Empty repo set → empty graph without Python call.

---

## TypeScript Shell — Manifests, Routing, Persistence

TS code performs exactly these categories of work:

| Category | Implementation |
|---|---|
| Agent registry | `src/domain/agents.ts` — CRUD, disable/enable, revisions |
| Workflow registry | `src/domain/workflows.ts` — CRUD, revisions |
| Run enrichment | `lastRunAt`/`lastRunStatus` joined from DB for list endpoints |
| Persistence — agent runs | `agentRunsTable` direct via `routes/agentRuns.ts` |
| Persistence — workflow runs | `workflowRunsTable` + `workflowRunNodesTable` via `workflowProjection.ts` |
| Persistence — checkpoints | `checkpointsTable` via `workflowProjection.ts` (supersede → insert pattern) |
| Persistence — state log | `appendStateLogEvent()` → atomic jsonb append on `workflowRunsTable.stateLog` |
| Executor lifecycle | `workflowExecutor.tick()` — lease TTL 30s, stale recovery, max 3 retries |
| HTTP dispatch | All `callPython*()` + `continueApproval()` + `continueHumanInput()` in `pythonClient.ts` |
| Validation | Zod schemas from `@workspace/api-zod`, input/output gating |
| Error shaping | `makeOkResponse()`, `makeErrorResponse()` |

---

## Python-Internal Utility Endpoints

These Python endpoints are NOT called by TS and exist for diagnostics only:

| Endpoint | Purpose |
|---|---|
| `GET /v1/health` | Python service health/version |
| `GET /v1/logs/recent` | In-memory ring-buffer log events |
| `GET /v1/session` | In-process session ring buffer summary |
| `GET /v1/mps-profiles` | MPS level reference table |
| `POST /v1/explore` | Prompt exploration — candidate paths, no LLM call |

---

## Deprecated / Legacy

`src/orchestrator/storage.ts` is deprecated. It writes to the legacy `runsTable`
/ `runNodesTable` schema. It is no longer called by any active workflow or agent
run path. The file is preserved for historical reference only and exports nothing
(`export {}`). Do not add new writes via this module.

