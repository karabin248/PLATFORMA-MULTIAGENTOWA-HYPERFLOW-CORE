import test from "node:test";
import assert from "node:assert";

// Stage 15: approval actionability tests
//
// These tests verify that newly introduced action-readiness hints on
// workflow run list and detail responses correctly reflect whether
// human approval action is required and whether a run can resume.  The
// `requiresApprovalAction` flag is derived from existing approval
// metadata (pendingApprovalCount / resumabilityReason) and never
// introduces new semantics.  The `actionability` object on the
// detail response mirrors this flag and also surfaces
// `canResumeNow`, which is equivalent to `resumability.canResume`.

import { createWorkflowsRouter } from "./harness/workflowsRouterFactory.js";
import { evaluateResumeEligibility } from "../src/lib/resumeEligibility.js";
import { validateResumeCheckpoint } from "../src/lib/resumeValidator.js";

const WorkflowResumeBodyStub = {
  safeParse(payload) {
    return { success: true, data: payload };
  },
};
const getConfigStub = () => ({ defaultRunTimeoutMs: 1000 });
function classifyErrorStub(err) {
  return { statusCode: 500, message: err.message || String(err), code: "INTERNAL_ERROR", category: "internal_error" };
}
function classifyCoreErrorStub(err) {
  return { statusCode: 500, message: err.message || String(err), code: "CORE_ERROR", category: "core_error" };
}
const loggerStub = { error: () => {} };

// DB stub used for actionability tests.  It returns the seeded data for selects
// and ignores where/orderBy calls.  No persistence is required here.
function createDbStub({ runs = [], approvals = [], checkpoints = [], nodes = [] }) {
  const runsData = runs.slice();
  const approvalsData = approvals.slice();
  const checkpointsData = checkpoints.slice();
  const nodeRows = nodes.slice();
  return {
    workflowRunsTable: {},
    approvalsTable: {},
    checkpointsTable: {},
    workflowRunNodesTable: {},
    select() {
      const self = this;
      return {
        from(table) {
          return {
            where() {
              return {
                limit() {
                  if (table === self.workflowRunsTable) return Promise.resolve(runsData);
                  if (table === self.approvalsTable) return Promise.resolve(approvalsData);
                  if (table === self.checkpointsTable) return Promise.resolve(checkpointsData);
                  if (table === self.workflowRunNodesTable) return Promise.resolve(nodeRows);
                  return Promise.resolve([]);
                },
              };
            },
            orderBy() {
              if (table === self.workflowRunsTable) return Promise.resolve(runsData);
              if (table === self.checkpointsTable) return Promise.resolve(checkpointsData);
              return Promise.resolve([]);
            },
          };
        },
      };
    },
    update() {
      return { set() { return { where() { return Promise.resolve(); } }; } };
    },
    insert() {
      return { values() { return Promise.resolve(); } };
    },
  };
}

function createPythonClientStub({ result }) {
  return {
    resumeWorkflow: async () => result,
  };
}

function createMockResponse() {
  const res = {};
  res.statusCode = 200;
  res.body = undefined;
  res.status = function (code) {
    this.statusCode = code;
    return this;
  };
  res.json = function (obj) {
    this.body = obj;
    return this;
  };
  return res;
}

test("list shows requiresApprovalAction correctly", async () => {
  // One run blocked by pending approval, one clear run, one terminal run
  const runs = [
    { id: "runBlock", status: "running", runtimeRequest: {}, blockedNodeId: "nodeB", resumabilityReason: "pending_approval" },
    { id: "runClear", status: "running", runtimeRequest: {}, blockedNodeId: null, resumabilityReason: "none" },
    { id: "runTerm", status: "completed", runtimeRequest: {}, blockedNodeId: null, resumabilityReason: "none" },
  ];
  const db = createDbStub({ runs });
  const pythonClient = createPythonClientStub({ result: { ok: true, data: {} } });
  const router = createWorkflowsRouter({
    db,
    pythonClient,
    evaluateResumeEligibility,
    validateResumeCheckpoint,
    WorkflowResumeBody: WorkflowResumeBodyStub,
    getConfig: getConfigStub,
    classifyError: classifyErrorStub,
    classifyCoreError: classifyCoreErrorStub,
    logger: loggerStub,
  });
  const req = { method: "GET", url: "/workflow-runs" };
  const res = createMockResponse();
  await router(req, res);
  assert.equal(res.statusCode, 200);
  const pendingRun = res.body.runs.find((r) => r.id === "runBlock");
  const clearRun = res.body.runs.find((r) => r.id === "runClear");
  const termRun = res.body.runs.find((r) => r.id === "runTerm");
  assert.ok(pendingRun && clearRun && termRun);
  // Pending approval runs require approval action
  assert.equal(pendingRun.requiresApprovalAction, true);
  // Clear run does not require approval action
  assert.equal(clearRun.requiresApprovalAction, false);
  // Terminal run should not require approval action
  assert.equal(termRun.requiresApprovalAction, false);
});

test("detail exposes actionability object coherently", async () => {
  const run = { id: "runD2", status: "running", runtimeRequest: {}, blockedNodeId: "nodeD2", resumabilityReason: "pending_approval" };
  const approvals = [
    { id: "ap1", runId: "runD2", nodeId: "nodeD2", status: "pending", reason: "R1", requestedAt: new Date(), decidedAt: null },
    { id: "ap2", runId: "runD2", nodeId: "nodeD2", status: "pending", reason: "R2", requestedAt: new Date(), decidedAt: null },
  ];
  const db = createDbStub({ runs: [run], approvals });
  const pythonClient = createPythonClientStub({ result: { ok: true, data: {} } });
  const router = createWorkflowsRouter({
    db,
    pythonClient,
    evaluateResumeEligibility,
    validateResumeCheckpoint,
    WorkflowResumeBody: WorkflowResumeBodyStub,
    getConfig: getConfigStub,
    classifyError: classifyErrorStub,
    classifyCoreError: classifyCoreErrorStub,
    logger: loggerStub,
  });
  const req = { method: "GET", url: "/workflow-runs/runD2" };
  const res = createMockResponse();
  await router(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body);
  // The detail should include an actionability object
  assert.ok(res.body.actionability);
  // requiresApprovalAction should be true for pending approval runs
  assert.equal(res.body.actionability.requiresApprovalAction, true);
  // canResumeNow should match resumability.canResume (false in this case)
  assert.equal(res.body.actionability.canResumeNow, res.body.resumability.canResume);
  // pendingApprovalCount should reflect number of pending approvals
  assert.equal(res.body.pendingApprovalCount, 2);
  // hasPendingApproval should be consistent
  assert.equal(res.body.hasPendingApproval, true);
});

test("detail actionability on clear and terminal runs", async () => {
  // Clear run that can resume (no approvals, running)
  const clearRun = { id: "runClearD", status: "running", runtimeRequest: {}, blockedNodeId: null, resumabilityReason: "none" };
  {
    const db = createDbStub({ runs: [clearRun], approvals: [], checkpoints: [], nodes: [] });
    const pythonClient = createPythonClientStub({ result: { ok: true, data: {} } });
    const router = createWorkflowsRouter({
      db,
      pythonClient,
      evaluateResumeEligibility,
      validateResumeCheckpoint,
      WorkflowResumeBody: WorkflowResumeBodyStub,
      getConfig: getConfigStub,
      classifyError: classifyErrorStub,
      classifyCoreError: classifyCoreErrorStub,
      logger: loggerStub,
    });
    const reqClear = { method: "GET", url: "/workflow-runs/runClearD" };
    const resClear = createMockResponse();
    await router(reqClear, resClear);
    assert.equal(resClear.statusCode, 200);
    assert.ok(resClear.body);
    assert.equal(resClear.body.pendingApprovalCount, 0);
    assert.equal(resClear.body.hasPendingApproval, false);
    // requiresApprovalAction false
    assert.equal(resClear.body.actionability.requiresApprovalAction, false);
    // canResumeNow true for a running resumable run
    assert.equal(resClear.body.actionability.canResumeNow, true);
  }
  // Terminal run (completed)
  const termRun = { id: "runTermD", status: "completed", runtimeRequest: {}, blockedNodeId: null, resumabilityReason: "none" };
  {
    const db = createDbStub({ runs: [termRun], approvals: [], checkpoints: [], nodes: [] });
    const pythonClient = createPythonClientStub({ result: { ok: true, data: {} } });
    const router = createWorkflowsRouter({
      db,
      pythonClient,
      evaluateResumeEligibility,
      validateResumeCheckpoint,
      WorkflowResumeBody: WorkflowResumeBodyStub,
      getConfig: getConfigStub,
      classifyError: classifyErrorStub,
      classifyCoreError: classifyCoreErrorStub,
      logger: loggerStub,
    });
    const reqTerm = { method: "GET", url: "/workflow-runs/runTermD" };
    const resTerm = createMockResponse();
    await router(reqTerm, resTerm);
    assert.equal(resTerm.statusCode, 200);
    assert.ok(resTerm.body);
    // Terminal run should not require approval action
    assert.equal(resTerm.body.actionability.requiresApprovalAction, false);
    // Terminal run cannot resume
    assert.equal(resTerm.body.actionability.canResumeNow, false);
  }
});