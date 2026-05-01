/**
 * orchestrator/storage.ts — DEPRECATED
 *
 * This module operated on the legacy `runs` / `run_nodes` / `log_events` schema
 * (orchestrator/types.ts). All live workflow execution now uses:
 *   - workflowRunsTable        (workflow_runs)
 *   - workflowRunNodesTable    (workflow_run_nodes)
 *   - checkpointsTable         (workflow_checkpoints)
 * written exclusively via workflowProjection.ts.
 *
 * The Storage class below is DEAD CODE — it is no longer imported by any
 * production route. It is preserved here only for historical reference and to
 * avoid breaking any external forks that may import it.
 *
 * DO NOT add new writes via this class. Use workflowProjection.ts instead.
 */

// Re-export nothing. Callers that import { storage } from "./orchestrator/storage"
// will get a compile error, which is the desired outcome — migrate them to
// workflowProjection.ts.
export {};

import { eq, desc, and, sql } from "drizzle-orm";
import type {
  WorkflowRun,
  NodeRecord,
  LogEvent,
  CheckpointRecord,
} from "./types";

export class Storage {
  async saveRun(run: WorkflowRun): Promise<void> {
    await db
      .insert(runsTable)
      .values({
        runId: run.runId,
        workflowId: run.workflowId,
        agentId: run.agentId,
        type: run.type,
        name: run.name,
        status: run.status,
        progress: run.progress,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        errorMessage: run.errorMessage,
      })
      .onConflictDoUpdate({
        target: runsTable.runId,
        set: {
          status: sql`excluded.status`,
          progress: sql`excluded.progress`,
          completedAt: sql`excluded.completed_at`,
          errorMessage: sql`excluded.error_message`,
        },
      });
  }

  async updateRun(
    runId: string,
    updates: Partial<Pick<WorkflowRun, "status" | "progress" | "completedAt" | "errorMessage">>,
  ): Promise<void> {
    await db.update(runsTable).set(updates).where(eq(runsTable.runId, runId));
  }

  async saveNodes(runId: string, nodes: NodeRecord[]): Promise<void> {
    if (nodes.length === 0) return;

    await db.delete(runNodesTable).where(eq(runNodesTable.runId, runId));

    await db.insert(runNodesTable).values(
      nodes.map((n) => ({
        runId,
        nodeId: n.nodeId,
        name: n.name,
        status: n.status,
        startedAt: n.startedAt,
        completedAt: n.completedAt,
        result: n.result ?? null,
        error: n.error ?? null,
      })),
    );
  }

  async saveLog(event: LogEvent): Promise<void> {
    await db
      .insert(logEventsTable)
      .values({
        id: event.id,
        runId: event.runId,
        correlationId: event.correlationId,
        severity: event.severity,
        message: event.message,
        summary: event.summary,
        context: event.context,
        timestamp: event.timestamp,
      })
      .onConflictDoNothing();
  }

  async saveCheckpoint(cp: CheckpointRecord): Promise<void> {
    await db
      .insert(checkpointsTable)
      .values({
        id: cp.id,
        runId: cp.runId,
        nodeId: cp.nodeId,
        nodeName: cp.nodeName,
        status: cp.status,
        savedAt: new Date(cp.savedAt),
        resumable: cp.resumable,
      })
      .onConflictDoNothing();
  }

  async listRuns(opts: { limit?: number; status?: string } = {}): Promise<WorkflowRun[]> {
    const conditions = [];
    if (opts.status) {
      conditions.push(eq(runsTable.status, opts.status as any));
    }

    const rows = await db
      .select()
      .from(runsTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(runsTable.createdAt))
      .limit(opts.limit ?? 20);

    const result: WorkflowRun[] = [];
    for (const row of rows) {
      const nodeRows = await db
        .select()
        .from(runNodesTable)
        .where(eq(runNodesTable.runId, row.runId));

      result.push({
        runId: row.runId,
        workflowId: row.workflowId,
        agentId: row.agentId,
        type: row.type,
        name: row.name,
        status: row.status,
        progress: row.progress,
        nodes: nodeRows.map((n) => ({
          nodeId: n.nodeId,
          name: n.name,
          status: n.status,
          startedAt: n.startedAt,
          completedAt: n.completedAt,
          result: n.result as Record<string, unknown> | null,
          error: n.error,
        })),
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        errorMessage: row.errorMessage,
      });
    }

    return result;
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const rows = await db
      .select()
      .from(runsTable)
      .where(eq(runsTable.runId, runId))
      .limit(1);

    if (rows.length === 0) return null;
    const row = rows[0];

    const nodeRows = await db
      .select()
      .from(runNodesTable)
      .where(eq(runNodesTable.runId, runId));

    return {
      runId: row.runId,
      workflowId: row.workflowId,
      agentId: row.agentId,
      type: row.type,
      name: row.name,
      status: row.status,
      progress: row.progress,
      nodes: nodeRows.map((n) => ({
        nodeId: n.nodeId,
        name: n.name,
        status: n.status,
        startedAt: n.startedAt,
        completedAt: n.completedAt,
        result: n.result as Record<string, unknown> | null,
        error: n.error,
      })),
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      errorMessage: row.errorMessage,
    };
  }

  async listLogs(
    opts: { limit?: number; severity?: string; runId?: string } = {},
  ): Promise<LogEvent[]> {
    const conditions = [];
    if (opts.severity) {
      conditions.push(eq(logEventsTable.severity, opts.severity as any));
    }
    if (opts.runId) {
      conditions.push(eq(logEventsTable.runId, opts.runId));
    }

    const rows = await db
      .select()
      .from(logEventsTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(logEventsTable.timestamp))
      .limit(opts.limit ?? 100);

    return rows.map((r) => ({
      id: r.id,
      runId: r.runId,
      correlationId: r.correlationId,
      severity: r.severity as LogEvent["severity"],
      message: r.message,
      summary: r.summary,
      context: r.context as Record<string, unknown>,
      timestamp: r.timestamp,
    }));
  }

  async getRunLogs(runId: string): Promise<LogEvent[]> {
    const rows = await db
      .select()
      .from(logEventsTable)
      .where(eq(logEventsTable.runId, runId))
      .orderBy(desc(logEventsTable.timestamp));

    return rows.map((r) => ({
      id: r.id,
      runId: r.runId,
      correlationId: r.correlationId,
      severity: r.severity as LogEvent["severity"],
      message: r.message,
      summary: r.summary,
      context: r.context as Record<string, unknown>,
      timestamp: r.timestamp,
    }));
  }

  async listCheckpoints(opts: { runId?: string } = {}): Promise<CheckpointRecord[]> {
    const conditions = [];
    if (opts.runId) {
      conditions.push(eq(checkpointsTable.runId, opts.runId));
    }

    const rows = await db
      .select()
      .from(checkpointsTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(checkpointsTable.savedAt));

    return rows.map((r) => ({
      id: r.id,
      runId: r.runId,
      nodeId: r.nodeId,
      nodeName: r.nodeName,
      status: r.status as CheckpointRecord["status"],
      savedAt: r.savedAt.toISOString(),
      resumable: r.resumable,
    }));
  }

  async getResumableCheckpoint(runId: string): Promise<CheckpointRecord | null> {
    const rows = await db
      .select()
      .from(checkpointsTable)
      .where(
        and(
          eq(checkpointsTable.runId, runId),
          eq(checkpointsTable.resumable, true),
        ),
      )
      .orderBy(desc(checkpointsTable.savedAt))
      .limit(1);

    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      runId: r.runId,
      nodeId: r.nodeId,
      nodeName: r.nodeName,
      status: r.status as CheckpointRecord["status"],
      savedAt: r.savedAt.toISOString(),
      resumable: r.resumable,
    };
  }

  async claimCheckpoint(runId: string): Promise<CheckpointRecord | null> {
    const rows = await db
      .update(checkpointsTable)
      .set({ status: "resumed" })
      .where(
        and(
          eq(checkpointsTable.runId, runId),
          eq(checkpointsTable.status, "active"),
          eq(checkpointsTable.resumable, true),
        ),
      )
      .returning();

    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      runId: r.runId,
      nodeId: r.nodeId,
      nodeName: r.nodeName,
      status: r.status as CheckpointRecord["status"],
      savedAt: r.savedAt.toISOString(),
      resumable: r.resumable,
    };
  }

  async revertCheckpoint(checkpointId: string): Promise<void> {
    await db
      .update(checkpointsTable)
      .set({ status: "active" })
      .where(eq(checkpointsTable.id, checkpointId));
  }

  async countRuns(): Promise<{ active: number; completed: number; failed: number }> {
    const rows = await db
      .select({
        status: runsTable.status,
        count: sql<number>`count(*)::int`,
      })
      .from(runsTable)
      .groupBy(runsTable.status);

    const counts = { active: 0, completed: 0, failed: 0 };
    for (const row of rows) {
      if (row.status === "running" || row.status === "pending") {
        counts.active += row.count;
      } else if (row.status === "completed") {
        counts.completed = row.count;
      } else if (row.status === "failed") {
        counts.failed = row.count;
      }
    }
    return counts;
  }

  async checkHealth(): Promise<boolean> {
    try {
      await db.execute(sql`SELECT 1`);
      return true;
    } catch {
      return false;
    }
  }
}

export const storage = new Storage();
