# Deferred API Paths

**Updated:** 2026-05-01
**Status:** Deferred — storage layer exists, route handler does not

These paths were removed from `lib/api-spec/openapi.yaml` during the Canon Freeze
because they have no route handler implementation. However, they have backing
storage methods in `artifacts/api-server/src/orchestrator/storage.ts` (legacy)
and are candidates for future implementation.

> **Note on storage.ts:** The methods below exist in the deprecated `storage.ts`
> which operates on the legacy `runs`/`run_nodes`/`log_events` schema. Any future
> implementation of these routes should migrate to the current schema:
> - Logs → `log_events` table still exists and is populated by `storage.ts`
> - Checkpoints → migrate to `checkpointsTable` (live schema in `workflowProjection.ts`)

---

## Dead vs Deferred Triage

### Dead (removed permanently)

| Path | Reason |
|---|---|
| `GET /dashboard/summary` | No storage method, no route handler, no dashboard feature exists |
| `GET /scheduler/triggers` | No scheduler feature exists; no storage, no route, no Python endpoint |
| `POST /scheduler/triggers` | Same as above |
| `POST /settings/push-token` | No settings/push feature exists anywhere |
| `GET /settings/ai-status` | No AI status feature exists anywhere |
| `POST /checkpoints/:runId/resume` | Path mismatch — actual route is `POST /runs/:id/resume` (already in spec) |

### Deferred (documented below)

| Path | Storage method | Notes |
|---|---|---|
| `GET /logs` | `storage.listLogs()` | Reads from legacy `log_events` table |
| `GET /logs/{runId}` | `storage.getRunLogs()` | Reads from legacy `log_events` table |
| `GET /checkpoints` | `storage.listCheckpoints()` | Reads from legacy `checkpoints` table; live checkpoints are in `checkpointsTable` |

---

## GET /logs

**Storage methods:** `storage.listLogs({ limit?, severity?, runId? })`

```yaml
/logs:
  get:
    operationId: listLogs
    tags: [logs]
    summary: List log events
    parameters:
      - name: severity
        in: query
        schema:
          type: string
          enum: [debug, info, warn, error]
      - name: runId
        in: query
        schema:
          type: ["string", "null"]
      - name: limit
        in: query
        schema:
          type: integer
          default: 100
    responses:
      "200":
        description: Log event list
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/LogListResponse"
```

---

## GET /logs/{runId}

**Storage methods:** `storage.getRunLogs(runId)`

```yaml
/logs/{runId}:
  get:
    operationId: getRunLogs
    tags: [logs]
    summary: Get run logs
    parameters:
      - name: runId
        in: path
        required: true
        schema:
          type: string
    responses:
      "200":
        description: Log events for run
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/LogListResponse"
```

---

## GET /checkpoints

**Storage methods:** `storage.listCheckpoints({ runId? })`

> When implementing this route, prefer reading from the live `checkpointsTable`
> (via `workflowProjection.ts`) rather than the legacy `storage.listCheckpoints()`
> which reads from the old `checkpoints` schema.

```yaml
/checkpoints:
  get:
    operationId: listCheckpoints
    tags: [checkpoints]
    summary: List checkpoints
    parameters:
      - name: runId
        in: query
        schema:
          type: ["string", "null"]
    responses:
      "200":
        description: Checkpoint list
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/CheckpointListResponse"
```

---

## Deferred Schemas

```yaml
LogEvent:
  type: object
  properties:
    id:
      type: string
    runId:
      type: ["string", "null"]
    correlationId:
      type: string
    severity:
      type: string
      enum: [debug, info, warn, error]
    message:
      type: string
    summary:
      type: string
    context:
      type: object
      additionalProperties: true
    timestamp:
      type: string
      format: date-time
  required: [id, runId, correlationId, severity, message, summary, context, timestamp]

CheckpointRecord:
  type: object
  properties:
    id:
      type: string
    runId:
      type: string
    nodeId:
      type: string
    nodeName:
      type: string
    status:
      type: string
      enum: [active, resumed, rolled_back, superseded]
      # "superseded" is used by workflowProjection.ts when a checkpoint is
      # replaced by a new one for the same node on continuation/resume.
    savedAt:
      type: string
      format: date-time
    resumable:
      type: boolean
  required: [id, runId, nodeId, nodeName, status, savedAt, resumable]
```
