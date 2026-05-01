import test from "node:test";
import assert from "node:assert";

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

function makeRouter(seed) {
  const db = createDbStub(seed);
  const pythonClient = createPythonClientStub({ result: { ok: true, data: {} } });
  return createWorkflowsRouter({
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
}

test("executionStory reflects pending-approval blockage coherently", async () => {
  const requested = new Date("2026-04-18T10:00:00Z");
  const router = makeRouter({
    runs: [{
      id: "runBlockStory",
      status: "running",
      runtimeRequest: {},
      blockedNodeId: "nodeApprove",
      resumabilityReason: "pending_approval",
      lastCheckpointId: null,
      resumableCheckpointId: null,
    }],
    approvals: [{
      id: "ap1",
      runId: "runBlockStory",
      nodeId: "nodeApprove",
      status: "pending",
      reason: "Needs sign-off",
      requestedAt: requested,
      decidedAt: null,
    }],
    checkpoints: [],
    nodes: [],
  });
  const req = { method: "GET", url: "/workflow-runs/runBlockStory" };
  const res = createMockResponse();
  await router(req, res);
  assert.equal(res.statusCode, 200);
  const body = res.body;
  assert.ok(body.executionStory);
  assert.equal(body.executionStory.status, "running");
  assert.equal(body.executionStory.blocked, true);
  assert.equal(body.executionStory.blockType, "pending_approval");
  assert.equal(body.executionStory.blockedNodeId, "nodeApprove");
  assert.equal(body.executionStory.requiresApprovalAction, true);
  assert.equal(body.executionStory.canResumeNow, false);
  assert.equal(body.executionStory.pendingApprovalCount, 1);
  assert.equal(body.executionStory.latestApprovalStatus, "pending");
  assert.equal(body.blockingApproval.id, "ap1");
  assert.equal(body.pendingApprovalCount, 1);
  assert.equal(body.hasPendingApproval, true);
  assert.equal(body.actionability.requiresApprovalAction, true);
});

test("executionStory reflects clear resumable run truthfully", async () => {
  const router = makeRouter({
    runs: [{
      id: "runClearStory",
      status: "running",
      runtimeRequest: {},
      blockedNodeId: null,
      resumabilityReason: "none",
      lastCheckpointId: null,
      resumableCheckpointId: null,
    }],
    approvals: [],
    checkpoints: [],
    nodes: [],
  });
  const req = { method: "GET", url: "/workflow-runs/runClearStory" };
  const res = createMockResponse();
  await router(req, res);
  const story = res.body.executionStory;
  assert.equal(story.blocked, false);
  assert.equal(story.blockType, null);
  assert.equal(story.requiresApprovalAction, false);
  assert.equal(story.canResumeNow, true);
  assert.equal(story.pendingApprovalCount, 0);
  assert.equal(story.currentBoundaryCheckpointId, null);
  assert.equal(story.latestCheckpointNodeId, null);
  assert.equal(story.latestApprovalStatus, null);
});

test("executionStory stays coherent for terminal run", async () => {
  const router = makeRouter({
    runs: [{
      id: "runTerminalStory",
      status: "completed",
      runtimeRequest: {},
      blockedNodeId: null,
      resumabilityReason: "none",
      lastCheckpointId: null,
      resumableCheckpointId: null,
    }],
    approvals: [],
    checkpoints: [],
    nodes: [],
  });
  const req = { method: "GET", url: "/workflow-runs/runTerminalStory" };
  const res = createMockResponse();
  await router(req, res);
  const body = res.body;
  assert.equal(body.executionStory.status, "completed");
  assert.equal(body.executionStory.blocked, false);
  assert.equal(body.executionStory.requiresApprovalAction, false);
  assert.equal(body.executionStory.canResumeNow, false);
  assert.equal(body.resumability.canResume, false);
});

test("executionStory reflects checkpoint context coherently", async () => {
  const t1 = new Date("2026-04-18T09:00:00Z");
  const t2 = new Date("2026-04-18T10:00:00Z");
  const router = makeRouter({
    runs: [{
      id: "runCheckpointStory",
      status: "running",
      runtimeRequest: {},
      blockedNodeId: null,
      resumabilityReason: "none",
      lastCheckpointId: "cp2",
      resumableCheckpointId: "cp2",
    }],
    approvals: [],
    checkpoints: [
      { id: "cp2", runId: "runCheckpointStory", nodeId: "nodeB", checkpointType: "workflow.node", createdAt: t2 },
      { id: "cp1", runId: "runCheckpointStory", nodeId: "nodeA", checkpointType: "workflow.node", createdAt: t1 },
    ],
    nodes: [],
  });
  const req = { method: "GET", url: "/workflow-runs/runCheckpointStory" };
  const res = createMockResponse();
  await router(req, res);
  const body = res.body;
  assert.equal(body.executionStory.currentBoundaryCheckpointId, "cp2");
  assert.equal(body.executionStory.resumableCheckpointId, "cp2");
  assert.equal(body.executionStory.latestCheckpointNodeId, "nodeB");
  assert.ok(Array.isArray(body.checkpointTimeline));
  assert.equal(body.checkpointTimeline[body.checkpointTimeline.length - 1].id, "cp2");
  assert.equal(body.lastCheckpointId, "cp2");
  assert.equal(body.resumableCheckpointId, "cp2");
});

test("executionStory stays truthful for minimal run", async () => {
  const router = makeRouter({
    runs: [{
      id: "runMinimalStory",
      status: "queued",
      runtimeRequest: {},
      blockedNodeId: null,
      resumabilityReason: "none",
      lastCheckpointId: null,
      resumableCheckpointId: null,
    }],
    approvals: [],
    checkpoints: [],
    nodes: [],
  });
  const req = { method: "GET", url: "/workflow-runs/runMinimalStory" };
  const res = createMockResponse();
  await router(req, res);
  const story = res.body.executionStory;
  assert.ok(story);
  assert.equal(story.status, "queued");
  assert.equal(story.blocked, false);
  assert.equal(story.blockType, null);
  assert.equal(story.requiresApprovalAction, false);
  assert.equal(story.pendingApprovalCount, 0);
  assert.equal(story.currentBoundaryCheckpointId, null);
  assert.equal(story.resumableCheckpointId, null);
  assert.equal(story.latestCheckpointNodeId, null);
  assert.equal(story.latestApprovalStatus, null);
});
