import type { Workflow, WorkflowRun } from "@workspace/db";

export type WorkflowStatus = "active" | "disabled" | "deprecated";
export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled";

// TS is projection-only for orchestration truth.
// Python is the sole execution authority for status transitions.
// TS may only persist status values returned from Python-owned execution events.

export type WorkflowSpec = Workflow;
export type WorkflowRunRecord = WorkflowRun;
