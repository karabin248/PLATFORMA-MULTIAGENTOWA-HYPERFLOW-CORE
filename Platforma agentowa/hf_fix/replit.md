# Hyperflow Agent Platform

## Overview

pnpm workspace monorepo for the Hyperflow Agent Platform. TypeScript Express shell + React operator panel consuming a Python runtime core. Phase 4 production hardening applied.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Python version**: 3.12 (runtime core)
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Logging**: pino + pino-http (structured JSON)

## Architecture

- `artifacts/api-server` — TypeScript Express shell (port 8080)
- `artifacts/operator-panel` — React operator UI (Vite)
- `artifacts/hyperflow-core` — Python runtime core (port 8000), owns canonical semantics `🌈💎🔥🧠🔀⚡`
- `lib/db` — Drizzle ORM schema + migrations
- `lib/api-zod` — Generated Zod validators from OpenAPI
- `lib/api-client-react` — Generated React Query hooks from OpenAPI
- `lib/api-spec` — OpenAPI specification (source of truth)
- `scripts/` — DB backup, restore, cleanup utilities

## Canonical Invariant

The six canonical phases (`perceive→extract→direct→synthesize→generate→decide`) and their emoji combo (`🌈💎🔥🧠🔀⚡`) are owned exclusively by the Python core. The TypeScript shell and operator panel only consume and render these values — they never redefine them. Drift guard tests enforce this.

## Phase 4 Hardening (Sprint 1)

### Auth Middleware
- Bearer token auth via `API_TOKEN` env var
- `HARDENED_MODE=true` requires auth on all sensitive routes
- Dev mode: auth bypass enabled (GET routes always open)
- Protected routes: POST/PATCH/DELETE on agents, run/retry/cancel, seed

### Rate Limiting
- Default: 100 req/min per IP
- Run endpoints: 20 req/min per IP
- Body size limit: 1MB (configurable via `MAX_BODY_SIZE_KB`)
- Prompt length limit: 32KB (configurable via `MAX_PROMPT_LENGTH`)

### Health Endpoints
- `GET /api/livez` — Liveness probe (always 200 if process running)
- `GET /api/readyz` — Readiness probe (checks DB + core connectivity)
- `GET /api/healthz` — Detailed health with latency metrics

### Structured Logging
- JSON logs via pino (all environments)
- `x-correlation-id` header propagated on all requests
- Audit events emitted for all state-changing operations

### Error Classification
- Classified errors with category, code, retryable flag
- Categories: validation, timeout, core_unavailable, persistence, rate_limited, etc.

### Audit Trail
- All agent CRUD, run lifecycle, auth failures, rate limit events logged
- Structured audit events with correlation-id, resource type/id, action, timestamp

### Startup Checks
- DB connectivity verified before accepting requests
- Core health checked (warn + continue in dev, fail in hardened mode)

## Phase 4 Hardening (Sprint 2)

### DB Hardening
- Pool configured: max=20, idleTimeout=30s, connectionTimeout=5s, error listener
- `getPoolStats()` exposes active/idle/waiting/errors
- Auto-schema check on startup (runs `drizzle-kit push` if tables missing)
- Backup/restore scripts corrected (no camelCase→snake_case transform; backup uses raw SQL column names)

### Observability
- `GET /api/metrics` — Prometheus-format endpoint with HTTP request counts, run success/failure, latency p50/p95, DB pool stats
- Request metrics middleware records method, status, and duration for every HTTP request
- Run metrics track success/failure counts and latency
- Pool stats exposed in `/api/healthz` response

### Correlation-ID Propagation
- Shell correlation-id forwarded to Python core as `x-correlation-id` header
- Python core logs correlation-id via structured logger + ring buffer events
- All audit events include correlationId

### Error Response Normalization
- All error responses use shape: `{ error, code, category, retryable, correlationId }`
- Error categories: validation_error, core_unreachable, core_error, core_execution_error, timeout, persistence_error, not_found, conflict, payload_too_large, internal_error
- `classifyCoreError()` maps typed core error codes to categories
- Global error middleware in app.ts normalizes uncaught errors

### Schema Validation
- All mutating routes (POST/PATCH) validate with Zod
- Validation errors return normalized shape with details array

### Audit Trail Enhancements
- Cancel emits previousStatus in details
- Retry emits errorCode, errorCategory, durationMs in details
- All audit events include correlationId

## Phase 4 Hardening (Sprint 3)

### Execution Control
- **Run timeout policy**: `defaultRunTimeoutMs` (default 60s) enforced on all runs. Timed-out runs return `{code: "CORE_TIMEOUT", category: "timeout", retryable: true}`. Timeout hint forwarded to Python core via `x-timeout-hint-ms` header.
- **In-flight run registry**: `inFlightRegistry.ts` tracks all active runs with AbortControllers. Exposes `activeCount`, per-run metadata, and `abort(runId)`.
- **Real cancellation**: Cancel endpoint (`POST /api/agent-runs/:id/cancel`) aborts the in-flight HTTP request to Python core. Response includes `interrupted: true/false`.

### Concurrency Control
- **Concurrency limiter**: `MAX_CONCURRENT_RUNS` (default 10). When at capacity, returns `429 {code: "CONCURRENCY_LIMIT", retryable: true, retryAfterMs: 1000}`.
- **System pressure endpoint**: `GET /api/system/pressure` — returns `activeRuns`, `maxConcurrentRuns`, `utilizationPct`, `activeRunDetails`.

### Idempotency
- **Idempotency key**: `Idempotency-Key` header on `POST /agents/run`. If key matches existing run: completed → return cached result; running → return in-progress status. Stored in `idempotency_key` column.

### Retry Discipline
- **Max retry count**: `MAX_RETRY_COUNT` (default 3). Retry beyond limit returns `409 RETRY_LIMIT_EXCEEDED`.
- **Retryable category check**: Only errors with retryable categories (timeout, core_unreachable, core_error, persistence_error) can be retried. Non-retryable errors (execution_error, validation_error) are rejected.

### Failure Forensics
- **Forensic metadata**: Failed/cancelled runs persist `errorCode` and `errorCategory` columns in DB.
- **Partial runtime response**: On failure, any partial response from core is saved in `runtimeResponse`.
- **Timeline**: `admittedAt` timestamp added. Run detail API includes `timeline` object with all lifecycle timestamps.
- **Enriched retry chain**: Retry chain entries now include `errorCode`, `errorCategory`, and `durationMs`.

### Metrics (Sprint 3 additions)
- `hyperflow_runs_timeout` — counter of timed-out runs
- `hyperflow_runs_cancelled` — counter of cancelled runs
- `hyperflow_concurrency_denied` — counter of requests denied at capacity
- `hyperflow_idempotency_hits` — counter of deduplicated idempotency key hits
- `hyperflow_active_runs` — gauge of currently in-flight runs
- Run metrics endpoint includes `timedOut`, `activeRuns`, `maxConcurrentRuns`
- Healthz endpoint includes `system.activeRuns`, `system.maxConcurrentRuns`, `system.utilizationPct`

### Operator Panel (Sprint 3)
- Dashboard: "Timed Out" count + "System Pressure" card (active runs / capacity)
- Run list: "timed out" badge for CORE_TIMEOUT failures
- Run detail: Timeline card (admitted→started→completed/failed/cancelled), Failure Forensics card (errorCode, errorCategory), enriched retry chain (errorCode, durationMs per hop)

### New Error Categories
- `concurrency_limit` — request denied due to capacity
- `RUN_CANCELLED` — run aborted via cancel endpoint

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `PORT` | No | `8080` | Server listen port |
| `CORE_URL` | No | `http://localhost:8000` | Python core URL |
| `HARDENED_MODE` | No | `false` | Enable production hardening |
| `API_TOKEN` | If hardened | — | Bearer token for auth |
| `SESSION_SECRET` | No | — | Session secret |
| `DEFAULT_RUN_TIMEOUT_MS` | No | `60000` | Default run timeout (ms) |
| `MAX_CONCURRENT_RUNS` | No | `10` | Max concurrent in-flight runs |
| `MAX_RETRY_COUNT` | No | `3` | Max retry attempts per run chain |
| `MAX_BODY_SIZE_KB` | No | `1024` | Max request body size (KB) |
| `MAX_PROMPT_LENGTH` | No | `32768` | Max prompt length (chars) |
| `LOG_LEVEL` | No | `info` | Pino log level |

## Workflows

| Workflow | Command | Port | Purpose |
|---|---|---|---|
| `artifacts/api-server: API Server` | `pnpm --filter @workspace/api-server run dev` | 8080 | TypeScript Express shell |
| `artifacts/hyperflow-core: Python Core` | `cd artifacts/hyperflow-core && python3 main.py` | 8000 | Python runtime core (uvicorn) |
| `artifacts/operator-panel: web` | `pnpm --filter @workspace/operator-panel run dev` | (Vite) | React operator UI |

The Python core must be running for `/api/readyz` to report `ready` and for agent runs to execute. Without it, the shell reports `"Core unreachable"`. The core runs stub execution without `OPENROUTER_API_KEY` (all 6 canonical phases complete, `source: "stub"`).

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run typecheck:libs` — typecheck shared libs only
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

### Database Scripts
- `pnpm --filter @workspace/scripts run db:backup [output-dir]` — export DB to JSON
- `pnpm --filter @workspace/scripts run db:restore <backup-file>` — restore from JSON backup
- `pnpm --filter @workspace/scripts run db:cleanup [days] [--dry-run]` — retention cleanup (default 90 days)
- `pnpm --filter @workspace/scripts run db:migrate:push` — push schema changes

### Testing
- `cd artifacts/hyperflow-core && python3 -m pytest tests/ -v` — run all Python tests (166 tests)
- Drift guard: `python3 -m pytest tests/test_canonical_no_shell_drift.py -v` — verify no canonical drift (9 tests)

## File Structure

```
artifacts/
  api-server/src/
    middlewares/    — auth, correlation, rateLimiter
    routes/        — agents, agentRuns, health, metrics
    lib/           — config, logger, auditLog, errorClassifier, metrics, pythonClient, inFlightRegistry
    domain/        — catalog, agentRuns
  operator-panel/  — React UI
  hyperflow-core/  — Python runtime core
lib/
  db/              — Drizzle schema
  api-zod/         — Generated Zod validators
  api-client-react/ — Generated React Query hooks
  api-spec/        — OpenAPI spec
scripts/src/       — db-backup, db-restore, db-cleanup
```
