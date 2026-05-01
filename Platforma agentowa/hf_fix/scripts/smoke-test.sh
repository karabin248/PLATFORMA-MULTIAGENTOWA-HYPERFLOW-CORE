#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

echo "=== Hyperflow Smoke Test ==="

echo ""
echo "--- Static Checks (always run) ---"

echo "  Running pnpm typecheck..."
if pnpm run typecheck > /dev/null 2>&1; then
  pass "pnpm run typecheck"
else
  fail "pnpm run typecheck — TypeScript compilation errors"
fi

echo "  Checking Python core import..."
if python3 -c "import sys; sys.path.insert(0, 'artifacts/hyperflow-core'); import main" 2>/dev/null; then
  pass "python3 -c 'import main' (hyperflow-core)"
else
  fail "python3 -c 'import main' — Python import errors"
fi

echo ""
echo "--- Prerequisites ---"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "  PREREQ FAIL: DATABASE_URL is not set."
  exit 1
fi
echo "  DATABASE_URL is set"

if [ -z "${PYTHON_CORE_URL:-}" ]; then
  echo "  PREREQ FAIL: PYTHON_CORE_URL is not set."
  exit 1
fi
echo "  PYTHON_CORE_URL is set"

if ! curl -sf -o /dev/null "http://localhost:8000/v1/health" 2>/dev/null; then
  echo "  PREREQ FAIL: Python Core is not running on port 8000."
  echo "               Start the Hyperflow Python Core workflow."
  exit 1
fi
echo "  Python Core is running on port 8000"

if ! curl -sf -o /dev/null "http://localhost:8080/api/healthz" 2>/dev/null; then
  echo "  PREREQ FAIL: API Server is not running on port 8080."
  echo "               Start the API Server workflow."
  exit 1
fi
echo "  API Server is running on port 8080"

echo ""
echo "--- Route Checks ---"

check_route() {
  local url="$1"
  local label="$2"
  local resp
  resp=$(curl -sf "${url}" 2>/dev/null || true)
  if [ -n "$resp" ]; then
    local status
    status=$(echo "$resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
    if [ "$status" = "ok" ]; then
      pass "${label} returns status=ok"
    else
      fail "${label} expected status=ok, got: ${status}"
    fi
  else
    fail "${label} no response"
  fi
}

check_route "http://localhost:8000/v1/health" "GET /v1/health (Python Core)"
check_route "http://localhost:8080/api/healthz" "GET /api/healthz"
check_route "http://localhost:8080/api/agents" "GET /api/agents"
check_route "http://localhost:8080/api/workflows" "GET /api/workflows"
check_route "http://localhost:8080/api/agent-runs" "GET /api/agent-runs"
check_route "http://localhost:8080/api/workflow-runs" "GET /api/workflow-runs"
check_route "http://localhost:8080/api/repositories" "GET /api/repositories"
check_route "http://localhost:8080/api/repositories/graph" "GET /api/repositories/graph"

echo ""
echo "=== Results: ${PASS} passed, ${FAIL} failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
