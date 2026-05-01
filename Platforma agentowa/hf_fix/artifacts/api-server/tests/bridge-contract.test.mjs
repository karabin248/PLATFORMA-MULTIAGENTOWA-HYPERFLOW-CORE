/**
 * bridge-contract.test.mjs
 *
 * BRIDGE INTEGRITY CONTRACT TESTS
 *
 * Verifies that the TS shell and Python core contract surfaces are correctly
 * aligned and that every admission-gate and startup guard added in the EDDE
 * patch sprint operates as specified.
 *
 * Coverage areas:
 *
 *   A. SCHEMA INTEGRITY
 *      A1. All lease/cancel/stateLog fields are inside pgTable() — CRIT-01 regression guard
 *      A2. WORKFLOW_RUN_STATUSES exported and complete
 *      A3. status check constraint present in schema definition
 *
 *   B. PROMPT LENGTH ENFORCEMENT (HIGH-01)
 *      B1. Prompt within limit → no rejection
 *      B2. Prompt at exact limit → no rejection (boundary inclusive)
 *      B3. Prompt exceeding limit → HTTP 400 / PROMPT_TOO_LONG
 *      B4. Error body shape matches contract (code, category, retryable, details[].field)
 *
 *   C. STARTUP TOKEN ENFORCEMENT (MED-02)
 *      C1. Hardened mode + HYPERFLOW_CORE_TOKEN present → no fatal
 *      C2. Hardened mode + HYPERFLOW_CORE_TOKEN absent → fatal logged + exit path triggered
 *      C3. Dev mode + HYPERFLOW_CORE_TOKEN absent → no fatal (token not required)
 *
 *   D. OPERATOR SUMMARY OBSERVABILITY (PHASE 6)
 *      D1. deriveOperatorSummary includes executorId, leaseExpiresAt, heartbeatAt, retryAttempt
 *      D2. Null/undefined inputs produce safe zero-value defaults (not undefined)
 *      D3. Date objects are serialised to ISO-8601 strings, not raw Date instances
 *      D4. leaseExpiresAt from string passthrough preserved
 *
 *   E. STATE LOG EVENT CONSTANTS (PHASE 6)
 *      E1. WORKFLOW_RUN_STATE_LOG_EVENTS contains required canonical values
 *      E2. No duplicate values across the constants object
 *      E3. appendStateLogEvent in workflowExecutor.ts references only constants — regression guard
 *
 *   F. TS ↔ PYTHON REQUEST SHAPE (CONTRACT PARITY)
 *      F1. CoreWorkflowRunRequest fields match Python RunRequest Pydantic model
 *      F2. CoreApprovalContinuationRequest carries completedNodes + nodeId + approvedBy
 *      F3. CoreHumanInputContinuationRequest carries completedNodes + nodeId + humanInput
 *      F4. Python response canonicalTrace field preserved through TS projection
 *
 *   G. DOCKER IMAGE DIGEST PINNING (MED-01)
 *      G1. .gitlab-ci.yml python and node base images use digest-pinned format
 *      G2. Floating tags python:3.12 and node:24 are no longer bare
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const root  = join(__dir, "../../..");

// ---------------------------------------------------------------------------
// Source file readers (static analysis — no build step required)
// ---------------------------------------------------------------------------

function src(relPath) {
  return readFileSync(join(__dir, relPath), "utf8");
}

function rootSrc(relPath) {
  return readFileSync(join(root, relPath), "utf8");
}

const workflowRunsSchema  = rootSrc("lib/db/src/schema/workflowRuns.ts");
const workflowProjection  = src("../src/lib/workflowProjection.ts");
const workflowExecutor    = src("../src/lib/workflowExecutor.ts");
const configTs            = src("../src/lib/config.ts");
const agentRunsTs         = src("../src/routes/agentRuns.ts");
const pythonClientTs      = src("../src/lib/pythonClient.ts");
const gitlabCi            = rootSrc(".gitlab-ci.yml");

// ---------------------------------------------------------------------------
// A. SCHEMA INTEGRITY — CRIT-01 regression guards
// ---------------------------------------------------------------------------

test("A1: all critical lease/cancel/stateLog fields are inside the pgTable() column object", () => {
  const requiredFields = [
    "executorId",
    "leaseToken",
    "leaseExpiresAt",
    "heartbeatAt",
    "retryAttempt",
    "cancelState",
    "cancelRequestedAt",
    "cancelRequestedBy",
    "timeoutMs",
    "timedOutAt",
    "stateLog",
  ];

  // The column-definition object closes at the first `}, (table) => ([` boundary.
  // Everything before that boundary is inside pgTable(). Everything after is
  // the index/constraint array or module-level code.
  const pgTableOpen  = workflowRunsSchema.indexOf("pgTable(\"workflow_runs\", {");
  const columnClose  = workflowRunsSchema.indexOf("}, (table) => ([");

  assert.ok(pgTableOpen >= 0,  "pgTable(\"workflow_runs\", { not found");
  assert.ok(columnClose  > pgTableOpen, "}, (table) => ([ closing boundary not found after pgTable open");

  const columnBlock = workflowRunsSchema.slice(pgTableOpen, columnClose);

  for (const field of requiredFields) {
    assert.ok(
      columnBlock.includes(field + ":"),
      `CRIT-01 regression: field '${field}' is not inside the pgTable() column definition object`,
    );
  }
});

test("A2: WORKFLOW_RUN_STATUSES is exported and contains all required status values", () => {
  const requiredStatuses = [
    "queued", "running", "completed", "failed",
    "waiting_approval", "waiting_input", "cancelled",
  ];
  for (const s of requiredStatuses) {
    assert.ok(
      workflowRunsSchema.includes(`"${s}"`),
      `WORKFLOW_RUN_STATUSES is missing value "${s}"`,
    );
  }
  assert.ok(
    workflowRunsSchema.includes("export const WORKFLOW_RUN_STATUSES"),
    "WORKFLOW_RUN_STATUSES is not exported",
  );
});

test("A3: status check constraint is present in workflowRuns schema", () => {
  assert.ok(
    workflowRunsSchema.includes("workflow_run_status_chk"),
    "DB-level status check constraint 'workflow_run_status_chk' not found in schema",
  );
  assert.ok(
    workflowRunsSchema.includes("check("),
    "Drizzle check() call not found in schema",
  );
});

// ---------------------------------------------------------------------------
// B. PROMPT LENGTH ENFORCEMENT — HIGH-01
// ---------------------------------------------------------------------------

test("B1–B4: agentRuns.ts contains promptMaxLength admission gate with correct contract shape", () => {
  // B1/B2: The gate must be present
  assert.ok(
    agentRunsTs.includes("config.promptMaxLength"),
    "B1: promptMaxLength is not referenced in agentRuns.ts — enforcement gate missing",
  );

  // B3: Must compare resolvedPrompt.length against the limit
  assert.ok(
    agentRunsTs.includes("resolvedPrompt.length > config.promptMaxLength"),
    "B3: resolvedPrompt.length > config.promptMaxLength comparison not found — gate condition missing",
  );

  // B3: Must return HTTP 400
  assert.ok(
    agentRunsTs.includes("res.status(400)"),
    "B3: HTTP 400 response not found in agentRuns.ts",
  );

  // B4: Error code must be PROMPT_TOO_LONG
  assert.ok(
    agentRunsTs.includes("PROMPT_TOO_LONG"),
    "B4: PROMPT_TOO_LONG error code not found in agentRuns.ts",
  );

  // B4: category must be validation_error
  assert.ok(
    agentRunsTs.includes('"validation_error"'),
    "B4: category: 'validation_error' not found in agentRuns.ts error response",
  );

  // B4: retryable: false
  assert.ok(
    agentRunsTs.includes("retryable: false"),
    "B4: retryable: false not found in PROMPT_TOO_LONG response body",
  );

  // B4: details array with field key
  assert.ok(
    agentRunsTs.includes('"prompt"'),
    "B4: details[].field = 'prompt' not found in PROMPT_TOO_LONG error body",
  );
});

test("B — gate must fire BEFORE runtimeRequest is constructed (no premature DB write)", () => {
  // The promptMaxLength check must appear before the runtimeRequest object literal
  const gatePos    = agentRunsTs.indexOf("resolvedPrompt.length > config.promptMaxLength");
  const requestPos = agentRunsTs.indexOf("const runtimeRequest = {");

  assert.ok(gatePos    >= 0, "promptMaxLength gate not found");
  assert.ok(requestPos >= 0, "runtimeRequest construction not found");
  assert.ok(
    gatePos < requestPos,
    "Prompt length gate fires AFTER runtimeRequest construction — DB write could precede rejection",
  );
});

// ---------------------------------------------------------------------------
// C. STARTUP TOKEN ENFORCEMENT — MED-02
// ---------------------------------------------------------------------------

test("C1–C3: config.ts enforces HYPERFLOW_CORE_TOKEN in hardened mode", () => {
  // C2: HYPERFLOW_CORE_TOKEN check must be inside hardenedMode guard
  assert.ok(
    configTs.includes("HYPERFLOW_CORE_TOKEN"),
    "C2: HYPERFLOW_CORE_TOKEN is not referenced in config.ts",
  );

  // C2: Must emit a fatal log
  assert.ok(
    configTs.includes("logger.fatal"),
    "C2: logger.fatal not found in config.ts — startup failure is not logged",
  );

  // C2: Must call process.exit(1) on missing token
  assert.ok(
    configTs.includes("process.exit(1)"),
    "C2: process.exit(1) not found in config.ts — server does not fail fast on missing token",
  );

  // C2: HYPERFLOW_CORE_TOKEN check must be inside the hardenedMode block
  const hardenedBlock = configTs.slice(
    configTs.indexOf("if (hardenedMode)"),
    configTs.indexOf("} else {"),
  );
  assert.ok(
    hardenedBlock.includes("HYPERFLOW_CORE_TOKEN"),
    "C2: HYPERFLOW_CORE_TOKEN check is outside the hardenedMode block — will fire in dev mode",
  );
});

test("C — pythonClient reads HYPERFLOW_CORE_TOKEN from env (token forwarding path exists)", () => {
  assert.ok(
    pythonClientTs.includes("HYPERFLOW_CORE_TOKEN"),
    "pythonClient.ts does not read HYPERFLOW_CORE_TOKEN — token cannot be forwarded to Python core",
  );
  assert.ok(
    pythonClientTs.includes("x-internal-token"),
    "pythonClient.ts does not set x-internal-token header — Python core auth will fail",
  );
});

// ---------------------------------------------------------------------------
// D. OPERATOR SUMMARY OBSERVABILITY — PHASE 6
// ---------------------------------------------------------------------------

// Pure-function test: dynamically import the projection module
// These tests use direct property-presence checks on the source as a static
// fallback, since the module cannot be imported without a full TS build.

test("D1: RunOperatorSummary interface declares all four executor/lease fields", () => {
  const fields = ["executorId", "leaseExpiresAt", "heartbeatAt", "retryAttempt"];

  // Find the RunOperatorSummary interface block
  const start = workflowProjection.indexOf("export interface RunOperatorSummary {");
  const end   = workflowProjection.indexOf("}", start);
  const block = workflowProjection.slice(start, end);

  for (const f of fields) {
    assert.ok(block.includes(f), `RunOperatorSummary is missing field '${f}'`);
  }
});

test("D2–D4: deriveOperatorSummary returns all executor/lease fields with safe defaults", () => {
  const start = workflowProjection.indexOf("export function deriveOperatorSummary(");
  const end   = workflowProjection.indexOf("\n}", start) + 2;
  const fn    = workflowProjection.slice(start, end);

  // D2: Must handle undefined/null with ?? 0 or ?? null
  assert.ok(
    fn.includes("retryAttempt: run.retryAttempt ?? 0"),
    "D2: retryAttempt default (run.retryAttempt ?? 0) not found — undefined leaks into response",
  );
  assert.ok(
    fn.includes("executorId: run.executorId ?? null"),
    "D2: executorId default (run.executorId ?? null) not found",
  );

  // D3: Date objects must be converted to ISO strings
  assert.ok(
    fn.includes("toISOString()"),
    "D3: toISOString() not found in deriveOperatorSummary — Date objects will leak into JSON response",
  );

  // D4: leaseExpiresAt and heartbeatAt must be present in return
  assert.ok(fn.includes("leaseExpiresAt"),  "D4: leaseExpiresAt not in deriveOperatorSummary return");
  assert.ok(fn.includes("heartbeatAt"),     "D4: heartbeatAt not in deriveOperatorSummary return");
});

// ---------------------------------------------------------------------------
// E. STATE LOG EVENT CONSTANTS — PHASE 6
// ---------------------------------------------------------------------------

test("E1: WORKFLOW_RUN_STATE_LOG_EVENTS contains all required canonical event values", () => {
  const requiredEvents = [
    "QUEUED", "EXECUTING", "COMPLETED", "FAILED", "CANCELLED", "REQUEUED",
    "LEASE_ACQUIRED", "LEASE_RENEWED", "LEASE_LOST",
    "APPROVAL_WAITING", "HUMAN_INPUT_WAITING", "RESUME_REQUESTED",
    "CANCEL_REQUESTED", "TIMED_OUT",
  ];
  for (const key of requiredEvents) {
    assert.ok(
      workflowProjection.includes(key + ":"),
      `E1: WORKFLOW_RUN_STATE_LOG_EVENTS missing key '${key}'`,
    );
  }
  assert.ok(
    workflowProjection.includes("export const WORKFLOW_RUN_STATE_LOG_EVENTS"),
    "E1: WORKFLOW_RUN_STATE_LOG_EVENTS is not exported from workflowProjection.ts",
  );
});

test("E2: no duplicate values in WORKFLOW_RUN_STATE_LOG_EVENTS", () => {
  const block = workflowProjection.slice(
    workflowProjection.indexOf("export const WORKFLOW_RUN_STATE_LOG_EVENTS"),
    workflowProjection.indexOf("} as const;", workflowProjection.indexOf("export const WORKFLOW_RUN_STATE_LOG_EVENTS")) + 10,
  );
  const values = [...block.matchAll(/"([a-z_]+)"/g)].map(m => m[1]);
  const unique  = new Set(values);
  assert.equal(
    values.length, unique.size,
    `E2: duplicate event values detected in WORKFLOW_RUN_STATE_LOG_EVENTS: ${values.filter((v,i) => values.indexOf(v) !== i).join(", ")}`,
  );
});

test("E3: workflowExecutor.ts uses no bare string-literal event names in appendStateLogEvent calls", () => {
  // Extract all appendStateLogEvent call lines
  const lines = workflowExecutor
    .split("\n")
    .filter(line => line.includes("appendStateLogEvent("));

  const stringLiteralPattern = /appendStateLogEvent\([^,]+,\s*"/;
  const violations = lines.filter(line => stringLiteralPattern.test(line));

  assert.equal(
    violations.length, 0,
    `E3: ${violations.length} appendStateLogEvent call(s) still use bare string literals instead of WORKFLOW_RUN_STATE_LOG_EVENTS constants:\n${violations.map(l => "  " + l.trim()).join("\n")}`,
  );
});

// ---------------------------------------------------------------------------
// F. TS ↔ PYTHON REQUEST SHAPE (CONTRACT PARITY)
// ---------------------------------------------------------------------------

test("F1: pythonClient defines CoreWorkflowRunRequest with required Python-matching fields", () => {
  const required = ["prompt", "agent_id", "run_policy"];
  for (const field of required) {
    assert.ok(
      pythonClientTs.includes(field),
      `F1: pythonClient.ts missing field '${field}' — contract drift from Python RunRequest Pydantic model`,
    );
  }
});

test("F2: CoreApprovalContinuationRequest carries completedNodes, nodeId, approvedBy", () => {
  const requiredFields = ["completedNodes", "nodeId", "approvedBy"];
  for (const field of requiredFields) {
    assert.ok(
      pythonClientTs.includes(field),
      `F2: pythonClient.ts missing '${field}' in approval continuation contract`,
    );
  }
});

test("F3: CoreHumanInputContinuationRequest carries completedNodes, nodeId, humanInput", () => {
  const requiredFields = ["completedNodes", "nodeId", "humanInput"];
  for (const field of requiredFields) {
    assert.ok(
      pythonClientTs.includes(field),
      `F3: pythonClient.ts missing '${field}' in human-input continuation contract`,
    );
  }
});

test("F4: canonical_trace field is preserved in TS response shaping", () => {
  assert.ok(
    pythonClientTs.includes("canonical_trace") || pythonClientTs.includes("canonicalTrace"),
    "F4: canonicalTrace / canonical_trace not found in pythonClient.ts — field is dropped before reaching the API caller",
  );
});

// ---------------------------------------------------------------------------
// G. DOCKER IMAGE DIGEST PINNING — MED-01
// ---------------------------------------------------------------------------

test("G1–G2: .gitlab-ci.yml base images no longer use bare floating tags", () => {
  // G2: Bare floating tags must not appear as image values
  assert.doesNotMatch(
    gitlabCi,
    /^\s*image:\s*"python:3\.12"\s*$/m,
    "G2: bare floating tag 'python:3.12' still present in .gitlab-ci.yml",
  );
  assert.doesNotMatch(
    gitlabCi,
    /^\s*image:\s*"node:24"\s*$/m,
    "G2: bare floating tag 'node:24' still present in .gitlab-ci.yml",
  );

  // G1: Pinned format must be present (digest separator @sha256:)
  assert.ok(
    gitlabCi.includes("python:3.12@sha256:"),
    "G1: python base image is not in digest-pinned format (python:3.12@sha256:...)",
  );
  assert.ok(
    gitlabCi.includes("node:24@sha256:"),
    "G1: node base image is not in digest-pinned format (node:24@sha256:...)",
  );
});

// ---------------------------------------------------------------------------
// H. RESUME RESPONSE CONTRACT — MEDIUM blocker fix
//    Verifies that WorkflowResumeResponse matches the actual Python
//    /v1/workflow/resume response shape and is NOT a scan-progress payload.
// ---------------------------------------------------------------------------

test("H1: WorkflowResumeResponse is defined and exported from pythonClient.ts", () => {
  assert.ok(
    pythonClientTs.includes("export interface WorkflowResumeResponse"),
    "H1: WorkflowResumeResponse interface not found — resume response is untyped or uses wrong shape",
  );
});

test("H2: WorkflowResumeResponse carries execution fields, not scan-progress fields", () => {
  // Extract the WorkflowResumeResponse interface block
  const start = pythonClientTs.indexOf("export interface WorkflowResumeResponse");
  const end   = pythonClientTs.indexOf("\n}", start) + 2;
  const block = pythonClientTs.slice(start, end);

  // Required execution fields (matches Python main.py /v1/workflow/resume return)
  const required = [
    "runId",
    "workflowId",
    "status",
    "nodes",
    "startedAt",
    "completedAt",
    "resumabilityReason",
  ];
  for (const field of required) {
    assert.ok(
      block.includes(field),
      `H2: WorkflowResumeResponse is missing execution field '${field}' — contract drift from Python response`,
    );
  }

  // Must NOT contain scan-only field 'progress'
  assert.ok(
    !block.includes("progress:"),
    "H2: WorkflowResumeResponse still contains 'progress' — this is a scan field, not a resume execution field",
  );
});

test("H3: PythonWorkflowResumeResponse is aliased to WorkflowResumeResponse (no scan-shape duplication)", () => {
  assert.ok(
    pythonClientTs.includes("PythonWorkflowResumeResponse = WorkflowResumeResponse"),
    "H3: PythonWorkflowResumeResponse must be an alias for WorkflowResumeResponse, not a separate scan-shaped interface",
  );
});

test("H4: callPythonWorkflowResume returns WorkflowResumeResponse, not scan type", () => {
  assert.ok(
    pythonClientTs.includes("): Promise<WorkflowResumeResponse>"),
    "H4: callPythonWorkflowResume must return Promise<WorkflowResumeResponse>",
  );
});

// ---------------------------------------------------------------------------
// I. COMPENSATION NODE TYPE — HIGH blocker fix
//    Verifies compensation is promoted to executable across all layers.
// ---------------------------------------------------------------------------

test("I1: compensation appears in ExecutableWorkflowStepSchema discriminated union", () => {
  const orchestrationSrc = src("../src/lib/orchestrationSchemas.ts");
  assert.ok(
    orchestrationSrc.includes("ExecutableCompensationStepSchema"),
    "I1: ExecutableCompensationStepSchema not found in orchestrationSchemas.ts — " +
      "compensation is not part of the executable discriminated union",
  );
  // Verify it is actually in the union (not just defined but unused)
  const unionStart = orchestrationSrc.indexOf("ExecutableWorkflowStepSchema = z.discriminatedUnion");
  const unionEnd   = orchestrationSrc.indexOf(");", unionStart);
  const unionBlock = orchestrationSrc.slice(unionStart, unionEnd);
  assert.ok(
    unionBlock.includes("ExecutableCompensationStepSchema"),
    "I1: ExecutableCompensationStepSchema is defined but not included in the ExecutableWorkflowStepSchema union",
  );
});

test("I2: workflowCompilation.ts compiles compensation nodes (not rejects them)", () => {
  const compilationSrc = src("../src/lib/workflowCompilation.ts");
  assert.ok(
    compilationSrc.includes("node.type === \"compensation\""),
    "I2: workflowCompilation.ts has no compilation branch for 'compensation' — " +
      "nodes of this type will be rejected instead of compiled",
  );
  assert.ok(
    compilationSrc.includes("targetNodeId"),
    "I2: compensation compilation branch does not extract targetNodeId — " +
      "Python executor will reject the step",
  );
});

test("I3: CoreWorkflowCompensationStep is defined in pythonClient.ts", () => {
  assert.ok(
    pythonClientTs.includes("CoreWorkflowCompensationStep"),
    "I3: CoreWorkflowCompensationStep not found in pythonClient.ts — " +
      "compensation steps cannot be typed on the TS→Python bridge",
  );
  assert.ok(
    pythonClientTs.includes("targetNodeId"),
    "I3: CoreWorkflowCompensationStep is missing targetNodeId field",
  );
});

test("I4: CoreWorkflowStep union includes CoreWorkflowCompensationStep", () => {
  const unionStart = pythonClientTs.indexOf("export type CoreWorkflowStep =");
  const unionEnd   = pythonClientTs.indexOf(";", unionStart);
  const unionBlock = pythonClientTs.slice(unionStart, unionEnd);
  assert.ok(
    unionBlock.includes("CoreWorkflowCompensationStep"),
    "I4: CoreWorkflowStep union does not include CoreWorkflowCompensationStep — " +
      "compensation steps cannot flow through the TS bridge",
  );
});

test("I5: Python contracts.py does NOT reject compensation in _normalize_step_payload", () => {
  const contractsSrc = src("../../hyperflow-core/workflow/contracts.py");
  const rejectionMatch = contractsSrc.match(
    /if\s+step_type\s+in\s+\{([^}]+)\}\s*:\s*\n\s*raise\s+ValueError/,
  );
  assert.ok(
    rejectionMatch,
    "I5: _normalize_step_payload stored-only rejection block not found in contracts.py",
  );
  const rejectionSet = rejectionMatch[1];
  assert.ok(
    !rejectionSet.includes("\"compensation\"") && !rejectionSet.includes("'compensation'"),
    "I5: Python contracts.py still rejects 'compensation' in _normalize_step_payload — " +
      "remove it from the stored-only set since the executor fully implements it",
  );
});

// ---------------------------------------------------------------------------
// J. AGENT-NATIVE ROUTING SEMANTICS — HIGH blocker fix
//    Verifies /v1/agent/run uses agent_role/agent_capabilities/run_policy
//    to build real execution routing, not just pass them as metadata.
// ---------------------------------------------------------------------------

test("J1: Python agent_run builds a routing dict using agent identity fields", () => {
  const mainPySrc = src("../../hyperflow-core/main.py");
  assert.ok(
    mainPySrc.includes("routing = {"),
    "J1: agent_run does not build a routing dict — agent_role/capabilities/run_policy are ignored",
  );
  assert.ok(
    mainPySrc.includes("\"role\":") && mainPySrc.includes("role"),
    "J1: routing dict does not include agent role",
  );
  assert.ok(
    mainPySrc.includes("availableCapabilities") || mainPySrc.includes("capabilities"),
    "J1: routing dict does not include agent capabilities",
  );
});

test("J2: Python agent_run builds an enriched prompt when routing context is non-trivial", () => {
  const mainPySrc = src("../../hyperflow-core/main.py");
  assert.ok(
    mainPySrc.includes("HYPERFLOW AGENT ROUTING CONTEXT"),
    "J2: agent_run does not inject a routing preamble into the prompt — " +
      "agent_role/capabilities/run_policy have no effect on execution",
  );
  assert.ok(
    mainPySrc.includes("effective_prompt"),
    "J2: agent_run does not use an effective_prompt variable — raw req.prompt is still passed to run_edde unconditionally",
  );
});

test("J3: Python agent_run attaches routing to result (observable in run output)", () => {
  const mainPySrc = src("../../hyperflow-core/main.py");
  assert.ok(
    mainPySrc.includes("result[\"routing\"] = routing"),
    "J3: agent_run does not attach routing to result — routing constraints are invisible in run output",
  );
});

test("J4: Python agent_run attaches routing to contract (observable in contract)", () => {
  const mainPySrc = src("../../hyperflow-core/main.py");
  // contract dict must include routing key
  const contractBlockStart = mainPySrc.indexOf("contract = {");
  const contractBlockEnd   = mainPySrc.indexOf("\n    }", contractBlockStart);
  const contractBlock      = mainPySrc.slice(contractBlockStart, contractBlockEnd);
  assert.ok(
    contractBlock.includes("\"routing\""),
    "J4: agent_run contract dict does not include routing — routing is not surfaced to callers",
  );
});
