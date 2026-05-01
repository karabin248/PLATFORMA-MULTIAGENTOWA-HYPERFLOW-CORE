import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractPath = path.resolve(__dirname, "../../../core/contracts/runtime-authority.json");
const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));

function validateCombo(payload) {
  const matrix = contract["x-statusReasonMatrix"];
  const allowed = matrix[payload.status];
  if (!allowed) return false;
  return allowed.includes(payload.resumabilityReason ?? "none");
}

test("sample python workflow responses conform to status/reason matrix", () => {
  const samples = [
    { status: "completed", resumabilityReason: "none", nodes: [{ nodeId: "s1", status: "succeeded" }] },
    { status: "waiting_approval", resumabilityReason: "pending_approval", blockedNodeId: "approve", nodes: [{ nodeId: "approve", status: "waiting_approval" }] },
    { status: "waiting_input", resumabilityReason: "pending_human_input", blockedNodeId: "human", nodes: [{ nodeId: "human", status: "waiting_input" }] },
    { status: "cancelled", resumabilityReason: "terminal", nodes: [{ nodeId: "s1", status: "skipped" }] },
  ];

  for (const sample of samples) {
    assert.equal(validateCombo(sample), true, JSON.stringify(sample));
  }
});

test("unknown status/reason combinations are rejected", () => {
  assert.equal(validateCombo({ status: "completed", resumabilityReason: "pending_approval", nodes: [] }), false);
  assert.equal(validateCombo({ status: "waiting_approval", resumabilityReason: "none", nodes: [] }), false);
});
