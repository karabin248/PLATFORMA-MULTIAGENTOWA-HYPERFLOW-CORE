import { resolveAgent } from "../domain/catalog";
import { hydrateTemplate } from "./promptHydrator";
import { validateJsonSchema } from "./schemaValidator";
import {
  WorkflowRuntimeRequestSchema,
  EXECUTABLE_NODE_TYPES,
  STORED_ONLY_NODE_TYPES,
} from "./orchestrationSchemas";
import { getConfig } from "./config";

export class WorkflowCompilationError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly category: string;
  readonly details?: unknown;

  constructor(message: string, statusCode = 400, code = "WORKFLOW_COMPILATION_ERROR", category = "validation_error", details?: unknown) {
    super(message);
    this.name = "WorkflowCompilationError";
    this.statusCode = statusCode;
    this.code = code;
    this.category = category;
    this.details = details;
  }
}

type JsonRecord = Record<string, unknown>;

type PersistedWorkflowNode = {
  id: string;
  type: string;
  name?: string;
  config?: JsonRecord;
  inputSchema?: JsonRecord;
  outputSchema?: JsonRecord;
  retryPolicy?: { maxAttempts: number };
  compensationNodeId?: string;
};

type PersistedWorkflowEdge = { from: string; to: string; condition?: string };

type PersistedWorkflow = {
  id: string;
  name: string;
  definition?: {
    nodes?: PersistedWorkflowNode[];
    edges?: PersistedWorkflowEdge[];
  };
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function mergeInput(runInput: JsonRecord, nodeConfig: JsonRecord): JsonRecord {
  const explicitInput = asRecord(nodeConfig.input);
  return {
    ...runInput,
    ...explicitInput,
  };
}

function dependsOnFor(nodeId: string, edges: PersistedWorkflowEdge[]): string[] {
  return edges.filter((edge) => String(edge.to) === String(nodeId)).map((edge) => String(edge.from));
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mergeAgentRunPolicy(agentPolicy: JsonRecord, nodeConfig: JsonRecord): JsonRecord {
  const explicitPolicy = asRecord(nodeConfig.runPolicy);
  const merged = {
    ...agentPolicy,
    ...explicitPolicy,
  };
  for (const key of ["runtimeMode", "modelHint", "safeConstraintProfile"]) {
    if (typeof nodeConfig[key] === "string") {
      merged[key] = nodeConfig[key];
    }
  }
  return merged;
}

function normalizeHandoffContract(nodeConfig: JsonRecord): JsonRecord | undefined {
  const contract = asRecord(nodeConfig.handoffContract ?? nodeConfig.handoff);
  if (Object.keys(contract).length === 0) {
    return undefined;
  }
  return {
    schemaVersion: typeof contract.schemaVersion === "string" ? contract.schemaVersion : "1.0",
    intent: typeof contract.intent === "string" ? contract.intent : "node_result",
    ...(typeof contract.targetHint === "string" ? { targetHint: contract.targetHint } : {}),
    artifactKeys: asStringArray(contract.artifactKeys),
    openQuestions: asStringArray(contract.openQuestions),
    ...(typeof contract.successSignal === "string" ? { successSignal: contract.successSignal } : {}),
  };
}

/**
 * NODE TYPE TRUTH TABLE — see orchestrationSchemas.ts for the canonical sets.
 *
 * executable_now:    agent, tool, condition, approval, human, join
 * stored_only:       parallel, memory-write, memory-query, compensation
 *   - Stored-only types exist in the stored workflow model but are NOT
 *     executable by the runtime.
 *   - Workflows containing them are rejected at admission time below.
 *   - They must not appear in runtimeRequest payloads sent to Python.
 *
 * Any type not listed is unknown and is also rejected.
 */
const EXECUTABLE_NODE_TYPE_SET: ReadonlySet<string> = new Set(EXECUTABLE_NODE_TYPES);
const STORED_ONLY_NODE_TYPE_SET: ReadonlySet<string> = new Set(STORED_ONLY_NODE_TYPES);

function rejectUnsupportedType(node: PersistedWorkflowNode): never {
  const category = STORED_ONLY_NODE_TYPE_SET.has(node.type) ? "stored_only" : "unknown";
  throw new WorkflowCompilationError(
    `Workflow node type '${node.type}' is not executable by the runtime. ` +
    `Category: ${category}. Only these types are executable: ${[...EXECUTABLE_NODE_TYPE_SET].join(", ")}.`,
    400,
    "UNSUPPORTED_NODE_TYPE",
    "validation_error",
    { nodeId: node.id, type: node.type, category },
  );
}

/** Returns true if the given type is executable now. */
export function isExecutableNodeType(type: string): boolean {
  return EXECUTABLE_NODE_TYPE_SET.has(type);
}

/** Returns true if the given type is stored-only (not executable). */
export function isStoredOnlyNodeType(type: string): boolean {
  return STORED_ONLY_NODE_TYPE_SET.has(type);
}

export async function compileWorkflowRuntimeRequest(workflow: PersistedWorkflow, runInput: JsonRecord) {
  const nodes = Array.isArray(workflow.definition?.nodes) ? workflow.definition?.nodes ?? [] : [];
  const edges = Array.isArray(workflow.definition?.edges) ? workflow.definition?.edges ?? [] : [];

  // M-06 fix: hard caps on workflow complexity. Without these limits a caller
  // could submit a definition with hundreds of parallel steps, causing
  // asyncio.gather to fan out into hundreds of simultaneous LLM calls,
  // exhausting executor concurrency and driving runaway API cost.
  const config = getConfig();
  const maxSteps = config.maxWorkflowSteps ?? 50;
  const maxEdges = config.maxWorkflowEdges ?? 200;
  if (nodes.length > maxSteps) {
    throw new WorkflowCompilationError(
      `Workflow definition exceeds the maximum step count (${nodes.length} > ${maxSteps})`,
      422,
      "WORKFLOW_TOO_COMPLEX",
      "validation_error",
      { stepCount: nodes.length, maxSteps },
    );
  }
  if (edges.length > maxEdges) {
    throw new WorkflowCompilationError(
      `Workflow definition exceeds the maximum edge count (${edges.length} > ${maxEdges})`,
      422,
      "WORKFLOW_TOO_COMPLEX",
      "validation_error",
      { edgeCount: edges.length, maxEdges },
    );
  }

  const compiledSteps = [];

  for (const node of nodes) {
    const config = asRecord(node.config);
    const input = mergeInput(runInput, config);
    const common = {
      id: String(node.id),
      type: String(node.type),
      name: String(node.name ?? node.id),
      dependsOn: dependsOnFor(String(node.id), edges),
      input,
      retryPolicy: node.retryPolicy,
      inputSchema: node.inputSchema,
      outputSchema: node.outputSchema,
    };

    if (!EXECUTABLE_NODE_TYPE_SET.has(node.type)) {
      // Catches both stored_only types (parallel, memory-write, etc.) and truly unknown types.
      rejectUnsupportedType(node);
    }

    if (node.type === "agent") {
      const agentId = typeof config.agentId === "string" ? config.agentId : typeof config.agentRef === "string" ? config.agentRef : undefined;
      const agent = agentId ? await resolveAgent(agentId) : null;
      if (agent && agent.status !== "active") {
        throw new WorkflowCompilationError(`Agent '${agent.id}' is ${agent.status}`, 409, "CONFLICT", "conflict", { nodeId: node.id, agentId: agent.id });
      }
      const mergedInput = input;
      const requiredCapabilities = asStringArray(config.requiredCapabilities ?? config.capabilitiesRequired);
      if (requiredCapabilities.length > 0 && agent?.capabilities) {
        const missing = requiredCapabilities.filter((cap) => !agent.capabilities.includes(cap));
        if (missing.length > 0) {
          throw new WorkflowCompilationError(
            `Agent '${agent.id}' is missing required capabilities for node '${node.id}'`,
            400,
            "VALIDATION_ERROR",
            "validation_error",
            { nodeId: node.id, agentId: agent.id, missingCapabilities: missing },
          );
        }
      }
      if (agent?.inputSchema && Object.keys(asRecord(agent.inputSchema)).length > 0) {
        const check = validateJsonSchema(asRecord(agent.inputSchema), mergedInput);
        if (!check.valid) {
          throw new WorkflowCompilationError(
            `Input schema validation failed for workflow agent node '${node.id}'`,
            400,
            "VALIDATION_ERROR",
            "validation_error",
            check.errors,
          );
        }
      }
      const promptTemplate = typeof config.promptTemplate === "string"
        ? config.promptTemplate
        : agent?.promptTemplate || (typeof config.prompt === "string" ? config.prompt : "{{input.prompt}}");
      const resolvedPrompt = hydrateTemplate(promptTemplate, mergedInput);
      if (!resolvedPrompt.trim()) {
        throw new WorkflowCompilationError(`Agent node '${node.id}' produced an empty prompt`, 400, "VALIDATION_ERROR", "validation_error");
      }
      // M-4: enforce promptMaxLength — prevents unbounded prompts from
      // reaching the Python execution core and exhausting model context windows.
      // Limit is configurable via PROMPT_MAX_LENGTH env var (default: 50 000).
      const maxPromptLength = getConfig().promptMaxLength;
      if (resolvedPrompt.length > maxPromptLength) {
        throw new WorkflowCompilationError(
          `Step '${node.id}' prompt length ${resolvedPrompt.length} exceeds limit ${maxPromptLength}`,
          400,
          "PROMPT_TOO_LONG",
          "validation_error",
          { nodeId: node.id, promptLength: resolvedPrompt.length, limit: maxPromptLength },
        );
      }
      const mergedRunPolicy = mergeAgentRunPolicy(asRecord(agent?.executionPolicy), config);
      compiledSteps.push({
        ...common,
        type: "agent",
        prompt: resolvedPrompt,
        requiredCapabilities,
        handoffContract: normalizeHandoffContract(config),
        agentRef: agent
          ? {
              id: agent.id,
              version: agent.version,
              role: agent.role,
              capabilities: agent.capabilities ?? [],
              runPolicy: mergedRunPolicy,
            }
          : Object.keys(mergedRunPolicy).length > 0
            ? { id: agentId ?? String(node.id), runPolicy: mergedRunPolicy }
            : undefined,
      });
      continue;
    }

    if (node.type === "tool") {
      const action = typeof config.action === "string" ? config.action : typeof config.toolAction === "string" ? config.toolAction : undefined;
      if (!action) {
        throw new WorkflowCompilationError(`Tool node '${node.id}' requires config.action`, 400, "VALIDATION_ERROR", "validation_error");
      }
      compiledSteps.push({ ...common, type: "tool", action });
      continue;
    }

    if (node.type === "condition") {
      const expression = typeof config.expression === "string" ? config.expression : typeof config.condition === "string" ? config.condition : undefined;
      if (!expression) {
        throw new WorkflowCompilationError(`Condition node '${node.id}' requires config.expression`, 400, "VALIDATION_ERROR", "validation_error");
      }
      compiledSteps.push({ ...common, type: "condition", expression });
      continue;
    }

    if (node.type === "approval") {
      const reason = typeof config.reason === "string" ? config.reason : `Approval required for ${node.name ?? node.id}`;
      compiledSteps.push({
        ...common,
        type: "approval",
        reason,
        objective: typeof config.objective === "string" ? config.objective : undefined,
        metadata: asRecord(config.metadata),
      });
      continue;
    }

    if (node.type === "human") {
      const instruction = typeof config.instruction === "string" ? config.instruction : typeof config.prompt === "string" ? config.prompt : `Human input required for ${node.name ?? node.id}`;
      compiledSteps.push({
        ...common,
        type: "human",
        instruction,
        expectedInputSchema: asRecord(config.expectedInputSchema),
      });
      continue;
    }

    if (node.type === "join") {
      compiledSteps.push({ ...common, type: "join", mergePolicy: typeof config.mergePolicy === "string" ? config.mergePolicy : "all_active" });
      continue;
    }

    if (node.type === "compensation") {
      const targetNodeId = typeof config.targetNodeId === "string" ? config.targetNodeId : undefined;
      if (!targetNodeId) {
        throw new WorkflowCompilationError(
          `Compensation node '${node.id}' requires config.targetNodeId`,
          400,
          "VALIDATION_ERROR",
          "validation_error",
          { nodeId: node.id },
        );
      }
      compiledSteps.push({
        ...common,
        type: "compensation",
        targetNodeId,
        strategy: typeof config.strategy === "string" ? config.strategy : "record",
      });
      continue;
    }

    rejectUnsupportedType(node);
  }

  const compiled = {
    workflowId: workflow.id,
    name: workflow.name,
    input: runInput,
    steps: compiledSteps,
    edges: edges.map((edge) => ({ from: String(edge.from), to: String(edge.to), ...(edge.condition ? { condition: String(edge.condition) } : {}) })),
  };

  return WorkflowRuntimeRequestSchema.parse(compiled);
}
