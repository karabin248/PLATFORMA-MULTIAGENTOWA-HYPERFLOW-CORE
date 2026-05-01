# Hyperflow — Canonical Execution Spine

**Frozen:** 2026-04-04
**Status:** Canonical — verified by source audit

---

## 1. Agent Run

```
POST /api/agents/run
  Body: { agentId, params? }
  Route: routes/agents.ts

  1. Validate body via RunAgentBody (Zod)
  2. getAgent(agentId)                        → agent or 404
  3. agent.promptTemplate(params ?? {})       → prompt string
  4. callPythonRun({ prompt, type: "agent", name })
     → POST http://<PYTHON_CORE_URL>/v1/run
     Python: classifies, executes (LLM or stub), returns run envelope
  5. storage.saveRun(pythonResp)              → DB insert: runs table
  6. res.json(makeOkResponse(RunSummary))
```

Error paths:
- Unknown agentId: 404
- Python unavailable: 503
- Python error: 502

---

## 2. Workflow Run

```
POST /api/workflows/run
  Body: { workflowId, params? }
  Route: routes/workflows.ts

  1. Validate body via RunWorkflowBody (Zod)
  2. getWorkflow(workflowId)                  → workflow or 404
  3. For each step:
     getAgent(step.agentId)                   → agent or 400
     agent.promptTemplate(params ?? {})       → step prompt
  4. callPythonWorkflowRun({ workflowId, name, steps[] })
     → POST http://<PYTHON_CORE_URL>/v1/workflow/run
     Python: topological sort, execute each step, return nodes[]
  5. storage.saveRun(pythonResp)              → DB insert: runs table
  6. storage.saveNodes(runId, nodes)          → DB insert: run_nodes table
  7. [if status === "failed"]
     storage.saveCheckpoint(...)              → DB insert: checkpoints table
  8. res.json(makeOkResponse(RunSummary))
```

Error paths:
- Unknown workflowId: 404
- Unknown agentId in step: 400
- Python unavailable: 503
- Python error: 502

Node failure semantics (Python-owned):
- Failed step → `failed`
- Subsequent steps → `skipped`
- Overall run → `failed`

---

## 3. Checkpoint/Resume

```
POST /api/runs/:id/resume
  Route: routes/runs.ts

  1. storage.getRun(runId)                    → run or 404
  2. Validate: type=workflow (else 400), status=failed (else 409)
  3. storage.claimCheckpoint(runId)           → atomic UPDATE…RETURNING or 409
  4. Validate: workflowId exists (else 400 + revert)
  5. getWorkflow(workflowId)                  → workflow or 404 + revert
  6. Validate: step count matches nodes (else 409 + revert)
  7. For each step: getAgent(step.agentId)    → agent or 400 + revert
  8. Build completedNodes[] from run.nodes where status=completed
  9. callPythonWorkflowResume({ runId, workflowId, name, steps[], completedNodes[] })
     → POST http://<PYTHON_CORE_URL>/v1/workflow/resume
     Python: carry forward completed, re-execute failed/skipped
  10. storage.updateRun(runId, pythonResp)    → DB update: runs table
  11. storage.saveNodes(runId, nodes)         → DB upsert: run_nodes table
  12. [if status === "failed"]
      storage.saveCheckpoint(...)            → new active checkpoint for re-resume
  13. res.json(makeOkResponse(RunSummary))
```

Key properties:
- Resume continues the SAME runId (no new run created)
- Original startedAt preserved
- Completed nodes immutable: carried forward verbatim
- claimCheckpoint is atomic: second concurrent resume → 409
- Any post-claim failure → checkpoint reverted to "active"

---

## 4. Repository Scan

```
POST /api/repositories/scan
  Route: routes/repositories.ts

  1. Read all repos from DB
  2. Empty set → 400
  3. callPythonRepositoryScan({ repositories: [{id, name, url}] })
     → POST http://<PYTHON_CORE_URL>/v1/repositories/scan
     Python: enriches with language, classification, dependencyCount, overlapScore
  4. Validate: no unknown IDs (else 500), valid classifications (else 502)
  5. db.transaction:
     - Insert run record to runs table
     - Update each repository with enrichment fields
  6. res.json(makeOkResponse(RunSummary))
```

---

## 5. Repository Graph

```
GET /api/repositories/graph
  Route: routes/repositories.ts

  1. Read repos from DB (id, name, language, classification, dependencyCount)
  2. Empty set → return { nodes:[], edges:[], overlapPairs:[] }
  3. callPythonRepositoryGraph({ repositories })
     → POST http://<PYTHON_CORE_URL>/v1/repositories/graph
     Python: computes overlap pairs + heuristic edges
  4. res.json(makeOkResponse(graphResult))
```

---

## 6. Read-Only Routes (TS-Only, No Python Call)

```
GET /api/healthz             → routes/health.ts
GET /api/agents              → routes/agents.ts    (registry + DB join for lastRun*)
GET /api/workflows           → routes/workflows.ts (registry + DB join for lastRun*)
GET /api/runs                → routes/runs.ts      (DB read with limit/status filters)
GET /api/runs/:id/status     → routes/runs.ts      (DB read with nodes[])
GET /api/repositories        → routes/repositories.ts (DB read + lastScan join)
```

---

## Error Handling Summary

| Error | HTTP | Source |
|---|---|---|
| Invalid request body | 400 | Zod validation |
| Unknown agent/workflow | 404 | Registry lookup |
| Unknown agentId in workflow step | 400 | Registry lookup |
| Run not found | 404 | DB lookup |
| Resume precondition failure | 409 | Status/checkpoint/drift checks |
| Python Core unavailable | 503 | Connection failure |
| Python Core error | 502 | Non-2xx response |
| Internal error | 500 | Unexpected exception |
