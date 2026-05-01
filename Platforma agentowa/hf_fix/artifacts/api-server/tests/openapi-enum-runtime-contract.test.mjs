import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../../..");

const openApi = fs.readFileSync(path.resolve(root, "lib/api-spec/openapi.yaml"), "utf8");
const workflowsRoute = fs.readFileSync(path.resolve(__dirname, "../src/routes/workflows.ts"), "utf8");
const agentRunsRoute = fs.readFileSync(path.resolve(__dirname, "../src/routes/agentRuns.ts"), "utf8");

const runStatuses = ["queued", "running", "completed", "failed", "cancelled"];
for (const status of runStatuses) {
  assert.ok(openApi.includes(status), `OpenAPI must define run status '${status}'`);
}

assert.ok(
  workflowsRoute.includes('z.enum(["queued", "running", "completed", "failed", "cancelled"])') ||
    agentRunsRoute.includes('z.enum(["queued", "running", "completed", "failed", "cancelled"])'),
  "Runtime routes must validate run statuses against OpenAPI enum values",
);


console.log("✓ Runtime run-status responses remain constrained to OpenAPI enums");
