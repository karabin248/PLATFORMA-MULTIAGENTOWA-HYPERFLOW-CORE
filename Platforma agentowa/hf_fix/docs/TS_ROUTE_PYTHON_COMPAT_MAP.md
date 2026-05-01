# TS Route ↔ Python Core Compatibility Map

**Frozen:** 2026-04-04
**Status:** Canonical — all routes verified against source

---

## Python Core Endpoints (live)

| Method | Path | Called by TS | Purpose |
|--------|------|-------------|---------|
| POST | `/v1/run` | `callPythonRun()` | Single-prompt agent execution |
| POST | `/v1/workflow/run` | `callPythonWorkflowRun()` | Multi-step workflow sequencing |
| POST | `/v1/workflow/resume` | `callPythonWorkflowResume()` | Failure-resume with completed-node carry-forward |
| POST | `/v1/repositories/scan` | `callPythonRepositoryScan()` | Repository enrichment (language, classification, deps, overlap) |
| POST | `/v1/repositories/graph` | `callPythonRepositoryGraph()` | Graph derivation (overlap pairs + heuristic edges) |
| GET | `/v1/health` | (not called by TS) | Python service diagnostics |
| GET | `/v1/logs/recent` | (not called by TS) | Python in-memory log ring buffer |
| POST | `/v1/explore` | (not called by TS) | Prompt exploration — candidate paths |

---

## TS Route → Python Endpoint Wiring

| TS Route | Python Endpoint | TS-Side Work |
|---|---|---|
| `GET /api/healthz` | None | TS-only health check |
| `GET /api/agents` | None | TS-only: registry + DB join for lastRun* |
| `POST /api/agents/run` | `POST /v1/run` | Resolve agentId → prompt, persist run |
| `GET /api/workflows` | None | TS-only: registry + DB join for lastRun* |
| `POST /api/workflows/run` | `POST /v1/workflow/run` | Resolve steps → prompts, persist run + nodes + checkpoint |
| `GET /api/runs` | None | TS-only: DB read |
| `GET /api/runs/:id/status` | None | TS-only: DB read with nodes[] |
| `POST /api/runs/:id/resume` | `POST /v1/workflow/resume` | Validate + claim checkpoint, persist updated run + nodes |
| `GET /api/repositories` | None | TS-only: DB read + lastScan join |
| `POST /api/repositories/scan` | `POST /v1/repositories/scan` | Validate, persist atomically (run + repo updates) |
| `GET /api/repositories/graph` | `POST /v1/repositories/graph` | Read repos, forward to Python, wrap response |

---

## Classification Key

| Label | Meaning |
|---|---|
| `TS-ONLY` | Route served entirely by TS (manifest read or DB read); no Python call |
| `PYTHON-WIRED` | Route calls a Python endpoint and persists the result |

All routes are fully implemented. No `NEEDS_DESIGN` or `NEEDS_PYTHON_EXT` routes remain.

---

## TS Python Client Functions

All Python calls are in `artifacts/api-server/src/lib/pythonClient.ts`.

| Function | Calls | Request shape | Response shape |
|---|---|---|---|
| `callPythonRun` | `POST /v1/run` | `PythonRunPayload` | `PythonRunResponse` |
| `callPythonWorkflowRun` | `POST /v1/workflow/run` | `PythonWorkflowPayload` | `PythonWorkflowResponse` |
| `callPythonWorkflowResume` | `POST /v1/workflow/resume` | `PythonResumePayload` | `PythonWorkflowResponse` |
| `callPythonRepositoryScan` | `POST /v1/repositories/scan` | `PythonScanPayload` | `PythonScanResponse` |
| `callPythonRepositoryGraph` | `POST /v1/repositories/graph` | `PythonGraphPayload` | `PythonGraphResponse` |

Error handling: all functions throw `PythonCoreUnavailable` (connection failure)
or `PythonCoreError` (non-2xx response). Route handlers map these to 503 and 502.

---

## Environment

- `PYTHON_CORE_URL` — base URL for Python core (default: `http://localhost:8000`)
- Python core port: `8000` (workflow: `Hyperflow Python Core`)
- TS API server port: `$PORT` (workflow: `artifacts/api-server: API Server`)
