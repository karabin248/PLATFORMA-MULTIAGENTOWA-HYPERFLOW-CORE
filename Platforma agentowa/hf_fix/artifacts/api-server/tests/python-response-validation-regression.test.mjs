import test from "node:test";
import assert from "node:assert/strict";

function stubFetch(payload, status = 200) {
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
    async text() { return JSON.stringify(payload); },
  });
}

test("runWorkflow rejects unknown workflow status from Python", async () => {
  stubFetch({ status: "unknown_new_status", nodes: [] });
  const { runWorkflow } = await import("../dist/lib/pythonClient.mjs");
  const result = await runWorkflow({ workflowId: "w1", steps: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CORE_INVALID_WORKFLOW_RESPONSE");
});

test("resumeWorkflow rejects waiting_approval node/run-status mismatch", async () => {
  stubFetch({
    status: "completed",
    nodes: [{ nodeId: "n1", status: "waiting_approval" }],
  });
  const { resumeWorkflow } = await import("../dist/lib/pythonClient.mjs");
  const result = await resumeWorkflow({ workflowId: "w1", runId: "r1", steps: [], completedNodes: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "CORE_INVALID_WORKFLOW_RESPONSE");
});

test("executor guards projection behind successful Python response", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../src/lib/workflowExecutor.ts", import.meta.url), "utf8");
  const guardIdx = src.indexOf("if (!coreResult.ok)");
  const projectionIdx = src.indexOf("await projectContinuationSnapshot(");
  assert.ok(guardIdx !== -1 && projectionIdx !== -1 && guardIdx < projectionIdx);
});
