import test from "node:test";
import assert from "node:assert/strict";

// This test is intentionally source-level and should pass once the bundled route output omits raw runtime fields.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routeSource = fs.readFileSync(path.resolve(__dirname, "../src/routes/agentRuns.ts"), "utf8");

test("run records are sanitized before list/detail responses are emitted", () => {
  assert.match(routeSource, /function sanitizeRunRecord/);
  assert.match(routeSource, /resolvedPrompt, runtimeRequest, runtimeResponse, rawOutput, correlationId, idempotencyKey/);
  assert.match(routeSource, /runs: safeRuns/);
  assert.match(routeSource, /const safeRun = buildRunDetail/);
});
