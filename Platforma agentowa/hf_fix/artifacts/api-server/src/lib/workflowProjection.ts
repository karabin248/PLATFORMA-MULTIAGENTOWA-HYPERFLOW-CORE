/**
 * workflowProjection.ts
 *
 * INVARIANT: This is the ONLY approved module that may write orchestration
 * truth fields into the database. All routes must call these functions instead
 * of issuing ad-hoc UPDATE statements against protected columns.
 *
 * PROTECTED FIELDS (may ONLY be written via this module):
 *   - workflowRunsTable.status
 *   - workflowRunsTable.blockedNodeId
 *   - workflowRunsTable.resumabilityReason
 *   - workflowRunsTable.lastCheckpointId
 *   - workflowRunsTable.resumableCheckpointId
 *   - workflowRunsTable.approvalState (when derived from execution)
 *   - workflowRunNodesTable.status
 *   - workflowRunNodesTable.output / error / completedAt / checkpointRef
 *   - checkpointsTable rows
 *
 * ALLOWED outside this module:
 *   - approval decision record writes (approvalsTable.status, decidedAt, actorId, note)
 *   - run admission writes (INSERT into workflowRunsTable, workflowRunNodesTable)
 *   - terminal rejection projection: status = "failed", approvalState = "rejected" (approval.ts only)
 */

import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  workflowRunsTable,
  workflowRunNodesTable,
  checkpointsTable,
  approvalsTable,
} from "@workspace/db";
import { logger } from "./logger";
import { assertKnownStatusReasonCombination } from "./runtimeAuthorityContract";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecutionNode {
  nodeId: string;
  name?: string;
  status: string;
  result?: Record<string, unknown> | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface ExecutionSnapshot {
  /** Python-returned run status */
  status: string;
  nodes: ExecutionNode[];
  /** Python's checkpoint boundary node id (may be a node id, not a UUID yet) */
  checkpointId?: string | null;
  blockedNodeId?: string | null;
  resumabilityReason?: string;
  error?: string;
}

export interface ProjectionResult {
  lastCheckpointId: string | null;
  resumabilityReason: string;
  blockedNodeId: string | null;
  approvalState: string;
  pendingApprovalNodeId: string | null;
  pendingHumanNodeId: string | null;
}

// ---------------------------------------------------------------------------
// Core projection function
// ---------------------------------------------------------------------------

/**
 * projectExecutionSnapshot
 *
 * Takes a Python-authored execution snapshot and projects it into the
 * database. This is the single approved write path for orchestration truth.
 *
 * @param runId  - the workflow run being updated
 * @param snapshot - authoritative snapshot returned by Python
 * @param tx - optional drizzle transaction; if omitted uses default db
 */
export async function projectExecutionSnapshot(
  runId: string,
  snapshot: ExecutionSnapshot,
  tx: typeof db = db,
): Promise<ProjectionResult> {
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  let lastCheckpointId: string | null = null;
  let pendingApprovalNodeId: string | null = null;
  let pendingHumanNodeId: string | null = null;

  for (const node of nodes) {
    const checkpointId = randomUUID();
    lastCheckpointId = checkpointId;
    const nodeStatus = String(node.status ?? "pending");

    if (nodeStatus === "waiting_approval" && !pendingApprovalNodeId) {
      pendingApprovalNodeId = String(node.nodeId);
    }
    if (nodeStatus === "waiting_input" && !pendingHumanNodeId) {
      pendingHumanNodeId = String(node.nodeId);
    }

    await tx
      .update(workflowRunNodesTable)
      .set({
        status: nodeStatus,
        output: (node.result as Record<string, unknown> | undefined) ?? null,
        startedAt: node.startedAt ? new Date(String(node.startedAt)) : null,
        completedAt: node.completedAt ? new Date(String(node.completedAt)) : null,
        error:
          typeof (node.result as Record<string, unknown> | undefined)?.error === "string"
            ? String((node.result as Record<string, unknown>).error)
            : null,
        checkpointRef: checkpointId,
      })
      .where(
        and(
          eq(workflowRunNodesTable.runId, runId),
          eq(workflowRunNodesTable.nodeId, String(node.nodeId)),
        ),
      );

    // Demote any prior active checkpoint for this (runId, nodeId) so the new
    // active row does not collide with the partial unique index
    // workflow_checkpoints_active_per_node_idx. History is preserved via
    // status='superseded' instead of deletion.
    await tx
      .update(checkpointsTable)
      .set({ status: "superseded" })
      .where(
        and(
          eq(checkpointsTable.runId, runId),
          eq(checkpointsTable.nodeId, String(node.nodeId)),
          eq(checkpointsTable.status, "active"),
        ),
      );

    await tx.insert(checkpointsTable).values({
      id: checkpointId,
      runId,
      nodeId: String(node.nodeId),
      nodeName: typeof (node as ExecutionNode & { name?: string }).name === "string"
        ? String((node as ExecutionNode & { name?: string }).name)
        : String(node.nodeId),  // fallback: nodeId is always unique and non-empty
      checkpointType: "workflow.node",
      state: {
        status: node.status ?? null,
        result: node.result ?? null,
        startedAt: node.startedAt ?? null,
        completedAt: node.completedAt ?? null,
      },
      memoryRefs: [],
      traceRefs: [],
    });
  }

  const runStatus = String(snapshot.status ?? "completed");
  assertKnownStatusReasonCombination(runStatus, snapshot.resumabilityReason ?? null);
  const approvalState = runStatus === "waiting_approval" ? "pending" : "none";
  const blockedNodeId = pendingApprovalNodeId ?? pendingHumanNodeId ?? null;
  const resumabilityReason = pendingApprovalNodeId
    ? "pending_approval"
    : pendingHumanNodeId
      ? "pending_human_input"
      : "none";

  await tx
    .update(workflowRunsTable)
    .set({
      status: runStatus,
      completedAt:
        runStatus === "completed" || runStatus === "failed" || runStatus === "cancelled"
          ? new Date()
          : null,
      lastCheckpointId,
      resumableCheckpointId: lastCheckpointId,
      blockedNodeId,
      resumabilityReason,
      approvalState,
      ...(snapshot.error ? { error: snapshot.error } : {}),
    })
    .where(eq(workflowRunsTable.id, runId));

  return {
    lastCheckpointId,
    resumabilityReason,
    blockedNodeId,
    approvalState,
    pendingApprovalNodeId,
    pendingHumanNodeId,
  };
}

/**
 * projectContinuationSnapshot
 *
 * Projects a Python continuation snapshot (approval or human-input) into DB.
 * Differs from projectExecutionSnapshot in that:
 *  - it additionally emits a waiting_approval row in approvalsTable if the
 *    continuation itself ended at a new approval boundary
 *  - it explicitly clears a prior blocking state before writing the new truth
 *
 * @param runId       - the workflow run
 * @param snapshot    - authoritative continuation response from Python
 * @param runtimeRequest - the stored runtimeRequest (used to re-create approval records)
 * @param tx          - optional drizzle transaction
 */
export async function projectContinuationSnapshot(
  runId: string,
  snapshot: ExecutionSnapshot,
  runtimeRequest: Record<string, unknown>,
  tx: typeof db = db,
): Promise<ProjectionResult> {
  const result = await projectExecutionSnapshot(runId, snapshot, tx);

  // If continuation ended at a new approval node, create the approval record
  if (result.pendingApprovalNodeId) {
    const newApprovalNodeId = result.pendingApprovalNodeId;
    const steps = Array.isArray(runtimeRequest?.steps)
      ? (runtimeRequest.steps as Array<Record<string, unknown>>)
      : [];
    const approvalStep = steps.find((s) => String(s.id) === newApprovalNodeId);
    const blockedNode = (snapshot.nodes ?? []).find(
      (n) => String(n.nodeId) === newApprovalNodeId,
    );
    const result2 = ((blockedNode?.result as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;

    await tx.insert(approvalsTable).values({
      id: randomUUID(),
      runId,
      nodeId: newApprovalNodeId,
      reason:
        typeof result2.reason === "string"
          ? result2.reason
          : typeof (approvalStep?.reason) === "string"
            ? (approvalStep.reason as string)
            : `Approval required for ${newApprovalNodeId}`,
      objective: typeof result2.objective === "string" ? result2.objective : null,
      metadata: (result2.metadata as Record<string, unknown> | undefined) ?? {},
      status: "pending",
    });
  }

  return result;
}

/**
 * projectTerminalRejection
 *
 * Specialized projection for approval rejection — the only case where TS
 * may write "failed" status without a Python execution response, because
 * rejection is a terminal state that requires no Python execution.
 */
export async function projectTerminalRejection(
  runId: string,
  tx: typeof db = db,
): Promise<void> {
  await tx
    .update(workflowRunsTable)
    .set({
      status: "failed",
      approvalState: "rejected",
      blockedNodeId: null,
      resumabilityReason: "terminal",
      failedAt: new Date(),
    })
    .where(eq(workflowRunsTable.id, runId));
}

// ---------------------------------------------------------------------------
// State log helper
// ---------------------------------------------------------------------------

/**
 * Append an event entry to the run's stateLog column.
 * This is the single approved path for timeline writes.
 *
 * ATOMICITY: Uses a single SQL UPDATE with a jsonb concatenation expression
 * (`stateLog || '[...]'::jsonb`) so the append is done atomically by
 * PostgreSQL — no SELECT→UPDATE round-trip, no lost-update race even if two
 * executor instances somehow call this concurrently.
 */
export async function appendStateLogEvent(
  runId: string,
  event: string,
  meta?: Record<string, unknown>,
  tx: typeof db = db,
): Promise<void> {
  const entry: { event: string; at: string; meta?: Record<string, unknown> } = {
    event,
    at: new Date().toISOString(),
    ...(meta ? { meta } : {}),
  };
  // Single atomic UPDATE: concatenate the new entry JSON onto the existing
  // jsonb array column. COALESCE handles the case where stateLog is NULL.
  await tx
    .update(workflowRunsTable)
    .set({
      stateLog: sql`COALESCE(${workflowRunsTable.stateLog}, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb`,
    })
    .where(eq(workflowRunsTable.id, runId));
}

/**
 * projectTimeout
 *
 * Finalize a run that has exceeded its execution timeout.
 * Sets status=failed with a timed_out terminal reason.
 */
export async function projectTimeout(
  runId: string,
  tx: typeof db = db,
): Promise<void> {
  const now = new Date();
  await tx
    .update(workflowRunsTable)
    .set({
      status: "failed",
      error: "Workflow execution timed out",
      failedAt: now,
      timedOutAt: now,
      resumabilityReason: "terminal",
      executorId: null,
      leaseToken: null,
      leaseExpiresAt: null,
    })
    .where(eq(workflowRunsTable.id, runId));
}

/**
 * projectCancellation
 *
 * Finalize a cancel_requested run as cancelled.
 * Called by the executor when it honours a cancellation request.
 */
export async function projectCancellation(
  runId: string,
  requestedBy?: string,
  tx: typeof db = db,
): Promise<void> {
  await tx
    .update(workflowRunsTable)
    .set({
      status: "cancelled",
      cancelState: "cancelled",
      cancelledAt: new Date(),
      resumabilityReason: "terminal",
      executorId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      ...(requestedBy ? { cancelRequestedBy: requestedBy } : {}),
    })
    .where(eq(workflowRunsTable.id, runId));
}


// ---------------------------------------------------------------------------
// Operator read model derivation
// ---------------------------------------------------------------------------

/**
 * TERMINAL_STATUSES — runs in these states cannot transition further.
 */
export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * BLOCKING_REASONS — reasons that indicate a run is blocked waiting for external action.
 */
export const BLOCKING_REASONS = new Set(["pending_approval", "pending_human_input"]);

export interface RunResumability {
  reason: string;
  blockedNodeId: string | null;
  canResume: boolean;
  requiresApprovalAction: boolean;
  requiresHumanInput: boolean;
}

/**
 * WORKFLOW_RUN_STATE_LOG_EVENTS
 *
 * Canonical set of event name strings for the stateLog append-only timeline.
 * Every call to appendStateLogEvent() MUST use one of these values as the
 * `event` argument. This ensures the operator panel and any downstream log
 * consumers can rely on a stable, finite vocabulary.
 *
 * INVARIANT: Never remove a value — old persisted stateLog rows still reference
 * it. Additions are backwards-compatible; removals are breaking.
 */
export const WORKFLOW_RUN_STATE_LOG_EVENTS = {
  // Lifecycle
  QUEUED:              "queued",
  EXECUTING:           "executing",
  COMPLETED:           "completed",
  FAILED:              "failed",
  CANCELLED:           "cancelled",
  REQUEUED:            "requeued",
  // Lease
  LEASE_ACQUIRED:      "lease_acquired",
  LEASE_RENEWED:       "lease_renewed",
  LEASE_LOST:          "lease_lost",
  // Pause points
  APPROVAL_WAITING:    "approval_waiting",
  HUMAN_INPUT_WAITING: "human_input_waiting",
  RESUME_REQUESTED:    "resume_requested",
  CANCEL_REQUESTED:    "cancel_requested",
  // Timeout
  TIMED_OUT:           "timed_out",
} as const;

export type WorkflowRunStateLogEvent =
  (typeof WORKFLOW_RUN_STATE_LOG_EVENTS)[keyof typeof WORKFLOW_RUN_STATE_LOG_EVENTS];

export interface RunOperatorSummary {
  status: string;
  blocked: boolean;
  blockType: string | null;
  requiresApprovalAction: boolean;
  requiresHumanInput: boolean;
  canResumeNow: boolean;
  currentBoundaryCheckpointId: string | null;
  isTerminal: boolean;
  cancelState: string | null;
  stateLog: Array<{ event: string; at: string; meta?: Record<string, unknown> }>;
  // ---------------------------------------------------------------------------
  // Executor / lease observability fields
  //
  // These fields allow the operator panel and debugging tools to observe which
  // executor holds a run, when its lease expires, the last heartbeat, and how
  // many retry attempts have occurred. All values are derived directly from the
  // persisted DB row — never synthesised by the TS layer.
  // ---------------------------------------------------------------------------
  /** Instance UUID of the executor currently holding this run's lease. Null if not running. */
  executorId: string | null;
  /** ISO-8601 timestamp after which the current lease is considered expired. */
  leaseExpiresAt: string | null;
  /** ISO-8601 timestamp of the most recent heartbeat from the holding executor. */
  heartbeatAt: string | null;
  /** Number of times this run has been requeued after a stale-lease recovery. */
  retryAttempt: number;
}

/**
 * deriveResumability
 *
 * Single approved derivation of resumability truth from a persisted run row.
 * Used by both list and detail views — no divergence.
 */
export function deriveResumability(run: {
  status: string;
  resumabilityReason?: string | null;
  blockedNodeId?: string | null;
}): RunResumability {
  const reason = run.resumabilityReason ?? "none";
  const blockedNodeId = run.blockedNodeId ?? null;
  const isTerminal = TERMINAL_STATUSES.has(run.status);
  const canResume = !isTerminal && reason === "none";
  return {
    reason,
    blockedNodeId,
    canResume,
    requiresApprovalAction: reason === "pending_approval",
    requiresHumanInput: reason === "pending_human_input",
  };
}

/**
 * deriveOperatorSummary
 *
 * Single approved derivation of the compact execution summary for list and detail views.
 * Never invents truth — all fields are derived from persisted, Python-authoritative state.
 *
 * The executor/lease fields (executorId, leaseExpiresAt, heartbeatAt, retryAttempt) allow
 * the operator panel and debugging tools to observe which executor holds a run, when its
 * lease expires, the last heartbeat time, and how many retry attempts have occurred —
 * enabling diagnosis of stuck or leaked runs without requiring direct DB access.
 */
export function deriveOperatorSummary(run: {
  status: string;
  resumabilityReason?: string | null;
  blockedNodeId?: string | null;
  lastCheckpointId?: string | null;
  cancelState?: string | null;
  stateLog?: Array<{ event: string; at: string; meta?: Record<string, unknown> }> | null;
  executorId?: string | null;
  leaseExpiresAt?: Date | string | null;
  heartbeatAt?: Date | string | null;
  retryAttempt?: number | null;
}): RunOperatorSummary {
  const res = deriveResumability(run);

  const toIsoOrNull = (v: Date | string | null | undefined): string | null => {
    if (!v) return null;
    return v instanceof Date ? v.toISOString() : String(v);
  };

  return {
    status: run.status,
    blocked: BLOCKING_REASONS.has(res.reason),
    blockType: BLOCKING_REASONS.has(res.reason) ? res.reason : null,
    requiresApprovalAction: res.requiresApprovalAction,
    requiresHumanInput: res.requiresHumanInput,
    canResumeNow: res.canResume,
    currentBoundaryCheckpointId: run.lastCheckpointId ?? null,
    isTerminal: TERMINAL_STATUSES.has(run.status),
    cancelState: run.cancelState ?? null,
    stateLog: Array.isArray(run.stateLog) ? run.stateLog : [],
    executorId: run.executorId ?? null,
    leaseExpiresAt: toIsoOrNull(run.leaseExpiresAt),
    heartbeatAt: toIsoOrNull(run.heartbeatAt),
    retryAttempt: run.retryAttempt ?? 0,
  };
}


// ---------------------------------------------------------------------------
// Race safety: optimistic status guard
// ---------------------------------------------------------------------------

/**
 * assertRunStatusFor
 *
 * Atomically verify that a run is still in the expected status before a
 * continuation write. If the run has moved to a different status (e.g. another
 * request won a race), returns an error string instead of proceeding.
 *
 * Usage: call before projectContinuationSnapshot in approval/human-input routes.
 * If the guard fails, return 409 Conflict to the caller.
 */
export async function assertRunStatusFor(
  runId: string,
  expectedStatuses: string[],
  tx: typeof db = db,
): Promise<{ ok: true } | { ok: false; reason: string; actualStatus: string }> {
  const rows = await tx
    .select({ status: workflowRunsTable.status })
    .from(workflowRunsTable)
    .where(eq(workflowRunsTable.id, runId))
    .limit(1);
  if (!rows[0]) return { ok: false, reason: "Run not found", actualStatus: "not_found" };
  const actual = rows[0].status;
  if (!expectedStatuses.includes(actual)) {
    return {
      ok: false,
      reason: `Run is in status '${actual}', expected one of: ${expectedStatuses.join(", ")}`,
      actualStatus: actual,
    };
  }
  return { ok: true };
}
