import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const openapi = fs.readFileSync(path.resolve(__dirname, "../../../lib/api-spec/openapi.yaml"), "utf8");
const apiZod = fs.readFileSync(path.resolve(__dirname, "../../../lib/api-zod/src/generated/api.ts"), "utf8");

function between(source, start, end) {
  const s = source.indexOf(start);
  const e = source.indexOf(end, s + start.length);
  return s >= 0 && e >= 0 ? source.slice(s, e) : "";
}

test("OpenAPI health surface matches hardened runtime posture", () => {
  const healthz = between(openapi, "  /healthz:", "  /metrics:");
  const livez = between(openapi, "  /livez:", "  /readyz:");
  assert.ok(livez.includes("security: []"));
  assert.ok(!healthz.includes("security: []"));
  assert.match(openapi, /\/readyz:/);
  assert.match(openapi, /\/metrics:/);
});

test("OpenAPI and generated Zod schemas omit redacted AgentRun fields", () => {
  const agentRun = between(openapi, "    AgentRun:", "    AgentRunRequest:");
  assert.doesNotMatch(agentRun, /resolvedPrompt:/);
  assert.doesNotMatch(agentRun, /rawOutput:/);
  assert.doesNotMatch(agentRun, /correlationId:/);
  assert.doesNotMatch(apiZod, /resolvedPrompt: zod\.string\(\)\.nullish\(\)/);
  assert.doesNotMatch(apiZod, /rawOutput: zod\.object\(\{\}\)\.passthrough\(\)\.nullish\(\)/);
  assert.doesNotMatch(apiZod, /correlationId: zod\.string\(\)\.nullish\(\)/);
});
