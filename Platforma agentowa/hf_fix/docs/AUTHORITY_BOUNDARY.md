# Hyperflow — Authority Boundary

**Frozen:** 2026-04-04
**Status:** Canonical — verified by source audit

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

### 1. Agent Run Execution

**Python endpoint:** `POST /v1/run`
**TS caller:** `callPythonRun()` in `pythonClient.ts`
**TS route:** `POST /agents/run` in `routes/agents.ts`
**Flow:** TS resolves agentId → prompt via `agentRegistry.promptTemplate()`,
sends `{ prompt, type: "agent", name }` to Python, persists returned run via
`storage.saveRun()`.

### 2. Workflow Step Sequencing

**Python endpoint:** `POST /v1/workflow/run`
**TS caller:** `callPythonWorkflowRun()` in `pythonClient.ts`
**TS route:** `POST /workflows/run` in `routes/workflows.ts`
**Flow:** TS resolves each workflow step's agentId → prompt, sends
`{ workflowId, name, steps[{id, name, prompt, dependsOn}] }` to Python.
Python performs topological sort, executes each step, returns `nodes[]`
with per-node status/result. TS persists run + nodes via `storage.saveRun()`
+ `storage.saveNodes()`. If any node fails: overall status=failed, subsequent
nodes=skipped, and TS creates an active checkpoint for future resume.

### 3. Workflow Resume

**Python endpoint:** `POST /v1/workflow/resume`
**TS caller:** `callPythonWorkflowResume()` in `pythonClient.ts`
**TS route:** `POST /runs/:id/resume` in `routes/runs.ts`
**Flow:** TS validates run (exists, type=workflow, status=failed), claims
checkpoint atomically, re-resolves workflow steps, sends
`{ runId, workflowId, name, steps[], completedNodes[] }` to Python.
Python carries forward completed nodes unchanged, re-executes failed/skipped.
TS persists updated run + nodes.

### 4. Repository Scan Enrichment

**Python endpoint:** `POST /v1/repositories/scan`
**TS caller:** `callPythonRepositoryScan()` in `pythonClient.ts`
**TS route:** `POST /repositories/scan` in `routes/repositories.ts`
**Flow:** TS reads all repos from DB, sends `{ repositories: [{id, name, url}] }`
to Python. Python enriches with language, classification, dependencyCount,
overlapScore. TS validates returned IDs and classifications, persists atomically
in one DB transaction (run insert + repository updates).

### 5. Repository Graph Derivation

**Python endpoint:** `POST /v1/repositories/graph`
**TS caller:** `callPythonRepositoryGraph()` in `pythonClient.ts`
**TS route:** `GET /repositories/graph` in `routes/repositories.ts`
**Flow:** TS reads repos from DB, sends to Python. Python computes overlap pairs
(name-token similarity) and heuristic edges (classification affinity + language
match). TS wraps and returns. Empty repo set → empty graph without Python call.

---

## TypeScript Shell — Manifests, Routing, Persistence

TS code performs exactly these categories of work:

| Category | Examples |
|---|---|
| Manifests | Agent registry, workflow registry (in-memory) |
| Run enrichment | `lastRunAt`/`lastRunStatus` joined from DB for list endpoints |
| Persistence — runs | `storage.saveRun()`, `storage.updateRun()` |
| Persistence — nodes | `storage.saveNodes()` |
| Persistence — checkpoints | `storage.saveCheckpoint()`, `claimCheckpoint()`, `revertCheckpoint()` |
| Persistence — repositories | DB transaction in `routes/repositories.ts` |
| HTTP dispatch | All `callPython*()` functions in `pythonClient.ts` |
| Validation | Zod schemas from `@workspace/api-zod`, input/output gating |
| Error shaping | `makeOkResponse()`, `makeErrorResponse()` |

---

## Python-Internal Utility Endpoints

These Python endpoints are NOT called by TS and exist for diagnostics only:

| Endpoint | Purpose |
|---|---|
| `GET /v1/health` | Python service health/version |
| `GET /v1/logs/recent` | In-memory ring-buffer log events |
| `POST /v1/explore` | Prompt exploration — candidate paths + selection |
