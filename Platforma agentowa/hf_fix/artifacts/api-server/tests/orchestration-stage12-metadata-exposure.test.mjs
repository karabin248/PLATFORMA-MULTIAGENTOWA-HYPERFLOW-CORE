import test from "node:test";
import assert from "node:assert";

// Stage 12: metadata exposure tests
//
// These tests verify that the blockedNodeId and resumabilityReason
// columns on workflow runs are surfaced through the read routes.  They
// also demonstrate that pending approval scenarios set these fields
// correctly and that successful resumes reset them.  The tests use the
// createWorkflowsRouter factory to exercise the route wiring and rely
// on simple stubs for the database and pythonClient.  They do not
// require Express or a real database.

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

// A helper to create a DB stub that updates the run record in place.
function createDbStub({ runs = [], approvals = [], checkpoints = [], nodes = [] }) {
  // Clone arrays to avoid mutation across tests.
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
              // Return rows as-is for testing; Drizzle would sort by createdAt.
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
              // Apply updates to the first matching run for simplicity.
              if (runsData.length > 0) {
                Object.assign(runsData[0], updateObj);
              }
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
          // Push into checkpoints array for any insert.  In this stub we
          // don't discriminate between tables because the inserted
          // records are only used for checkpoints assertions in tests.
          checkpointsData.push(valueObj);
          return Promise.resolve();
        },
      };
    },
    _runs: runsData,
    _updates: updates,
    _inserts: inserts,
  };
}

// A simple pythonClient stub that records calls and returns configurable responses.
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

// Helper to create a mock response object capturing status and JSON body.
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

// Test 1: The run list includes blockedNodeId and resumabilityReason fields.
test("run list exposes resumability metadata", async () => {
  const db = createDbStub({
    runs: [
      {
        id: "runList1",
        status: "running",
        runtimeRequest: {},
        blockedNodeId: "node42",
        resumabilityReason: "pending_approval",
      },
    ],
  });
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
  assert.equal(res.body.runs.length, 1);
  const run = res.body.runs[0];
  // Raw fields remain present for backward compatibility
  assert.equal(run.blockedNodeId, "node42");
  assert.equal(run.resumabilityReason, "pending_approval");
  // Derived resumability object should reflect the same state
  assert.ok(run.resumability);
  assert.equal(run.resumability.reason, "pending_approval");
  assert.equal(run.resumability.blockedNodeId, "node42");
  assert.equal(run.resumability.canResume, false);
  // List-level summary: hasPendingApproval should be true for pending approval runs
  assert.equal(run.hasPendingApproval, true);
});

// Test 2: The run detail exposes blockedNodeId and resumabilityReason fields.
test("run detail exposes resumability metadata", async () => {
  const db = createDbStub({
    runs: [
      {
        id: "runDetail1",
        status: "running",
        runtimeRequest: {},
        blockedNodeId: "nodeX",
        resumabilityReason: "invalid_checkpoint",
      },
    ],
    nodes: [],
    checkpoints: [],
  });
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
  const req = { method: "GET", url: "/workflow-runs/runDetail1" };
  const res = createMockResponse();
  await router(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body && res.body.id === "runDetail1");
  assert.equal(res.body.blockedNodeId, "nodeX");
  assert.equal(res.body.resumabilityReason, "invalid_checkpoint");
  // Derived resumability object should be present
  assert.ok(res.body.resumability);
  assert.equal(res.body.resumability.reason, "invalid_checkpoint");
  assert.equal(res.body.resumability.blockedNodeId, "nodeX");
  assert.equal(res.body.resumability.canResume, false);

  // There are no approvals for this run, so blockingApproval should be null
  assert.equal(res.body.blockingApproval, null);

  // Detail-level summary: hasPendingApproval should be false, pendingApprovalCount should be 0
  assert.equal(res.body.hasPendingApproval, false);
  assert.equal(res.body.pendingApprovalCount, 0);
});

// Test 3: Pending approvals set resumabilityReason and blockedNodeId in the run list/detail.
test("pending approvals reflect in metadata after gating", async () => {
  // Start with a run that has no blocking metadata.
  const runRecord = { id: "runPending", status: "running", runtimeRequest: {}, blockedNodeId: null, resumabilityReason: "none" };
  const db = createDbStub({ runs: [runRecord], approvals: [{ id: "appr1", status: "pending", nodeId: "pendingNode" }], checkpoints: [], nodes: [] });
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
  // Attempt to resume.  This should set blockedNodeId and reason via the handler.
  let req = { method: "POST", url: "/workflow-runs/runPending/resume", body: { completedNodes: [] } };
  let res = createMockResponse();
  await router(req, res);
  assert.equal(res.statusCode, 409, "Pending approvals should yield 409");
  // Now fetch the run list; the updated run record should reflect pending approval metadata.
  req = { method: "GET", url: "/workflow-runs" };
  res = createMockResponse();
  await router(req, res);
  const run = res.body.runs[0];
  assert.equal(run.resumabilityReason, "pending_approval");
  assert.equal(run.blockedNodeId, "pendingNode");
  assert.ok(run.resumability);
  assert.equal(run.resumability.reason, "pending_approval");
  assert.equal(run.resumability.blockedNodeId, "pendingNode");
  assert.equal(run.resumability.canResume, false);
  // The list-level summary should indicate pending approvals
  assert.equal(run.hasPendingApproval, true);
  // Fetch run detail and ensure metadata is reflected there as well.
  req = { method: "GET", url: "/workflow-runs/runPending" };
  res = createMockResponse();
  await router(req, res);
  assert.equal(res.body.resumabilityReason, "pending_approval");
  assert.equal(res.body.blockedNodeId, "pendingNode");
  assert.ok(res.body.resumability);
  assert.equal(res.body.resumability.reason, "pending_approval");
  assert.equal(res.body.resumability.blockedNodeId, "pendingNode");
  assert.equal(res.body.resumability.canResume, false);
  // The detail response should include blockingApproval when a pending approval exists.
  assert.ok(res.body.blockingApproval);
  assert.equal(res.body.blockingApproval.nodeId, "pendingNode");
  assert.equal(res.body.blockingApproval.status, "pending");
  // Detail-level summary: hasPendingApproval should be true and pendingApprovalCount should reflect the number of pending approvals
  assert.equal(res.body.hasPendingApproval, true);
  assert.equal(res.body.pendingApprovalCount, 1);
});

// Test 4: Successful resume clears blocked metadata.
test("successful resume clears blocked metadata", async () => {
  // Run initially blocked due to previous pending approval.
  const runRecord = { id: "runSuccess", status: "running", runtimeRequest: {}, blockedNodeId: "nodeZ", resumabilityReason: "pending_approval" };
  const db = createDbStub({ runs: [runRecord], approvals: [], checkpoints: [] });
  const pythonClient = createPythonClientStub({ result: { ok: true, data: { status: "running", nodes: [] } } });
  // Stub the checkpoint validator to always succeed.  Without a
  // persisted checkpoint ID, the default validator would reject the
  // resume request with "No resumable checkpoint available".  This
  // test focuses on metadata clearing, so we avoid that failure.
  const validateResumeCheckpointStub = () => ({ ok: true });
  const router = createWorkflowsRouter({
    db,
    pythonClient,
    evaluateResumeEligibility,
    validateResumeCheckpoint: validateResumeCheckpointStub,
    WorkflowResumeBody: WorkflowResumeBodyStub,
    getConfig: getConfigStub,
    classifyError: classifyErrorStub,
    classifyCoreError: classifyCoreErrorStub,
    logger: loggerStub,
  });
  // Resume should succeed and reset metadata.
  let req = { method: "POST", url: "/workflow-runs/runSuccess/resume", body: { completedNodes: [] } };
  let res = createMockResponse();
  await router(req, res);
  assert.equal(res.statusCode, 200);
  // Fetch detail to verify metadata reset
  req = { method: "GET", url: "/workflow-runs/runSuccess" };
  res = createMockResponse();
  await router(req, res);
  assert.equal(res.body.resumabilityReason, "none");
  assert.equal(res.body.blockedNodeId, null);
  assert.ok(res.body.resumability);
  assert.equal(res.body.resumability.reason, "none");
  assert.equal(res.body.resumability.blockedNodeId, null);
  assert.equal(res.body.resumability.canResume, true);
  // The summary fields should indicate no pending approvals after success
  assert.equal(res.body.hasPendingApproval, false);
  assert.equal(res.body.pendingApprovalCount, 0);
  // After a successful resume, blockingApproval should be null again.
  assert.equal(res.body.blockingApproval, null);
});