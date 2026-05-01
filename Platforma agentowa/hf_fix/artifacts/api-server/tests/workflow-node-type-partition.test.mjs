import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXECUTABLE_NODE_TYPES,
  STORED_ONLY_NODE_TYPES,
} from "../src/lib/workflowNodeTypes.js";

// -----------------------------------------------------------------------------
// Workflow node type partition contract
//
// The platform deliberately splits node types into two tiers:
//   - Definition-time (WorkflowNodeType in orchestrationSchemas.ts):
//     everything an operator may author and persist.
//   - Runtime (ExecutableWorkflowNodeType / ExecutableWorkflowStepSchema):
//     everything the Python core can actually execute.
//
// Stored-only types (parallel, memory-write, memory-query) live in the
// definition tier but are rejected at compile time by workflowCompilation.ts
// before any payload reaches Python.
//
// compensation was previously stored-only but has been promoted to executable
// because the Python runtime (workflow/contracts.py + workflow/executors.py)
// fully implements it end-to-end. The TS admission path now compiles and
// forwards compensation nodes to the Python core.
//
// This test pins the partition so future drift between the SSOT arrays in
// workflowNodeTypes.js, the zod enums and discriminated union in
// orchestrationSchemas.ts, the rejection logic in workflowCompilation.ts,
// and the Python-side normalizer in hyperflow-core/workflow/contracts.py
// is caught immediately.
// -----------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const orchestrationSchemasSrc = fs.readFileSync(
  path.resolve(__dirname, "../src/lib/orchestrationSchemas.ts"),
  "utf8",
);
const workflowCompilationSrc = fs.readFileSync(
  path.resolve(__dirname, "../src/lib/workflowCompilation.ts"),
  "utf8",
);
const pythonContractsSrc = fs.readFileSync(
  path.resolve(__dirname, "../../hyperflow-core/workflow/contracts.py"),
  "utf8",
);

test("EXECUTABLE_NODE_TYPES ∩ STORED_ONLY_NODE_TYPES === ∅", () => {
  const exec = new Set(EXECUTABLE_NODE_TYPES);
  const overlap = STORED_ONLY_NODE_TYPES.filter((t) => exec.has(t));
  assert.deepEqual(
    overlap,
    [],
    `executable and stored-only sets overlap on: ${overlap.join(", ")}`,
  );
});

test("EXECUTABLE_NODE_TYPES has the documented seven runtime types", () => {
  assert.deepEqual(
    [...EXECUTABLE_NODE_TYPES].sort(),
    ["agent", "approval", "compensation", "condition", "human", "join", "tool"],
    "EXECUTABLE_NODE_TYPES drifted from the documented runtime surface — " +
      "if intentional, also update the schema, compiler and Python contracts",
  );
});

test("STORED_ONLY_NODE_TYPES has the documented three definition-only types", () => {
  assert.deepEqual(
    [...STORED_ONLY_NODE_TYPES].sort(),
    ["memory-query", "memory-write", "parallel"],
    "STORED_ONLY_NODE_TYPES drifted from the documented set — " +
      "if intentional, also update the schema and Python normalizer",
  );
});

test("orchestrationSchemas.ts imports the SSOT and uses both arrays", () => {
  // The TS schema layer must source the partition from workflowNodeTypes.js,
  // not redeclare the strings inline. This is what makes the partition a
  // single source of truth across TS schema and tests.
  assert.match(
    orchestrationSchemasSrc,
    /from\s+["']\.\/workflowNodeTypes\.js["']/,
    "orchestrationSchemas.ts must import node type SSOT from workflowNodeTypes.js",
  );
  assert.match(
    orchestrationSchemasSrc,
    /WorkflowNodeType\s*=\s*z\.enum\(\[[\s\S]*EXECUTABLE_NODE_TYPES[\s\S]*STORED_ONLY_NODE_TYPES[\s\S]*\]\)/,
    "WorkflowNodeType must be built as the union of EXECUTABLE and STORED_ONLY arrays",
  );
  assert.match(
    orchestrationSchemasSrc,
    /ExecutableWorkflowNodeType\s*=\s*z\.enum\(EXECUTABLE_NODE_TYPES\)/,
    "ExecutableWorkflowNodeType must be built directly from EXECUTABLE_NODE_TYPES",
  );
});

test("workflowCompilation.ts rejects stored-only node types using the SSOT", () => {
  assert.match(
    workflowCompilationSrc,
    /from\s+["']\.\/orchestrationSchemas["']/,
    "workflowCompilation.ts must import the SSOT arrays via orchestrationSchemas",
  );
  // Sanity: the runtime rejection logic mentions the stored_only category.
  assert.match(
    workflowCompilationSrc,
    /stored_only/,
    "workflowCompilation.ts must classify stored-only types in error details",
  );
});

test("Python contracts.py rejects the same stored-only type set", () => {
  // The Python normalizer in contracts.py must reject the same set of
  // stored-only types so neither side can accidentally execute them.
  for (const t of STORED_ONLY_NODE_TYPES) {
    const escaped = t.replace(/[-]/g, "[-]");
    const re = new RegExp(`["']${escaped}["']`);
    assert.match(
      pythonContractsSrc,
      re,
      `hyperflow-core/workflow/contracts.py must mention stored-only type '${t}' ` +
        `(it must be rejected by _normalize_step_payload to keep the partition aligned across runtimes)`,
    );
  }
  // The rejection branch itself must explicitly list each stored-only type.
  // We assert per-type membership in the same _normalize_step_payload set
  // literal so a reorder does not break the test (avoiding a brittle
  // sequence-based regex), but a removal still fails it.
  const rejectionBlockMatch = pythonContractsSrc.match(
    /if\s+step_type\s+in\s+\{([^}]+)\}\s*:\s*\n\s*raise\s+ValueError/,
  );
  assert.ok(
    rejectionBlockMatch,
    "contracts.py must contain the stored-only rejection set literal " +
      "in _normalize_step_payload (pattern: `if step_type in { ... }: raise ValueError`)",
  );
  const rejectionSetSrc = rejectionBlockMatch[1];
  for (const t of STORED_ONLY_NODE_TYPES) {
    assert.ok(
      rejectionSetSrc.includes(`"${t}"`) || rejectionSetSrc.includes(`'${t}'`),
      `contracts.py rejection set is missing stored-only type '${t}'. ` +
        `Found set body: {${rejectionSetSrc.trim()}}`,
    );
  }
});
