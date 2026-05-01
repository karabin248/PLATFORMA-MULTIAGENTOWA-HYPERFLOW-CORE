import { db, agentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { CreateAgentInput } from "./agents";

const SEED_AGENTS: CreateAgentInput[] = [
  {
    id: "agent-general-assistant",
    name: "General Assistant",
    version: "1.0.0",
    description: "General-purpose assistant that handles diverse prompts through the full EDDE pipeline",
    status: "active",
    role: "assistant",
    capabilities: ["natural_language", "analysis", "generation", "explanation"],
    runtimeMode: "standard",
    promptTemplate: "{{input.prompt}}",
    executionPolicy: { timeoutMs: 30000, maxRetries: 1 },
    tags: ["general", "default"],
    owner: "system",
  },
  {
    id: "agent-code-analyst",
    name: "Code Analyst",
    version: "1.0.0",
    description: "Specialized agent for code analysis, review, and transformation tasks",
    status: "active",
    role: "analyst",
    capabilities: ["code_analysis", "code_review", "transformation"],
    runtimeMode: "standard",
    promptTemplate: "Analyze the following code or repository:\n\n{{input.prompt}}",
    executionPolicy: { timeoutMs: 60000, maxRetries: 2 },
    tags: ["code", "analysis"],
    owner: "system",
  },
  {
    id: "agent-planner",
    name: "Planning Agent",
    version: "1.0.0",
    description: "Agent specialized in planning, decomposition, and workflow generation",
    status: "active",
    role: "planner",
    capabilities: ["planning", "decomposition", "workflow_generation"],
    runtimeMode: "standard",
    promptTemplate: "Create a plan for:\n\n{{input.prompt}}",
    executionPolicy: { timeoutMs: 45000, maxRetries: 1 },
    tags: ["planning", "workflow"],
    owner: "system",
  },
];

export async function seedAgents(): Promise<{ seeded: number; skipped: number }> {
  let seeded = 0;
  let skipped = 0;

  for (const agent of SEED_AGENTS) {
    const existing = await db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, agent.id))
      .limit(1);

    if (existing.length > 0) {
      skipped++;
      continue;
    }

    await db.insert(agentsTable).values(agent);
    seeded++;
  }

  return { seeded, skipped };
}

export async function resolveAgent(agentId: string) {
  const rows = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.id, agentId))
    .limit(1);

  return rows[0] ?? null;
}

export { SEED_AGENTS };
