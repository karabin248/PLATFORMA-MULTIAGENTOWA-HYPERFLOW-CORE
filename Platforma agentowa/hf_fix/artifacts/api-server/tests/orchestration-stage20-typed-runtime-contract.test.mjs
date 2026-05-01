import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createResumeWorkflowHandler } from "./harness/resumeWorkflowHandler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routesIndex = fs.readFileSync(path.resolve(__dirname, "../src/routes/index.ts"), "utf8");
const workflowsRoute = fs.readFileSync(path.resolve(__dirname, "../src/routes/workflows.ts"), "utf8");
const compilerSource = fs.readFileSync(path.resolve(__dirname, "../src/lib/workflowCompilation.ts"), "utf8");
const humanInputsRoute = fs.readFileSync(path.resolve(__dirname, "../src/routes/humanInputs.ts"), "utf8");

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("typed runtime compiler is wired into workflow execution and human-input surface is mounted", () => {
  assert.match(workflowsRoute, /compileWorkflowRuntimeRequest/);
  assert.match(compilerSource, /UNSUPPORTED_NODE_TYPE/);
  assert.match(compilerSource, /node\.type === "parallel"/);
  assert.match(routesIndex, /router\.use\(humanInputsRouter\)/);
  assert.match(humanInputsRoute, /\/workflow-runs\/:id\/nodes\/:nodeId\/input/);
});

test("resume handler infers completed nodes from persisted node rows when body omits them", async () => {
  const calls = [];
  const db = {
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
                  if (table === self.workflowRunsTable) {
                    return Promise.resolve([{ id: "run-1", status: "running", runtimeRequest: { workflowId: "wf", name: "WF", steps: [] }, lastCheckpointId: null, resumableCheckpointId: null }]);
                  }
                  if (table === self.approvalsTable) {
                    return Promise.resolve([]);
                  }
                  if (table === self.checkpointsTable) {
                    return Promise.resolve([]);
                  }
                  if (table === self.workflowRunNodesTable) {
                    return Promise.resolve([
                      { nodeId: "human-1", status: "succeeded", output: { humanInput: { approved: true } }, startedAt: new Date("2026-04-19T10:00:00Z"), completedAt: new Date("2026-04-19T10:01:00Z") },
                    ]);
                  }
                  return Promise.resolve([]);
                },
              };
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
  const handler = createResumeWorkflowHandler({
    db,
    pythonClient: {
      async resumeWorkflow(payload) {
        calls.push(payload);
        return { ok: true, data: { status: "completed", nodes: [] } };
      },
    },
    evaluateResumeEligibility: () => ({ ok: true }),
    validateResumeCheckpoint: () => ({ ok: true }),
    WorkflowResumeBody: { safeParse(payload) { return { success: true, data: payload }; } },
    getConfig: () => ({ defaultRunTimeoutMs: 1000 }),
    classifyError: (err) => ({ statusCode: 500, message: err?.message ?? String(err), code: "INTERNAL_ERROR", category: "internal_error" }),
    classifyCoreError: (err) => ({ statusCode: 500, message: err?.message ?? String(err), code: "CORE_ERROR", category: "core_error" }),
    logger: { error() {} },
  });

  const res = createMockResponse();
  await handler({ params: { id: "run-1" }, body: { completedNodes: [] } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].completedNodes.length, 1);
  assert.equal(calls[0].completedNodes[0].nodeId, "human-1");
  assert.deepEqual(calls[0].completedNodes[0].result, { humanInput: { approved: true } });
});


test("resume handler preserves blocked metadata and creates approval records when resume re-blocks on approval", async () => {
  const inserts = [];
  const updates = [];
  const db = {
    workflowRunsTable: {}, approvalsTable: {}, checkpointsTable: {}, workflowRunNodesTable: {},
    select() { const self = this; return { from(table) { return { where() { return { limit() {
      if (table === self.workflowRunsTable) return Promise.resolve([{ id: "run-2", status: "running", runtimeRequest: { workflowId: "wf", name: "WF", steps: [{ id: "approve" }] }, lastCheckpointId: null, resumableCheckpointId: null }]);
      if (table === self.approvalsTable) return Promise.resolve([]);
      if (table === self.checkpointsTable) return Promise.resolve([]);
      if (table === self.workflowRunNodesTable) return Promise.resolve([]);
      return Promise.resolve([]);
    } }; } }; } }; },
    update(table) { return { set(updateObj) { return { where() { updates.push({ table, updateObj }); return Promise.resolve(); } }; } }; },
    insert(table) { return { values(valueObj) { inserts.push({ table, valueObj }); return Promise.resolve(); } }; },
  };
  const handler = createResumeWorkflowHandler({
    db,
    pythonClient: { async resumeWorkflow() { return { ok: true, data: { status: "waiting_approval", nodes: [{ nodeId: "approve", name: "Approve", status: "waiting_approval", result: { reason: "Need review", metadata: { scope: "resume" } } }] } }; } },
    evaluateResumeEligibility: () => ({ ok: true }),
    validateResumeCheckpoint: () => ({ ok: true }),
    WorkflowResumeBody: { safeParse(payload) { return { success: true, data: payload }; } },
    getConfig: () => ({ defaultRunTimeoutMs: 1000 }),
    classifyError: (err) => ({ statusCode: 500, message: err?.message ?? String(err), code: "INTERNAL_ERROR", category: "internal_error" }),
    classifyCoreError: (err) => ({ statusCode: 500, message: err?.message ?? String(err), code: "CORE_ERROR", category: "core_error" }),
    logger: { error() {} },
  });

  const res = createMockResponse();
  await handler({ params: { id: "run-2" }, body: { completedNodes: [] } }, res);
  assert.equal(res.statusCode, 200);
  const runUpdate = updates.at(-1)?.updateObj;
  assert.equal(runUpdate.blockedNodeId, "approve");
  assert.equal(runUpdate.resumabilityReason, "pending_approval");
  assert.equal(runUpdate.approvalState, "pending");
  assert.equal(inserts.filter((entry) => entry.table === db.approvalsTable).length, 1);
});

test("runtime compiler source rejects unsupported executable node types beyond parallel", () => {
  assert.match(compilerSource, /node\.type === "parallel" \|\| node\.type === "memory-write" \|\| node\.type === "memory-query" \|\| node\.type === "compensation"/);
});


test("runtime compiler source carries handoff contracts and routing truth for agent nodes", () => {
  assert.match(compilerSource, /requiredCapabilities/);
  assert.match(compilerSource, /handoffContract/);
  assert.match(compilerSource, /missingCapabilities/);
  assert.match(compilerSource, /runtimeMode/);
  assert.match(compilerSource, /modelHint/);
  assert.match(compilerSource, /safeConstraintProfile/);
});
