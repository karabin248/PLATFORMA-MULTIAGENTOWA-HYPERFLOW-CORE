import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve __dirname for ES modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("runLifecycle includes waiting_approval status and transitions", () => {
  const lifecycle = fs.readFileSync(path.resolve(__dirname, "../src/lib/runLifecycle.ts"), "utf8");
  // ensure the waiting_approval status is declared in the RunStatus union
  assert.match(lifecycle, /\"waiting_approval\"/);
  // ensure the valid transitions include waiting_approval from queued and running
  assert.match(lifecycle, /queued:\s*\[\s*\"running\",\s*\"waiting_approval\"/);
  assert.match(lifecycle, /running:\s*\[\s*\"waiting_approval\"/);
  assert.match(lifecycle, /waiting_approval:\s*\[/);
});

test("checkpoints route is mounted in the router index", () => {
  const index = fs.readFileSync(path.resolve(__dirname, "../src/routes/index.ts"), "utf8");
  // The checkpoints router should be imported and used
  assert.match(index, /import checkpointsRouter from \"\.\/checkpoints\"/);
  assert.match(index, /router\.use\(checkpointsRouter\)/);
});

test("approvals route supports runId filtering", () => {
  const approvals = fs.readFileSync(path.resolve(__dirname, "../src/routes/approvals.ts"), "utf8");
  // The query parameter runId should be referenced when listing approvals
  assert.match(approvals, /req\.query\.runId/);
  // ensure eq(.. approvalsTable.runId ..) is used somewhere to filter
  assert.match(approvals, /approvalsTable\.runId/);
});