import test from "node:test";
import assert from "node:assert/strict";

// Import the JS wrappers to avoid requiring TypeScript at runtime. These
// wrappers mirror the logic of the TypeScript sources used by the API server.
import { executeResumeOrchestration } from "../src/lib/resumeEligibility.js";

/**
 * Create a stubbed pythonClient. Each invocation of resumeWorkflow will
 * record the request and return a successful response by default. Tests
 * can override this behaviour by defining a custom resumeWorkflow on the
 * returned object.
 */
function createPythonClientStub() {
  return {
    calls: [],
    async resumeWorkflow(request) {
      this.calls.push(request);
      return { ok: true, data: { status: "running", nodes: [] } };
    },
  };
}

test("executeResumeOrchestration forwards boundary nodeId when persisted checkpoint exists", async () => {
  const run = {
    id: "runA",
    status: "running",
    approvalState: "none",
    runtimeRequest: { name: "Test" },
    lastCheckpointId: "chk-2",
    resumableCheckpointId: "chk-2",
  };
  const pythonClient = createPythonClientStub();
  // Persisted checkpoint rows include nodeId mappings.  The helper should
  // translate the candidate checkpoint UUID (chk-2) into nodeId 'node2'.
  const checkpoints = [
    { id: "chk-1", runId: "runA", nodeId: "node1" },
    { id: "chk-2", runId: "runA", nodeId: "node2" },
  ];
  const result = await executeResumeOrchestration({
    run,
    requestedCheckpointId: undefined,
    completedNodes: [],
    pendingApprovals: 0,
    checkpoints,
    pythonClient,
  });
  assert.equal(result.ok, true);
  assert.equal(pythonClient.calls.length, 1);
  const forwarded = pythonClient.calls[0];
  // Should forward the nodeId associated with the persisted checkpoint
  assert.equal(forwarded.checkpointId, "node2");
});

test("executeResumeOrchestration omits checkpointId when no nodeId mapping", async () => {
  const run = {
    id: "runA",
    status: "running",
    approvalState: "none",
    runtimeRequest: { name: "Test" },
    lastCheckpointId: "chk-2",
    resumableCheckpointId: "chk-2",
  };
  const pythonClient = createPythonClientStub();
  // The checkpoint row lacks a nodeId; translation should fail and omit the
  // checkpointId from the forwarded request.
  const checkpoints = [
    { id: "chk-2", runId: "runA", nodeId: null },
  ];
  const result = await executeResumeOrchestration({
    run,
    requestedCheckpointId: undefined,
    completedNodes: [],
    pendingApprovals: 0,
    checkpoints,
    pythonClient,
  });
  assert.equal(result.ok, true);
  assert.equal(pythonClient.calls.length, 1);
  const forwarded = pythonClient.calls[0];
  // There should be no checkpointId on the forwarded request
  assert.ok(!Object.prototype.hasOwnProperty.call(forwarded, "checkpointId"));
});