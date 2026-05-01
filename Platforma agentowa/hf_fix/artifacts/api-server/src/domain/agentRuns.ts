import type { AgentRun, InsertAgentRun } from "@workspace/db";

export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentRunRecord = AgentRun;

export interface AgentRunRequest {
  agentId: string;
  input: Record<string, unknown>;
  context?: Record<string, unknown>;
  requestedBy?: string;
  correlationId?: string;
  runPolicy?: {
    timeoutMs?: number;
    maxRetries?: number;
    modelHint?: string;
  };
}

export interface AgentRunListQuery {
  agentId?: string;
  agentVersion?: string;
  status?: RunStatus;
  requestedBy?: string;
  from?: string;
  to?: string;
  hasError?: boolean;
  minQualityScore?: number;
  retryOf?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export type CreateAgentRunInput = InsertAgentRun;
