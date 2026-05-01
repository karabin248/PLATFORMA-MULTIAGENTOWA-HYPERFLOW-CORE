import { z } from "zod";
// @ts-ignore — companion JS module shared with the test runner (no build step)
import {
  EXECUTABLE_NODE_TYPES as _EXECUTABLE_NODE_TYPES,
  STORED_ONLY_NODE_TYPES as _STORED_ONLY_NODE_TYPES,
} from "./workflowNodeTypes.js";

// -----------------------------------------------------------------------------
// Workflow node type model — two-tier (definition vs runtime)
//
// The platform separates the *definition* schema (what an operator can author
// and persist) from the *runtime* schema (what the Python execution core can
// actually execute). The definition surface is intentionally larger than the
// runtime surface so that future features (parallel fan-out, memory ops,
// compensation chains) can be modelled and stored before they are executable.
//
// Two canonical sets keep the partition honest:
//   - EXECUTABLE_NODE_TYPES → mirrors ExecutableWorkflowNodeType. These types
//     are implemented end-to-end and reach the Python core.
//   - STORED_ONLY_NODE_TYPES → present in WorkflowNodeType but rejected at
//     compilation time by workflowCompilation.ts before any payload reaches
//     the runtime. Their schemas exist for definition-time validation only.
//
// Invariants (asserted in tests/workflow-node-type-partition.test.mjs):
//   1. EXECUTABLE_NODE_TYPES ∪ STORED_ONLY_NODE_TYPES === WorkflowNodeType
//   2. EXECUTABLE_NODE_TYPES ∩ STORED_ONLY_NODE_TYPES === ∅
//   3. EXECUTABLE_NODE_TYPES === ExecutableWorkflowNodeType enum values
//   4. Every value of ExecutableWorkflowNodeType has a corresponding member
//      schema in ExecutableWorkflowStepSchema's discriminated union.
//
// The arrays themselves live in workflowNodeTypes.js so the test runner can
// import them without a TS build step. To add a new executable type: update
// workflowNodeTypes.js, add a step schema below, add it to
// ExecutableWorkflowStepSchema's union, then implement the executor on the
// Python side. The partition test fails until all parts are aligned.
// -----------------------------------------------------------------------------

export const EXECUTABLE_NODE_TYPES = _EXECUTABLE_NODE_TYPES as readonly [
  "agent",
  "tool",
  "condition",
  "approval",
  "human",
  "join",
  "compensation",
];

export const STORED_ONLY_NODE_TYPES = _STORED_ONLY_NODE_TYPES as readonly [
  "parallel",
  "memory-write",
  "memory-query",
];

export type ExecutableNodeType = (typeof EXECUTABLE_NODE_TYPES)[number];
export type StoredOnlyNodeType = (typeof STORED_ONLY_NODE_TYPES)[number];

/** Full definition-time node type surface (executable + stored-only). */
export const WorkflowNodeType = z.enum([
  ...EXECUTABLE_NODE_TYPES,
  ...STORED_ONLY_NODE_TYPES,
]);

/** Subset of node types the Python runtime will accept and execute. */
export const ExecutableWorkflowNodeType = z.enum(EXECUTABLE_NODE_TYPES);

export const WorkflowNodeStatus = z.enum([
  "pending",
  "ready",
  "running",
  "blocked",
  "waiting_input",
  "waiting_approval",
  "succeeded",
  "failed_retryable",
  "failed_terminal",
  "compensated",
  "skipped",
]);

const JsonRecordSchema = z.record(z.string(), z.unknown());
const RetryPolicySchema = z.object({ maxAttempts: z.number().int().positive() }).optional();
const AgentRoutingPolicySchema = z.object({
  runtimeMode: z.string().optional(),
  modelHint: z.string().optional(),
  safeConstraintProfile: z.string().optional(),
}).partial();
const HandoffContractSchema = z.object({
  schemaVersion: z.string().default("1.0"),
  intent: z.string().min(1),
  targetHint: z.string().optional(),
  artifactKeys: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  successSignal: z.string().optional(),
});

export const WorkflowNodeSchema = z.object({
  id: z.string().min(1),
  type: WorkflowNodeType,
  name: z.string().min(1),
  config: JsonRecordSchema.optional(),
  inputSchema: JsonRecordSchema.optional(),
  outputSchema: JsonRecordSchema.optional(),
  retryPolicy: RetryPolicySchema,
  compensationNodeId: z.string().optional(),
});

export const WorkflowEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  condition: z.string().optional(),
});

export const WorkflowDefinitionSchema = z.object({
  id: z.string().min(3),
  version: z.string().default("1.0.0"),
  name: z.string().min(1),
  description: z.string().default(""),
  nodes: z.array(WorkflowNodeSchema),
  edges: z.array(WorkflowEdgeSchema),
  tags: z.array(z.string()).default([]),
  owner: z.string().nullable().optional(),
});

export const WorkflowRunBody = z.object({
  workflowId: z.string().min(1),
  workflowVersion: z.string().optional(),
  input: JsonRecordSchema.default({}),
  requestedBy: z.string().default("operator"),
  correlationId: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

export const CompletedWorkflowNodeSchema = z.object({
  nodeId: z.string(),
  name: z.string(),
  result: JsonRecordSchema.optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});

/**
 * Payload for resuming a workflow run. Clients may optionally provide a
 * checkpointId indicating which checkpoint to resume from. If omitted the
 * resumableCheckpointId stored on the run will be used. The completedNodes
 * array carries state for already-finished nodes to inform the Python core.
 */
export const WorkflowResumeBody = z.object({
  runId: z.string().min(1),
  checkpointId: z.string().optional(),
  completedNodes: z.array(CompletedWorkflowNodeSchema).default([]),
});

const ExecutableStepBaseSchema = z.object({
  id: z.string().min(1),
  type: ExecutableWorkflowNodeType,
  name: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  input: JsonRecordSchema.default({}),
  retryPolicy: RetryPolicySchema,
  inputSchema: JsonRecordSchema.optional(),
  outputSchema: JsonRecordSchema.optional(),
});

const AgentRefSchema = z.object({
  id: z.string().min(1),
  version: z.string().optional(),
  role: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  runPolicy: JsonRecordSchema.default({}),
});

export const ExecutableAgentStepSchema = ExecutableStepBaseSchema.extend({
  type: z.literal("agent"),
  prompt: z.string().min(1),
  agentRef: AgentRefSchema.optional(),
});

export const ExecutableToolStepSchema = ExecutableStepBaseSchema.extend({
  type: z.literal("tool"),
  action: z.string().min(1),
});

export const ExecutableConditionStepSchema = ExecutableStepBaseSchema.extend({
  type: z.literal("condition"),
  expression: z.string().min(1),
});

export const ExecutableApprovalStepSchema = ExecutableStepBaseSchema.extend({
  type: z.literal("approval"),
  reason: z.string().min(1),
  objective: z.string().optional(),
  metadata: JsonRecordSchema.default({}),
});

export const ExecutableHumanStepSchema = ExecutableStepBaseSchema.extend({
  type: z.literal("human"),
  instruction: z.string().min(1),
  expectedInputSchema: JsonRecordSchema.optional(),
});

export const ExecutableMemoryWriteStepSchema = ExecutableStepBaseSchema.extend({
  type: z.literal("memory-write"),
  key: z.string().min(1),
  value: z.unknown(),
});

export const ExecutableMemoryQueryStepSchema = ExecutableStepBaseSchema.extend({
  type: z.literal("memory-query"),
  key: z.string().optional(),
  query: z.string().optional(),
}).superRefine((value, ctx) => {
  if (!value.key && !value.query) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "memory-query step requires key or query" });
  }
});

export const ExecutableJoinStepSchema = ExecutableStepBaseSchema.extend({
  type: z.literal("join"),
  mergePolicy: z.string().default("all_active"),
});

export const ExecutableCompensationStepSchema = ExecutableStepBaseSchema.extend({
  type: z.literal("compensation"),
  targetNodeId: z.string().min(1),
  strategy: z.string().default("record"),
});

export const ExecutableWorkflowStepSchema = z.discriminatedUnion("type", [
  ExecutableAgentStepSchema,
  ExecutableToolStepSchema,
  ExecutableConditionStepSchema,
  ExecutableApprovalStepSchema,
  ExecutableHumanStepSchema,
  ExecutableJoinStepSchema,
  ExecutableCompensationStepSchema,
]);

export const ExecutableWorkflowEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  condition: z.string().optional(),
});

export const WorkflowRuntimeRequestSchema = z.object({
  workflowId: z.string().min(1),
  name: z.string().min(1),
  input: JsonRecordSchema.default({}),
  steps: z.array(ExecutableWorkflowStepSchema),
  edges: z.array(ExecutableWorkflowEdgeSchema).default([]),
});

export const HumanNodeInputBody = z.object({
  input: JsonRecordSchema,
  actorId: z.string().optional(),
});

export const ApprovalRequestBody = z.object({
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  reason: z.string().min(1),
  objective: z.string().optional(),
  metadata: JsonRecordSchema.default({}),
});

export const ApprovalDecisionBody = z.object({
  approved: z.boolean(),
  actorId: z.string().optional(),
  note: z.string().optional(),
});
