/**
 * humanInputs.ts
 *
 * INVARIANT: TS is projection-only for orchestration truth.
 *
 * Human-input submission is delegated to Python via the continuation endpoint.
 * Python returns an authoritative execution snapshot; TS projects it via
 * workflowProjection.ts. TS never invents node completion, checkpoint state,
 * run status, or any other execution truth.
 *
 * FORBIDDEN in this file (directly):
 *   - setting node.status = "succeeded"
 *   - writing node.output as execution truth
 *   - inserting checkpoints directly
 *   - setting run status = "running"
 *   - writing blockedNodeId = null without a Python snapshot
 *   - writing resumabilityReason = "none" without a Python snapshot
 *   - writing lastCheckpointId / resumableCheckpointId as execution truth
 *
 * ALLOWED:
 *   - validating run/node existence and input schema
 *   - calling Python continuation endpoint
 *   - projecting Python snapshot via projectContinuationSnapshot
 */

import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, workflowRunNodesTable, workflowRunsTable } from "@workspace/db";
import { HumanNodeInputBody } from "../lib/orchestrationSchemas";
import { validateJsonSchema } from "../lib/schemaValidator";
import { classifyError, classifyCoreError } from "../lib/errorClassifier";
import { logger } from "../lib/logger";
import { pythonClient } from "../lib/pythonClient";
import { getConfig } from "../lib/config";
import { projectContinuationSnapshot, assertRunStatusFor } from "../lib/workflowProjection";

const router = Router();

function fail(
  res: Response,
  status: number,
  message: string,
  code: string,
  category: string,
  correlationId?: string,
  details?: unknown,
) {
  res
    .status(status)
    .json({ error: message, code, category, retryable: false, correlationId, ...(details ? { details } : {}) });
}

router.post("/workflow-runs/:id/nodes/:nodeId/input", async (req: Request, res: Response) => {
  try {
    const parsed = HumanNodeInputBody.safeParse(req.body);
    if (!parsed.success) {
      fail(res, 400, "Validation failed", "VALIDATION_ERROR", "validation_error", req.correlationId);
      return;
    }

    const runRows = await db
      .select()
      .from(workflowRunsTable)
      .where(eq(workflowRunsTable.id, String(req.params.id)))
      .limit(1);
    const run = runRows[0];
    if (!run) {
      fail(res, 404, "Workflow run not found", "NOT_FOUND", "not_found", req.correlationId);
      return;
    }

    const nodeRows = await db
      .select()
      .from(workflowRunNodesTable)
      .where(
        and(
          eq(workflowRunNodesTable.runId, String(req.params.id)),
          eq(workflowRunNodesTable.nodeId, String(req.params.nodeId)),
        ),
      )
      .limit(1);
    const node = nodeRows[0];
    if (!node) {
      fail(res, 404, "Workflow node not found", "NOT_FOUND", "not_found", req.correlationId);
      return;
    }

    if (String(node.status) !== "waiting_input") {
      fail(
        res,
        409,
        `Workflow node '${req.params.nodeId}' is not waiting for human input`,
        "CONFLICT",
        "conflict",
        req.correlationId,
      );
      return;
    }

    // Validate input against the expected schema if one is defined.
    const steps = Array.isArray((run.runtimeRequest as Record<string, unknown> | null)?.steps)
      ? ((run.runtimeRequest as Record<string, unknown>).steps as Array<Record<string, unknown>>)
      : [];
    const runtimeStep = steps.find((step) => String(step.id) === String(req.params.nodeId));
    const expectedInputSchema =
      runtimeStep && runtimeStep.type === "human"
        ? (runtimeStep.expectedInputSchema as Record<string, unknown> | undefined)
        : undefined;
    if (expectedInputSchema && Object.keys(expectedInputSchema).length > 0) {
      const validation = validateJsonSchema(expectedInputSchema, parsed.data.input);
      if (!validation.valid) {
        fail(
          res,
          400,
          "Input schema validation failed",
          "VALIDATION_ERROR",
          "validation_error",
          req.correlationId,
          validation.errors,
        );
        return;
      }
    }

    // Race-safety guard: verify the run is still in waiting_input before calling Python.
    const statusCheck = await assertRunStatusFor(String(req.params.id), ["waiting_input", "running"]);
    if (!statusCheck.ok) {
      fail(res, 409, statusCheck.reason, "CONFLICT", "conflict", req.correlationId);
      return;
    }

    // Delegate continuation to Python — TS does not advance execution state itself.
    const runtimeRequest = (run.runtimeRequest as Record<string, unknown>) ?? {};

    // Build completedNodes from nodes that have already succeeded (excluding the human node).
    const allNodeRows = await db
      .select()
      .from(workflowRunNodesTable)
      .where(eq(workflowRunNodesTable.runId, String(req.params.id)));
    const runtimeSteps = Array.isArray(runtimeRequest?.steps)
      ? (runtimeRequest.steps as Array<Record<string, unknown>>)
      : [];
    const validStepIds = new Set(runtimeSteps.map((s) => String(s.id)));
    const completedNodes = allNodeRows
      .filter(
        (n) =>
          (validStepIds.size === 0 || validStepIds.has(String(n.nodeId))) &&
          ["completed", "succeeded", "compensated"].includes(String(n.status)) &&
          String(n.nodeId) !== String(req.params.nodeId),
      )
      .map((n) => ({
        nodeId: String(n.nodeId),
        name: String(n.nodeId),
        result: (n.output as Record<string, unknown> | undefined) ?? undefined,
        startedAt: n.startedAt ? new Date(n.startedAt).toISOString() : undefined,
        completedAt: n.completedAt ? new Date(n.completedAt).toISOString() : undefined,
      }));

    const coreResult = await pythonClient.continueHumanInput(
      {
        runId: String(req.params.id),
        nodeId: String(req.params.nodeId),
        workflowId: String(runtimeRequest.workflowId ?? run.workflowId),
        name: String(runtimeRequest.name ?? run.id),
        input: (runtimeRequest.input as Record<string, unknown> | undefined) ?? {},
        steps: (runtimeRequest.steps as Parameters<typeof pythonClient.continueHumanInput>[0]["steps"]) ?? [],
        edges:
          (runtimeRequest.edges as Parameters<typeof pythonClient.continueHumanInput>[0]["edges"]) ?? [],
        completedNodes,
        humanInput: parsed.data.input,
        actorId: parsed.data.actorId,
      },
      getConfig().defaultRunTimeoutMs,
      req.correlationId,
    );

    if (!coreResult.ok) {
      const classified = classifyCoreError(coreResult.error.code, coreResult.error.message);
      fail(
        res,
        classified.statusCode,
        classified.message,
        classified.code,
        classified.category,
        req.correlationId,
      );
      return;
    }

    // Project Python-owned snapshot — single approved write path.
    const response = coreResult.data as unknown as Record<string, unknown>;
    const projectionResult = await projectContinuationSnapshot(
      String(req.params.id),
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

    res.status(202).json({
      runId: String(req.params.id),
      nodeId: String(req.params.nodeId),
      status: "accepted",
      continuationStatus: String(response.status ?? "completed"),
      lastCheckpointId: projectionResult.lastCheckpointId,
    });
  } catch (err) {
    const classified = classifyError(err, "submit_human_input");
    logger.error({ err, category: classified.category }, "Failed to submit human workflow input");
    fail(
      res,
      classified.statusCode,
      classified.message,
      classified.code,
      classified.category,
      req.correlationId,
    );
  }
});

export default router;
