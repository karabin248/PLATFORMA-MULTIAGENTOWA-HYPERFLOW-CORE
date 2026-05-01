import test from "node:test";
import assert from "node:assert";

// Stage 17: checkpoint timeline tests
//
// These tests verify that the workflow run detail response includes a
// `checkpointTimeline` array reflecting all checkpoint records for the run.
// The timeline must be ordered by `createdAt` ascending (earliest first),
// include all checkpoints regardless of status, and remain consistent
// with run-level metadata such as `lastCheckpointId` and
// `resumableCheckpointId`.  The tests utilise the minimal router harness
// defined in workflowsRouterFactory.js to exercise the real route
// wiring and response shaping logic.

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
                orderBy() {
                  if (table === self.approvalsTable) return Promise.resolve(approvalsData);
                  if (table === self.checkpointsTable) return Promise.resolve(checkpointsData);
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

// Test 1: timeline appears and is empty when no checkpoints exist
test("checkpointTimeline is empty when no checkpoints exist", async () => {
  const run = {
    id: "runCT1",
    status: "running",
    runtimeRequest: {},
    blockedNodeId: null,
    resumabilityReason: "none",
    lastCheckpointId: null,
    resumableCheckpointId: null,
  };
  const db = createDbStub({ runs: [run], approvals: [], checkpoints: [] });
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
  const req = { method: "GET", url: "/workflow-runs/runCT1" };
  const res = createMockResponse();
  await router(req, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body);
  assert.ok(Array.isArray(res.body.checkpointTimeline));
  assert.equal(res.body.checkpointTimeline.length, 0);
});

// Test 2: timeline includes checkpoints in ascending order and matches run-level fields
test("checkpointTimeline includes checkpoints in ascending createdAt order", async () => {
  const run = {
    id: "runCT2",
    status: "running",
    runtimeRequest: {},
    blockedNodeId: null,
    resumabilityReason: "none",
    lastCheckpointId: "cp2",
    resumableCheckpointId: "cp2",
  };
  // Create checkpoints with distinct createdAt timestamps
  const now = new Date();
  const earlier = new Date(now.getTime() - 100000);
  const later = new Date(now.getTime() + 100000);
  const checkpoints = [
    { id: "cp2", runId: "runCT2", nodeId: "n2", checkpointType: "workflow.node", createdAt: later },
    { id: "cp1", runId: "runCT2", nodeId: "n1", checkpointType: "workflow.node", createdAt: earlier },
  ];
  const db = createDbStub({ runs: [run], approvals: [], checkpoints });
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
  const req = { method: "GET", url: "/workflow-runs/runCT2" };
  const res = createMockResponse();
  await router(req, res);
  assert.equal(res.statusCode, 200);
  const body = res.body;
  assert.ok(body);
  assert.ok(Array.isArray(body.checkpointTimeline));
  assert.equal(body.checkpointTimeline.length, checkpoints.length);
  // Ensure timeline is ordered by createdAt ascending
  const times = body.checkpointTimeline.map((item) => item.createdAt ? new Date(item.createdAt).getTime() : 0);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] >= times[i - 1]);
  }
  // Map timeline entries by id for comparison
  const cpMap = {};
  checkpoints.forEach((cp) => { cpMap[cp.id] = cp; });
  body.checkpointTimeline.forEach((entry) => {
    const original = cpMap[entry.id];
    assert.ok(original);
    assert.equal(entry.nodeId, original.nodeId);
    assert.equal(entry.type, original.checkpointType);
    // createdAt may be Date or ISO string; compare by timestamp
    assert.equal(entry.createdAt ? new Date(entry.createdAt).getTime() : null, original.createdAt ? original.createdAt.getTime() : null);
  });
  // Coherence: last checkpoint in timeline matches run.lastCheckpointId
  const lastTimeline = body.checkpointTimeline[body.checkpointTimeline.length - 1];
  assert.equal(lastTimeline.id, run.lastCheckpointId);
  // Coherence: resumableCheckpointId exists in timeline
  if (run.resumableCheckpointId) {
    const found = body.checkpointTimeline.find((item) => item.id === run.resumableCheckpointId);
    assert.ok(found);
  }
});