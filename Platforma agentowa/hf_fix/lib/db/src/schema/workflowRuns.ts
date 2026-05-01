import { pgTable, text, timestamp, jsonb, integer, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workflowsTable } from "./workflows";

/**
 * EXECUTION STATUS ENUM
 *
 * Canonical set of valid workflow run status values. Used both as a DB-level
 * check constraint (enforced by PostgreSQL on every write) and as a
 * compile-time type guard in application code.
 *
 * INVARIANT: Never add a value here without also updating:
 *   - runLifecycle.ts         (transition table)
 *   - workflowProjection.ts   (TERMINAL_STATUSES / BLOCKING_REASONS sets)
 *   - The OpenAPI spec         (run status enum)
 */
export const WORKFLOW_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "waiting_approval",
  "waiting_input",
  "cancelled",
] as const;

export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const workflowRunsTable = pgTable("workflow_runs", {
  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------
  id: text("id").primaryKey(),
  workflowId: text("workflow_id").notNull().references(() => workflowsTable.id),
  workflowVersion: text("workflow_version").notNull(),

  // -------------------------------------------------------------------------
  // Execution status
  // Constrained at the DB level via the check constraint below — invalid values
  // are rejected by PostgreSQL on INSERT / UPDATE, not just at the ORM layer.
  // -------------------------------------------------------------------------
  status: text("status").notNull().default("queued"),

  // -------------------------------------------------------------------------
  // Payload
  // -------------------------------------------------------------------------
  input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
  runtimeRequest: jsonb("runtime_request").$type<Record<string, unknown>>(),
  runtimeResponse: jsonb("runtime_response").$type<Record<string, unknown>>(),
  output: jsonb("output").$type<Record<string, unknown>>(),
  error: text("error"),

  // -------------------------------------------------------------------------
  // Orchestration metadata
  // -------------------------------------------------------------------------
  checkpointStrategy: text("checkpoint_strategy").default("externalized"),
  approvalState: text("approval_state").default("none"),
  requestedBy: text("requested_by").default("operator"),
  correlationId: text("correlation_id"),
  idempotencyKey: text("idempotency_key"),
  parentRunId: text("parent_run_id"),
  originRunId: text("origin_run_id"),

  // -------------------------------------------------------------------------
  // Timestamps
  // -------------------------------------------------------------------------
  queuedAt: timestamp("queued_at"),
  admittedAt: timestamp("admitted_at"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  failedAt: timestamp("failed_at"),
  cancelledAt: timestamp("cancelled_at"),
  durationMs: integer("duration_ms"),

  // -------------------------------------------------------------------------
  // Checkpoint / resumability metadata
  // Python-authoritative — written exclusively via workflowProjection.ts.
  // -------------------------------------------------------------------------

  /**
   * Most recent checkpoint created for this run. Surfaces resumability context
   * to the operator panel and external callers.
   */
  lastCheckpointId: text("last_checkpoint_id"),

  /**
   * Checkpoint from which this run should resume on the next /resume call.
   * Set by Python at the end of each run or resume cycle.
   */
  resumableCheckpointId: text("resumable_checkpoint_id"),

  /**
   * Node identifier blocking progress (e.g., pending approval). Null when no
   * specific node is blocking.
   */
  blockedNodeId: text("blocked_node_id"),

  /**
   * Machine-readable reason describing why a run is not currently resumable.
   * Values: "none" | "pending_approval" | "pending_human_input" | "terminal" | "invalid_checkpoint"
   */
  resumabilityReason: text("resumability_reason").notNull().default("none"),

  createdAt: timestamp("created_at").defaultNow().notNull(),

  // -------------------------------------------------------------------------
  // Execution lease fields
  //
  // Used by the background workflow executor (workflowExecutor.ts) to claim
  // exclusive ownership of a queued run, detect stale/crashed executors, and
  // enable safe retry. These fields are ONLY written by:
  //   - acquireLease()          — sets executorId/leaseToken/leaseExpiresAt/heartbeatAt
  //   - renewLease()            — updates heartbeatAt/leaseExpiresAt
  //   - releaseLease()          — nulls executorId/leaseToken/leaseExpiresAt
  //   - projectCancellation()   — nulls lease fields on terminal cancel transition
  //   - projectTimeout()        — nulls lease fields on terminal timeout transition
  //
  // INVARIANT: No other code path may write these fields.
  // -------------------------------------------------------------------------

  /** Instance UUID of the executor that currently holds this run's lease. */
  executorId: text("executor_id"),

  /** Opaque token generated per-lease-acquisition; detects stale claims. */
  leaseToken: text("lease_token"),

  /** Absolute timestamp after which the lease is considered expired. */
  leaseExpiresAt: timestamp("lease_expires_at"),

  /** Timestamp of the most recent heartbeat renewal from the holding executor. */
  heartbeatAt: timestamp("heartbeat_at"),

  /** Number of times this run has been requeued after a stale-lease recovery. */
  retryAttempt: integer("retry_attempt").default(0),

  // -------------------------------------------------------------------------
  // Cancellation state
  // -------------------------------------------------------------------------

  /**
   * Tracks the lifecycle of a cancellation request:
   *   "cancel_requested"  — operator requested cancellation; executor must honour it
   *   "cancelling"        — executor is actively winding down
   *   "cancelled"         — terminal; run has been cancelled
   * Null when no cancellation has been requested.
   */
  cancelState: text("cancel_state"),

  /** When the cancellation was requested. */
  cancelRequestedAt: timestamp("cancel_requested_at"),

  /** Identity of the actor who requested cancellation. */
  cancelRequestedBy: text("cancel_requested_by"),

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  /** Per-run execution timeout in milliseconds. Null → use global default. */
  timeoutMs: integer("timeout_ms"),

  /** Set when the run is terminated due to exceeding timeoutMs. */
  timedOutAt: timestamp("timed_out_at"),

  // -------------------------------------------------------------------------
  // State transition event log
  //
  // Append-only JSON array of { event, at, meta? } entries maintained
  // exclusively by appendStateLogEvent() in workflowProjection.ts.
  // Provides an auditable timeline of every significant state transition.
  //
  // Canonical event names are defined in WORKFLOW_RUN_STATE_LOG_EVENTS
  // (exported from workflowProjection.ts).
  // -------------------------------------------------------------------------
  stateLog: jsonb("state_log")
    .$type<Array<{ event: string; at: string; meta?: Record<string, unknown> }>>()
    .default([]),

}, (table) => ([
  uniqueIndex("workflow_runs_idempotency_key_idx").on(table.idempotencyKey),

  /**
   * DB-level status guard. Rejects any INSERT or UPDATE that sets status to a
   * value outside the canonical WORKFLOW_RUN_STATUSES set. This converts invalid
   * status transitions into a hard PostgreSQL error rather than a silent
   * application-layer inconsistency. Add new valid statuses to
   * WORKFLOW_RUN_STATUSES above and update this constraint in the same migration.
   */
  check(
    "workflow_run_status_chk",
    sql`${table.status} IN ('queued','running','completed','failed','waiting_approval','waiting_input','cancelled')`,
  ),
]));

export type WorkflowRun = typeof workflowRunsTable.$inferSelect;
export type InsertWorkflowRun = typeof workflowRunsTable.$inferInsert;
