import test from "node:test";
import assert from "node:assert";

// Stage 13: approval detail exposure tests
//
// These tests verify that workflow run detail responses include
// a `blockingApproval` field that surfaces the first pending approval
// record when a run is blocked on approval.  The tests exercise the
// actual route wiring via the createWorkflowsRouter harness and
// validate that the returned approval detail matches the persisted
// approval record.  They also confirm that the field is null when
// there is no pending approval.

import { createWorkflowsRouter } from "./harness/workflowsRouterFactory.js";
import { evaluateResumeEligibility } from "../src/lib/resumeEligibility.js";
import { validateResumeCheckpoint } from "../src/lib/resumeValidator.js";

// A minimal WorkflowResumeBody stub that accepts any payload.
const WorkflowResumeBodyStub = {
  safeParse(payload) {
    return { success: true, data: payload };
  },
};

// Configuration and error classifier stubs.
const getConfigStub = () => ({ defaultRunTimeoutMs: 1000 });
function classifyErrorStub(err) {
  return { statusCode: 500, message: err.message || String(err), code: "INTERNAL_ERROR", category: "internal_error" };
}
function classifyCoreErrorStub(err) {
  return { statusCode: 500, message: err.message || String(err), code: "CORE_ERROR", category: "core_error" };
}
const loggerStub = { error: () => {} };

// DB stub helper.  This version is similar to the one in the Stage 12
// tests but extended to support multiple runs and approvals.  It
// applies updates to the matching run record based on run ID rather
// than always updating the first row.  This is necessary when
// multiple runs exist in a test.
function createDbStub({ runs = [], approvals = [], checkpoints = [], nodes = [] }) {
  const runsData = runs.slice();
  const approvalsData = approvals.slice();
  const checkpointsData = checkpoints.slice();
  const nodeRows = nodes.slice();
  const updates = [];
  const inserts = [];
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
                limit(n) {
                  if (table === self.workflowRunsTable) return Promise.resolve(runsData.slice(0, n ?? runsData.length));
                  if (table === self.approvalsTable) return Promise.resolve(approvalsData.slice(0, n ?? approvalsData.length));
                  if (table === self.checkpointsTable) return Promise.resolve(checkpointsData.slice(0, n ?? checkpointsData.length));
                  if (table === self.workflowRunNodesTable) return Promise.resolve(nodeRows.slice(0, n ?? nodeRows.length));
                  return Promise.resolve([]);
                },
              };
            },
            orderBy() {
              if (table === self.workflowRunsTable) return Promise.resolve(runsData.slice());
              if (table === self.checkpointsTable) return Promise.resolve(checkpointsData.slice());
              return Promise.resolve([]);
            },
          };
        },
      };
    },
    update(table) {
      return {
        set(updateObj) {
          return {
            where() {
              // For simplicity, update all runs that match the runId property if provided
              runsData.forEach((run, index) => {
                if (true) {
                  Object.assign(runsData[index], updateObj);
                }
              });
              updates.push({ table, updateObj });
              return Promise.resolve();
            },
          };
        },
      };
    },
    insert(table) {
      return {
        values(valueObj) {
          inserts.push({ table, valueObj });
          // For checkpoints, push into checkpointsData; for approvals, push into approvalsData
          if (table === this.checkpointsTable) {
            checkpointsData.push(valueObj);
          } else if (table === this.approvalsTable) {
            approvalsData.push(valueObj);
          }
          return Promise.resolve();
        },
      };
    },
    _runs: runsData,
    _approvals: approvalsData,
    _checkpoints: checkpointsData,
    _updates: updates,
    _inserts: inserts,
  };
}

// Python client stub that records calls
function createPythonClientStub({ result }) {
  const calls = [];
  return {
    resumeWorkflow: async (...args) => {
      calls.push(args);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
    _calls: calls,
  };
}

// Helper to create mock response object
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

// Test 1: Detail route includes blockingApproval for a pending approval
test("workflow run detail includes blockingApproval when pending approval exists", async () => {
  const run = {
    id: "runA",
    status: "running",
    runtimeRequest: {},
    blockedNodeId: "nodeA",
    resumabilityReason: "pending_approval",
  };
  const approval = {
    id: "apprA",
    runId: "runA",
    nodeId: "nodeA",
    status: "pending",
    reason: "Need approval",
    requestedAt: new Date("2026-01-01T00:00:00Z"),
    decidedAt: null,
  };
  const db = createDbStub({ runs: [run], approvals: [approval], checkpoints: [], nodes: [] });
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
  const req = { method: "GET", url: "/workflow-runs/runA" };
  const res = createMockResponse();
  await router(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body);
  // Should include blockingApproval with matching fields
  assert.ok(res.body.blockingApproval);
  assert.equal(res.body.blockingApproval.id, "apprA");
  assert.equal(res.body.blockingApproval.nodeId, "nodeA");
  assert.equal(res.body.blockingApproval.status, "pending");
  assert.equal(res.body.blockingApproval.reason, "Need approval");
  // requestedAt should be preserved (string or Date) and decidedAt should be null
  assert.ok(res.body.blockingApproval.requestedAt);
  assert.equal(res.body.blockingApproval.decidedAt, null);
  // Resumability metadata should still reflect pending approval
  assert.equal(res.body.resumability.reason, "pending_approval");
  assert.equal(res.body.resumability.blockedNodeId, "nodeA");
  assert.equal(res.body.resumability.canResume, false);
  // Summary fields: pendingApprovalCount and hasPendingApproval
  assert.equal(res.body.pendingApprovalCount, 1);
  assert.equal(res.body.hasPendingApproval, true);
});

// Test 2: Detail route returns blockingApproval = null when no pending approval
test("workflow run detail returns blockingApproval null when no pending approval", async () => {
  const run = {
    id: "runB",
    status: "running",
    runtimeRequest: {},
    blockedNodeId: null,
    resumabilityReason: "none",
  };
  // Approval is approved, not pending
  const approval = {
    id: "apprB",
    runId: "runB",
    nodeId: "nodeB",
    status: "approved",
    reason: "some reason",
    requestedAt: new Date("2026-02-01T00:00:00Z"),
    decidedAt: new Date("2026-02-02T00:00:00Z"),
  };
  const db = createDbStub({ runs: [run], approvals: [approval], checkpoints: [], nodes: [] });
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
  const req = { method: "GET", url: "/workflow-runs/runB" };
  const res = createMockResponse();
  await router(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body);
  // blockingApproval should be null since approval is not pending
  assert.equal(res.body.blockingApproval, null);
  // Resumability reason should remain "none" and canResume should be true
  assert.equal(res.body.resumability.reason, "none");
  assert.equal(res.body.resumability.canResume, true);
  // Summary fields: pendingApprovalCount should be 0 and hasPendingApproval false
  assert.equal(res.body.pendingApprovalCount, 0);
  assert.equal(res.body.hasPendingApproval, false);
});