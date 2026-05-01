import test from "node:test";
import assert from "node:assert";

// Stage 14: approval summary tests
//
// These tests verify that list and detail responses include operator-friendly
// summary fields reflecting approval state.  In particular:
// - hasPendingApproval on run list entries indicates whether the run is
//   currently blocked by a pending approval.
// - pendingApprovalCount on run detail responses counts how many
//   approvals are in the "pending" state for the run.
// - hasPendingApproval on run detail responses mirrors whether there
//   are pending approvals.

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

// Simple DB stub for list/summary tests.  It always returns the provided
// data for selects and ignores where/limit calls.
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

test("run list includes hasPendingApproval summary", async () => {
  const db = createDbStub({ runs: [
    { id: "runPending", status: "running", runtimeRequest: {}, blockedNodeId: "nodeP", resumabilityReason: "pending_approval" },
    { id: "runClear", status: "running", runtimeRequest: {}, blockedNodeId: null, resumabilityReason: "none" },
  ] });
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
  assert.ok(res.body && Array.isArray(res.body.runs));
  // Find runs by id
  const pending = res.body.runs.find((r) => r.id === "runPending");
  const clear = res.body.runs.find((r) => r.id === "runClear");
  assert.ok(pending && clear);
  // pending run should have hasPendingApproval true
  assert.equal(pending.hasPendingApproval, true);
  // clear run should have hasPendingApproval false
  assert.equal(clear.hasPendingApproval, false);
});

test("run detail includes pendingApprovalCount and hasPendingApproval", async () => {
  const run = { id: "runD", status: "running", runtimeRequest: {}, blockedNodeId: "nodeD", resumabilityReason: "pending_approval" };
  const approvals = [
    { id: "ap1", runId: "runD", nodeId: "nodeD", status: "pending", reason: "Reason1", requestedAt: new Date(), decidedAt: null },
    { id: "ap2", runId: "runD", nodeId: "nodeD", status: "pending", reason: "Reason2", requestedAt: new Date(), decidedAt: null },
    { id: "ap3", runId: "runD", nodeId: "nodeD", status: "approved", reason: "Reason3", requestedAt: new Date(), decidedAt: new Date() },
  ];
  const db = createDbStub({ runs: [run], approvals, checkpoints: [], nodes: [] });
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
  const req = { method: "GET", url: "/workflow-runs/runD" };
  const res = createMockResponse();
  await router(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body);
  // pendingApprovalCount should reflect number of pending approvals
  assert.equal(res.body.pendingApprovalCount, 2);
  assert.equal(res.body.hasPendingApproval, true);
  // When there are pending approvals, resumabilityReason should be pending_approval and canResume false
  assert.equal(res.body.resumability.reason, "pending_approval");
  assert.equal(res.body.resumability.canResume, false);
});