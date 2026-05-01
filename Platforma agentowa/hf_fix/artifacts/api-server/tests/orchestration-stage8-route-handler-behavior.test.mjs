import test from "node:test";
import assert from "node:assert/strict";

// Import the JS wrappers for the resume helpers.  These wrappers mirror the
// TypeScript implementations used by the API server but are directly
// executable in the Node test environment.
import { evaluateResumeEligibility, executeResumeOrchestration } from "../src/lib/resumeEligibility.js";
import { validateResumeCheckpoint } from "../src/lib/resumeValidator.js";

/**
 * Helper to create a stubbed pythonClient.  The object records calls to
 * resumeWorkflow and returns a configurable result.  Tests can override the
 * resumeWorkflow method to simulate core failures or exceptions.
 */
function createPythonClientStub(result = { ok: true, data: { status: "running", nodes: [] } }) {
  return {
    calls: [],
    async resumeWorkflow(request) {
      this.calls.push(request);
      // If result is a function, invoke it to compute the return value; otherwise return as is.
      if (typeof result === "function") {
        return await result(request);
      }
      return result;
    },
  };
}

test("terminal run rejection prevents pythonClient invocation", async () => {
  const pythonClient = createPythonClientStub();
  const run = {
    id: "runA",
    status: "completed", // terminal status
    approvalState: "none",
    runtimeRequest: { name: "Test" },
    lastCheckpointId: "chk-1",
    resumableCheckpointId: "chk-1",
  };
  const checkpoints = [ { id: "chk-1", runId: "runA", nodeId: "node1" } ];
  const result = await executeResumeOrchestration({
    run,
    requestedCheckpointId: undefined,
    completedNodes: [],
    pendingApprovals: 0,
    checkpoints,
    pythonClient,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /terminal state/);
  assert.equal(pythonClient.calls.length, 0);
});

test("pending approvals block resume and pythonClient is not invoked", async () => {
  const pythonClient = createPythonClientStub();
  const run = {
    id: "runA",
    status: "running",
    approvalState: "none",
    runtimeRequest: { name: "Test" },
    lastCheckpointId: "chk-1",
    resumableCheckpointId: "chk-1",
  };
  const checkpoints = [ { id: "chk-1", runId: "runA", nodeId: "node1" } ];
  // Simulate one pending approval by passing pendingApprovals > 0
  const result = await executeResumeOrchestration({
    run,
    requestedCheckpointId: undefined,
    completedNodes: [],
    pendingApprovals: 1,
    checkpoints,
    pythonClient,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /approvals are pending/);
  assert.equal(pythonClient.calls.length, 0);
});

test("foreign checkpoint rejection prevents pythonClient invocation", async () => {
  const pythonClient = createPythonClientStub();
  const run = {
    id: "runA",
    status: "running",
    approvalState: "none",
    runtimeRequest: { name: "Test" },
    lastCheckpointId: "chk-2",
    resumableCheckpointId: "chk-2",
  };
  // Only checkpoint chk-2 belongs to this run; chk-3 is foreign
  const checkpoints = [ { id: "chk-2", runId: "runA", nodeId: "node2" } ];
  const result = await executeResumeOrchestration({
    run,
    requestedCheckpointId: "chk-3", // foreign
    completedNodes: [],
    pendingApprovals: 0,
    checkpoints,
    pythonClient,
  });
  assert.equal(result.ok, false);
  // The error message from validateResumeCheckpoint should mention "belong"
  assert.match(result.error ?? "", /belong/);
  assert.equal(pythonClient.calls.length, 0);
});

test("stale checkpoint rejection prevents pythonClient invocation", async () => {
  const pythonClient = createPythonClientStub();
  const run = {
    id: "runA",
    status: "running",
    approvalState: "none",
    runtimeRequest: { name: "Test" },
    lastCheckpointId: "chk-3",
    resumableCheckpointId: "chk-3",
  };
  // Provide two checkpoints: chk-1 (stale) and chk-3 (latest)
  const checkpoints = [
    { id: "chk-1", runId: "runA", nodeId: "node1" },
    { id: "chk-3", runId: "runA", nodeId: "node3" },
  ];
  const result = await executeResumeOrchestration({
    run,
    requestedCheckpointId: "chk-1", // stale
    completedNodes: [],
    pendingApprovals: 0,
    checkpoints,
    pythonClient,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /latest/);
  assert.equal(pythonClient.calls.length, 0);
});

test("valid checkpoint UUID translates to nodeId and forwards to pythonClient", async () => {
  const run = {
    id: "runA",
    status: "running",
    approvalState: "none",
    runtimeRequest: { name: "Test" },
    lastCheckpointId: "chk-2",
    resumableCheckpointId: "chk-2",
  };
  // The persisted checkpoint maps to node2
  const checkpoints = [ { id: "chk-2", runId: "runA", nodeId: "node2" } ];
  const pythonClient = createPythonClientStub();
  const result = await executeResumeOrchestration({
    run,
    requestedCheckpointId: "chk-2",
    completedNodes: [],
    pendingApprovals: 0,
    checkpoints,
    pythonClient,
  });
  assert.equal(result.ok, true);
  assert.equal(pythonClient.calls.length, 1);
  const forwarded = pythonClient.calls[0];
  assert.equal(forwarded.checkpointId, "node2");
});

test("missing nodeId mapping omits checkpointId on forwarded request", async () => {
  const run = {
    id: "runA",
    status: "running",
    approvalState: "none",
    runtimeRequest: { name: "Test" },
    lastCheckpointId: "chk-2",
    resumableCheckpointId: "chk-2",
  };
  // The checkpoint exists but lacks a nodeId, so translation fails
  const checkpoints = [ { id: "chk-2", runId: "runA", nodeId: null } ];
  const pythonClient = createPythonClientStub();
  const result = await executeResumeOrchestration({
    run,
    requestedCheckpointId: "chk-2",
    completedNodes: [],
    pendingApprovals: 0,
    checkpoints,
    pythonClient,
  });
  assert.equal(result.ok, true);
  assert.equal(pythonClient.calls.length, 1);
  const forwarded = pythonClient.calls[0];
  // No checkpointId field should be present
  assert.ok(!Object.prototype.hasOwnProperty.call(forwarded, "checkpointId"));
});

test("pythonClient error surfaces through route helper", async () => {
  // Simulate an error returned by the core
  const pythonClient = createPythonClientStub({ ok: false, error: { message: "Core failure" } });
  const run = {
    id: "runA",
    status: "running",
    approvalState: "none",
    runtimeRequest: { name: "Test" },
    lastCheckpointId: "chk-2",
    resumableCheckpointId: "chk-2",
  };
  const checkpoints = [ { id: "chk-2", runId: "runA", nodeId: "node2" } ];
  const result = await executeResumeOrchestration({
    run,
    requestedCheckpointId: "chk-2",
    completedNodes: [],
    pendingApprovals: 0,
    checkpoints,
    pythonClient,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Core failure/);
  assert.equal(pythonClient.calls.length, 1);
});

test("pythonClient exception surfaces through route helper", async () => {
  const pythonClient = createPythonClientStub(async () => { throw new Error("Unexpected failure"); });
  const run = {
    id: "runA",
    status: "running",
    approvalState: "none",
    runtimeRequest: { name: "Test" },
    lastCheckpointId: "chk-2",
    resumableCheckpointId: "chk-2",
  };
  const checkpoints = [ { id: "chk-2", runId: "runA", nodeId: "node2" } ];
  const result = await executeResumeOrchestration({
    run,
    requestedCheckpointId: "chk-2",
    completedNodes: [],
    pendingApprovals: 0,
    checkpoints,
    pythonClient,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Unexpected failure/);
  assert.equal(pythonClient.calls.length, 1);
});