import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routesIndex = fs.readFileSync(path.resolve(__dirname, "../src/routes/index.ts"), "utf8");
const workflowRoutes = fs.readFileSync(path.resolve(__dirname, "../src/routes/workflows.ts"), "utf8");
const approvalRoutes = fs.readFileSync(path.resolve(__dirname, "../src/routes/approvals.ts"), "utf8");
const pythonClient = fs.readFileSync(path.resolve(__dirname, "../src/lib/pythonClient.ts"), "utf8");
const dbIndex = fs.readFileSync(path.resolve(__dirname, "../../../lib/db/src/schema/index.ts"), "utf8");

test("workflow and approval routes are mounted behind auth in the TS shell", () => {
  assert.match(routesIndex, /router\.post\("\/workflows\/run", rateLimiter\("run"\)\)/);
  assert.match(routesIndex, /router\.post\("\/workflow-runs\/:id\/resume", rateLimiter\("run"\)\)/);
  assert.match(routesIndex, /router\.use\(workflowsRouter\)/);
  assert.match(routesIndex, /router\.use\(approvalsRouter\)/);
});

test("workflow surface delegates execution to the Python core instead of inventing a second runtime authority", () => {
  assert.match(workflowRoutes, /pythonClient\.runWorkflow/);
  assert.match(workflowRoutes, /pythonClient\.resumeWorkflow/);
  assert.match(pythonClient, /fetchCore\("\/v1\/workflow\/run"/);
  assert.match(pythonClient, /fetchCore\("\/v1\/workflow\/resume"/);
});

test("database schema now includes workflow, node, approval, and checkpoint persistence seams", () => {
  assert.match(dbIndex, /\.\/workflows/);
  assert.match(dbIndex, /\.\/workflowRuns/);
  assert.match(dbIndex, /\.\/workflowRunNodes/);
  assert.match(dbIndex, /\.\/approvals/);
  assert.match(dbIndex, /\.\/checkpoints/);
  assert.match(approvalRoutes, /workflowRunsTable/);
});
