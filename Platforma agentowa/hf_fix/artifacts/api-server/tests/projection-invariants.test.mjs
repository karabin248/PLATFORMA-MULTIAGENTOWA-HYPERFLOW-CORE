/**
 * projection-invariants.test.mjs
 *
 * Static invariant tests for the projection-only architecture.
 *
 * These tests enforce architectural contracts at the source level:
 *
 *  1. No runtime route in src/ may import the test-harness JS handlers.
 *  2. No runtime route may directly write protected orchestration fields
 *     outside of workflowProjection.ts.
 *  3. humanInputs.ts must not contain TS-owned node status mutation.
 *  4. approvals.ts decision route must not invent blockedNodeId / resumabilityReason.
 *  5. workflowProjection.ts must exist as the single approved write path.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROUTES = path.resolve(__dirname, "../src/routes");
const SRC_LIB = path.resolve(__dirname, "../src/lib");

function readSrc(relPath) {
  return fs.readFileSync(path.resolve(__dirname, "..", relPath), "utf8");
}

function routeFiles() {
  return fs.readdirSync(SRC_ROUTES).map((f) => path.join(SRC_ROUTES, f));
}

// ---------------------------------------------------------------------------
// Invariant 1: No runtime src/ file imports harness-only handlers
// ---------------------------------------------------------------------------
{
  const bannedImports = ["resumeWorkflowHandler", "workflowsRouterFactory"];
  for (const filePath of routeFiles()) {
    const content = fs.readFileSync(filePath, "utf8");
    for (const banned of bannedImports) {
      assert.ok(
        !content.includes(`from "./${banned}`),
        `INVARIANT VIOLATION: ${path.basename(filePath)} imports harness-only handler '${banned}'. ` +
          `These files live in tests/harness/ and must never be imported from src/.`
      );
      assert.ok(
        !content.includes(`require("./${banned}`),
        `INVARIANT VIOLATION: ${path.basename(filePath)} requires harness-only handler '${banned}'.`
      );
    }
  }
  console.log("✓ Invariant 1: No runtime src/ imports of harness-only handlers");
}

// ---------------------------------------------------------------------------
// Invariant 2: humanInputs.ts does not contain TS-owned node status mutation
// Protected write patterns that must NOT appear in humanInputs.ts:
//   - status: "succeeded"         (node status set directly)
//   - insert(checkpointsTable)    (direct checkpoint creation)
//   - status: "running"           (run status set directly)
//   - resumabilityReason: "none"  (TS-invented resumability)
//   - blockedNodeId: null         (TS-invented unblocking)
// ---------------------------------------------------------------------------
{
  const humanInputs = readSrc("src/routes/humanInputs.ts");

  const forbidden = [
    { pattern: 'status: "succeeded"', desc: "TS-authored node success status" },
    { pattern: "insert(checkpointsTable)", desc: "direct checkpoint insertion" },
    { pattern: 'status: "running"', desc: "TS-authored run status running" },
    { pattern: 'resumabilityReason: "none"', desc: "TS-invented resumabilityReason=none" },
    { pattern: "blockedNodeId: null,", desc: "TS-invented blockedNodeId=null" },
  ];

  for (const { pattern, desc } of forbidden) {
    assert.ok(
      !humanInputs.includes(pattern),
      `INVARIANT VIOLATION: humanInputs.ts contains forbidden pattern [${desc}]: "${pattern}". ` +
        `humanInputs.ts must be projection-only — all execution truth comes from Python.`
    );
  }
  console.log("✓ Invariant 2: humanInputs.ts contains no TS-owned execution mutation");
}

// ---------------------------------------------------------------------------
// Invariant 3: approvals.ts decision route does not invent execution state
// Protected write patterns that must NOT appear in the decision handler:
//   - resumabilityReason: "none"  (TS-invented, must come from Python snapshot)
//   - status: "running"           (TS must not set run to running)
//   - resumableCheckpointId       (TS must not set checkpoint boundaries)
// ---------------------------------------------------------------------------
{
  const approvals = readSrc("src/routes/approvals.ts");

  const forbidden = [
    { pattern: 'resumabilityReason: "none"', desc: "TS-invented resumabilityReason=none in decision path" },
    { pattern: 'status: "running"', desc: "TS-authored run status=running" },
    { pattern: "resumableCheckpointId:", desc: "TS-authored resumableCheckpointId in decision path" },
  ];

  for (const { pattern, desc } of forbidden) {
    assert.ok(
      !approvals.includes(pattern),
      `INVARIANT VIOLATION: approvals.ts contains forbidden pattern [${desc}]: "${pattern}". ` +
        `approvals.ts decision route must delegate to Python and project only.`
    );
  }
  console.log("✓ Invariant 3: approvals.ts decision route contains no TS-invented execution state");
}

// ---------------------------------------------------------------------------
// Invariant 4: workflowProjection.ts exists as single approved write path
// ---------------------------------------------------------------------------
{
  const projectionPath = path.join(SRC_LIB, "workflowProjection.ts");
  assert.ok(
    fs.existsSync(projectionPath),
    `INVARIANT VIOLATION: workflowProjection.ts does not exist at ${projectionPath}. ` +
      `This module is the single approved write path for orchestration truth.`
  );

  const projection = fs.readFileSync(projectionPath, "utf8");
  assert.ok(
    projection.includes("projectExecutionSnapshot"),
    "INVARIANT VIOLATION: workflowProjection.ts must export projectExecutionSnapshot"
  );
  assert.ok(
    projection.includes("projectContinuationSnapshot"),
    "INVARIANT VIOLATION: workflowProjection.ts must export projectContinuationSnapshot"
  );
  assert.ok(
    projection.includes("projectTerminalRejection"),
    "INVARIANT VIOLATION: workflowProjection.ts must export projectTerminalRejection"
  );
  console.log("✓ Invariant 4: workflowProjection.ts exists with all required exports");
}

// ---------------------------------------------------------------------------
// Invariant 5: pythonClient.ts exposes continuation methods
// ---------------------------------------------------------------------------
{
  const pythonClient = readSrc("src/lib/pythonClient.ts");
  assert.ok(
    pythonClient.includes("continueApproval"),
    "INVARIANT VIOLATION: pythonClient.ts must export continueApproval"
  );
  assert.ok(
    pythonClient.includes("continueHumanInput"),
    "INVARIANT VIOLATION: pythonClient.ts must export continueHumanInput"
  );
  assert.ok(
    pythonClient.includes("/v1/workflow/continue/approval"),
    "INVARIANT VIOLATION: pythonClient.ts must call /v1/workflow/continue/approval"
  );
  assert.ok(
    pythonClient.includes("/v1/workflow/continue/human-input"),
    "INVARIANT VIOLATION: pythonClient.ts must call /v1/workflow/continue/human-input"
  );
  console.log("✓ Invariant 5: pythonClient.ts exposes both continuation methods");
}

// ---------------------------------------------------------------------------
// Invariant 6: Python continuation endpoints exist in main.py
// ---------------------------------------------------------------------------
{
  const mainPy = fs.readFileSync(
    path.resolve(__dirname, "../../hyperflow-core/main.py"),
    "utf8"
  );
  assert.ok(
    mainPy.includes('"/v1/workflow/continue/approval"'),
    "INVARIANT VIOLATION: Python main.py must define /v1/workflow/continue/approval"
  );
  assert.ok(
    mainPy.includes('"/v1/workflow/continue/human-input"'),
    "INVARIANT VIOLATION: Python main.py must define /v1/workflow/continue/human-input"
  );
  console.log("✓ Invariant 6: Python continuation endpoints present in main.py");
}

// ---------------------------------------------------------------------------
// Invariant 7: Python continuation functions exported from executors.py
// ---------------------------------------------------------------------------
{
  const executors = fs.readFileSync(
    path.resolve(__dirname, "../../hyperflow-core/workflow/executors.py"),
    "utf8"
  );
  assert.ok(
    executors.includes("async def continue_workflow_approval"),
    "INVARIANT VIOLATION: executors.py must define continue_workflow_approval"
  );
  assert.ok(
    executors.includes("async def continue_workflow_human_input"),
    "INVARIANT VIOLATION: executors.py must define continue_workflow_human_input"
  );
  console.log("✓ Invariant 7: Python continuation functions present in executors.py");
}

// ---------------------------------------------------------------------------
// Invariant 8: Harness files must not exist in src/routes/
// ---------------------------------------------------------------------------
{
  const srcRouteFiles = fs.readdirSync(SRC_ROUTES);
  assert.ok(
    !srcRouteFiles.includes("resumeWorkflowHandler.js"),
    "INVARIANT VIOLATION: resumeWorkflowHandler.js must not exist in src/routes/ (move to tests/harness/)"
  );
  assert.ok(
    !srcRouteFiles.includes("workflowsRouterFactory.js"),
    "INVARIANT VIOLATION: workflowsRouterFactory.js must not exist in src/routes/ (move to tests/harness/)"
  );
  console.log("✓ Invariant 8: Harness JS files absent from src/routes/");
}


// ---------------------------------------------------------------------------
// Invariant 9: workflowExecutor.ts exists with required exports
// ---------------------------------------------------------------------------
{
  const executorPath = path.join(SRC_LIB, "workflowExecutor.ts");
  assert.ok(
    fs.existsSync(executorPath),
    "INVARIANT VIOLATION: workflowExecutor.ts must exist"
  );
  const executor = fs.readFileSync(executorPath, "utf8");
  assert.ok(executor.includes("startExecutor"), "Invariant 9: must export startExecutor");
  assert.ok(executor.includes("stopExecutor"), "Invariant 9: must export stopExecutor");
  assert.ok(executor.includes("requestCancellation"), "Invariant 9: must export requestCancellation");
  assert.ok(executor.includes("acquireLease"), "Invariant 9: must define acquireLease");
  assert.ok(executor.includes("recoverStaleLeases"), "Invariant 9: must define recoverStaleLeases");
  console.log("✓ Invariant 9: workflowExecutor.ts exists with all required exports");
}

// ---------------------------------------------------------------------------
// Invariant 10: POST /run is admission-only (no inline pythonClient.runWorkflow)
// ---------------------------------------------------------------------------
{
  const workflows = readSrc("src/routes/workflows.ts");
  // The workflows.ts run route must NOT call runWorkflow inline anymore
  // (execution is delegated to the background executor).
  // The only pythonClient calls allowed in workflows.ts are resumeWorkflow.
  const runWorkflowCallCount = (workflows.match(/pythonClient\.runWorkflow/g) || []).length;
  assert.equal(
    runWorkflowCallCount,
    0,
    "INVARIANT VIOLATION: workflows.ts POST /run must not call pythonClient.runWorkflow inline. " +
    "Execution is async — the executor handles it. Remove the inline call."
  );
  // Must return status queued
  assert.ok(
    workflows.includes('"queued"'),
    "INVARIANT VIOLATION: POST /run must return status=queued (admission-only)"
  );
  console.log("✓ Invariant 10: POST /run is admission-only, no inline execution");
}

// ---------------------------------------------------------------------------
// Invariant 11: Cancel route exists in workflows.ts
// ---------------------------------------------------------------------------
{
  const workflows = readSrc("src/routes/workflows.ts");
  assert.ok(
    workflows.includes('"/workflow-runs/:id/cancel"'),
    "INVARIANT VIOLATION: workflows.ts must define POST /workflow-runs/:id/cancel"
  );
  assert.ok(
    workflows.includes("requestCancellation"),
    "INVARIANT VIOLATION: cancel route must call requestCancellation from workflowExecutor"
  );
  console.log("✓ Invariant 11: Cancel route exists and calls requestCancellation");
}

// ---------------------------------------------------------------------------
// Invariant 12: Canonical read model derivation used in list/detail views
// ---------------------------------------------------------------------------
{
  const workflows = readSrc("src/routes/workflows.ts");
  assert.ok(
    workflows.includes("deriveResumability"),
    "INVARIANT VIOLATION: workflows.ts must use deriveResumability from workflowProjection"
  );
  assert.ok(
    workflows.includes("deriveOperatorSummary"),
    "INVARIANT VIOLATION: workflows.ts must use deriveOperatorSummary from workflowProjection"
  );
  console.log("✓ Invariant 12: Canonical read model derivation used in list and detail views");
}

// ---------------------------------------------------------------------------
// Invariant 13: EXECUTABLE_NODE_TYPES truth table exists in workflowCompilation.ts
// ---------------------------------------------------------------------------
{
  const compilation = readSrc("src/lib/workflowCompilation.ts");
  assert.ok(
    compilation.includes("EXECUTABLE_NODE_TYPES"),
    "INVARIANT VIOLATION: workflowCompilation.ts must define EXECUTABLE_NODE_TYPES"
  );
  assert.ok(
    compilation.includes("STORED_ONLY_NODE_TYPES"),
    "INVARIANT VIOLATION: workflowCompilation.ts must define STORED_ONLY_NODE_TYPES"
  );
  assert.ok(
    compilation.includes("isExecutableNodeType"),
    "INVARIANT VIOLATION: workflowCompilation.ts must export isExecutableNodeType"
  );
  console.log("✓ Invariant 13: EXECUTABLE_NODE_TYPES truth table enforced in compilation");
}

// ---------------------------------------------------------------------------
// Invariant 14: Race safety guards exist in approvals.ts and humanInputs.ts
// ---------------------------------------------------------------------------
{
  const approvals = readSrc("src/routes/approvals.ts");
  const humanInputs = readSrc("src/routes/humanInputs.ts");
  assert.ok(
    approvals.includes("assertRunStatusFor"),
    "INVARIANT VIOLATION: approvals.ts must call assertRunStatusFor before continuation"
  );
  assert.ok(
    humanInputs.includes("assertRunStatusFor"),
    "INVARIANT VIOLATION: humanInputs.ts must call assertRunStatusFor before continuation"
  );
  console.log("✓ Invariant 14: Race safety guards present in continuation routes");
}

// ---------------------------------------------------------------------------
// Invariant 15: workflowProjection.ts exports appendStateLogEvent
// ---------------------------------------------------------------------------
{
  const projection = readSrc("src/lib/workflowProjection.ts");
  assert.ok(
    projection.includes("appendStateLogEvent"),
    "INVARIANT VIOLATION: workflowProjection.ts must export appendStateLogEvent"
  );
  assert.ok(
    projection.includes("projectTimeout"),
    "INVARIANT VIOLATION: workflowProjection.ts must export projectTimeout"
  );
  assert.ok(
    projection.includes("projectCancellation"),
    "INVARIANT VIOLATION: workflowProjection.ts must export projectCancellation"
  );
  assert.ok(
    projection.includes("assertRunStatusFor"),
    "INVARIANT VIOLATION: workflowProjection.ts must export assertRunStatusFor"
  );
  console.log("✓ Invariant 15: workflowProjection.ts exports lifecycle and race-safety helpers");
}

// ---------------------------------------------------------------------------
// Invariant 16: Admission persists "queued" — executor owns "running" transition
//
// PATCH 1 enforcement.  Both insert paths in the run admission handler must
// write status="queued".  Any status="running" in an insert would mean the
// executor's WHERE-status="queued" condition would never match and the run
// would never execute.
// ---------------------------------------------------------------------------
{
  const workflows = readSrc("src/routes/workflows.ts");

  // Count every occurrence of the two patterns inside insert .values({...}) blocks.
  // A conservative proxy: count bare string literals in source.
  const runningInInserts = (workflows.match(/status:\s*["']running["']/g) ?? []).length;
  assert.equal(
    runningInInserts,
    0,
    "INVARIANT VIOLATION: workflows.ts must not persist status='running' during admission. " +
      "Admission must write status='queued'; the executor's acquireLease() owns the transition to 'running'."
  );

  // Positive assertion: both insert paths must contain "queued"
  const queuedCount = (workflows.match(/status:\s*["']queued["']/g) ?? []).length;
  assert.ok(
    queuedCount >= 2,
    "INVARIANT VIOLATION: workflows.ts admission must set status='queued' in BOTH insert paths " +
      "(idempotency path and plain path). Found " + queuedCount + " occurrence(s)."
  );

  // Executor acquireLease must own the "running" transition
  const executor = readSrc("src/lib/workflowExecutor.ts");
  assert.ok(
    executor.includes('status: "running"'),
    "INVARIANT VIOLATION: workflowExecutor.ts acquireLease() must set status='running' " +
      "(executor is the sole authority for this transition)"
  );
  assert.ok(
    executor.includes('eq(workflowRunsTable.status, "queued")'),
    "INVARIANT VIOLATION: workflowExecutor.ts acquireLease() must guard update with " +
      "WHERE status='queued' to prevent double-acquisition"
  );

  console.log("✓ Invariant 16: Admission writes 'queued'; executor owns transition to 'running'");
}

// ---------------------------------------------------------------------------
// Invariant 17: Approval creation does NOT mutate run execution state
//
// PATCH 2 enforcement.  POST /approvals must be record-only.  The previous
// implementation wrote approvalState / blockedNodeId / resumabilityReason
// directly, violating the projection-only rule.  These fields must only
// arrive via Python execution snapshots projected through workflowProjection.ts.
// ---------------------------------------------------------------------------
{
  const approvals = readSrc("src/routes/approvals.ts");

  // Find the creation handler block (between 'post("/approvals"' and the decision handler).
  // We verify that no db.update(workflowRunsTable) call sets execution-truth fields
  // that Python owns — specifically in the creation context.
  // The forbidden triple: all three set together in a single .set() constitutes
  // the TS-owned blocking mutation.
  const hasApprovalStatePending = approvals.includes('approvalState: "pending"');
  const hasBlockedNodeIdSet =
    approvals.includes("blockedNodeId: body.nodeId") ||
    // also catch generic assignments in the creation block
    (approvals.match(/blockedNodeId:\s*body\./g) ?? []).length > 0;
  const hasResumabilityPendingApproval = approvals.includes('resumabilityReason: "pending_approval"');

  assert.ok(
    !hasApprovalStatePending,
    "INVARIANT VIOLATION: approvals.ts POST /approvals must NOT set approvalState='pending'. " +
      "Python owns execution state. Approval creation is record-only."
  );
  assert.ok(
    !hasBlockedNodeIdSet,
    "INVARIANT VIOLATION: approvals.ts POST /approvals must NOT write blockedNodeId from body.nodeId. " +
      "Python owns blockedNodeId; it must arrive via projectContinuationSnapshot."
  );
  assert.ok(
    !hasResumabilityPendingApproval,
    "INVARIANT VIOLATION: approvals.ts POST /approvals must NOT set resumabilityReason='pending_approval'. " +
      "Python owns resumabilityReason; TS projects only."
  );

  // Positive assertion: creation handler must still insert the approval record
  assert.ok(
    approvals.includes("insert(approvalsTable)"),
    "INVARIANT VIOLATION: approvals.ts must still insert into approvalsTable (record-only)"
  );

  console.log("✓ Invariant 17: Approval creation is record-only — no TS mutation of run execution state");
}

// ---------------------------------------------------------------------------
// Invariant 18: Cancellation is propagated into Python execution via AbortController
//
// PATCH 3 enforcement.  The executor must create an AbortController, pass
// its signal to pythonClient.runWorkflow, and handle the RUN_CANCELLED error
// code to set the run terminal.  The cancel-poll interval must also be cleared
// in the finally block alongside the heartbeat interval.
// ---------------------------------------------------------------------------
{
  const executor = readSrc("src/lib/workflowExecutor.ts");

  assert.ok(
    executor.includes("new AbortController()"),
    "INVARIANT VIOLATION: workflowExecutor.ts executeRun() must create an AbortController " +
      "to propagate cancellation into in-flight Python calls."
  );
  assert.ok(
    executor.includes("controller.signal"),
    "INVARIANT VIOLATION: workflowExecutor.ts must pass controller.signal to pythonClient.runWorkflow"
  );
  assert.ok(
    executor.includes("controller.abort()"),
    "INVARIANT VIOLATION: workflowExecutor.ts must call controller.abort() when cancel_requested is detected"
  );
  assert.ok(
    executor.includes("RUN_CANCELLED"),
    "INVARIANT VIOLATION: workflowExecutor.ts must handle RUN_CANCELLED error from pythonClient " +
      "and project the run as cancelled"
  );
  assert.ok(
    executor.includes("cancelPollInterval"),
    "INVARIANT VIOLATION: workflowExecutor.ts must define a cancel-poll interval " +
      "to detect cancel_requested during long-running Python calls"
  );
  assert.ok(
    executor.includes("clearInterval(cancelPollInterval)"),
    "INVARIANT VIOLATION: cancelPollInterval must be cleared in the finally block to prevent leaks"
  );

  // pythonClient must expose externalSignal parameter on runWorkflow
  const pythonClient = readSrc("src/lib/pythonClient.ts");
  assert.ok(
    pythonClient.includes("externalSignal?: AbortSignal"),
    "INVARIANT VIOLATION: pythonClient.ts runWorkflow must accept externalSignal?: AbortSignal"
  );

  console.log("✓ Invariant 18: Cancellation propagated into Python via AbortController + cancel-poll");
}

// ---------------------------------------------------------------------------
// Invariant 19: Executor start/stop round-trip is safe (no double-start)
//
// The executor uses a _running guard to prevent multiple loops from spawning.
// Both startExecutor and stopExecutor must manipulate this guard.
// ---------------------------------------------------------------------------
{
  const executor = readSrc("src/lib/workflowExecutor.ts");

  assert.ok(
    executor.includes("if (_running) return"),
    "INVARIANT VIOLATION: startExecutor must guard against double-start with if (_running) return"
  );
  assert.ok(
    executor.includes("_running = true"),
    "INVARIANT VIOLATION: startExecutor must set _running = true"
  );
  assert.ok(
    executor.includes("_running = false"),
    "INVARIANT VIOLATION: stopExecutor must set _running = false"
  );

  console.log("✓ Invariant 19: Executor start/stop guard prevents double-start");
}

// ---------------------------------------------------------------------------
// Invariant 20: approvals.ts decision handler does NOT TS-author approvalState
//
// MICRO-FIX enforcement.  After calling Python continuation and projecting
// the snapshot via projectContinuationSnapshot(), TS must not perform a
// follow-up db.update() to set approvalState="approved".  That field is
// execution-adjacent truth — it must arrive exclusively from the Python
// snapshot projected through workflowProjection.ts.
// ---------------------------------------------------------------------------
{
  const approvals = readSrc("src/routes/approvals.ts");

  assert.ok(
    !approvals.includes('approvalState: "approved"'),
    "INVARIANT VIOLATION: approvals.ts decision handler must NOT set approvalState='approved' " +
      "via a direct db.update(). approvalState is projection-only — it must come from the " +
      "Python continuation snapshot via projectContinuationSnapshot()."
  );

  assert.ok(
    !approvals.includes('approvalState: "pending"'),
    "INVARIANT VIOLATION: approvals.ts must NOT set approvalState='pending' anywhere. " +
      "approvalState is owned by Python execution snapshots."
  );

  // Positive: projection call must still be present
  assert.ok(
    approvals.includes("projectContinuationSnapshot"),
    "INVARIANT VIOLATION: approvals.ts must still delegate to projectContinuationSnapshot — " +
      "it is the single approved write path for execution truth."
  );

  console.log("✓ Invariant 20: approvalState is projection-only — no TS echo-write after Python snapshot");
}

console.log("\n✅ All projection invariants passed.");
