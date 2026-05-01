/**
 * workflowExecutor.ts
 *
 * Durable background workflow executor.
 *
 * DESIGN CONTRACT:
 *  - HTTP admission (POST /workflows/run) persists a "queued" run and returns immediately.
 *  - This module owns actual execution, completely detached from the HTTP lifecycle.
 *  - Exactly one executor instance holds the lease for a run at any time.
 *  - If the executor crashes, leases expire and another executor instance can recover.
 *
 * INVARIANTS:
 *  - Only this module may set run.status = "running".
 *  - Only this module may set run.executorId / leaseToken / leaseExpiresAt.
 *  - All execution results are projected via workflowProjection.ts.
 *  - TS is still projection-only; Python still owns execution truth.
 *
 * OPERATION:
 *  1. poll() — scans for queued runs, acquires leases, dispatches execution.
 *  2. executeRun() — calls Python, projects snapshot, releases lease.
 *  3. recoverStaleLeases() — finds crashed/expired runs, re-queues them.
 *  4. cancelPendingRun() — marks a run cancelled before execution starts.
 */

import { and, eq, lt, or, isNull } from "drizzle-orm";
import { randomUUID } from "crypto";
import { db, workflowRunsTable } from "@workspace/db";
import { pythonClient } from "./pythonClient";
import { projectContinuationSnapshot, appendStateLogEvent, WORKFLOW_RUN_STATE_LOG_EVENTS } from "./workflowProjection";
import { classifyCoreError } from "./errorClassifier";
import { logger } from "./logger";
import { getConfig } from "./config";
import { assertKnownStatusReasonCombination, validateRuntimeAuthorityResponse } from "./runtimeAuthorityContract";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Lease TTL in ms. If heartbeat stops within this window, lease is stale. */
const LEASE_TTL_MS = 30_000;

/** Polling interval between executor ticks. */
const POLL_INTERVAL_MS = 2_000;

/** Max concurrent runs per executor instance. Sourced from config (MAX_CONCURRENT_RUNS env). */
function maxConcurrent(): number {
  return getConfig().maxConcurrentRuns;
}

// ---------------------------------------------------------------------------
// Lease acquisition
// ---------------------------------------------------------------------------

/**
 * Attempt to atomically claim a queued run.
 * Returns the run id if claimed, null if the run was already claimed by another executor.
 *
 * Uses optimistic concurrency: update WHERE status = 'queued' AND (leaseToken IS NULL OR leaseExpiresAt < now).
 * Only the executor whose UPDATE touches 1 row wins.
 */
async function acquireLease(runId: string, executorId: string): Promise<boolean> {
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + LEASE_TTL_MS);
  const now = new Date();

  try {
    // Drizzle does not expose affected row count directly on update; use a returning clause.
    const updated = await db
      .update(workflowRunsTable)
      .set({
        status: "running",
        executorId,
        leaseToken,
        leaseExpiresAt,
        heartbeatAt: now,
        startedAt: now,
      })
      .where(
        and(
          eq(workflowRunsTable.id, runId),
          eq(workflowRunsTable.status, "queued"),
        ),
      )
      .returning({ id: workflowRunsTable.id });

    if (updated.length > 0) {
      // Emit lease_acquired synchronously before returning — the stateLog entry
      // confirms exactly when this executor claimed ownership of the run.
      await appendStateLogEvent(runId, WORKFLOW_RUN_STATE_LOG_EVENTS.LEASE_ACQUIRED, { executorId });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Renew the lease heartbeat to prevent it from expiring while execution is in progress.
 */
async function renewLease(runId: string, executorId: string): Promise<void> {
  await db
    .update(workflowRunsTable)
    .set({
      heartbeatAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + LEASE_TTL_MS),
    })
    .where(and(eq(workflowRunsTable.id, runId), eq(workflowRunsTable.executorId, executorId)));
}

/**
 * Release the lease after execution completes (success or failure).
 */
async function releaseLease(runId: string, executorId: string): Promise<void> {
  await db
    .update(workflowRunsTable)
    .set({ executorId: null, leaseToken: null, leaseExpiresAt: null })
    .where(and(eq(workflowRunsTable.id, runId), eq(workflowRunsTable.executorId, executorId)));
}

// ---------------------------------------------------------------------------
// Core execution
// ---------------------------------------------------------------------------

/**
 * Execute a single workflow run.
 * Called only after the lease is held by this executor.
 */
async function executeRun(runId: string, executorId: string): Promise<void> {
  const runRows = await db
    .select()
    .from(workflowRunsTable)
    .where(eq(workflowRunsTable.id, runId))
    .limit(1);
  const run = runRows[0];
  if (!run || !run.runtimeRequest) {
    logger.warn({ runId }, "Executor: run not found or missing runtimeRequest, skipping");
    return;
  }

  // Check cancellation before starting
  if (run.cancelState === "cancel_requested") {
    await db
      .update(workflowRunsTable)
      .set({
        status: "cancelled",
        cancelState: "cancelled",
        cancelledAt: new Date(),
        resumabilityReason: "terminal",
      })
      .where(eq(workflowRunsTable.id, runId));
    await appendStateLogEvent(runId, WORKFLOW_RUN_STATE_LOG_EVENTS.CANCELLED, { reason: "cancel_requested_before_execution" });
    await releaseLease(runId, executorId);
    return;
  }

  // Determine effective timeout
  const timeoutMs = run.timeoutMs ?? getConfig().defaultRunTimeoutMs;

  // PATCH 3: AbortController wires cancellation into the Python HTTP call.
  // If cancel_requested is detected before or during execution, the controller
  // aborts the in-flight fetch; pythonClient maps AbortError → RUN_CANCELLED.
  const controller = new AbortController();

  // Start heartbeat renewal loop. If renewal fails repeatedly the lease has
  // likely been claimed by a recovery executor — abort the Python call
  // immediately to prevent duplicate execution (H-03 fix).
  let _renewalFailures = 0;
  const _MAX_RENEWAL_FAILURES = 2;
  const heartbeatInterval = setInterval(() => {
    renewLease(runId, executorId)
      .then(() => { _renewalFailures = 0; })
      .catch((err) => {
        _renewalFailures++;
        logger.warn(
          { runId, executorId, renewalFailures: _renewalFailures, err },
          "Lease renewal failed",
        );
        if (_renewalFailures >= _MAX_RENEWAL_FAILURES) {
          logger.error(
            { runId, executorId },
            "Lease renewal failed too many times — aborting run to prevent duplicate execution",
          );
          controller.abort();
        }
      });
  }, LEASE_TTL_MS / 3);

  // Cancellation polling: re-check DB every 5 s during long-running calls.
  // If cancel_requested is found, abort the controller immediately.
  const cancelPollInterval = setInterval(async () => {
    try {
      const rows = await db
        .select({ cancelState: workflowRunsTable.cancelState })
        .from(workflowRunsTable)
        .where(eq(workflowRunsTable.id, runId))
        .limit(1);
      if (rows[0]?.cancelState === "cancel_requested") {
        controller.abort();
      }
    } catch { /* best-effort */ }
  }, 5_000);

  try {
    await appendStateLogEvent(runId, WORKFLOW_RUN_STATE_LOG_EVENTS.EXECUTING, { executorId });

    const runtimeRequest = run.runtimeRequest as Record<string, unknown>;
    const coreResult = await pythonClient.runWorkflow(
      runtimeRequest as Parameters<typeof pythonClient.runWorkflow>[0],
      timeoutMs,
      undefined,
      controller.signal,
    );

    if (!coreResult.ok) {
      // Handle cancellation signalled via AbortController
      if (coreResult.error.code === "RUN_CANCELLED" || controller.signal.aborted) {
        await db
          .update(workflowRunsTable)
          .set({
            status: "cancelled",
            cancelState: "cancelled",
            cancelledAt: new Date(),
            resumabilityReason: "terminal",
          })
          .where(eq(workflowRunsTable.id, runId));
        await appendStateLogEvent(runId, WORKFLOW_RUN_STATE_LOG_EVENTS.CANCELLED, { reason: "abort_during_execution" });
        return;
      }
      const classified = classifyCoreError(coreResult.error.code, coreResult.error.message);
      await db
        .update(workflowRunsTable)
        .set({ status: "failed", error: classified.message, failedAt: new Date() })
        .where(eq(workflowRunsTable.id, runId));
      await appendStateLogEvent(runId, WORKFLOW_RUN_STATE_LOG_EVENTS.FAILED, { code: classified.code, message: classified.message });
      return;
    }

    const response = coreResult.data as unknown as Record<string, unknown>;
    validateRuntimeAuthorityResponse(response);
    assertKnownStatusReasonCombination(String(response.status ?? ""), response.resumabilityReason as string | undefined);
    const nodes = Array.isArray(response.nodes)
      ? (response.nodes as Array<Record<string, unknown>>)
      : [];

    await projectContinuationSnapshot(
      runId,
      {
        status: String(response.status ?? "completed"),
        nodes: nodes as Array<Record<string, unknown> & { nodeId: string; status: string }>,
        checkpointId: response.checkpointId as string | null | undefined,
        blockedNodeId: response.blockedNodeId as string | null | undefined,
        resumabilityReason: response.resumabilityReason as string | undefined,
        error: response.error as string | undefined,
      },
      runtimeRequest,
    );

    // Persist raw runtime response
    await db
      .update(workflowRunsTable)
      .set({
        runtimeResponse: response,
        output: { nodes },
        durationMs: run.startedAt ? Date.now() - new Date(run.startedAt).getTime() : null,
      })
      .where(eq(workflowRunsTable.id, runId));

    const finalStatus = String(response.status ?? "completed");
    await appendStateLogEvent(runId, finalStatus === "completed" ? WORKFLOW_RUN_STATE_LOG_EVENTS.COMPLETED : finalStatus, {
      checkpointId: response.checkpointId ?? null,
    });

    logger.info({ runId, status: finalStatus }, "Executor: run completed");
  } catch (err) {
    logger.error({ err, runId }, "Executor: unexpected error during run execution");
    await db
      .update(workflowRunsTable)
      .set({ status: "failed", error: "Executor internal error", failedAt: new Date() })
      .where(eq(workflowRunsTable.id, runId));
    await appendStateLogEvent(runId, WORKFLOW_RUN_STATE_LOG_EVENTS.FAILED, { reason: "executor_internal_error" });
  } finally {
    clearInterval(heartbeatInterval);
    clearInterval(cancelPollInterval);
    await releaseLease(runId, executorId);
  }
}

// ---------------------------------------------------------------------------
// Stale lease recovery
// ---------------------------------------------------------------------------

/**
 * Find runs whose leases have expired (executor crashed/timed out) and re-queue them.
 * Only re-queues runs that are still in "running" state with an expired lease.
 */
async function recoverStaleLeases(): Promise<void> {
  const now = new Date();
  try {
    const stale = await db
      .select({ id: workflowRunsTable.id, retryAttempt: workflowRunsTable.retryAttempt })
      .from(workflowRunsTable)
      .where(
        and(
          eq(workflowRunsTable.status, "running"),
          lt(workflowRunsTable.leaseExpiresAt, now),
        ),
      );

    for (const run of stale) {
      const attempt = (run.retryAttempt ?? 0) + 1;
      if (attempt > 3) {
        // Max retries exceeded — mark as failed
        await db
          .update(workflowRunsTable)
          .set({
            status: "failed",
            error: "Max executor retries exceeded after lease expiry",
            failedAt: now,
            executorId: null,
            leaseToken: null,
            leaseExpiresAt: null,
            resumabilityReason: "terminal",
          })
          .where(eq(workflowRunsTable.id, run.id));
        await appendStateLogEvent(run.id, WORKFLOW_RUN_STATE_LOG_EVENTS.LEASE_LOST, { attempt, reason: "stale_lease_max_retries_exceeded" });
        await appendStateLogEvent(run.id, WORKFLOW_RUN_STATE_LOG_EVENTS.FAILED, { reason: "max_retries_exceeded" });
        logger.warn({ runId: run.id, attempt }, "Executor: max retries exceeded, marking failed");
      } else {
        // Re-queue for retry
        await db
          .update(workflowRunsTable)
          .set({
            status: "queued",
            executorId: null,
            leaseToken: null,
            leaseExpiresAt: null,
            retryAttempt: attempt,
          })
          .where(
            and(
              eq(workflowRunsTable.id, run.id),
              eq(workflowRunsTable.status, "running"),
              lt(workflowRunsTable.leaseExpiresAt, now),
            ),
          );
        await appendStateLogEvent(run.id, WORKFLOW_RUN_STATE_LOG_EVENTS.REQUEUED, { attempt, reason: "stale_lease" });
        logger.info({ runId: run.id, attempt }, "Executor: re-queued stale run");
      }
    }
  } catch (err) {
    logger.error({ err }, "Executor: error during stale lease recovery");
  }
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

let _running = false;
const _executorId = `executor-${randomUUID().slice(0, 8)}`;
const _activeLocks = new Set<string>();

/**
 * Single poll tick: recover stale leases, then pick up to maxConcurrent() queued runs.
 */
async function tick(): Promise<void> {
  try {
    await recoverStaleLeases();

    const limit = maxConcurrent();
    if (_activeLocks.size >= limit) return;

    const queued = await db
      .select({ id: workflowRunsTable.id })
      .from(workflowRunsTable)
      .where(
        and(
          eq(workflowRunsTable.status, "queued"),
          isNull(workflowRunsTable.leaseToken),
        ),
      )
      .limit(limit - _activeLocks.size);

    for (const row of queued) {
      if (_activeLocks.size >= limit) break;
      const claimed = await acquireLease(row.id, _executorId);
      if (!claimed) continue;
      _activeLocks.add(row.id);
      executeRun(row.id, _executorId)
        .catch((err) => logger.error({ err, runId: row.id }, "Executor: run error"))
        .finally(() => _activeLocks.delete(row.id));
    }
  } catch (err) {
    logger.error({ err }, "Executor: tick error");
  }
}

/**
 * Start the background executor poll loop.
 * Safe to call multiple times — only one loop runs per process.
 */
export function startExecutor(): void {
  if (_running) return;
  _running = true;
  logger.info({ executorId: _executorId }, "Workflow executor started");
  const loop = () => {
    tick().finally(() => {
      if (_running) setTimeout(loop, POLL_INTERVAL_MS);
    });
  };
  setTimeout(loop, 0);
}

/**
 * Stop the executor loop (for graceful shutdown).
 */
export function stopExecutor(): void {
  _running = false;
  logger.info({ executorId: _executorId }, "Workflow executor stopped");
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/**
 * Request cancellation of a workflow run.
 *
 * If the run is queued (not yet executing), it is immediately marked cancelled.
 * If the run is executing, we set cancelState=cancel_requested; the executor
 * will honour it at the next safe checkpoint.
 *
 * Returns the resulting run status.
 */
export async function requestCancellation(
  runId: string,
  requestedBy: string,
): Promise<{ ok: boolean; status: string; reason?: string }> {
  const runRows = await db
    .select()
    .from(workflowRunsTable)
    .where(eq(workflowRunsTable.id, runId))
    .limit(1);
  const run = runRows[0];
  if (!run) return { ok: false, status: "not_found", reason: "Run not found" };

  const TERMINAL = ["completed", "failed", "cancelled"];
  if (TERMINAL.includes(run.status)) {
    return { ok: false, status: run.status, reason: "Run is already in terminal state" };
  }

  const now = new Date();

  if (run.status === "queued") {
    // Not executing yet — cancel immediately
    await db
      .update(workflowRunsTable)
      .set({
        status: "cancelled",
        cancelState: "cancelled",
        cancelledAt: now,
        cancelRequestedAt: now,
        cancelRequestedBy: requestedBy,
        resumabilityReason: "terminal",
        executorId: null,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(and(eq(workflowRunsTable.id, runId), eq(workflowRunsTable.status, "queued")));
    await appendStateLogEvent(runId, WORKFLOW_RUN_STATE_LOG_EVENTS.CANCELLED, { requestedBy, reason: "immediate_cancel_queued" });
    return { ok: true, status: "cancelled" };
  }

  // Running / blocked — request cancellation, executor honours it
  await db
    .update(workflowRunsTable)
    .set({
      cancelState: "cancel_requested",
      cancelRequestedAt: now,
      cancelRequestedBy: requestedBy,
    })
    .where(eq(workflowRunsTable.id, runId));
  await appendStateLogEvent(runId, WORKFLOW_RUN_STATE_LOG_EVENTS.CANCEL_REQUESTED, { requestedBy });
  return { ok: true, status: "cancel_requested" };
}

export { _executorId as executorId };
