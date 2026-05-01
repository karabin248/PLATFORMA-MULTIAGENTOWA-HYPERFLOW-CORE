# Hyperflow — Canonical Execution Spine

**Updated:** 2026-05-01
**Status:** Canonical — verified against source (v6 audit)

> All persistence calls below reflect the **current** code paths.
> The legacy `storage.saveRun()` / `storage.saveNodes()` path is **deprecated**
> and is NOT used by any active workflow or agent run route.

---

## 1. Agent Run (Agent Platform path)

```
POST /api/agents/run
  Body: { agentId, prompt?, params?, idempotencyKey?, requestedBy? }
  Route: routes/agentRuns.ts

  1. Validate body (Zod)
  2. Load agent from agentsTable (or 404)
  3. Validate agent.status === "active" (else 409)
  4. Resolve prompt from agent.promptTemplate + params
  5. Build AgentExecutionRequest:
       { agent_id, agent_version, prompt, agent_role,
         agent_capabilities, run_policy, context }
  6. db.insert(agentRunsTable, { status: "running", resolvedPrompt, runtimeRequest, ... })
  7. pythonClient.fetchCore("POST /v1/agent/run", AgentExecutionRequest)
     Python: EDDE 6-phase pipeline with agent context
             returns { run_id, result, contract, canonical_trace,
                       quality_score, modelUsed, ... }
  8. normalizeOutput(coreData) → normalizedOutput
  9. db.update(agentRunsTable).set({
       status: "completed",
       runtimeResponse, output, normalizedOutput,
       qualityScore, canonicalTrace, modelUsed,
       completedAt, durationMs
     })
  10. res.json(makeOkResponse(runRecord))
```

Error paths:
- Unknown agentId: 404
- Agent disabled: 409
- Python unavailable: 503
- Python error: 502
- Idempotency collision: returns existing run (200)

---

## 2. Agent Run Retry

```
POST /api/agent-runs/:id/retry
  Route: routes/agentRuns.ts

  1. Load original run (or 404)
  2. Validate status === "failed" (else 409)
  3. Create NEW run record with:
       parentRunId = original.id
       originRunId = original.originRunId ?? original.id
       retryCount  = (origin.retryCount ?? 0) + 1
  4. Execute same flow as Agent Run (steps 6–10 above)
  5. Return new run with originalRunId, retryRunId, originRunId, retryCount
```

Key: original run status stays "failed". Retry chain is immutable.

---

## 3. Agent Run Cancel

```
POST /api/agent-runs/:id/cancel
  Route: routes/agentRuns.ts

  1. Load run (or 404)
  2. Validate status in ["queued", "running"] (else 409)
  3. db.update(agentRunsTable).set({ status: "cancelled", cancelledAt })
  4. Return updated run
```

---

## 4. Workflow Run

```
POST /api/workflows/run
  Body: { workflowId, params?, idempotencyKey?, requestedBy? }
  Route: routes/workflows.ts

  1. Validate body (Zod)
  2. Load workflow from workflowsTable (or 404)
  3. Idempotency check: if idempotencyKey matches existing run → return it
  4. Build PythonWorkflowPayload:
       { workflowId, name, steps[], edges[], input }
     (steps include agentRef, requiredCapabilities, handoffContract, prompt)
  5. db.insert(workflowRunsTable, {
       status: "queued", workflowId, idempotencyKey,
       runtimeRequest, requestedBy, ...
     })
  6. appendStateLogEvent(runId, "admitted")
  7. workflowExecutor.tick() picks up the queued run:
     a. acquireLease(runId, executorId) — atomic UPDATE WHERE status=queued AND leaseToken IS NULL
     b. appendStateLogEvent(runId, "lease_acquired")
     c. callPythonWorkflowRun(runtimeRequest)
        Python: topological sort, asyncio.gather per DAG level,
                returns { status, nodes[], blockedNodeId?,
                          blockedNodeType?, snapshot }
     d. projectExecutionSnapshot(runId, pythonResult)
        → workflowRunsTable.status, completedAt, error
        → workflowRunNodesTable upsert per node
        → checkpointsTable insert/supersede per blocking node
        → appendStateLogEvent(runId, "completed" | "failed" | "waiting_approval" | "waiting_input")
     e. releaseLease(runId)
  8. GET /api/workflow-runs/:id/status returns projected state from DB
```

Lease TTL: 30 s. `recoverStaleLeases()` fires each tick and re-queues stale
runs up to 3 times before marking `failed`.

---

## 5. Workflow Resume (from failed)

```
POST /api/runs/:id/resume
  Route: routes/runs.ts (legacy) OR routes/workflows.ts

  1. Load run from workflowRunsTable (or 404)
  2. Validate: status === "failed" (else 409)
  3. validateResumeCheckpoint(runId) → active checkpoint exists (else 409)
  4. Load runtimeRequest from run record
  5. Build completedNodes[] from workflowRunNodesTable WHERE status="succeeded"
  6. callPythonWorkflowResume({
       runId, workflowId, name, steps[], edges[], completedNodes[]
     })
     Python: carries forward completed nodes unchanged,
             re-executes failed/skipped nodes from checkpoint
  7. projectExecutionSnapshot(runId, pythonResult)
  8. Return updated run status
```

Key: same runId, original startedAt preserved, completed nodes immutable.

---

## 6. Approval Gate Continuation

```
POST /api/approvals/:id/decide
  Body: { decision: "approved" | "rejected", decidedBy? }
  Route: routes/approvals.ts

  1. Load approval record (or 404)
  2. Validate: status === "pending" (else 409)
  3. Load runtimeRequest from parent workflow run
  4. Build completedNodes[] from DB (all succeeded nodes before gate)
  5. pythonClient.continueApproval({
       runId, nodeId, workflowId, name,
       steps[], edges[], completedNodes[], approvedBy
     })
     Python: marks approval node as succeeded,
             resumes DAG execution past gate,
             returns updated snapshot
  6. projectContinuationSnapshot(runId, pythonResult)
  7. Update approval record: status → "approved" | "rejected"
  8. Return updated run status
```

Note: rejection flows set status="rejected" and may terminate the run
depending on downstream edge conditions.

---

## 7. Human-Input Gate Continuation

```
POST /api/human-inputs/:id/submit
  Body: { input: object, actorId? }
  Route: routes/humanInputs.ts

  1. Load human-input record (or 404)
  2. Validate: node status === "waiting_input" (else 409)
  3. Load runtimeRequest from parent workflow run
  4. Build completedNodes[] from DB
  5. pythonClient.continueHumanInput({
       runId, nodeId, workflowId, name,
       steps[], edges[], completedNodes[], humanInput, actorId
     })
     Python: marks human node as succeeded with provided input,
             resumes DAG execution past gate,
             returns updated snapshot
  6. projectContinuationSnapshot(runId, pythonResult)
  7. Return updated run status
```

---

## 8. Repository Scan

```
POST /api/repositories/scan
  Route: routes/repositories.ts

  1. Read all repos from DB
  2. Empty set → 400
  3. callPythonRepositoryScan({ repositories: [{id, name, url}] })
     Python: enriches with language, classification, dependencyCount, overlapScore
  4. Validate: no unknown IDs (else 500), valid classifications (else 502)
  5. db.transaction:
     - Insert run record to runsTable (legacy — scan still uses old schema)
     - Update each repository with enrichment fields
  6. res.json(makeOkResponse(RunSummary))
```

---

## 9. Repository Graph

```
GET /api/repositories/graph
  Route: routes/repositories.ts

  1. Read repos from DB (id, name, language, classification, dependencyCount)
  2. Empty set → return { nodes:[], edges:[], overlapPairs:[] }
  3. callPythonRepositoryGraph({ repositories })
     Python: computes overlap pairs + heuristic edges
  4. res.json(makeOkResponse(graphResult))
```

---

## 10. Read-Only Routes (TS-Only, No Python Call)

```
GET /api/healthz             → routes/health.ts
GET /api/agents              → routes/agents.ts    (agentsTable + lastRun join)
GET /api/agents/:id          → routes/agents.ts    (agent detail)
GET /api/agents/:id/revisions → routes/agents.ts   (agentRevisionsTable)
GET /api/workflows           → routes/workflows.ts (workflowsTable + lastRun join)
GET /api/workflow-runs       → routes/workflows.ts (workflowRunsTable)
GET /api/workflow-runs/:id/status → routes/workflows.ts (workflowRunsTable + nodes + checkpoints)
GET /api/agent-runs          → routes/agentRuns.ts (full filter support)
GET /api/agent-runs/metrics  → routes/agentRuns.ts (aggregate stats)
GET /api/agent-runs/:id      → routes/agentRuns.ts (run detail with retry chain)
GET /api/runs                → routes/runs.ts      (legacy)
GET /api/runs/:id/status     → routes/runs.ts      (legacy)
GET /api/repositories        → routes/repositories.ts (DB read + lastScan join)
```

---

## Error Handling Summary

| Error | HTTP | Source |
|---|---|---|
| Invalid request body | 400 | Zod validation |
| Unknown agent/workflow | 404 | DB lookup |
| Agent disabled | 409 | Status check |
| Run not found | 404 | DB lookup |
| Resume precondition failure | 409 | Status/checkpoint checks |
| Idempotency collision | 200 | Returns existing run |
| Python Core unavailable | 503 | Connection failure |
| Python Core error | 502 | Non-2xx response |
| Internal error | 500 | Unexpected exception |
