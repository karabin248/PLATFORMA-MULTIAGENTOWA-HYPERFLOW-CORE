/**
 * approvals.ts
 *
 * INVARIANT: TS is projection-only for orchestration truth.
 *
 * Approval DECISIONS are delegated to Python via the continuation endpoint.
 * Python returns an authoritative execution snapshot; TS projects it via
 * workflowProjection.ts. TS never invents execution state.
 *
 * FORBIDDEN in this file (directly):
 *   - setting run status to "running"
 *   - inventing checkpoint boundaries
 *   - writing resumableCheckpointId as execution truth
 *   - setting blockedNodeId = null without a Python snapshot saying so
 *   - setting resumabilityReason = "none" without a Python snapshot saying so
 *
 * ALLOWED:
 *   - recording the approval decision record (approvalsTable)
 *   - calling Python continuation endpoint
 *   - projecting Python snapshot via projectContinuationSnapshot / projectTerminalRejection
 *   - blocking creation: recording that a node is waiting on approval
 */

import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  approvalsTable,
  db,
  workflowRunNodesTable,
  workflowRunsTable,
} from "@workspace/db";
import { ApprovalDecisionBody, ApprovalRequestBody } from "../lib/orchestrationSchemas";
import { classifyError, classifyCoreError } from "../lib/errorClassifier";
import { logger } from "../lib/logger";
import { pythonClient } from "../lib/pythonClient";
import { getConfig } from "../lib/config";
import {
  projectContinuationSnapshot,
  projectTerminalRejection,
  assertRunStatusFor,
} from "../lib/workflowProjection";

const router = Router();

function fail(
  res: Response,
  status: number,
  message: string,
  code: string,
  category: string,
  correlationId?: string,
) {
  res.status(status).json({ error: message, code, category, retryable: false, correlationId });
}

router.get("/approvals", async (req, res) => {
  const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
  const rows = runId
    ? await db
        .select()
        .from(approvalsTable)
        .where(eq(approvalsTable.runId, runId))
        .orderBy(desc(approvalsTable.requestedAt))
    : await db.select().from(approvalsTable).orderBy(desc(approvalsTable.requestedAt));
  res.json({ approvals: rows, total: rows.length });
});

router.post("/approvals", async (req: Request, res: Response) => {
  try {
    const parsed = ApprovalRequestBody.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, "Validation failed", "VALIDATION_ERROR", "validation_error", req.correlationId);
      return;
    }

    const body = parsed.data;

    const runRows = await db
      .select()
      .from(workflowRunsTable)
      .where(eq(workflowRunsTable.id, body.runId))
      .limit(1);
    if (!runRows[0]) {
      fail(res, 404, "Workflow run not found", "NOT_FOUND", "not_found", req.correlationId);
      return;
    }

    // FIX H3: Verify the node exists and belongs to this run.
    const nodeRows = await db
      .select()
      .from(workflowRunNodesTable)
      .where(
        and(
          eq(workflowRunNodesTable.runId, body.runId),
          eq(workflowRunNodesTable.nodeId, body.nodeId),
        ),
      )
      .limit(1);
    if (!nodeRows[0]) {
      fail(res, 422, "Node does not exist for this run", "VALIDATION_ERROR", "validation_error", req.correlationId);
      return;
    }

    // M-01 fix: use INSERT ... ON CONFLICT DO NOTHING instead of the previous
    // read-check-insert sequence. The read-check-insert was a TOCTOU race: two
    // concurrent requests could both pass the existingApproval SELECT and both
    // insert, creating duplicate pending approvals that would block resume
    // indefinitely. With the unique index on (run_id, node_id) WHERE status='pending'
    // the database enforces exclusivity; onConflictDoNothing() surfaces the
    // collision as a 409 at the application layer without a separate SELECT.
    const insertResult = await db
      .insert(approvalsTable)
      .values({
        id: randomUUID(),
        runId: body.runId,
        nodeId: body.nodeId,
        status: "pending",
        reason: body.reason,
        objective: body.objective ?? null,
        metadata: body.metadata ?? {},
        requestedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: approvalsTable.id });

    if (!insertResult[0]) {
      fail(res, 409, "An open approval already exists for this node", "CONFLICT", "conflict", req.correlationId);
      return;
    }

    const created = insertResult[0];

    // PATCH 2: TS does NOT mutate run execution state during approval creation.
    // approvalState / blockedNodeId / resumabilityReason are projection-only —
    // they must come from Python execution snapshots via workflowProjection.ts.

    res.status(201).json({ id: created.id, runId: body.runId, nodeId: body.nodeId, status: "pending" });
  } catch (err) {
    const classified = classifyError(err, "create_approval");
    logger.error({ err, category: classified.category }, "Failed to create approval request");
    fail(res, classified.statusCode, classified.message, classified.code, classified.category, req.correlationId);
  }
});

router.post("/approvals/:id/decision", async (req: Request, res: Response) => {
  try {
    const parsed = ApprovalDecisionBody.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, "Validation failed", "VALIDATION_ERROR", "validation_error", req.correlationId);
      return;
    }

    const rows = await db
      .select()
      .from(approvalsTable)
      .where(eq(approvalsTable.id, String(req.params.id)))
      .limit(1);
    const approval = rows[0];
    if (!approval) {
      fail(res, 404, "Approval not found", "NOT_FOUND", "not_found", req.correlationId);
      return;
    }

    // Idempotent: already decided — return existing record.
    if (approval.status !== "pending") {
      const existing = await db
        .select()
        .from(approvalsTable)
        .where(eq(approvalsTable.id, approval.id))
        .limit(1);
      res.json({ ...existing[0], alreadyDecided: true });
      return;
    }

    // Record the decision on the approval record.
    await db
      .update(approvalsTable)
      .set({
        status: parsed.data.approved ? "approved" : "rejected",
        actorId: parsed.data.actorId ?? null,
        note: parsed.data.note ?? null,
        decidedAt: new Date(),
      })
      .where(eq(approvalsTable.id, approval.id));

    if (!parsed.data.approved) {
      // REJECTION is terminal — no Python execution needed.
      // projectTerminalRejection is the only approved write path for this state.
      await projectTerminalRejection(approval.runId);
      const updated = await db
        .select()
        .from(approvalsTable)
        .where(eq(approvalsTable.id, approval.id))
        .limit(1);
      res.json(updated[0]);
      return;
    }

    // APPROVAL: delegate continuation entirely to Python.
    // Python advances execution from the approved approval node boundary.
    // TS projects the authoritative snapshot it returns.
    const runRows = await db
      .select()
      .from(workflowRunsTable)
      .where(eq(workflowRunsTable.id, approval.runId))
      .limit(1);
    const run = runRows[0];
    if (!run || !run.runtimeRequest) {
      fail(res, 404, "Workflow run not found", "NOT_FOUND", "not_found", req.correlationId);
      return;
    }

    const runtimeRequest = run.runtimeRequest as Record<string, unknown>;

    // Build completedNodes: all previously-succeeded nodes EXCLUDING the approval node
    // (Python's continuation handler adds the approval node as the boundary).
    const nodeRows = await db
      .select()
      .from(workflowRunNodesTable)
      .where(eq(workflowRunNodesTable.runId, run.id));
    const runtimeSteps = Array.isArray(runtimeRequest?.steps)
      ? (runtimeRequest.steps as Array<Record<string, unknown>>)
      : [];
    const validStepIds = new Set(runtimeSteps.map((s) => String(s.id)));
    const completedNodes = nodeRows
      .filter(
        (n) =>
          (validStepIds.size === 0 || validStepIds.has(String(n.nodeId))) &&
          ["completed", "succeeded", "compensated"].includes(String(n.status)) &&
          String(n.nodeId) !== String(approval.nodeId),
      )
      .map((n) => ({
        nodeId: String(n.nodeId),
        name: String(n.nodeId),
        result: (n.output as Record<string, unknown> | undefined) ?? undefined,
        startedAt: n.startedAt ? new Date(n.startedAt).toISOString() : undefined,
        completedAt: n.completedAt ? new Date(n.completedAt).toISOString() : undefined,
      }));

    // Race-safety guard: verify run is still in a blockable state before calling Python.
    const statusCheck = await assertRunStatusFor(run.id, ["running", "waiting_approval", "queued"]);
    if (!statusCheck.ok) {
      fail(res, 409, statusCheck.reason, "CONFLICT", "conflict", req.correlationId);
      return;
    }

    const coreResult = await pythonClient.continueApproval(
      {
        runId: run.id,
        nodeId: String(approval.nodeId),
        workflowId: String(runtimeRequest.workflowId ?? run.workflowId),
        name: String(runtimeRequest.name ?? run.id),
        input: (runtimeRequest.input as Record<string, unknown> | undefined) ?? {},
        steps: (runtimeRequest.steps as Parameters<typeof pythonClient.continueApproval>[0]["steps"]) ?? [],
        edges: (runtimeRequest.edges as Parameters<typeof pythonClient.continueApproval>[0]["edges"]) ?? [],
        completedNodes,
        approvedBy: parsed.data.actorId,
        note: parsed.data.note,
      },
      getConfig().defaultRunTimeoutMs,
      req.correlationId,
    );

    if (!coreResult.ok) {
      const classified = classifyCoreError(coreResult.error.code, coreResult.error.message);
      fail(res, classified.statusCode, classified.message, classified.code, classified.category, req.correlationId);
      return;
    }

    // Project Python-owned snapshot — single approved write path.
    const response = coreResult.data as unknown as Record<string, unknown>;
    await projectContinuationSnapshot(
      run.id,
      {
        status: String(response.status ?? "completed"),
        nodes: Array.isArray(response.nodes)
          ? (response.nodes as Array<Record<string, unknown> & { nodeId: string; status: string }>)
          : [],
        checkpointId: response.checkpointId as string | null | undefined,
        blockedNodeId: response.blockedNodeId as string | null | undefined,
        resumabilityReason: response.resumabilityReason as string | undefined,
        error: response.error as string | undefined,
      },
      runtimeRequest,
    );

    // MICRO-FIX: approvalState is projection-only.
    // Python's continuation snapshot already carries the resolved state;
    // projectContinuationSnapshot() above is the sole write authority.
    // TS must not echo-write execution-adjacent truth after projection.

    const updated = await db
      .select()
      .from(approvalsTable)
      .where(eq(approvalsTable.id, approval.id))
      .limit(1);
    res.json({ ...updated[0], continuationStatus: String(response.status ?? "completed") });
  } catch (err) {
    const classified = classifyError(err, "decide_approval");
    logger.error({ err, category: classified.category }, "Failed to decide approval request");
    fail(res, classified.statusCode, classified.message, classified.code, classified.category, req.correlationId);
  }
});

export default router;
