# Nemerged Ownership Inventory

**Date:** 2026-04-09
**Purpose:** Definitive inventory of Python ownership — what belongs where after MVP cleanup.

---

## Canonical Python Runtime Owner

**`artifacts/hyperflow-core/`** — the one and only canonical Python runtime.

All Python compute, EDDE pipeline, MPS controller, emoji parser, intent resolver,
memory layer, scanner, and LLM adapter live here.

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
| `core/contracts/` | Yes — Pydantic models | **Reference only** | Shared contract models; may be extracted to shared lib later |
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
├── memory/                # Knowledge store, traces, session buffer
├── scanner/               # Repository analyzer
├── configs/               # canonical_semantics.json
├── storage/               # Runtime storage (JSONL files)
├── tests/                 # All runtime tests (consolidated)
├── docs/                  # Runtime contract docs
├── main.py                # FastAPI app entry point
├── openrouter.py          # OpenRouter LLM adapter
├── pyproject.toml         # Package metadata (build-backend: setuptools.build_meta)
├── Makefile               # Canonical build/test/release commands
├── MANIFEST.in            # sdist/wheel inclusion rules
├── README.md              # Core-specific README
├── requirements.txt       # Pinned runtime deps (mirrors pyproject.toml)
└── pytest.ini             # Test config (also in pyproject.toml)
```

---

## Invariants

1. Root is a **workspace host only** — it orchestrates TS/Python services, it does not own Python runtime code.
2. `artifacts/hyperflow-core/` is the **single canonical Python owner** — all runtime tests, packaging, and release flow live here.
3. The TS API server (`artifacts/api-server/`) is a **thin shell** — it calls Python core via HTTP, persists to PostgreSQL, shapes responses.
4. The operator panel (`artifacts/operator-panel/`) is a **thin UI layer** — it reads from the TS shell API.
