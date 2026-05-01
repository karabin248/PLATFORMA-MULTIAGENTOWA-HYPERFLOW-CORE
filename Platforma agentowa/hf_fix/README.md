Hyperflow Python Core
Version 0.3.0 · Python 3.11+
The canonical Python runtime for the Hyperflow platform.
Hyperflow is not a general-purpose AI framework. It is a purposeful
execution engine built around the EDDE cycle (Perceive → Extract_essence → Sense_direction →
Synthesize → Generate_options → Choose) and the Multi-Pulse System (MPS) — a
7-level execution-depth controller that governs LLM temperature, candidate
generation, and observer rigor.

What this is



Module
Responsibility




engine/edde_orchestrator.py
Full 6-phase EDDE pipeline — strict ordered execution, injectable callbacks


control/mps_controller.py
7-level MPS: resolves execution depth from emoji, intent, and mode


language/emoji_parser.py
Trie-based emoji tokenizer: detects canonical combo 🌈💎🔥🧠🔀⚡, MPS markers, action signals


language/intent_resolver.py
Weighted keyword + emoji scoring → (intent, mode, output_type)


memory/store.py
JSONL knowledge store + traces + in-process session ring buffer


openrouter.py
OpenRouter async adapter — stub fallback when API key is absent


main.py
FastAPI app — all /v1/* endpoints; delegates compute to submodules



What this is not

Not a general AI framework. The EDDE cycle is fixed — phases do not run out of order.
Not a database. Memory persistence is flat JSONL files (session is in-process only).
Not a TS shell. The TypeScript layer in artifacts/api-server/ is a thin HTTP proxy.


Install
cd artifacts/hyperflow-core

# Runtime only
pip install -e .

# With test and build tools
pip install -e ".[test,build]"Copy to clipboard

Run
# Default port 8000; respects $PORT env var
python3 main.py

# Or via uvicorn directly
uvicorn main:app --host 0.0.0.0 --port 8000Copy to clipboard
Verify:
curl http://localhost:8000/v1/healthCopy to clipboard
Expected:
{
  "status": "ok",
  "service": "hyperflow-python-core",
  "version": "0.3.0",
  "canonical_phases": ["perceive", "extract_essence", "sense_direction", "synthesize", "generate_options", "choose"],
  "mps_levels": 7
}Copy to clipboard

Test
cd artifacts/hyperflow-core
make test
# or directly:
python3 -m pytest tests/ -vCopy to clipboard
All tests run without any external services or environment variables.

Build
cd artifacts/hyperflow-core
make build
# produces: dist/hyperflow-0.3.0-*.whl  dist/hyperflow-0.3.0.tar.gzCopy to clipboard

Release verify
cd artifacts/hyperflow-core
make release-verifyCopy to clipboard
Runs: editable install → module imports → unit tests. Gives a single PASS/FAIL signal.

Packaging smoke
cd artifacts/hyperflow-core
make packaging-smokeCopy to clipboard
Builds wheel + sdist, installs each into an isolated venv, and verifies basic imports.

Environment variables



Variable
Required
Default
Purpose




PORT
No
8000
Uvicorn listen port


OPENROUTER_API_KEY
No
—
LLM calls; absent → deterministic stub


OPENROUTER_MODEL
No
openai/gpt-4o-mini
Model for LLM calls




Endpoints



Method
Path
Description




GET
/v1/health
Service health + version


GET
/v1/logs/recent?limit=N
Recent run events (ring buffer)


GET
/v1/session
In-process session memory summary


GET
/v1/mps-profiles
MPS level reference table


POST
/v1/explore
Emoji-aware path exploration (no LLM)


POST
/v1/run
Full 6-phase EDDE pipeline + LLM


POST
/v1/workflow/run
Multi-step workflow with topo sort


POST
/v1/workflow/resume
Resume workflow from completed node set


POST
/v1/repositories/scan
Clone + classify + extract deps


POST
/v1/repositories/graph
Build dependency + affinity graph



Full contract: docs/runtime_contract.md

MPS levels (quick reference)



Level
Name
Temperature
Triggered by




1
Observation
0.3
Observational mode


2
Stabilize
0.5
Default


3
Harmonize
0.65
Analytical / explanatory mode


4
Amplify
0.75
Planning / generative / canonical combo 🌈💎🔥🧠🔀⚡


5
Dominant Core
0.85
💎 + plan/generate intent


6
Satellite Ops
0.90
Satellite execution policy


7
Emergency
0.2
🛑 signal




Canonical combo
The full execution trigger is: 🌈💎🔥🧠🔀⚡
When all 6 phase-emoji appear in the input, canonical_combo_detected = True
and MPS level is set to 4 (Amplify).

Ownership
This directory (artifacts/hyperflow-core/) is the single canonical owner of all
Python runtime code in this repository.

All Python modules (language/, control/, engine/, memory/, scanner/), tests,
packaging (pyproject.toml, MANIFEST.in), and build/test commands (Makefile)
live here and nowhere else.
The repository root is a workspace host only — it orchestrates TS/Python services
but does not own Python runtime code.
See docs/NEMERGED_OWNERSHIP_INVENTORY.md for the full inventory.

Architecture position
artifacts/operator-panel  →  artifacts/api-server  →  artifacts/hyperflow-core
                                     │
                                PostgreSQLCopy to clipboard
This package is the rightmost layer — the only one that performs compute.
It has no database dependency. It is stateless across requests.

