import test from "node:test";
import assert from "node:assert";

// Mission 10A: router-level behavioural tests
//
// These tests exercise the resume route logic one level above the handler
// layer.  Rather than invoking the handler function directly, a tiny
// routing harness is used to match the HTTP method and path and to
// populate req.params from the URL.  This provides a minimal
// request-response context that more closely resembles the mounted
// route in Express without requiring the full Express library (which
// is unavailable in this environment).  Dependencies such as the
// database client and pythonClient are stubbed to observe their
// interactions.

import { createWorkflowsRouter } from "./harness/workflowsRouterFactory.js";
import { evaluateResumeEligibility } from "../src/lib/resumeEligibility.js";
import { validateResumeCheckpoint } from "../src/lib/resumeValidator.js";
// For this router-level test harness we provide simple stubs for the
// validation schema, config, error classifiers and logger.  This avoids
// importing TypeScript modules which are not compiled to JavaScript.  The
// WorkflowResumeBody stub always succeeds and returns the payload,
// simulating successful validation.  The getConfig stub provides a
// defaultRunTimeoutMs used by the handler.  The error classifiers
// simply wrap thrown errors into objects with statusCode and message.
const WorkflowResumeBody = {
  safeParse(payload) {
    return { success: true, data: payload };
  },
};

function getConfig() {
  return { defaultRunTimeoutMs: 1000 };
}

function classifyError(err) {
  return {
    statusCode: 500,
    message: err && err.message ? String(err.message) : String(err),
    code: "INTERNAL_ERROR",
    category: "internal_error",
  };
}

function classifyCoreError(err) {
  return {
    statusCode: 500,
    message: err && err.message ? String(err.message) : String(err),
    code: "CORE_ERROR",
    category: "core_error",
  };
}

const logger = { error: () => {} };

// The router-level tests exercise the actual route wiring via the
// createWorkflowsRouter factory.  This factory constructs a minimal
// router that matches POST /workflow-runs/:id/resume and delegates to
// the real resume handler with injected dependencies.  It performs
// URL parsing and param injection in the same manner as the
// production router.

// Helper to create a stubbed DB interface.
function createDbStub({ run, approvals, checkpoints, nodeRows }) {
  const updates = [];
  const inserts = [];
  return {
    workflowRunsTable: {},
    workflowRunNodesTable: {},
    approvalsTable: {},
    checkpointsTable: {},
    select() {
      const self = this;
      return {
        from(table) {
          return {
            where() {
              return {
                limit() {
                  if (table === self.workflowRunsTable) {
                    return Promise.resolve(run ? [run] : []);
                  }
                  if (table === self.approvalsTable) {
                    return Promise.resolve(approvals ?? []);
                  }
                  if (table === self.checkpointsTable) {
                    return Promise.resolve(checkpoints ?? []);
                  }
                  if (table === self.workflowRunNodesTable) {
                    return Promise.resolve(nodeRows ?? []);
                  }
                  return Promise.resolve([]);
                },
              };
            },
            orderBy() {
              return Promise.resolve(checkpoints ?? []);
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
          return Promise.resolve();
        },
      };
    },
    _updates: updates,
    _inserts: inserts,
  };
}

// Helper to create a mock pythonClient.
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

// Helper to create a mock response object used by the route.  It
// captures status codes and JSON bodies.
function createMockResponse() {
  const res = {};
  res.statusCode = 200;
  res.body = undefined;
  res.status = function (code) {
    res.statusCode = code;
    return res;
  };
  res.json = function (obj) {
    res.body = obj;
    return res;
  };
  return res;
}

// Test 1: terminal run rejection at router level.
test("router-level: terminal run rejection", async () => {
  const run = { id: "tr1", runtimeRequest: {}, status: "completed", lastCheckpointId: null, resumableCheckpointId: null };
  const db = createDbStub({ run, approvals: [], checkpoints: [] });
  const pythonClient = createPythonClientStub({ result: { ok: true, data: {} } });
  const router = createWorkflowsRouter({
    db,
    pythonClient,
    evaluateResumeEligibility,
    // Use a stubbed validateResumeCheckpoint that always succeeds for this scenario.
    validateResumeCheckpoint: () => ({ ok: true }),
    WorkflowResumeBody,
    getConfig,
    classifyError,
    classifyCoreError,
    logger,
  });
  const req = { method: "POST", url: "/workflow-runs/tr1/resume", body: { completedNodes: [] } };
  const res = createMockResponse();
  await router(req, res);
  assert.strictEqual(res.statusCode, 409);
  assert.ok(res.body.error.includes("terminal") || res.body.error.includes("approval"));
  assert.strictEqual(pythonClient._calls.length, 0);
  // The handler should record one DB update to set resumabilityReason and blockedNodeId
  assert.equal(db._updates.length, 1, "A single update should occur for resumability metadata");
  const update = db._updates[0];
  // Update object should include terminal reason and null blocked node
  assert.strictEqual(update.updateObj.resumabilityReason, "terminal");
  assert.strictEqual(update.updateObj.blockedNodeId, null);
});

// Test 2: pending approval rejection at router level.
test("router-level: pending approval rejection", async () => {
  const run = { id: "pa1", runtimeRequest: {}, status: "running", lastCheckpointId: null, resumableCheckpointId: null };
  const db = createDbStub({ run, approvals: [{ id: "a1", status: "pending", nodeId: "nodeA" }], checkpoints: [] });
  const pythonClient = createPythonClientStub({ result: { ok: true, data: {} } });
  const router = createWorkflowsRouter({
    db,
    pythonClient,
    evaluateResumeEligibility,
    // Stub validateResumeCheckpoint to always succeed.
    validateResumeCheckpoint: () => ({ ok: true }),
    WorkflowResumeBody,
    getConfig,
    classifyError,
    classifyCoreError,
    logger,
  });
  const req = { method: "POST", url: "/workflow-runs/pa1/resume", body: { completedNodes: [] } };
  const res = createMockResponse();
  await router(req, res);
  assert.strictEqual(res.statusCode, 409);
  assert.ok(res.body.error.includes("approval") || res.body.error.includes("pending"));
  assert.strictEqual(pythonClient._calls.length, 0);
  // The handler should record one DB update to set resumabilityReason and blockedNodeId
  assert.equal(db._updates.length, 1, "A single update should occur for resumability metadata");
  const update = db._updates[0];
  assert.strictEqual(update.updateObj.resumabilityReason, "pending_approval");
  assert.strictEqual(update.updateObj.blockedNodeId, "nodeA");
});

// Test 3: valid checkpoint UUID translates to nodeId and forwards to Python.
test("router-level: valid checkpoint translation and forwarding", async () => {
  const run = { id: "vc1", runtimeRequest: {}, status: "running", lastCheckpointId: "cp1", resumableCheckpointId: "cp1" };
  const db = createDbStub({ run, approvals: [], checkpoints: [{ id: "cp1", nodeId: "nodeX" }] });
  const pythonClient = createPythonClientStub({ result: { ok: true, data: { nodes: [] } } });
  const router = createWorkflowsRouter({
    db,
    pythonClient,
    evaluateResumeEligibility,
    validateResumeCheckpoint: () => ({ ok: true }),
    WorkflowResumeBody,
    getConfig,
    classifyError,
    classifyCoreError,
    logger,
  });
  const req = { method: "POST", url: "/workflow-runs/vc1/resume", body: { completedNodes: [], checkpointId: "cp1" } };
  const res = createMockResponse();
  await router(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(pythonClient._calls.length, 1);
  const [[resumePayload]] = pythonClient._calls;
  assert.strictEqual(resumePayload.checkpointId, "nodeX");
  // The run update should reset blockedNodeId and resumabilityReason to none
  assert.ok(db._updates.length >= 1);
  const lastUpdate = db._updates[db._updates.length - 1];
  assert.strictEqual(lastUpdate.updateObj.blockedNodeId, null);
  assert.strictEqual(lastUpdate.updateObj.resumabilityReason, "none");
});

// Test 4: missing nodeId mapping results in omission of checkpointId.
test("router-level: missing nodeId mapping omits checkpointId", async () => {
  const run = { id: "nm1", runtimeRequest: {}, status: "running", lastCheckpointId: "cp2", resumableCheckpointId: "cp2" };
  // The checkpoint lacks a nodeId.
  const db = createDbStub({ run, approvals: [], checkpoints: [{ id: "cp2" }] });
  const pythonClient = createPythonClientStub({ result: { ok: true, data: { nodes: [] } } });
  const router = createWorkflowsRouter({
    db,
    pythonClient,
    evaluateResumeEligibility,
    validateResumeCheckpoint: () => ({ ok: true }),
    WorkflowResumeBody,
    getConfig,
    classifyError,
    classifyCoreError,
    logger,
  });
  const req = { method: "POST", url: "/workflow-runs/nm1/resume", body: { completedNodes: [], checkpointId: "cp2" } };
  const res = createMockResponse();
  await router(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(pythonClient._calls.length, 1);
  const [[resumePayload]] = pythonClient._calls;
  assert.ok(!("checkpointId" in resumePayload));
  // The run update should reset blockedNodeId and resumabilityReason to none
  assert.ok(db._updates.length >= 1);
  const lastUpdate2 = db._updates[db._updates.length - 1];
  assert.strictEqual(lastUpdate2.updateObj.blockedNodeId, null);
  assert.strictEqual(lastUpdate2.updateObj.resumabilityReason, "none");
});

// Test 5: pythonClient failure surfaces error through the router.
test("router-level: python client error surfaces through router", async () => {
  const run = { id: "fail1", runtimeRequest: {}, status: "running", lastCheckpointId: null, resumableCheckpointId: null };
  const db = createDbStub({ run, approvals: [], checkpoints: [] });
  const pythonClient = createPythonClientStub({ result: { ok: false, error: new Error("Core failure") } });
  const router = createWorkflowsRouter({
    db,
    pythonClient,
    evaluateResumeEligibility,
    // Stub validateResumeCheckpoint to always succeed so the request reaches the python client
    validateResumeCheckpoint: () => ({ ok: true }),
    WorkflowResumeBody,
    getConfig,
    classifyError,
    classifyCoreError,
    logger,
  });
  const req = { method: "POST", url: "/workflow-runs/fail1/resume", body: { completedNodes: [] } };
  const res = createMockResponse();
  await router(req, res);
  // Should return non-200 and include an error message.
  assert.notStrictEqual(res.statusCode, 200);
  assert.ok(res.body && res.body.error);
  // A python failure should not update resumability metadata
  assert.strictEqual(db._updates.length, 0);
});
