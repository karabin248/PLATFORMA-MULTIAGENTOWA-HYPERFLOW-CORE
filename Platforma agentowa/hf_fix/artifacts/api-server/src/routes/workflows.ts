import { Router, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  db,
  workflowsTable,
  workflowRevisionsTable,
  workflowRunsTable,
  workflowRunNodesTable,
  checkpointsTable,
  approvalsTable,
} from "@workspace/db";
import { classifyError, classifyCoreError } from "../lib/errorClassifier";
import { logger } from "../lib/logger";
import { getConfig } from "../lib/config";
import { pythonClient } from "../lib/pythonClient";
import { WorkflowDefinitionSchema, WorkflowRunBody, WorkflowResumeBody } from "../lib/orchestrationSchemas";
import { compileWorkflowRuntimeRequest, WorkflowCompilationError } from "../lib/workflowCompilation";
import { validateResumeCheckpoint } from "../lib/resumeValidator";
import { evaluateResumeEligibility } from "../lib/resumeEligibility";
import { projectExecutionSnapshot, projectContinuationSnapshot, appendStateLogEvent, deriveResumability, deriveOperatorSummary } from "../lib/workflowProjection";
import { requestCancellation } from "../lib/workflowExecutor";
// The live resume route is implemented inline below with proper scoped predicates.
// The former resumeWorkflowHandler.js has been moved to tests/harness/ (test-only).

const router = Router();

// Resume semantics live in dedicated helpers — see resumeEligibility.ts and
// workflowProjection.ts. The route here only orchestrates: it loads run
// state, calls evaluateResumeEligibility, forwards to the Python core via
// pythonClient, then projects the snapshot. It owns no execution truth.
// Operator-facing error strings ("Cannot resume…") are produced by
// evaluateResumeEligibility, not by this file.

function fail(res: Response, status: number, message: string, code: string, category: string, correlationId?: string) {
  res.status(status).json({ error: message, code, category, retryable: false, correlationId });
}

router.get("/workflows", async (_req, res) => {
  const rows = await db.select().from(workflowsTable).orderBy(workflowsTable.name);
  res.json({ workflows: rows, total: rows.length });
});

router.post("/workflows", async (req: Request, res: Response) => {
  const parsed = WorkflowDefinitionSchema.safeParse(req.body);
  if (!parsed.success) {
    fail(res, 400, "Validation failed", "VALIDATION_ERROR", "validation_error", req.correlationId);
    return;
  }

  const body = parsed.data;
  const existing = await db.select().from(workflowsTable).where(eq(workflowsTable.id, body.id)).limit(1);
  if (existing[0]) {
    fail(res, 409, `Workflow '${body.id}' already exists`, "CONFLICT", "conflict", req.correlationId);
    return;
  }

  await db.insert(workflowsTable).values({
    id: body.id,
    version: body.version,
    name: body.name,
    description: body.description,
    definition: { nodes: body.nodes, edges: body.edges },
    tags: body.tags,
    owner: body.owner ?? null,
  });

  await db.insert(workflowRevisionsTable).values({
    workflowId: body.id,
    revisionNumber: 1,
    spec: body,
    changedFields: ["definition"],
    changedBy: body.owner ?? "operator",
  });

  const created = await db.select().from(workflowsTable).where(eq(workflowsTable.id, body.id)).limit(1);
  res.status(201).json(created[0]);
});

router.get("/workflows/:id", async (req, res) => {
  const rows = await db.select().from(workflowsTable).where(eq(workflowsTable.id, String(req.params.id))).limit(1);
  if (!rows[0]) {
    fail(res, 404, "Workflow not found", "NOT_FOUND", "not_found", req.correlationId);
    return;
  }
  res.json(rows[0]);
});

router.post("/workflows/run", async (req: Request, res: Response) => {
  try {
    const parsed = WorkflowRunBody.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, "Validation failed", "VALIDATION_ERROR", "validation_error", req.correlationId);
      return;
    }

    const body = parsed.data;
    const workflow = await db.select().from(workflowsTable).where(eq(workflowsTable.id, body.workflowId)).limit(1);
    const found = workflow[0];
    if (!found) {
      fail(res, 404, "Workflow not found", "NOT_FOUND", "not_found", req.correlationId);
      return;
    }

    const now = new Date();
    const runId = randomUUID();
    let runtimeRequest;
    try {
      runtimeRequest = await compileWorkflowRuntimeRequest(found as unknown as Parameters<typeof compileWorkflowRuntimeRequest>[0], body.input ?? {});
    } catch (err) {
      if (err instanceof WorkflowCompilationError) {
        res.status(err.statusCode).json({
          error: err.message,
          code: err.code,
          category: err.category,
          retryable: false,
          correlationId: req.correlationId,
          details: err.details,
        });
        return;
      }
      throw err;
    }

    // --- ATOMIC IDEMPOTENCY ADMISSION ---
    // INSERT with onConflictDoNothing() is atomic against the DB UNIQUE constraint
    // on idempotency_key. Under a race, only one INSERT wins; the loser gets
    // rowCount=0 and we return the winner's cached run instead.
    if (body.idempotencyKey) {
      const insertResult = await db
        .insert(workflowRunsTable)
        .values({
          id: runId,
          workflowId: found.id,
          workflowVersion: body.workflowVersion ?? found.version,
          // PATCH 1: admission persists "queued"; executor owns transition to "running"
          status: "queued",
          input: body.input,
          runtimeRequest,
          requestedBy: body.requestedBy,
          correlationId: body.correlationId ?? null,
          idempotencyKey: body.idempotencyKey,
          admittedAt: now,
          startedAt: null,
          lastCheckpointId: null,
          resumableCheckpointId: null,
          blockedNodeId: null,
          resumabilityReason: "none",
        })
        .onConflictDoNothing()
        .returning({ id: workflowRunsTable.id });

      if (insertResult.length === 0) {
        // Idempotency hit: return the existing run.
        const existing = await db
          .select()
          .from(workflowRunsTable)
          .where(and(eq(workflowRunsTable.workflowId, found.id), eq(workflowRunsTable.idempotencyKey, body.idempotencyKey)))
          .limit(1);
        const existingRun = existing[0];
        logger.info({ runId: existingRun?.id, idempotencyKey: body.idempotencyKey }, "Workflow idempotency key hit — returning cached run");
        res.status(200).json({
          runId: existingRun?.id,
          workflowId: found.id,
          status: existingRun?.status,
          idempotencyHit: true,
          message: "Workflow run already admitted with this idempotency key",
        });
        return;
      }
    } else {
      // No idempotency key — plain insert.
      await db.insert(workflowRunsTable).values({
        id: runId,
        workflowId: found.id,
        workflowVersion: body.workflowVersion ?? found.version,
        // PATCH 1: admission persists "queued"; executor owns transition to "running"
        status: "queued",
        input: body.input,
        runtimeRequest,
        requestedBy: body.requestedBy,
        correlationId: body.correlationId ?? null,
        idempotencyKey: null,
        admittedAt: now,
        startedAt: null,
        lastCheckpointId: null,
        resumableCheckpointId: null,
        blockedNodeId: null,
        resumabilityReason: "none",
      });
    }

    // Insert node state records for this run. Nodes with no dependencies are marked "ready"
    // to reflect that they are immediately schedulable; others remain "pending" until their
    // dependencies are satisfied. The waitingOn array captures upstream dependencies.
    for (const step of runtimeRequest.steps) {
      const deps = Array.isArray(step.dependsOn) ? step.dependsOn : [];
      const initialStatus = deps.length === 0 ? "ready" : "pending";
      await db.insert(workflowRunNodesTable).values({
        id: randomUUID(),
        runId,
        nodeId: String(step.id),
        nodeType: String(step.type ?? "agent"),
        status: initialStatus,
        waitingOn: deps,
        input: (step.input as Record<string, unknown> | undefined) ?? {},
      });
    }

    // ADMISSION COMPLETE — execution is durable and async, owned by the background executor.
    // POST /workflows/run is admission-only: validate, persist, queue, return.
    // The executor polls for queued runs, acquires leases, calls Python, and projects results.
    await appendStateLogEvent(runId, "admitted", { workflowId: found.id, requestedBy: body.requestedBy });

    res.status(202).json({
      runId,
      workflowId: found.id,
      status: "queued",
      message: "Workflow run admitted. Execution is asynchronous — poll GET /workflow-runs/:id for status.",
    });
  } catch (err) {
    const classified = classifyError(err, "run_workflow");
    logger.error({ err, category: classified.category }, "Failed to run workflow");
    fail(res, classified.statusCode, classified.message, classified.code, classified.category, req.correlationId);
  }
});


//
// POST /workflow-runs/:id/resume
//
// INVARIANT: TS is projection-only for orchestration truth.
// Python is the sole execution authority. All run state transitions here
// originate from Python-owned execution events or Python response payloads.
// TS does not invent run status, node status, or checkpoint boundaries.
//
router.post("/workflow-runs/:id/resume", async (req: Request, res: Response) => {
  try {
    const parsed = WorkflowResumeBody.safeParse({ ...req.body, runId: String(req.params.id) });
    if (!parsed.success) {
      fail(res, 400, "Validation failed", "VALIDATION_ERROR", "validation_error", req.correlationId);
      return;
    }
    const data = parsed.data;
    const targetRunId = String(req.params.id);

    // --- SCOPED DB LOAD: always predicate by run id ---
    // No unscoped DB queries allowed — all queries must use eq() predicates scoped to targetRunId.
    const runRows = await db
      .select()
      .from(workflowRunsTable)
      .where(eq(workflowRunsTable.id, targetRunId))
      .limit(1);
    const run = runRows[0];
    if (!run || !run.runtimeRequest) {
      fail(res, 404, "Workflow run not found", "NOT_FOUND", "not_found", req.correlationId);
      return;
    }

    // Load nodes scoped to this run only
    const nodeRows = await db
      .select()
      .from(workflowRunNodesTable)
      .where(eq(workflowRunNodesTable.runId, run.id));

    // Load pending approvals scoped to this run only
    const approvalRows = await db
      .select()
      .from(approvalsTable)
      .where(and(eq(approvalsTable.runId, run.id), eq(approvalsTable.status, "pending")));
    const pendingCount = approvalRows.length;

    // Eligibility gate: terminal states and unresolved approvals block resume
    const eligibility = evaluateResumeEligibility(run, pendingCount);
    if (!eligibility.ok) {
      fail(res, 409, eligibility.error, "CONFLICT", "conflict", req.correlationId);
      return;
    }

    // Load checkpoints scoped to this run only
    const checkpointsForRun = await db
      .select({ id: checkpointsTable.id, runId: checkpointsTable.runId, nodeId: checkpointsTable.nodeId })
      .from(checkpointsTable)
      .where(eq(checkpointsTable.runId, run.id));

    // Validate checkpoint boundary lineage
    const checkpointValidation = validateResumeCheckpoint(
      { id: run.id, lastCheckpointId: run.lastCheckpointId ?? null, resumableCheckpointId: run.resumableCheckpointId ?? null },
      data.checkpointId,
      checkpointsForRun,
    );
    if (!checkpointValidation.ok) {
      fail(res, 409, checkpointValidation.error ?? "Invalid checkpoint", "CONFLICT", "conflict", req.correlationId);
      return;
    }

    // Translate persisted checkpoint UUID → node ID for Python core
    // Python interprets checkpointId as the last completed node boundary.
    const candidateId = data.checkpointId ?? run.resumableCheckpointId ?? run.lastCheckpointId ?? null;
    let checkpointIdToForward: string | undefined;
    if (candidateId) {
      const cpRow = checkpointsForRun.find((c) => c.id === candidateId && c.runId === run.id);
      if (cpRow?.nodeId) {
        checkpointIdToForward = String(cpRow.nodeId);
      }
    }

    // Build completedNodes from DB-backed node state
    const runtimeSteps = Array.isArray((run.runtimeRequest as Record<string, unknown>)?.steps)
      ? (run.runtimeRequest as Record<string, unknown>).steps as Array<Record<string, unknown>>
      : [];
    const validStepIds = new Set(runtimeSteps.map((s) => String(s.id)));
    const inferredCompleted = nodeRows
      .filter(
        (n) =>
          (validStepIds.size === 0 || validStepIds.has(String(n.nodeId))) &&
          ["completed", "succeeded", "compensated"].includes(String(n.status)) &&
          (n.completedAt || n.checkpointRef),
      )
      .map((n) => ({
        nodeId: String(n.nodeId),
        name: String(n.nodeId),
        result: (n.output as Record<string, unknown> | undefined) ?? undefined,
        startedAt: n.startedAt ? new Date(n.startedAt).toISOString() : undefined,
        completedAt: n.completedAt ? new Date(n.completedAt).toISOString() : undefined,
      }));
    const completedNodes = data.completedNodes && data.completedNodes.length > 0 ? data.completedNodes : inferredCompleted;

    const resumeRequest = {
      ...(run.runtimeRequest as Record<string, unknown>),
      runId: run.id,
      completedNodes,
      ...(checkpointIdToForward ? { checkpointId: checkpointIdToForward } : {}),
    };

    // Delegate execution authority to Python — TS does not advance state itself
    const coreResult = await pythonClient.resumeWorkflow(
      resumeRequest as Parameters<typeof pythonClient.resumeWorkflow>[0],
      getConfig().defaultRunTimeoutMs,
      req.correlationId,
    );
    if (!coreResult.ok) {
      // classifyCoreError expects (code: string, message: string) — pass fields explicitly
      const classified = classifyCoreError(coreResult.error.code, coreResult.error.message);
      fail(res, classified.statusCode, classified.message, classified.code, classified.category, req.correlationId);
      return;
    }

    // Project Python-owned execution truth into DB — via single approved projection path.
    const response = coreResult.data as unknown as Record<string, unknown>;
    const nodes = Array.isArray(response.nodes) ? (response.nodes as Array<Record<string, unknown>>) : [];

    // Route all orchestration truth writes through the single approved projection path.
    await projectContinuationSnapshot(
      run.id,
      {
        status: String(response.status ?? run.status),
        nodes: nodes as Array<Record<string, unknown> & { nodeId: string; status: string }>,
        checkpointId: response.checkpointId as string | null | undefined,
        blockedNodeId: response.blockedNodeId as string | null | undefined,
        resumabilityReason: response.resumabilityReason as string | undefined,
        error: response.error as string | undefined,
      },
      run.runtimeRequest as Record<string, unknown>,
    );

    // Store raw runtime response metadata — not orchestration truth.
    await db
      .update(workflowRunsTable)
      .set({ runtimeResponse: response, output: { nodes } })
      .where(eq(workflowRunsTable.id, run.id));

    res.json({ runId: run.id, status: String(response.status ?? run.status), runtime: response });
  } catch (err) {
    const classified = classifyError(err, "resume_workflow");
    logger.error({ err, category: classified.category }, "Failed to resume workflow");
    fail(res, classified.statusCode, classified.message, classified.code, classified.category, req.correlationId);
  }
});


router.post("/workflow-runs/:id/cancel", async (req: Request, res: Response) => {
  try {
    const targetRunId = String(req.params.id);
    const requestedBy = typeof req.body?.requestedBy === "string" ? req.body.requestedBy : "operator";

    const result = await requestCancellation(targetRunId, requestedBy);

    if (!result.ok) {
      fail(res, result.status === "not_found" ? 404 : 409, result.reason ?? "Cannot cancel", "CONFLICT", "conflict", req.correlationId);
      return;
    }

    res.json({ runId: targetRunId, status: result.status, cancelledAt: new Date().toISOString() });
  } catch (err) {
    const classified = classifyError(err, "cancel_workflow_run");
    logger.error({ err, category: classified.category }, "Failed to cancel workflow run");
    fail(res, classified.statusCode, classified.message, classified.code, classified.category, req.correlationId);
  }
});

router.get("/workflow-runs", async (_req, res) => {
  const rows = await db.select().from(workflowRunsTable).orderBy(desc(workflowRunsTable.createdAt));
  // Expose resumability metadata and derive a resumability object for
  // each run.  The raw fields `blockedNodeId` and `resumabilityReason`
  // remain on the run record.  The derived `resumability` property
  // combines these fields with a computed `canResume` boolean to make
  // the state easy for operators to consume.  The boolean is true
  // only when the reason is "none" and the run status is not in a
  // terminal state.  This does not alter execution semantics; it
  // simply surfaces metadata from persistence.
  // Single canonical derivation — list and detail views share the same logic.
  const runs = rows.map((run) => {
    const resumability = deriveResumability(run);
    const summary = deriveOperatorSummary(run);
    return {
      ...run,
      resumability,
      hasPendingApproval: resumability.requiresApprovalAction,
      requiresApprovalAction: resumability.requiresApprovalAction,
      listExecutionSummary: summary,
    };
  });
  res.json({ runs, total: runs.length });
});

router.get("/workflow-runs/:id", async (req, res) => {
  const rows = await db.select().from(workflowRunsTable).where(eq(workflowRunsTable.id, String(req.params.id))).limit(1);
  const run = rows[0];
  if (!run) {
    fail(res, 404, "Workflow run not found", "NOT_FOUND", "not_found", req.correlationId);
    return;
  }
  const nodes = await db
    .select()
    .from(workflowRunNodesTable)
    .where(eq(workflowRunNodesTable.runId, run.id));
  const checkpoints = await db
    .select()
    .from(checkpointsTable)
    .where(eq(checkpointsTable.runId, run.id))
    .orderBy(desc(checkpointsTable.createdAt));
  // Fetch approval records for this run.  Only the first pending approval is
  // relevant as a blocking approval.  We order by requestedAt descending
  // similar to the approvals route; however, the stub DB may ignore orderBy.
  const approvals = await db
    .select()
    .from(approvalsTable)
    .where(eq(approvalsTable.runId, run.id))
    .orderBy ? await db.select().from(approvalsTable).where(eq(approvalsTable.runId, run.id)).orderBy(desc(approvalsTable.requestedAt)) : await db.select().from(approvalsTable).where(eq(approvalsTable.runId, run.id));
  // Determine the blocking approval if any.  We consider the first pending
  // approval as the blocker.  If no approvals exist or none are pending,
  // blockingApproval remains null.  Only include fields that exist in
  // the schema.  Do not infer or derive new semantics.
  let blockingApproval = null;
  if (approvals && Array.isArray(approvals)) {
    const pending = approvals.find((appr) => appr && appr.status === "pending");
    if (pending) {
      blockingApproval = {
        id: pending.id,
        nodeId: pending.nodeId,
        status: pending.status,
        reason: pending.reason,
        requestedAt: pending.requestedAt ?? null,
        decidedAt: pending.decidedAt ?? null,
      };
    }
  }
  // Single canonical derivation — same logic as list view.
  const resumability = deriveResumability(run);
  const { requiresApprovalAction, canResume: canResumeNow } = resumability;
  const pendingApprovalCount = Array.isArray(approvals)
    ? approvals.filter((a) => a?.status === "pending").length
    : 0;
  const hasPendingApproval = pendingApprovalCount > 0;
  const actionability = { requiresApprovalAction, canResumeNow };
  // Build an approval timeline for this run.  The timeline contains
  // every approval record for the run, ordered by requestedAt in ascending
  // order (earliest first).  Only fields present in the schema are
  // exposed; no new semantics are introduced.  If there are no
  // approvals, the timeline is an empty array.
  let approvalTimeline: Array<{
    id: string;
    nodeId: string | null;
    status: string;
    reason: string | null;
    requestedAt: Date | string | null;
    decidedAt: Date | string | null;
  }> = [];
  if (approvals && Array.isArray(approvals)) {
    // Sort by requestedAt ascending.  Approvals without a requestedAt
    // field are treated as earliest (epoch 0).  Clone array to avoid
    // mutating the original.
    const sorted = approvals.slice().sort((a, b) => {
      const aTime = a && a.requestedAt ? new Date(a.requestedAt).getTime() : 0;
      const bTime = b && b.requestedAt ? new Date(b.requestedAt).getTime() : 0;
      return aTime - bTime;
    });
    approvalTimeline = sorted.map((appr) => ({
      id: appr.id,
      nodeId: appr.nodeId,
      status: appr.status,
      reason: appr.reason,
      requestedAt: appr.requestedAt ?? null,
      decidedAt: appr.decidedAt ?? null,
    }));
  }
  // Build a checkpoint timeline.  This timeline lists all checkpoint
  // records for the run ordered by creation time ascending (earliest
  // first).  Each entry exposes only fields available in the DB: the
  // checkpoint ID, nodeId, type and createdAt timestamp.  The timeline
  // reflects exactly the persisted checkpoint history; it does not
  // infer any state transitions or missing checkpoints.  If there are
  // no checkpoints for the run, the timeline is an empty array.
  let checkpointTimeline: Array<{
    id: string;
    nodeId: string | null;
    type: string;
    createdAt: Date | string | null;
  }> = [];
  if (Array.isArray(checkpoints) && checkpoints.length > 0) {
    // Sort ascending by createdAt.  createdAt is not-null in schema but
    // cast to Date for safe comparison.  Should a value be missing, treat
    // it as epoch 0.
    const sortedCp = checkpoints.slice().sort((a, b) => {
      const aTime = a && a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b && b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return aTime - bTime;
    });
    checkpointTimeline = sortedCp.map((cp) => ({
      id: cp.id,
      nodeId: cp.nodeId ?? null,
      type: cp.checkpointType,
      createdAt: cp.createdAt ?? null,
    }));
  }
  // deriveOperatorSummary uses the same logic as the list view — no divergence.
  const executionStory = {
    ...deriveOperatorSummary(run),
    pendingApprovalCount,
    blockedNodeId: resumability.blockedNodeId,
    resumableCheckpointId: run.resumableCheckpointId ?? null,
  };
  res.json({
    ...run,
    resumability,
    blockingApproval,
    pendingApprovalCount,
    hasPendingApproval,
    actionability,
    approvalTimeline,
    checkpointTimeline,
    executionStory,
    nodes,
    checkpoints,
  });
});

export default router;
