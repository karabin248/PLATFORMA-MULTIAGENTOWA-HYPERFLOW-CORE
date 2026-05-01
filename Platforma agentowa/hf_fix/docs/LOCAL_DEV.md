# Local Development Runbook

## Architecture

```
workspace root (host/workspace)
├── artifacts/hyperflow-core   ← canonical Python runtime (port 8000)
├── artifacts/api-server       ← thin TypeScript shell   (port 8080)
├── artifacts/operator-panel   ← React operator panel    (port: dynamic)
└── artifacts/mockup-sandbox   ← component preview       (port 8081)
```

## Prerequisites

- Python 3.11+
- Node.js 24+
- pnpm

## Startup Order

### 1. Python Core (required first)

```bash
cd artifacts/hyperflow-core

pip install -e .

# Start server
python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Or via make
make run
```

Verify:
```bash
curl http://localhost:8000/v1/health
```

### 2. TypeScript Shell (depends on Python Core)

```bash
pnpm --filter @workspace/api-server run dev
```

### 3. Component Sandbox (independent)

```bash
pnpm --filter @workspace/mockup-sandbox run dev
```

### 4. Operator Panel (depends on API Server)

```bash
pnpm --filter @workspace/operator-panel run dev
```

The panel proxies API calls to the API Server on port 8080.

## Environment Variables

| Variable | Service | Required | Default | Purpose |
|---|---|---|---|---|
| `OPENROUTER_API_KEY` | Python Core | No | — | LLM calls; absent = deterministic stub |
| `OPENROUTER_MODEL` | Python Core | No | `openai/gpt-4o-mini` | Which model to use |
| `HYPERFLOW_STORAGE_DIR` | Python Core | No | `./storage` | JSONL knowledge store |
| `PORT` | All | No | 8000/8080/8081 | Service port |
| `DATABASE_URL` | TS Shell | No | — | PostgreSQL connection |
| `SESSION_SECRET` | TS Shell | No | — | Express session secret |

## Testing

### Python Core (canonical test runner)
```bash
cd artifacts/hyperflow-core
make test              # unit tests
make release-verify    # full validation gate
make packaging-smoke   # wheel/sdist install smoke
make canonical-check   # canonical semantics CI gate (21 tests)
```

### TypeScript Shell
```bash
npx tsc -b lib/db             # build lib/db (composite TS project reference)
pnpm --filter @workspace/api-server run typecheck
```

### Operator Panel
```bash
pnpm --filter @workspace/operator-panel run typecheck
```

### Orval Codegen (regenerate API types)
```bash
cd lib/api-spec && npx orval
```

## Agent Operations

### Seed agents
```bash
curl -X POST http://localhost:8080/api/agents/seed
```

### List agents
```bash
curl http://localhost:8080/api/agents
curl http://localhost:8080/api/agents?status=active
```

### Create an agent
```bash
curl -X POST http://localhost:8080/api/agents \
  -H "Content-Type: application/json" \
  -d '{"id": "agent-custom", "name": "Custom Agent", "version": "1.0.0"}'
```

### Get agent detail
```bash
curl http://localhost:8080/api/agents/agent-general-assistant
```

### Update an agent
```bash
curl -X PATCH http://localhost:8080/api/agents/agent-general-assistant \
  -H "Content-Type: application/json" \
  -d '{"description": "Updated description", "version": "1.1.0"}'
```

### Disable/enable an agent
```bash
curl -X POST http://localhost:8080/api/agents/agent-general-assistant/disable
curl -X POST http://localhost:8080/api/agents/agent-general-assistant/enable
```

### View revision history
```bash
curl http://localhost:8080/api/agents/agent-general-assistant/revisions
```

### Run an agent
```bash
curl -X POST http://localhost:8080/api/agents/run \
  -H "Content-Type: application/json" \
  -d '{"agentId": "agent-general-assistant", "input": {"prompt": "Analyze the system"}}'
```

### List runs (with filters)
```bash
curl http://localhost:8080/api/agent-runs
curl "http://localhost:8080/api/agent-runs?status=failed&agentId=agent-general-assistant"
curl "http://localhost:8080/api/agent-runs?from=2026-01-01T00:00:00Z&minQualityScore=0.8"
```

### Get run detail
```bash
curl http://localhost:8080/api/agent-runs/<run-id>
```

### Get aggregate metrics
```bash
curl http://localhost:8080/api/agent-runs/metrics
```

### Retry a failed run
```bash
curl -X POST http://localhost:8080/api/agent-runs/<run-id>/retry \
  -H "Content-Type: application/json" \
  -d '{"reason": "Transient error"}'
```

### Cancel a running run
```bash
curl -X POST http://localhost:8080/api/agent-runs/<run-id>/cancel
```

## Building

```bash
cd artifacts/hyperflow-core
make build
# outputs: dist/hyperflow-0.3.0-py3-none-any.whl
#          dist/hyperflow-0.3.0.tar.gz
```

## Inspecting Canonical Execution

### Verify canonical combo from health
```bash
curl http://localhost:8000/v1/health | python3 -m json.tool
# Check: canonical_combo = "🌈💎🔥🧠🔀⚡"
# Check: canonical_phases = ["perceive","extract_essence","sense_direction","synthesize","generate_options","choose"]
```

### Verify canonical trace in a run
```bash
curl -X POST http://localhost:8000/v1/run \
  -H "Content-Type: application/json" \
  -d '{"prompt": "test"}' | python3 -m json.tool
# Check: canonical_combo, canonical_phases, canonical_trace fields present
# Check: canonical_trace.order_preserved = true
# Check: canonical_trace.phases_completed has all 6 phases
```

### Run canonical check gate
```bash
cd artifacts/hyperflow-core
make canonical-check
```

## Troubleshooting

**Python imports fail**: Run `pip install -e .` from `artifacts/hyperflow-core/`
**Stub mode**: If no `OPENROUTER_API_KEY`, the system returns deterministic stub responses — fully functional, no external deps.
**Port conflicts**: Each service has a dedicated port. Check that nothing else is bound to 8000/8080/8081.
**lib/db build**: Run `npx tsc -b lib/db` before api-server typecheck (composite TS project references).
