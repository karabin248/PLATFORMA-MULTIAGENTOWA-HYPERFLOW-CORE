# Code Review — hyperflow_microfix_patched

**Source:** `attached_assets/hyperflow_microfix_patched_1776853217728.zip`
**Date:** 2026-04-22
**Method:** zip extracted over workspace, dependencies installed (pnpm + uv), services started, smoke test executed, architect review.

## Run results

| Check | Result |
|---|---|
| `pnpm install` | OK (261 packages added) |
| `uv sync` (hyperflow-core) | OK |
| Python core boots on `:8000` | OK |
| API dev server boots on `:8080` | OK |
| `GET /v1/health` (Python core) | 200 OK |
| `GET /api/healthz` | 200 OK |
| `GET /api/agents` | 200 OK |
| `GET /api/workflows` | 200 OK |
| `GET /api/runs` | 200 OK |
| `GET /api/repositories` | 200 OK |
| `GET /api/repositories/graph` | **500 (broken)** |
| `pnpm run typecheck` | **FAIL — 35+ errors** |
| Production "Platform Shell" workflow | **FAIL** (DB schema not migrated, port collision) |

**Smoke test: 7 passed / 2 failed.**

## Issues found

### HIGH — TypeScript no longer compiles
`pnpm run typecheck` produces 35+ errors. The dev server only runs because esbuild does not enforce types.

| File | Problem | Fix |
|---|---|---|
| `lib/db/src/schema/index.ts` | Doesn't re-export `repositoriesTable` and `runsTable` (referenced by `src/routes/repositories.ts:4`, `src/routes/runs.ts`) | Add `export * from "./repositories"; export * from "./runs";` |
| `lib/db/src/schema/checkpoints.ts` | Missing columns `nodeName`, `status`, `savedAt`, `resumable` that `src/orchestrator/storage.ts:290–311` expects; `nodeId` is nullable but storage code assigns `string` | Add the 4 missing columns; mark `nodeId` not-null or update storage |
| `artifacts/api-server/src/lib/pythonClient.ts` | `routes/repositories.ts` and `routes/runs.ts` use named imports (`callPythonRepositoryScan`, `callPythonRepositoryGraph`, `PythonCoreUnavailable`, `PythonCoreError`, `callPythonWorkflowResume`, `PythonWorkflowStep`); module exports them as default | Convert default → named exports (or update import sites) |
| `artifacts/api-server/src/lib/metrics.ts` | `MetricsCollector` is missing `recordValidationDenied()` (called from `routes/agentRuns.ts:170`) | Add the method |
| `artifacts/api-server/src/routes/repositories.ts` | Several `err is unknown` (lines 96/100/138/142) and implicit `any` parameters (lines 152/153/168/169) | Type the catch with `unknown` + narrowing; type the `.map(r => …)` arg |
| `artifacts/api-server/src/routes/workflows.ts` | `approvalTimeline` and `checkpointTimeline` declared without type, then used elsewhere (lines 518/544/575/576) | Add `: SomeRow[] = []` annotations |

### CRITICAL — `/api/repositories/graph` returns 500
Caused by the broken `pythonClient` named-vs-default import — the route handler throws on import. Fix the export shape (above) and this endpoint goes green.

### HIGH — Schema drift between `lib/db/src/schema/checkpoints.ts` and `orchestrator/storage.ts`
`storage.ts` expects: `nodeName`, `status`, `savedAt`, `resumable`. The schema actually has: `checkpointType`, `state`, `memoryRefs`, `traceRefs`, `createdAt`. Either column set is internally consistent — but they don't agree, so checkpoint persistence is partially broken.

### MEDIUM — Production "Platform Shell" workflow fails to boot
Two distinct causes:
1. `relation "agents" does not exist` — DB schema was never migrated. Run `pnpm --filter @workspace/db run migrate` (or whatever the patched repo uses) before HARDENED start.
2. Port 8000 collision with the dev `Hyperflow Python Core` if both run together.

### MEDIUM — Deprecated FastAPI pattern
`artifacts/hyperflow-core/main.py:111` uses `@app.on_event("shutdown")` — deprecated. Migrate to `lifespan` context manager. Currently still functional.

## Bottom line
- Runtime: **mostly OK** in dev mode (7/9 smoke tests green).
- Build/type-safety: **broken** — would block any production build that runs `tsc --noEmit`.
- Production hardened mode: **blocked** by missing DB migration.

The "patched" zip introduces references to schema columns and named exports that don't exist in the rest of the workspace. This looks like a partial in-flight refactor.
