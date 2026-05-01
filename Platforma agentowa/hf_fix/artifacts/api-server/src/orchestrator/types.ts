export type RunState = "pending" | "running" | "completed" | "failed" | "cancelled";
export type NodeState = "pending" | "running" | "completed" | "failed" | "skipped";
export type LogSeverity = "debug" | "info" | "warn" | "error";
export type CheckpointStatus = "active" | "resumed" | "rolled_back" | "superseded";

export interface WorkflowStepDef {
  id: string;
  name: string;
  agentId: string;
  dependsOn: string[];
}

export interface WorkflowDef {
  workflowId: string;
  name: string;
  steps: WorkflowStepDef[];
}

export interface NodeRecord {
  nodeId: string;
  name: string;
  status: NodeState;
  startedAt: string | null;
  completedAt: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

export interface CheckpointRecord {
  id: string;
  runId: string;
  nodeId: string;
  nodeName: string;
  status: CheckpointStatus;
  savedAt: string;
  resumable: boolean;
}

export interface LogEvent {
  id: string;
  runId: string | null;
  correlationId: string;
  severity: LogSeverity;
  message: string;
  summary: string;
  context: Record<string, unknown>;
  timestamp: string;
}

export interface WorkflowRun {
  runId: string;
  workflowId: string | null;
  agentId: string | null;
  type: "workflow" | "agent" | "scan";
  name: string;
  status: RunState;
  progress: number;
  nodes: NodeRecord[];
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

