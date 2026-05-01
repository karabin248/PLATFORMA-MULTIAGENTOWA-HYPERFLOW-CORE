/**
 * ⚠️  TEST HARNESS ONLY — NOT A RUNTIME MODULE ⚠️
 *
 * This file lives in tests/harness/ and must NEVER be imported from src/.
 * It exists solely to back harness-style tests that were written before the
 * projection-only architecture was introduced. New tests must use the
 * DB-backed integration test pattern (see tests/orchestration-continuation-integration.test.mjs).
 *
 * DO NOT add business logic here. DO NOT import this from any route file.
 */

/*
 * Resume Workflow Handler
 *
 * This module exports a factory function that constructs an Express handler
 * for the POST /workflow-runs/:id/resume endpoint.  The handler mirrors
 * the logic found in the TypeScript `workflows.ts` route but allows
 * dependency injection so it can be tested in isolation.  Consumers must
 * supply implementations for database access, eligibility checking,
 * checkpoint validation, Python client delegation, configuration, and
 * error classification.  The handler enforces approval gating, checkpoint
 * lineage validation, checkpoint translation (persisted UUID → node ID)
 * and performs persistence updates when a resume completes.
 *
 * NOTE: This file is intentionally written in plain JavaScript to
 * facilitate testing with Node.js without a TypeScript build step.  It
 * should remain logically equivalent to the corresponding logic in
 * `workflows.ts`.  Any changes to the resume route must be reflected
 * here to keep the test harness truthful.
 */

// This module is authored as an ES module because the surrounding
// package.json in `artifacts/api-server` sets "type": "module".
// Import `randomUUID` via ESM syntax.  CommonJS `require` is not
// available in this context.
import { randomUUID } from "crypto";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function filterRowsForRun(rows, runId) {
  return asArray(rows).filter((row) => row && (row.runId == null || String(row.runId) === String(runId)));
}

function firstMatchingRun(rows, runId) {
  return asArray(rows).find((row) => row && String(row.id) === String(runId)) ?? asArray(rows)[0] ?? null;
}

function runtimeStepIds(runtimeRequest) {
  const steps = Array.isArray(runtimeRequest?.steps) ? runtimeRequest.steps : [];
  return new Set(steps.map((step) => String(step.id)));
}

/**
 * Factory for a resume workflow handler.
 *
 * @param {Object} deps - A dictionary of injected dependencies.
 * @param {Object} deps.db - Database client with select, update and insert methods.
 *   It should also expose table descriptors as properties (e.g. workflowRunsTable).
 * @param {Object} deps.pythonClient - Client capable of invoking resumeWorkflow on the Python core.
 * @param {Function} deps.evaluateResumeEligibility - Function that returns { ok: boolean, error?: string } given a run and count of pending approvals.
 * @param {Function} deps.validateResumeCheckpoint - Function that validates a checkpoint request and returns { ok: boolean, error?: string }.
 * @param {Object} deps.WorkflowResumeBody - Zod schema or similar with a safeParse() method.
 * @param {Function} deps.getConfig - Function returning configuration with defaultRunTimeoutMs.
 * @param {Function} deps.classifyError - Error classifier for unexpected exceptions.
 * @param {Function} deps.classifyCoreError - Error classifier for Python core errors.
 * @param {Object} deps.logger - Logger instance with error() method.
 *
 * @returns {Function} Express handler accepting (req, res).
 */
function createResumeWorkflowHandler(deps) {
  const {
    db,
    pythonClient,
    evaluateResumeEligibility,
    validateResumeCheckpoint,
    WorkflowResumeBody,
    getConfig,
    classifyError,
    classifyCoreError,
    logger,
  } = deps;

  // Fallback fail helper replicating the one in workflows.ts.  It writes a JSON
  // error response with the given status, message and classification.  In
  // production the router will provide a response object; in tests the
  // response can be a stub that records status and json payloads.
  function fail(res, status, message, code, category, correlationId) {
    // In keeping with the existing contract, retryable is always false.
    res.status(status).json({ error: message, code, category, retryable: false, correlationId });
  }

  return async function resumeWorkflowHandler(req, res) {
    try {
      // Parse and validate the request body.  The WorkflowResumeBody schema
      // expects a runId to be present.  Here we override runId from the
      // route parameter to guard against tampering.  If validation fails the
      // call returns early.
      const parsed = WorkflowResumeBody.safeParse({ ...req.body, runId: String(req.params.id) });
      if (!parsed.success) {
        fail(res, 400, "Validation failed", "VALIDATION_ERROR", "validation_error", req.correlationId);
        return;
      }
      const data = parsed.data;

      // Fetch the workflow run and its runtime request.  A missing run or
      // missing runtimeRequest results in a 404.
      const runRows = await db
        .select()
        .from(db.workflowRunsTable)
        .where() // the stub DB may ignore the where clause and return predetermined rows
        .limit(1);
      const run = firstMatchingRun(runRows, req.params.id);
      if (!run || !run.runtimeRequest) {
        fail(res, 404, "Workflow run not found", "NOT_FOUND", "not_found", req.correlationId);
        return;
      }


      const nodeRows = filterRowsForRun(await db
        .select()
        .from(db.workflowRunNodesTable)
        .where()
        .limit(), run.id);

      // Fetch any pending approvals for this run.  Approvals are considered
      // pending when their status is "pending".  The stub DB may return
      // predetermined approvals regardless of where clause content.
      const pendingApprovals = filterRowsForRun(await db
        .select()
        .from(db.approvalsTable)
        .where()
        .limit(), run.id).filter((approval) => String(approval.status ?? "pending") === "pending");

      // Evaluate eligibility for resumption.  This covers terminal status and
      // pending approvals.  If not eligible, return a 409 with the
      // appropriate message.
      const pendingCount = pendingApprovals ? pendingApprovals.length : 0;
      const eligibility = evaluateResumeEligibility(run, pendingCount);
      if (!eligibility.ok) {
        // Determine the resumability reason and blocked node, if any.  A run
        // may be in a terminal state, awaiting approval or both (approvalState
        // overrides runtime status).  Derive blockedNodeId from the first
        // pending approval when available; otherwise leave null.  Update the
        // workflow run record to surface this metadata to callers.  These
        // updates are best-effort and do not alter core execution semantics.
        let resumabilityReason = "none";
        let blockedNodeId = null;
        const terminalStatuses = ["completed", "failed", "cancelled"];
        if (terminalStatuses.includes(run.status)) {
          resumabilityReason = "terminal";
        } else if (pendingCount > 0 || (run.approvalState && run.approvalState === "pending")) {
          resumabilityReason = "pending_approval";
          if (pendingApprovals && pendingApprovals.length > 0 && pendingApprovals[0].nodeId) {
            blockedNodeId = String(pendingApprovals[0].nodeId);
          }
        }
        // Persist the blocked node and reason for orchestration introspection.
        await db
          .update(db.workflowRunsTable)
          .set({ blockedNodeId: blockedNodeId, resumabilityReason: resumabilityReason })
          .where();
        fail(res, 409, eligibility.error, "CONFLICT", "conflict", req.correlationId);
        return;
      }

      // Fetch all checkpoints for the run.  Used to validate the requested
      // checkpoint against lineage and to provide context for translation.
      const checkpointsForRun = filterRowsForRun(await db
        .select({ id: db.checkpointsTable.id, runId: db.checkpointsTable.runId, nodeId: db.checkpointsTable.nodeId })
        .from(db.checkpointsTable)
        .where() // stub ignores where conditions
        .limit(), run.id);

      // Validate the requested checkpoint using the helper.  The helper
      // determines whether the requested checkpoint (if any) is owned by the
      // run and whether it represents a valid resumable boundary.  It also
      // handles cases where the run has no checkpoints or the request is
      // stale relative to last/resumable checkpoint.
      const checkpointValidation = validateResumeCheckpoint(
        { id: run.id, lastCheckpointId: run.lastCheckpointId ?? null, resumableCheckpointId: run.resumableCheckpointId ?? null },
        data.checkpointId,
        checkpointsForRun,
      );
      if (!checkpointValidation.ok) {
        // When the checkpoint lineage is invalid, update the run to reflect an
        // invalid checkpoint resumability reason.  No node is blocking
        // progress in this scenario.
        await db
          .update(db.workflowRunsTable)
          .set({ blockedNodeId: null, resumabilityReason: "invalid_checkpoint" })
          .where();
        fail(res, 409, checkpointValidation.error ?? "Invalid checkpoint", "CONFLICT", "conflict", req.correlationId);
        return;
      }

      // Derive the candidate persisted checkpoint UUID.  Prefer the caller
      // provided checkpointId; otherwise fall back to the run's resumable or
      // last checkpoint ID.  If none exists, omit the checkpoint field.
      const candidateRandomId = data.checkpointId
        ? String(data.checkpointId)
        : run.resumableCheckpointId ?? run.lastCheckpointId ?? null;
      let checkpointIdToForward;
      if (candidateRandomId) {
        // Look up the checkpoint row to extract the nodeId.  The Python core
        // interprets checkpointId as the identifier of the last completed node.
        const checkpointRows = checkpointsForRun.filter((checkpoint) => String(checkpoint.id) === String(candidateRandomId));
        const validStepIds = runtimeStepIds(run.runtimeRequest);
        const nodeId = checkpointRows[0] && checkpointRows[0].nodeId && (validStepIds.size === 0 || validStepIds.has(String(checkpointRows[0].nodeId))) ? checkpointRows[0].nodeId : undefined;
        if (nodeId) {
          checkpointIdToForward = String(nodeId);
        }
      }

      // Construct the resume request payload.  Completed nodes from the
      // request body are passed through verbatim.  Include checkpointId
      // only when derived from the DB.  Spread the original runtimeRequest
      // last to override any prior fields if necessary.
      const validStepIds = runtimeStepIds(run.runtimeRequest);
      const inferredCompletedNodes = Array.isArray(nodeRows)
        ? nodeRows
            .filter((node) => (validStepIds.size === 0 || validStepIds.has(String(node.nodeId))) && ["completed", "succeeded", "compensated"].includes(String(node.status)) && (node.completedAt || node.checkpointRef))
            .map((node) => ({
              nodeId: String(node.nodeId),
              name: String(node.nodeId),
              result: node.output || undefined,
              startedAt: node.startedAt ? new Date(node.startedAt).toISOString() : undefined,
              completedAt: node.completedAt ? new Date(node.completedAt).toISOString() : undefined,
            }))
        : [];
      const completedNodes = data.completedNodes && data.completedNodes.length > 0 ? data.completedNodes : inferredCompletedNodes;

      const resumeRequest = {
        ...run.runtimeRequest,
        runId: run.id,
        completedNodes,
        ...(checkpointIdToForward ? { checkpointId: checkpointIdToForward } : {}),
      };

      // Invoke the Python core's resumeWorkflow method.  Execution authority
      // remains with the Python core.  The request may include a
      // correlationId for tracing/logging.  The coreResult is expected to
      // follow the { ok: boolean, data?: any, error?: any } pattern.
      const coreResult = await pythonClient.resumeWorkflow(
        resumeRequest,
        getConfig().defaultRunTimeoutMs,
        req.correlationId,
      );
      if (!coreResult.ok) {
        const classified = classifyCoreError(coreResult.error, "resume_workflow");
        fail(res, classified.statusCode, classified.message, classified.code, classified.category, req.correlationId);
        return;
      }

      const response = coreResult.data || {};
      const nodes = Array.isArray(response.nodes) ? response.nodes : [];
      let lastCheckpointId = null;
      let pendingApprovalNodeId = null;
      let pendingHumanNodeId = null;

      // For each node returned from the Python core, update its state in the
      // workflowRunNodes table and create a corresponding checkpoint.  The
      // checkpointRef on the node record is updated to link it to the new
      // checkpoint.  Each checkpoint is persisted with minimal metadata
      // (status, result, timestamps, etc.).
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
        await db
          .update(db.workflowRunNodesTable)
          .set({
            status: nodeStatus,
            output: (node.result || null),
            startedAt: node.startedAt ? new Date(String(node.startedAt)) : null,
            completedAt: node.completedAt ? new Date(String(node.completedAt)) : null,
            error: typeof (node.result || {}).error === "string" ? String((node.result || {}).error) : null,
            checkpointRef: checkpointId,
          })
          .where();

        await db.insert(db.checkpointsTable).values({
          id: checkpointId,
          runId: run.id,
          nodeId: String(node.nodeId),
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

        if (nodeStatus === "waiting_approval") {
          const result = (node.result && typeof node.result === "object") ? node.result : {};
          await db.insert(db.approvalsTable).values({
            id: randomUUID(),
            runId: run.id,
            nodeId: String(node.nodeId),
            reason: typeof result.reason === "string" ? result.reason : `Approval required for ${String(node.name ?? node.nodeId)}`,
            objective: typeof result.objective === "string" ? result.objective : null,
            metadata: result.metadata && typeof result.metadata === "object" ? result.metadata : {},
            status: "pending",
          });
        }
      }

      const runStatus = String(response.status ?? run.status);
      const blockedNodeId = pendingApprovalNodeId ?? pendingHumanNodeId ?? null;
      const resumabilityReason = pendingApprovalNodeId
        ? "pending_approval"
        : pendingHumanNodeId
          ? "pending_human_input"
          : "none";
      const approvalState = pendingApprovalNodeId ? "pending" : "none";

      // Update the workflow run record with the new status, runtime response,
      // outputs, checkpoint metadata and completion timestamp (when applicable).
      await db
        .update(db.workflowRunsTable)
        .set({
          status: runStatus,
          runtimeResponse: response,
          output: { nodes },
          completedAt:
            runStatus === "completed" || runStatus === "failed" || runStatus === "cancelled"
              ? new Date()
              : null,
          lastCheckpointId: lastCheckpointId,
          resumableCheckpointId: lastCheckpointId,
          blockedNodeId,
          resumabilityReason,
          approvalState,
        })
        .where();

      res.json({ runId: run.id, status: runStatus, runtime: response });
    } catch (err) {
      const classified = classifyError(err, "resume_workflow");
      // Log the error for observability.  The logger may be a stub in tests.
      if (logger && typeof logger.error === "function") {
        logger.error({ err, category: classified.category }, "Failed to resume workflow");
      }
      fail(res, classified.statusCode, classified.message, classified.code, classified.category, req.correlationId);
    }
  };
}

export { createResumeWorkflowHandler };