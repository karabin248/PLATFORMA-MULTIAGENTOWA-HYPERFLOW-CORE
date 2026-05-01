# Deferred API Paths

**Created:** 2026-04-04
**Status:** Deferred — storage layer exists, route handler does not

These paths were removed from `lib/api-spec/openapi.yaml` during the Canon Freeze
because they have no route handler implementation. However, they have backing
storage methods in `artifacts/api-server/src/orchestrator/storage.ts` and are
candidates for future implementation.

When implementing any of these paths, re-add them to `openapi.yaml`, run codegen,
and create the corresponding route handler.

---

## Dead vs Deferred Triage

During the Canon Freeze, all OpenAPI paths without route handlers were triaged
into two categories:

### Dead (removed permanently)
No storage methods, no route handlers, no implementation anywhere in the codebase.

| Path | Reason |
|---|---|
| `GET /dashboard/summary` | No storage method, no route handler, no dashboard feature exists |
| `GET /scheduler/triggers` | No scheduler feature exists; no storage, no route, no Python endpoint |
| `POST /scheduler/triggers` | Same as above |
| `POST /settings/push-token` | No settings/push feature exists anywhere |
| `GET /settings/ai-status` | No AI status feature exists anywhere |
| `POST /checkpoints/:runId/resume` | Path mismatch — actual route is `POST /runs/:id/resume` (already in spec) |

### Deferred (documented below)
Storage methods exist in `storage.ts` but no route handler wires them to HTTP.

| Path | Storage method |
|---|---|
| `GET /logs` | `storage.listLogs()` |
| `GET /logs/{runId}` | `storage.getRunLogs()` |
| `GET /checkpoints` | `storage.listCheckpoints()` |

---

## GET /logs

**Storage methods:** `storage.listLogs({ limit?, severity?, runId? })`

```yaml
/logs:
  get:
    operationId: listLogs
    tags: [logs]
    summary: List log events
    description: Retrieves log events with optional filters
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
    description: Fetches logs for a specific run
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

```yaml
/checkpoints:
  get:
    operationId: listCheckpoints
    tags: [checkpoints]
    summary: List checkpoints
    description: Lists available checkpoints
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

These schemas support the deferred paths above. They are preserved here
for re-use when the paths are implemented. Note: the local TypeScript
interfaces `LogEvent` and `CheckpointRecord` in `types.ts` / `storage.ts`
are independent of these OpenAPI schemas.

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
  required:
    - id
    - runId
    - correlationId
    - severity
    - message
    - summary
    - context
    - timestamp

LogListResponse:
  type: object
  properties:
    status:
      type: string
      enum: [ok]
    data:
      type: array
      items:
        $ref: "#/components/schemas/LogEvent"
    meta:
      $ref: "#/components/schemas/ResponseMeta"
  required:
    - status
    - data
    - meta

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
      enum: [active, resumed, rolled_back]
    savedAt:
      type: string
      format: date-time
    resumable:
      type: boolean
  required:
    - id
    - runId
    - nodeId
    - nodeName
    - status
    - savedAt
    - resumable

CheckpointListResponse:
  type: object
  properties:
    status:
      type: string
      enum: [ok]
    data:
      type: array
      items:
        $ref: "#/components/schemas/CheckpointRecord"
    meta:
      $ref: "#/components/schemas/ResponseMeta"
  required:
    - status
    - data
    - meta
```
