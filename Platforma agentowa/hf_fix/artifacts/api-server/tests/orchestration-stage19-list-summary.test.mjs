import test from "node:test";
import assert from "node:assert";

// Stage 19: list-level execution summary tests
//
// These tests verify that GET /workflow-runs exposes a compact,
// scan-friendly listExecutionSummary derived only from existing run-row
// truth and current list shaping.  The summary must remain lightweight,
// avoid history/timeline data, and stay coherent with the detail-route
// executionStory philosophy.

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

test("listExecutionSummary is coherent for blocked-by-approval, clear, terminal, and checkpoint-aware runs", async () => {
  const runs = [
    {
      id: "runBlocked",
      status: "running",
      runtimeRequest: {},
      blockedNodeId: "nodeA",
      resumabilityReason: "pending_approval",
      lastCheckpointId: "cpA",
    },
    {
      id: "runClear",
      status: "running",
      runtimeRequest: {},
      blockedNodeId: null,
      resumabilityReason: "none",
      lastCheckpointId: "cpB",
    },
    {
      id: "runTerminal",
      status: "completed",
      runtimeRequest: {},
      blockedNodeId: null,
      resumabilityReason: "none",
      lastCheckpointId: "cpC",
    },
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
  assert.ok(res.body && Array.isArray(res.body.runs));

  const blocked = res.body.runs.find((r) => r.id === "runBlocked");
  const clear = res.body.runs.find((r) => r.id === "runClear");
  const terminal = res.body.runs.find((r) => r.id === "runTerminal");
  assert.ok(blocked && clear && terminal);

  // blocked-by-approval run
  assert.ok(blocked.listExecutionSummary);
  assert.equal(blocked.listExecutionSummary.status, "running");
  assert.equal(blocked.listExecutionSummary.blocked, true);
  assert.equal(blocked.listExecutionSummary.blockType, "pending_approval");
  assert.equal(blocked.listExecutionSummary.requiresApprovalAction, true);
  assert.equal(blocked.listExecutionSummary.canResumeNow, false);
  assert.equal(blocked.listExecutionSummary.currentBoundaryCheckpointId, "cpA");
  // coherence with existing list fields
  assert.equal(blocked.requiresApprovalAction, true);
  assert.equal(blocked.hasPendingApproval, true);
  assert.equal(blocked.resumability.reason, "pending_approval");
  assert.equal(blocked.resumability.canResume, false);

  // clear resumable run
  assert.ok(clear.listExecutionSummary);
  assert.equal(clear.listExecutionSummary.blocked, false);
  assert.equal(clear.listExecutionSummary.blockType, null);
  assert.equal(clear.listExecutionSummary.requiresApprovalAction, false);
  assert.equal(clear.listExecutionSummary.canResumeNow, true);
  assert.equal(clear.listExecutionSummary.currentBoundaryCheckpointId, "cpB");
  assert.equal(clear.resumability.canResume, true);

  // terminal run
  assert.ok(terminal.listExecutionSummary);
  assert.equal(terminal.listExecutionSummary.blocked, false);
  assert.equal(terminal.listExecutionSummary.requiresApprovalAction, false);
  assert.equal(terminal.listExecutionSummary.canResumeNow, false);
  assert.equal(terminal.listExecutionSummary.currentBoundaryCheckpointId, "cpC");
});
