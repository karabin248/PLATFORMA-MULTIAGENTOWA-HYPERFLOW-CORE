import test from "node:test";
import assert from "node:assert/strict";

// Import the JS wrappers to avoid requiring TypeScript at runtime. These
// wrappers mirror the logic of the TypeScript sources used by the API server.
import { evaluateResumeEligibility, executeResumeOrchestration } from "../src/lib/resumeEligibility.js";
import { validateResumeCheckpoint } from "../src/lib/resumeValidator.js";

/**
 * Helpers for creating stub pythonClient objects. Each test can override the
 * resumeWorkflow method to record calls and simulate core responses.
 */
function createPythonClientStub() {
  return {
    calls: [],
    resumeWorkflow: async function (request) {
      this.calls.push(request);
      // Default behaviour: return ok with empty response
      return { ok: true, data: { status: "completed", nodes: [] } };
    },
  };
}

test("evaluateResumeEligibility rejects terminal states", () => {
  const run = { status: "completed", approvalState: "none" };
  const result = evaluateResumeEligibility(run, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /terminal state/);
});

test("evaluateResumeEligibility rejects pending approvals", () => {
  const run = { status: "running", approvalState: "pending" };
  const result = evaluateResumeEligibility(run, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /approvals are pending/);
});

test("validateResumeCheckpoint detects foreign checkpoint", () => {
  const run = { id: "runA", lastCheckpointId: "chk-2", resumableCheckpointId: "chk-2" };
  const checkpoints = [{ id: "chk-2", runId: "runA" }];
  // Supply a checkpoint that does not belong to runA
  const result = validateResumeCheckpoint(run, "chk-3", checkpoints);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Checkpoint does not belong/);
});

test("executeResumeOrchestration rejects stale checkpoints", async () => {
  const run = {
    id: "runA",
    status: "running",
    approvalState: "none",
    runtimeRequest: { name: "Test" },
    lastCheckpointId: "chk-2",
    resumableCheckpointId: "chk-2",
  };
  const pythonClient = createPythonClientStub();
  // The run has last checkpoint chk-2; asking to resume from chk-1 should be considered stale
  // Each checkpoint row includes nodeId to reflect the translation to node boundary.
  const checkpoints = [
    { id: "chk-1", runId: "runA", nodeId: "node1" },
    { id: "chk-2", runId: "runA", nodeId: "node2" },
  ];
  const result = await executeResumeOrchestration({
    run,
    requestedCheckpointId: "chk-1",
    completedNodes: [],
    pendingApprovals: 0,
    checkpoints,
    pythonClient,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /latest resumable checkpoint/);
  // Ensure the python client was not called
  assert.equal(pythonClient.calls.length, 0);
});

test("executeResumeOrchestration rejects when runtimeRequest is missing", async () => {
  const run = {
    id: "runA",
    status: "running",
    approvalState: "none",
    runtimeRequest: null,
    lastCheckpointId: null,
    resumableCheckpointId: null,
  };
  const pythonClient = createPythonClientStub();
  const result = await executeResumeOrchestration({
    run,
    requestedCheckpointId: null,
    completedNodes: [],
    pendingApprovals: 0,
    checkpoints: [],
    pythonClient,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/);
  assert.equal(pythonClient.calls.length, 0);
});

test("executeResumeOrchestration rejects when approvals are pending", async () => {
  const run = {
    id: "runA",
    status: "running",
    approvalState: "none",
    runtimeRequest: { name: "Test" },
    lastCheckpointId: "chk-1",
    resumableCheckpointId: "chk-1",
  };
  const pythonClient = createPythonClientStub();
  const checkpoints = [{ id: "chk-1", runId: "runA" }];
  // Simulate one pending approval
  const result = await executeResumeOrchestration({
    run,
    requestedCheckpointId: "chk-1",
    completedNodes: [],
    pendingApprovals: 1,
    checkpoints,
    pythonClient,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /approvals are pending/);
  assert.equal(pythonClient.calls.length, 0);
});

test("executeResumeOrchestration invokes pythonClient on valid resume", async () => {
  const run = {
    id: "runA",
    status: "running",
    approvalState: "none",
    runtimeRequest: { name: "My Workflow", steps: [] },
    lastCheckpointId: "chk-2",
    resumableCheckpointId: "chk-2",
  };
  const pythonClient = createPythonClientStub();
  // Persisted checkpoint ID maps to node2.  The helper should forward nodeId 'node2'.
  const checkpoints = [{ id: "chk-2", runId: "runA", nodeId: "node2" }];
  const completedNodes = [
    { nodeId: "node1", name: "Node 1", result: { value: 1 }, startedAt: "2024-01-01T00:00:00Z", completedAt: "2024-01-01T00:00:01Z" },
  ];
  const result = await executeResumeOrchestration({
    run,
    requestedCheckpointId: "chk-2",
    completedNodes,
    pendingApprovals: 0,
    checkpoints,
    pythonClient,
  });
  assert.equal(result.ok, true);
  assert.equal(pythonClient.calls.length, 1);
  const requestUsed = pythonClient.calls[0];
  // The resume request should include the runId, completedNodes and checkpointId
  assert.equal(requestUsed.runId, run.id);
  assert.deepEqual(requestUsed.completedNodes, completedNodes);
  // The checkpointId forwarded should match the nodeId corresponding to the persisted checkpoint
  assert.equal(requestUsed.checkpointId, "node2");
});

test("executeResumeOrchestration surfaces core error", async () => {
  // Create a python client that fails
  const pythonClient = {
    calls: [],
    resumeWorkflow: async function (request) {
      this.calls.push(request);
      return { ok: false, error: { message: "Execution failed" } };
    },
  };
  const run = {
    id: "runA",
    status: "running",
    approvalState: "none",
    runtimeRequest: { name: "X", steps: [] },
    lastCheckpointId: "chk-1",
    resumableCheckpointId: "chk-1",
  };
  const checkpoints = [{ id: "chk-1", runId: "runA", nodeId: "node1" }];
  const result = await executeResumeOrchestration({
    run,
    requestedCheckpointId: "chk-1",
    completedNodes: [],
    pendingApprovals: 0,
    checkpoints,
    pythonClient,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Execution failed/);
  assert.equal(pythonClient.calls.length, 1);
  // The resume request forwarded should contain the nodeId of the persisted checkpoint
  assert.equal(pythonClient.calls[0].checkpointId, "node1");
});