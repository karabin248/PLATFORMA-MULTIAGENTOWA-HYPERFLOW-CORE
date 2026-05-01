# Platform Shell Workflow Fix

## Problem
The `Platform Shell` workflow (production-mode runner) failed on startup with three issues:

1. **DB schema mismatch** — the patched code expected an `agents` table, but the database still held the old schema (`log_events`, `repositories`, `runs`, `run_nodes`, `checkpoints`). `drizzle-kit push` prompted interactively to choose between "create table" and "rename from <old table>", which can't be answered inside a workflow.
2. **Startup race** — Python core was launched in the background with `&`, then the API server immediately ran `checkDependencies()` (DB + core health). The API server hit `ECONNREFUSED 127.0.0.1:8000` before Uvicorn finished booting.
3. **Port collision** — Platform Shell bound `PORT=8081`, the same port already taken by the `mockup-sandbox` artifact's component preview server, producing `EADDRINUSE`.

## Resolution
The workflow command was rewritten (via `configureWorkflow`) to:

1. Migrate the schema first (`pnpm --filter @workspace/db run push`). Stale dev tables were dropped beforehand so drizzle no longer mistakes the new `agents` table for a rename of the old ones.
2. Start the Python core, capture its PID, install an `EXIT` trap so the core is killed when the API server stops or the workflow is restarted.
3. Poll `GET /v1/health` (with `X-API-Key`) up to 60s; **fail fast with `exit 1`** if the core never becomes healthy.
4. Build and start the API server on `PORT=8099` (free port from the supported set), preserving `HARDENED_MODE=true`.

The dev `Python core` reference in the original task brief was already the same process on `:8000`; no separate dev core exists.

## Verification
After restart:

```bash
$ curl -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:8099/api/healthz
{"status":"ok","checks":{"database":{"status":"ok","latencyMs":1},"core":{"status":"ok","latencyMs":2}},...}
```

Workflow boots in ~6 seconds end-to-end (drizzle push + core ready + build + listen).

## Notes / Follow-ups
- The artifact-level `artifacts/api-server: API Server` dev workflow (port 8080) still fails because it has no Python core dependency check of its own. Out of scope for this task.
- TypeScript build still has 35+ `tsc` errors — tracked separately as Task #4.
- The `[[ports]]` mapping in `.replit` (8081 → 8081) corresponds to the mockup-sandbox preview, not Platform Shell. Platform Shell now runs internally on 8099 (`outputType = "console"`, no external mapping needed).
