# TS Route ↔ Python Core Compatibility Map

**Updated:** 2026-05-01
**Status:** Canonical — all routes verified against source (v6 audit)

---

## Python Core Endpoints (live)

| Method | Path | Called by TS | Purpose |
|--------|------|-------------|---------|
| POST | `/v1/run` | `callPythonRun()` | Single-prompt agent execution (legacy path) |
| POST | `/v1/agent/run` | `fetchCore("/v1/agent/run")` | Agent-platform execution with full agent identity context |
| POST | `/v1/workflow/run` | `callPythonWorkflowRun()` | Multi-step workflow sequencing with DAG |
| POST | `/v1/workflow/resume` | `callPythonWorkflowResume()` | Failure-resume with completed-node carry-forward |
| POST | `/v1/workflow/continue/approval` | `continueApproval()` | Resume workflow past approval gate |
| POST | `/v1/workflow/continue/human-input` | `continueHumanInput()` | Resume workflow past human-input gate |
| POST | `/v1/repositories/scan` | `callPythonRepositoryScan()` | Repository enrichment (language, classification, deps, overlap) |
| POST | `/v1/repositories/graph` | `callPythonRepositoryGraph()` | Graph derivation (overlap pairs + heuristic edges) |
| GET | `/v1/health` | (not called by TS) | Python service diagnostics |
| GET | `/v1/logs/recent` | (not called by TS) | Python in-memory log ring buffer |
| GET | `/v1/session` | (not called by TS) | Session ring buffer summary |
| GET | `/v1/mps-profiles` | (not called by TS) | MPS level reference table |
| POST | `/v1/explore` | (not called by TS) | Prompt exploration — candidate paths |

---

## TS Route → Python Endpoint Wiring

| TS Route | Python Endpoint | TS-Side Work |
|---|---|---|
| `GET /api/healthz` | None | TS-only health check (DB + core ping) |
| `GET /api/agents` | None | TS-only: agentsTable + lastRun join |
| `POST /api/agents` | None | TS-only: insert into agentsTable + agentRevisionsTable |
| `GET /api/agents/:id` | None | TS-only: DB read |
| `PATCH /api/agents/:id` | None | TS-only: update agentsTable + revision snapshot |
| `POST /api/agents/:id/disable` | None | TS-only: status update |
| `POST /api/agents/:id/enable` | None | TS-only: status update |
| `GET /api/agents/:id/revisions` | None | TS-only: agentRevisionsTable read |
| `POST /api/agents/run` | `POST /v1/agent/run` | Build AgentExecutionRequest, persist to agentRunsTable |
| `GET /api/agent-runs` | None | TS-only: agentRunsTable with full filter support |
| `GET /api/agent-runs/metrics` | None | TS-only: aggregate stats from agentRunsTable |
| `GET /api/agent-runs/:id` | None | TS-only: run detail + retry chain |
| `POST /api/agent-runs/:id/retry` | `POST /v1/agent/run` | Build retry run record, call Python, persist |
| `POST /api/agent-runs/:id/cancel` | None | TS-only: status update to cancelled |
| `GET /api/workflows` | None | TS-only: workflowsTable + lastRun join |
| `POST /api/workflows` | None | TS-only: insert into workflowsTable + revision |
| `POST /api/workflows/run` | `POST /v1/workflow/run` | Build payload, persist to workflowRunsTable, executor loop |
| `GET /api/workflow-runs` | None | TS-only: workflowRunsTable read |
| `GET /api/workflow-runs/:id/status` | None | TS-only: DB read with nodes[] + checkpoints[] |
| `POST /api/runs/:id/resume` | `POST /v1/workflow/resume` | Validate + carry forward completed nodes |
| `POST /api/approvals/:id/decide` | `POST /v1/workflow/continue/approval` | Validate pending approval, call Python, persist snapshot |
| `POST /api/human-inputs/:id/submit` | `POST /v1/workflow/continue/human-input` | Validate waiting_input state, call Python, persist snapshot |
| `GET /api/repositories` | None | TS-only: DB read + lastScan join |
| `POST /api/repositories/scan` | `POST /v1/repositories/scan` | Validate, persist atomically (run + repo updates) |
| `GET /api/repositories/graph` | `POST /v1/repositories/graph` | Read repos, forward to Python, wrap response |
| `GET /api/checkpoints` | None | TS-only: checkpointsTable read |
| `GET /api/metrics` | None | TS-only: aggregate stats |
| `GET /api/runs` | None | TS-only: legacy runsTable read |
| `GET /api/runs/:id/status` | None | TS-only: legacy runsTable + runNodesTable read |

---

## Classification Key

| Label | Meaning |
|---|---|
| `TS-ONLY` | Route served entirely by TS (manifest read, DB read, or status update); no Python call |
| `PYTHON-WIRED` | Route calls a Python endpoint and persists the result |

All routes are fully implemented.

---

## TS Python Client Functions

All Python calls are in `artifacts/api-server/src/lib/pythonClient.ts`.

| Function | Calls | Request shape | Response shape |
|---|---|---|---|
| `callPythonRun` | `POST /v1/run` | `PythonRunPayload` | `PythonRunResponse` |
| `fetchCore("/v1/agent/run")` | `POST /v1/agent/run` | `AgentExecutionRequest` | `CoreResponse` (with `modelUsed`) |
| `callPythonWorkflowRun` | `POST /v1/workflow/run` | `PythonWorkflowPayload` | `PythonWorkflowResponse` |
| `callPythonWorkflowResume` | `POST /v1/workflow/resume` | `PythonResumePayload` | `PythonWorkflowResponse` |
| `continueApproval` | `POST /v1/workflow/continue/approval` | `CoreApprovalContinuationRequest` | `PythonWorkflowResponse` |
| `continueHumanInput` | `POST /v1/workflow/continue/human-input` | `CoreHumanInputContinuationRequest` | `PythonWorkflowResponse` |
| `callPythonRepositoryScan` | `POST /v1/repositories/scan` | `PythonScanPayload` | `PythonScanResponse` |
| `callPythonRepositoryGraph` | `POST /v1/repositories/graph` | `PythonGraphPayload` | `PythonGraphResponse` |

Error handling: all functions throw `PythonCoreUnavailable` (connection failure)
or `PythonCoreError` (non-2xx response). Route handlers map these to 503 and 502.

---

## CoreResponse Contract (TS type)

`CoreResponse` in `pythonClient.ts` includes:

```typescript
interface CoreResponse {
  run_id: string;
  intent: string;
  mode: string;
  output_type: string;
  result: Record<string, unknown>;
  contract: Record<string, unknown> & {
    modelUsed?: string;   // real runtime model — reflects modelHint if provided
  };
  quality_score: number;
  canonical_trace: { ... };
  modelUsed?: string;    // top-level convenience field
  degraded?: boolean;
  [key: string]: unknown;
}
```

---

## Environment

- `PYTHON_CORE_URL` — base URL for Python core (default: `http://localhost:8000`)
- `HYPERFLOW_CORE_TOKEN` — internal Bearer token TS sends to Python
- Python core port: `8000`
- TS API server port: `$PORT` (default: `8080`, Platform Shell: `8099`)
