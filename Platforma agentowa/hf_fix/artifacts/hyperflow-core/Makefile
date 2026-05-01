.PHONY: help install install-dev test build clean release-verify packaging-smoke run canonical-check

PYTHON   ?= python3
PIP      ?= pip
PYTEST   ?= python3 -m pytest
BUILD    ?= python3 -m build
DIST_DIR  = dist

help:
	@echo "Hyperflow Python Core — available targets"
	@echo ""
	@echo "  install          Install package in editable mode (runtime deps)"
	@echo "  install-dev      Install package in editable mode with test + build extras"
	@echo "  test             Run unit tests with pytest"
	@echo "  build            Build sdist and wheel into $(DIST_DIR)/"
	@echo "  clean            Remove build artefacts and __pycache__"
	@echo "  release-verify   Install, import, test, version — hard PASS/FAIL gate"
	@echo "  packaging-smoke  Build, then install wheel/sdist to isolated dirs + smoke"
	@echo "  run              Start the FastAPI server on port 8000"

install:
	$(PIP) install -e .

install-dev:
	$(PIP) install -e ".[test,build]"

test:
	$(PYTEST) tests/ -v

build: clean
	$(BUILD) --outdir $(DIST_DIR)

clean:
	rm -rf $(DIST_DIR) build *.egg-info hyperflow.egg-info __pycache__
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.pyc" -delete 2>/dev/null || true

release-verify: install
	@echo "=== hyperflow release-verify ==="
	@$(PYTHON) -c "import hyperflow; print('  [OK] hyperflow package version:', hyperflow.__version__)"
	@$(PYTHON) -c "from hyperflow.cli import main; print('  [OK] CLI entrypoint importable')"
	@$(PYTHON) -c "from language.emoji_parser import parse, CANONICAL_PHASES; \
		assert len(CANONICAL_PHASES) == 6, 'wrong phase count'; \
		print('  [OK] emoji_parser:', CANONICAL_PHASES)"
	@$(PYTHON) -c "from control.mps_controller import MPS_PROFILES, build_mps_context; \
		assert len(MPS_PROFILES) == 7, 'wrong profile count'; \
		print('  [OK] mps_controller: 7 levels')"
	@$(PYTHON) -c "from engine.edde_orchestrator import run_edde; print('  [OK] edde_orchestrator importable')"
	@$(PYTHON) -c "from language.intent_resolver import resolve; \
		i, m, o = resolve('plan the architecture'); \
		assert i == 'plan', f'expected plan got {i}'; \
		print('  [OK] intent_resolver: plan ->', m, o)"
	@$(PYTHON) -c "from memory.store import get_session_summary; print('  [OK] memory.store importable')"
	@$(PYTHON) -c "from scanner.core import compute_overlap_scores; print('  [OK] scanner.core importable')"
	@$(PYTHON) -c "import main; print('  [OK] main.py importable as module')"
	@$(PYTHON) -c "import openrouter; print('  [OK] openrouter.py importable as module')"
	$(PYTEST) tests/ -q --tb=short
	@echo "=== release-verify PASS ==="

packaging-smoke: build
	@echo "=== packaging-smoke: wheel ==="
	@rm -rf /tmp/hf_smoke_wheel
	@$(PIP) install --target /tmp/hf_smoke_wheel --no-deps --no-user --quiet $(DIST_DIR)/hyperflow-*.whl
	@PYTHONPATH=/tmp/hf_smoke_wheel $(PYTHON) -c "import hyperflow; print('  [OK] wheel version:', hyperflow.__version__)"
	@PYTHONPATH=/tmp/hf_smoke_wheel $(PYTHON) -c "from language.emoji_parser import CANONICAL_PHASES; print('  [OK] wheel emoji_parser, phases:', CANONICAL_PHASES)"
	@PYTHONPATH=/tmp/hf_smoke_wheel $(PYTHON) -c "from control.mps_controller import MPS_PROFILES; print('  [OK] wheel mps_controller, profiles:', len(MPS_PROFILES))"
	@PYTHONPATH=/tmp/hf_smoke_wheel $(PYTHON) -c "from hyperflow.cli import main; print('  [OK] wheel CLI entrypoint importable')"
	@PYTHONPATH=/tmp/hf_smoke_wheel $(PYTHON) -c "import main; print('  [OK] wheel main.py importable')"
	@PYTHONPATH=/tmp/hf_smoke_wheel $(PYTHON) -c "import openrouter; print('  [OK] wheel openrouter.py importable')"
	@rm -rf /tmp/hf_smoke_wheel
	@echo "  wheel smoke PASS"
	@echo "=== packaging-smoke: sdist ==="
	@rm -rf /tmp/hf_smoke_sdist
	@$(PIP) install --target /tmp/hf_smoke_sdist --no-deps --no-user --quiet $(DIST_DIR)/hyperflow-*.tar.gz
	@PYTHONPATH=/tmp/hf_smoke_sdist $(PYTHON) -c "import hyperflow; print('  [OK] sdist version:', hyperflow.__version__)"
	@PYTHONPATH=/tmp/hf_smoke_sdist $(PYTHON) -c "from engine.edde_orchestrator import run_edde; print('  [OK] sdist edde_orchestrator importable')"
	@PYTHONPATH=/tmp/hf_smoke_sdist $(PYTHON) -c "from memory.store import get_session_summary; print('  [OK] sdist memory.store importable')"
	@PYTHONPATH=/tmp/hf_smoke_sdist $(PYTHON) -c "import main; print('  [OK] sdist main.py importable')"
	@rm -rf /tmp/hf_smoke_sdist
	@echo "  sdist smoke PASS"

canonical-check:
	@echo "=== canonical-check ==="
	@$(PYTHON) -c "\
from language.emoji_parser import CANONICAL_COMBO, CANONICAL_PHASES, SYMBOL_TO_PHASE; \
assert CANONICAL_COMBO == '🌈💎🔥🧠🔀⚡', f'combo drift: {CANONICAL_COMBO}'; \
assert CANONICAL_PHASES == ['perceive','extract_essence','sense_direction','synthesize','generate_options','choose'], f'phase drift: {CANONICAL_PHASES}'; \
assert len(CANONICAL_PHASES) == 6, 'phase count != 6'; \
print('  [OK] canonical combo + phases match')"
	@$(PYTHON) -c "\
import json; from pathlib import Path; from language.emoji_parser import CANONICAL_PHASES, SYMBOL_TO_PHASE; \
cfg = json.loads(Path('configs/canonical_semantics.json').read_text()); \
assert cfg['cycle']['order'] == CANONICAL_PHASES, 'config order drift'; \
assert all(SYMBOL_TO_PHASE[s] == p for p, s in cfg['cycle']['symbols'].items()), 'symbol drift'; \
assert cfg['authority']['execution'] == 'python_core', 'authority drift'; \
print('  [OK] config matches runtime')"
	$(PYTEST) tests/test_canonical_semantics.py tests/test_canonical_no_shell_drift.py -v --tb=short
	@echo "=== canonical-check PASS ==="

run:
	$(PYTHON) -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
