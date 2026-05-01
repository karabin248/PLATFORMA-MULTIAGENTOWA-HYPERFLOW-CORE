import type { Agent, InsertAgent } from "@workspace/db";

export type AgentStatus = "active" | "disabled" | "deprecated";

export type AgentSpec = Agent;

export interface AgentListQuery {
  status?: AgentStatus;
  role?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

export type CreateAgentInput = InsertAgent;
