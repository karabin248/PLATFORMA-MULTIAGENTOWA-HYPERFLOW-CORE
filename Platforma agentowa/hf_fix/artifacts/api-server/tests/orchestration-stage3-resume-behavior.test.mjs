import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve __dirname for ES modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dynamically import the resume validator and schemas
import { validateResumeCheckpoint } from "../src/lib/resumeValidator.js";

test("WorkflowResumeBody schema includes checkpointId field", () => {
  const schemaFile = fs.readFileSync(
    path.resolve(__dirname, "../src/lib/orchestrationSchemas.ts"),
    "utf8",
  );
  assert.match(schemaFile, /checkpointId/);
});

test("validateResumeCheckpoint allows latest checkpoint", () => {
  const run = { id: "run1", lastCheckpointId: "cp3", resumableCheckpointId: "cp3" };
  const checkpoints = [
    { id: "cp1", runId: "run1" },
    { id: "cp3", runId: "run1" },
  ];
  const res = validateResumeCheckpoint(run, "cp3", checkpoints);
  assert.deepEqual(res, { ok: true, checkpointId: "cp3" });
  // Without specifying checkpointId, it should default to last/resumable checkpoint
  const resDefault = validateResumeCheckpoint(run, undefined, checkpoints);
  assert.equal(resDefault.ok, true);
  assert.equal(resDefault.checkpointId, "cp3");
});

test("validateResumeCheckpoint rejects stale or foreign checkpoints", () => {
  const run = { id: "run1", lastCheckpointId: "cp3", resumableCheckpointId: "cp3" };
  const checkpoints = [
    { id: "cp1", runId: "run1" },
    { id: "cp3", runId: "run1" },
    { id: "cpX", runId: "run2" },
  ];
  // Stale candidate: older than lastCheckpointId
  const stale = validateResumeCheckpoint(run, "cp1", checkpoints);
  assert.equal(stale.ok, false);
  assert.match(stale.error ?? "", /latest/);
  // Foreign candidate: belongs to another run
  const foreign = validateResumeCheckpoint(run, "cpX", checkpoints);
  assert.equal(foreign.ok, false);
  assert.match(foreign.error ?? "", /belong/);
});

test("validateResumeCheckpoint rejects when no resumable checkpoint exists", () => {
  const run = { id: "run1", lastCheckpointId: null, resumableCheckpointId: null };
  const checkpoints = [];
  const res = validateResumeCheckpoint(run, undefined, checkpoints);
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /No resumable checkpoint/);
});

test("workflowRuns schema includes resumableCheckpointId column", () => {
  const schemaFile = fs.readFileSync(
    path.resolve(__dirname, "../../../lib/db/src/schema/workflowRuns.ts"),
    "utf8",
  );
  // verify the schema exports a resumable_checkpoint_id column
  assert.match(schemaFile, /resumableCheckpointId/);
  assert.match(schemaFile, /"resumable_checkpoint_id"/);
});