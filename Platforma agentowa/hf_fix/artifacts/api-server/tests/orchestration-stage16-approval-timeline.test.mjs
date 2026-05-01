import test from "node:test";
import assert from "node:assert";

// Stage 16: approval timeline tests
//
// These tests verify that the workflow run detail response includes an
// `approvalTimeline` array reflecting all approval records for the run.
// The timeline must be ordered by `requestedAt` ascending (earliest
// first), include both pending and decided approvals, and be
// consistent with other approval-related metadata such as
// `pendingApprovalCount`, `hasPendingApproval`, and `blockingApproval`.

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

// Minimal DB stub returning seeded data; used for timeline tests.
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

// Test 1: timeline appears and is empty when no approvals exist
test("approvalTimeline is empty when no approvals exist", async () => {
  const run = { id: "runT1", status: "running", runtimeRequest: {}, blockedNodeId: null, resumabilityReason: "none" };
  const db = createDbStub({ runs: [run], approvals: [] });
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
  const req = { method: "GET", url: "/workflow-runs/runT1" };
  const res = createMockResponse();
  await router(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body);
  assert.ok(Array.isArray(res.body.approvalTimeline));
  assert.equal(res.body.approvalTimeline.length, 0);
});

// Test 2: timeline includes all approvals in ascending order and matches other fields
test("approvalTimeline includes approvals in ascending requestedAt order", async () => {
  const run = { id: "runT2", status: "running", runtimeRequest: {}, blockedNodeId: "n1", resumabilityReason: "pending_approval" };
  // Create approvals with different requestedAt timestamps
  const now = new Date();
  const earlier = new Date(now.getTime() - 100000);
  const later = new Date(now.getTime() + 100000);
  const approvals = [
    { id: "apEarly", runId: "runT2", nodeId: "n1", status: "approved", reason: "R early", requestedAt: earlier, decidedAt: now },
    { id: "apMid", runId: "runT2", nodeId: "n1", status: "pending", reason: "R mid", requestedAt: now, decidedAt: null },
    { id: "apLate", runId: "runT2", nodeId: "n1", status: "rejected", reason: "R late", requestedAt: later, decidedAt: later },
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
  const req = { method: "GET", url: "/workflow-runs/runT2" };
  const res = createMockResponse();
  await router(req, res);
  assert.equal(res.statusCode, 200);
  const body = res.body;
  assert.ok(body);
  // Timeline length equals number of approvals
  assert.ok(Array.isArray(body.approvalTimeline));
  assert.equal(body.approvalTimeline.length, approvals.length);
  // Timeline is ordered by requestedAt ascending
  const times = body.approvalTimeline.map((item) => item.requestedAt ? new Date(item.requestedAt).getTime() : 0);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] >= times[i - 1]);
  }
  // Each timeline entry matches the corresponding approval fields
  // We test via a map lookup keyed by id
  const map = {};
  approvals.forEach((appr) => {
    map[appr.id] = appr;
  });
  body.approvalTimeline.forEach((entry) => {
    const original = map[entry.id];
    assert.ok(original);
    assert.equal(entry.nodeId, original.nodeId);
    assert.equal(entry.status, original.status);
    assert.equal(entry.reason, original.reason);
    // requestedAt and decidedAt may be null or equal; using toString for comparison
    assert.equal(entry.requestedAt ? new Date(entry.requestedAt).getTime() : null, original.requestedAt ? original.requestedAt.getTime() : null);
    assert.equal(entry.decidedAt ? new Date(entry.decidedAt).getTime() : null, original.decidedAt ? original.decidedAt.getTime() : null);
  });
  // Coherence: pendingApprovalCount equals number of pending approvals
  const pendingCount = approvals.filter((appr) => appr.status === "pending").length;
  assert.equal(body.pendingApprovalCount, pendingCount);
  assert.equal(body.hasPendingApproval, pendingCount > 0);
  // blockingApproval appears in the timeline if there's a pending approval
  if (body.blockingApproval) {
    const found = body.approvalTimeline.find((entry) => entry.id === body.blockingApproval.id);
    assert.ok(found);
    assert.equal(found.status, "pending");
  }
});