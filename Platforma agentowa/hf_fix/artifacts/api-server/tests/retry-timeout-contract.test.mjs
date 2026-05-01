import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const routeSource = fs.readFileSync(path.resolve(__dirname, "../src/routes/agentRuns.ts"), "utf8");

test("retry timeout is derived from the immutable admitted run policy", () => {
  assert.match(routeSource, /const timeoutMs = admittedTimeoutMsFromPolicy\(immutableRuntimeRequest\.run_policy, getConfig\(\)\.defaultRunTimeoutMs\)/);
  assert.match(routeSource, /function buildAdmittedRunPolicy/);
  assert.match(routeSource, /timeoutMs: admittedTimeoutMsFromPolicy\(merged, defaultTimeoutMs\)/);
});
