import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// -----------------------------------------------------------------------------
// Stage 2 orchestration contract tests
//
// These tests verify the resume contract by calling the real implementations,
// not by grepping route source for cosmetic strings. Two contracts are pinned:
//
//   1. Resume eligibility — terminal-state and pending-approval rejections
//      come from `evaluateResumeEligibility` and surface the documented
//      operator-facing error messages.
//   2. Resume write path — checkpoint mutation lives in `workflowProjection.ts`
//      (the single approved write path). The route delegates; the projection
//      owns the actual DB writes. We assert the patterns exist in the
//      projection module, where they are real code, not documentation.
//
// History: stage-2 was previously enforced by greping `routes/workflows.ts`
// for messages and DB calls. After resume logic was extracted into helpers
// and projection, those greps started matching dead constants kept around
// solely for the test. The constants were removed; this test now exercises
// the helpers directly so the contract is verified on real behaviour.
// -----------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const workflowRunsSchema = fs.readFileSync(
  path.resolve(__dirname, "../../../lib/db/src/schema/workflowRuns.ts"),
  "utf8",
);

const projectionSrc = fs.readFileSync(
  path.resolve(__dirname, "../src/lib/workflowProjection.ts"),
  "utf8",
);

const { evaluateResumeEligibility } = await import(
  new URL("../src/lib/resumeEligibility.ts", import.meta.url).href
).catch(async () => import("../src/lib/resumeEligibility.js"));

test("evaluateResumeEligibility rejects terminal run states with documented message", () => {
  for (const status of ["completed", "failed", "cancelled"]) {
    const result = evaluateResumeEligibility({ status }, 0);
    assert.equal(result.ok, false, `expected rejection for status=${status}`);
    assert.match(
      result.error,
      /Cannot resume a run in terminal state/,
      `expected terminal-state message for status=${status}, got: ${result.error}`,
    );
  }
});

test("evaluateResumeEligibility rejects runs with pending approvals", () => {
  // Pending approvals reported via count
  const byCount = evaluateResumeEligibility({ status: "running" }, 1);
  assert.equal(byCount.ok, false);
  assert.match(byCount.error, /Cannot resume while approvals are pending/);

  // Pending approvals reported via approvalState flag
  const byFlag = evaluateResumeEligibility(
    { status: "running", approvalState: "pending" },
    0,
  );
  assert.equal(byFlag.ok, false);
  assert.match(byFlag.error, /Cannot resume while approvals are pending/);

  // The canonical blocked state — status=waiting_approval with a pending
  // approval record present — must also reject.
  const waitingApproval = evaluateResumeEligibility(
    { status: "waiting_approval", approvalState: "pending" },
    1,
  );
  assert.equal(waitingApproval.ok, false);
  assert.match(waitingApproval.error, /Cannot resume while approvals are pending/);
});

test("evaluateResumeEligibility allows resumable runs", () => {
  const result = evaluateResumeEligibility({ status: "running" }, 0);
  assert.equal(result.ok, true);
});

test("workflowProjection owns checkpoint mutation (single approved write path)", () => {
  // The projection module is the only place in src/ that should be writing
  // checkpoint records and linking nodes to them. The patterns below are not
  // grepped on the route file because the route delegates to projection.
  assert.match(
    projectionSrc,
    /checkpointRef:\s*checkpointId/,
    "workflowProjection.ts must link node rows to the new checkpoint via checkpointRef",
  );
  assert.match(
    projectionSrc,
    /insert\(checkpointsTable\)/,
    "workflowProjection.ts must insert checkpoint rows directly",
  );
  assert.match(
    projectionSrc,
    /update\(workflowRunNodesTable\)/,
    "workflowProjection.ts must update workflowRunNodesTable with completion state",
  );
});

test("workflowRuns table includes lastCheckpointId column", () => {
  // The DB schema should surface a last_checkpoint_id column for orchestration metadata
  assert.match(workflowRunsSchema, /lastCheckpointId/);
  assert.match(workflowRunsSchema, /"last_checkpoint_id"/);
});
