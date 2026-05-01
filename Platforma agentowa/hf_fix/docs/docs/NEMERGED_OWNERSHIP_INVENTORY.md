# Nemerged Ownership Inventory

**Date:** 2026-04-09
**Updated:** 2026-05-01
**Purpose:** Definitive inventory of Python ownership — what belongs where after MVP cleanup.

---

## Canonical Python Runtime Owner

**`artifacts/hyperflow-core/`** — the one and only canonical Python runtime.

All Python compute, EDDE pipeline, MPS controller, emoji parser, intent resolver,
memory layer, scanner, and LLM adapter live here.

---

## Canonical TypeScript Platform Owner

**`artifacts/api-server/`** — the TypeScript control plane.

This is NOT a thin passthrough shell. It is a full-featured control platform with:
- Agent and workflow registries (CRUD, revisions, lifecycle)
- Agent run lifecycle: execution, retry chains, cancel, metrics, quality filtering
- Workflow run lifecycle: DAG execution via Python, approval/human-input gates, resume
- Executor polling loop with lease TTL, stale recovery, and concurrency control
- DB persistence layer for all Python-returned values
- Auth (Bearer token), rate limiting, body validation, CORS
- Operator-facing routes with pagination, full-text search, date-range filtering

The correct characterization: **TypeScript is the control plane; Python is the execution engine.**
"Thin shell" is misleading — TS owns significant operational logic that is not in Python.

---

## Root-Level Files — Disposition

| File / Dir | Origin | Disposition | Reason |
|---|---|---|---|
| `main.py` | Replit template | **Keep (host placeholder)** | Replit workspace placeholder; not runtime code |
| `pyproject.toml` | Replit template | **Keep (workspace config)** | Named `repl-nix-workspace`; not the runtime package |
| `package.json` | Monorepo host | **Keep** | pnpm workspace root |
| `pnpm-workspace.yaml` | Monorepo host | **Keep** | Workspace package discovery |
| `tsconfig*.json` | Monorepo host | **Keep** | TypeScript build config |

### Files from ZIP that were root-level Python ownership artifacts (now resolved)

| File / Dir | Was In Root ZIP | Disposition | Reason |
|---|---|---|---|
| `main.py` (runtime) | Yes — full FastAPI app | **Moved to core** | Canonical runtime lives in `artifacts/hyperflow-core/main.py` |
| `openrouter.py` | Yes — LLM adapter | **Moved to core** | Runtime dependency, lives in core |
| `Makefile` | Yes — build/test commands | **Replaced by core Makefile** | Core owns its own build/test flow |
| `MANIFEST.in` | Yes — packaging manifest | **Replaced by core MANIFEST.in** | Core owns its own sdist/wheel packaging |
| `pytest.ini` | Yes — test config | **Replaced by core pyproject.toml** | Test config consolidated in `[tool.pytest.ini_options]` |
| `requirements.txt` | Yes — Python deps | **Replaced by core pyproject.toml** | Dependencies declared in `[project.dependencies]` |
| `hyperflow/` | Yes — version.py + tests | **Replaced by core `hyperflow/`** | Package module now in `artifacts/hyperflow-core/hyperflow/` |
| `tests/` | Yes — 50+ test files | **Consolidated into core `tests/`** | Runtime tests live with runtime |
| `tests_base/` | Yes — baseline tests | **Consolidated into core `tests/`** | Deduplicated |
| `tests_integration/` | Yes — integration tests | **Consolidated into core `tests/`** | Deduplicated |
| `scanner/` | Yes — repo analyzer | **Moved to core `scanner/`** | Runtime module |
| `core/contracts/` | Yes — Pydantic models | **Reference only** | Shared contract models |
| `configs/` | Yes — canonical_semantics.json | **Copied to core `configs/`** | Runtime config |

---

## Core Package Structure (after cleanup)

```
artifacts/hyperflow-core/
├── hyperflow/             # Package module (version, CLI)
│   ├── __init__.py        # __version__ = "0.3.0"
│   └── cli.py             # CLI entrypoint: `hyperflow --version`, `hyperflow serve`
├── language/              # Emoji parser, intent resolver
├── control/               # MPS controller
├── engine/                # EDDE orchestrator
├── workflow/              # DAG executors, contracts, graph
├── memory/                # Knowledge store, traces, session buffer
├── scanner/               # Repository analyzer
├── configs/               # canonical_semantics.json
├── storage/               # Runtime storage (JSONL files)
├── tests/                 # All runtime tests (consolidated)
├── docs/                  # Runtime contract docs
├── main.py                # FastAPI app entry point
├── openrouter.py          # OpenRouter LLM adapter (with modelHint support)
├── pyproject.toml         # Package metadata
├── Makefile               # Canonical build/test/release commands
├── MANIFEST.in            # sdist/wheel inclusion rules
├── README.md              # Core-specific README
└── pytest.ini             # Test config
```

---

## API Server Structure

```
artifacts/api-server/
├── src/
│   ├── routes/            # HTTP route handlers
│   │   ├── agents.ts      # Agent CRUD + revisions
│   │   ├── agentRuns.ts   # Agent run execution, retry, cancel, metrics
│   │   ├── workflows.ts   # Workflow CRUD + run submission
│   │   ├── approvals.ts   # Approval decisions → Python continuation
│   │   ├── humanInputs.ts # Human-input submission → Python continuation
│   │   ├── checkpoints.ts # Checkpoint reads
│   │   ├── repositories.ts # Repo list, scan, graph
│   │   ├── runs.ts        # Legacy run reads
│   │   ├── health.ts      # Health check
│   │   └── metrics.ts     # Aggregate metrics
│   ├── lib/
│   │   ├── pythonClient.ts       # Python Core HTTP client
│   │   ├── workflowProjection.ts # Atomic workflow DB writes
│   │   ├── workflowExecutor.ts   # Executor polling loop + lease TTL
│   │   ├── runLifecycle.ts       # RunStatus type + VALID_TRANSITIONS
│   │   ├── resumeEligibility.ts  # Resume gate checks
│   │   └── resumeValidator.ts    # Checkpoint validation
│   ├── domain/
│   │   ├── agents.ts      # Agent domain (previously registry)
│   │   └── workflows.ts   # Workflow domain
│   ├── orchestrator/
│   │   ├── storage.ts     # DEPRECATED — legacy runsTable writes
│   │   └── types.ts       # Shared types (CheckpointStatus incl. "superseded")
│   └── middlewares/
│       ├── auth.ts        # Bearer token enforcement
│       └── rateLimiter.ts # Rate limiting
└── tests/                 # TS test suite (33 .mjs files, bridge-contract tests)
```

---

## Invariants

1. Root is a **workspace host only** — it orchestrates TS/Python services, it does not own Python runtime code.
2. `artifacts/hyperflow-core/` is the **single canonical Python owner** — all runtime tests, packaging, and release flow live here.
3. The TS API server (`artifacts/api-server/`) is the **control plane** — it owns agent/workflow lifecycle, DB persistence, executor loop, approval gates, and all operator-facing routes. It calls Python for execution and persists the results.
4. The operator panel (`artifacts/operator-panel/`) is the **display surface** — it reads from the TS API.
5. `orchestrator/storage.ts` is **DEPRECATED** — do not add writes. Migrate to `workflowProjection.ts` (workflows) or `agentRunsTable` (agent runs).
