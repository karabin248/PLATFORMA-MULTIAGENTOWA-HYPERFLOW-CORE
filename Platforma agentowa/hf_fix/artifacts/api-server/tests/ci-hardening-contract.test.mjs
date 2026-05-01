import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ghPy = fs.readFileSync(path.resolve(__dirname, "../../../.github/workflows/ci-python-core.yml"), "utf8");
const ghTs = fs.readFileSync(path.resolve(__dirname, "../../../.github/workflows/ci-ts-shell.yml"), "utf8");
const gl = fs.readFileSync(path.resolve(__dirname, "../../../.gitlab-ci.yml"), "utf8");

const runtimeAuthority = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../core/contracts/runtime-authority.json"), "utf8"));
const workflowProjection = fs.readFileSync(path.resolve(__dirname, "../src/lib/workflowProjection.ts"), "utf8");
const workflowExecutor = fs.readFileSync(path.resolve(__dirname, "../src/lib/workflowExecutor.ts"), "utf8");

const shaRef = /@[0-9a-f]{40}(?:\s|$)/;

test("GitHub workflows pin third-party actions by full SHA", () => {
  for (const source of [ghPy, ghTs]) {
    const usesLines = source.split(/\n/).filter((line) => line.includes("uses:"));
    assert.ok(usesLines.length > 0);
    for (const line of usesLines) {
      assert.match(line, shaRef);
    }
  }
});

test("CI no longer uses floating pnpm dlx or unpinned Python resolver installs", () => {
  assert.doesNotMatch(ghTs, /pnpm dlx @cyclonedx\/cyclonedx-npm\s/);
  assert.match(ghTs, /pnpm dlx @cyclonedx\/cyclonedx-npm@4\.2\.1/);
  assert.match(ghPy, /pip install -r requirements-ci\.txt/);
  assert.match(gl, /pip install -r requirements-ci\.txt/);
  assert.match(gl, /corepack prepare pnpm@9\.15\.4 --activate/);
});

test("runtime-authority schema status/reason matrix is synchronized with TS projection/executor", () => {
  const matrix = runtimeAuthority["x-statusReasonMatrix"];
  assert.ok(matrix && typeof matrix === "object");
  const statuses = Object.keys(matrix);
  for (const status of statuses) {
    assert.match(workflowProjection, new RegExp(status));
  }
  const serialized = JSON.stringify(matrix);
  assert.match(workflowProjection, /assertKnownStatusReasonCombination/);
  assert.match(workflowExecutor, /assertKnownStatusReasonCombination/);
  assert.ok(serialized.includes("pending_approval"));
});
