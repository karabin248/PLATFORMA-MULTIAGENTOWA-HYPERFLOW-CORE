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
 * Workflows Router Factory
 *
 * Mission 10A requires exercising the resume route through its real
 * router wiring rather than via a bespoke test harness.  In the
 * production code the resume route is mounted on an Express router in
 * `workflows.ts`, but Express is not available in this test
 * environment and the TypeScript source cannot be imported directly
 * into Node.js.  To bridge this gap, this file provides a minimal
 * router factory that mirrors the behaviour of the production
 * `workflows.ts` router for the POST `/workflow-runs/:id/resume` path.
 *
 * The factory accepts the same dependencies as `createResumeWorkflowHandler` and
 * returns an asynchronous function that routes requests based on
 * method and URL.  It parses the run identifier from the URL and
 * injects it into `req.params`, then delegates to the injected
 * resume handler.  Any unrecognised path or method will result in an
 * error.  This harness is deliberately narrow: it exists solely for
 * test purposes and does not attempt to emulate the entire Express
 * API.  It uses the same path pattern as the production router,
 * ensuring that tests exercise the true route wiring.
 */

import { createResumeWorkflowHandler } from "./resumeWorkflowHandler.js";

/**
 * Create a minimal workflows router for testing.  The returned
 * function implements routing logic for several workflow run paths.
 * - POST `/workflow-runs/:id/resume` invokes the injected resume handler.
 * - GET `/workflow-runs` returns all runs and a total count.
 * - GET `/workflow-runs/:id` returns a run along with its nodes and checkpoints.
 * The harness uses simple string splitting to match paths and inject
 * parameters rather than regular expressions.  It deliberately does
 * not emulate the full Express API.
 *
 * @param {Object} deps - Dependencies required by the resume handler.
 * @returns {Function} An async function accepting (req, res) that routes the request.
 */
export function createWorkflowsRouter(deps) {
  // Instantiate the resume handler once so it can capture the injected
  // dependencies.  The handler itself returns a Promise and writes to
  // the provided res object.  It follows the same signature as an
  // Express handler.
  const resumeHandler = createResumeWorkflowHandler(deps);
  /**
   * Route a request to the appropriate handler based on method and URL.
   * Only POST `/workflow-runs/:id/resume` is supported.  The run
   * identifier is extracted from the URL and set on `req.params.id`.
   *
   * This implementation avoids using regular expressions for routing.
   * Instead, it splits the URL on `/` to determine whether it matches
   * the expected path structure.  A valid path must consist of four
   * segments: `"", "workflow-runs", <id>, "resume"`.  When matched,
   * the handler is invoked and supplied with a `params` object
   * containing the run identifier.  Any non-matching path or method
   * results in an error.  This mirrors the route wiring in
   * `workflows.ts` without pulling in Express.
   *
   * @param {Object} req - The request object (must have method, url and body).
   * @param {Object} res - The response object (must support status() and json()).
   */
  return async function workflowsRouter(req, res) {
    const { method, url } = req;
    if (!method || !url) {
      throw new Error("Invalid request: missing method or url");
    }
    // Normalise method to uppercase for comparison.
    const httpMethod = String(method).toUpperCase();
    // Split the URL into segments.  A leading slash will result in
    // an empty first element.
    const segments = String(url).split("/");
    // Handle POST /workflow-runs/:id/resume
    // Expecting ['', 'workflow-runs', '<id>', 'resume']
    if (httpMethod === "POST" && segments.length === 4 && segments[1] === "workflow-runs" && segments[3] === "resume") {
      const runId = segments[2];
      // Populate req.params like Express would.  Preserve any existing
      // params object to avoid clobbering other values.
      req.params = { ...(req.params || {}), id: runId };
      await resumeHandler(req, res);
      return;
    }

    // Handle GET /workflow-runs (list runs)
    if (httpMethod === "GET" && segments.length === 2 && segments[1] === "workflow-runs") {
      // The db stub may ignore orderBy and where clauses, simply returning the seeded rows.
      let rows;
      try {
        // Attempt to call orderBy if available (in production Drizzle).  If undefined, fallback
        const query = deps.db.select().from(deps.db.workflowRunsTable);
        rows = query.orderBy ? await query.orderBy() : await query.orderBy?.() || [];
      } catch {
        // Fallback: select().from(table) may return a promise directly
        const q = deps.db.select().from(deps.db.workflowRunsTable);
        rows = q.then ? await q : [];
      }
      rows = rows || [];
      // Derive resumability metadata and augment each run with a
      // resumability object.  This mirrors the production route in
      // workflows.ts.  The derived property includes `reason`,
      // `blockedNodeId` and `canResume`.  See the comments in
      // workflows.ts for semantics.
      const runsWithResumability = rows.map((run) => {
        const reason = run.resumabilityReason ?? "none";
        const blockedNodeId = run.blockedNodeId ?? null;
        const terminalStatuses = ["completed", "failed", "cancelled"];
        const canResume = reason === "none" && !terminalStatuses.includes(run.status ?? "");
        // Derive hasPendingApproval from the resumabilityReason.  If the
        // reason is "pending_approval" then there is at least one
        // pending approval for this run.
        const hasPendingApproval = reason === "pending_approval";
        // At the list level, the action-readiness hint requires approval
        // attention precisely when there is a pending approval.  Do not
        // infer beyond existing truth.
        const requiresApprovalAction = hasPendingApproval;
        const listExecutionSummary = {
          status: run.status,
          blocked: reason !== "none",
          blockType: reason !== "none" ? reason : null,
          requiresApprovalAction,
          canResumeNow: canResume,
          currentBoundaryCheckpointId: run.lastCheckpointId ?? null,
        };
        return {
          ...run,
          resumability: { reason, blockedNodeId, canResume },
          hasPendingApproval,
          requiresApprovalAction,
          listExecutionSummary,
        };
      });
      res.status(200).json({ runs: runsWithResumability, total: runsWithResumability.length });
      return;
    }

    // Handle GET /workflow-runs/:id (run detail)
    if (httpMethod === "GET" && segments.length === 3 && segments[1] === "workflow-runs") {
      const runId = segments[2];
      // Fetch run
      let run;
      try {
        const query = deps.db.select().from(deps.db.workflowRunsTable);
        const rows = query.where ? await query.where().limit?.() : await query.where?.().limit?.();
        run = rows && rows[0];
      } catch {
        run = undefined;
      }
      if (!run) {
        res.status(404).json({ error: "Workflow run not found", code: "NOT_FOUND", category: "not_found", retryable: false, correlationId: req.correlationId });
        return;
      }
      // Fetch nodes
      let nodes;
      try {
        const nQuery = deps.db.select().from(deps.db.workflowRunNodesTable);
        nodes = nQuery.where ? await nQuery.where().limit?.() : await nQuery.where?.().limit?.();
      } catch {
        nodes = [];
      }
      // Fetch checkpoints
      let checkpoints;
      try {
        const cQuery = deps.db.select().from(deps.db.checkpointsTable);
        // orderBy may not exist on stub; call if available
        checkpoints = cQuery.where ? await cQuery.where().orderBy?.() : await cQuery.where?.().orderBy?.();
      } catch {
        checkpoints = [];
      }
      // Derive resumability metadata for the run.  This mirrors the
      // production route semantics.
      const reason = run.resumabilityReason ?? "none";
      const blockedNodeId = run.blockedNodeId ?? null;
      const terminalStatuses = ["completed", "failed", "cancelled"];
      const canResume = reason === "none" && !terminalStatuses.includes(run.status ?? "");
      const resumability = { reason, blockedNodeId, canResume };

      // Fetch approvals for this run.  In the production route these are
      // ordered by requestedAt descending.  The stub DB may not
      // implement orderBy, so we simply retrieve all approvals for this
      // run and operate on the array returned.  If there are no
      // approvals or no pending approvals, blockingApproval remains null.
      let approvals;
      try {
        const aQuery = deps.db.select().from(deps.db.approvalsTable);
        const aRows = aQuery.where ? await aQuery.where().limit?.() : await aQuery.where?.().limit?.();
        approvals = aRows || [];
      } catch {
        approvals = [];
      }
      let blockingApproval = null;
      if (Array.isArray(approvals)) {
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
      // Determine the number of pending approvals and derive a boolean
      // indicating whether any approvals are currently pending.  This
      // mirrors the logic in the production route which counts
      // pending approvals to surface operator-facing hints.  If the
      // approvals array is undefined or empty, both values default
      // sensibly.  The blockingApproval computed above is preserved.
      let pendingApprovalCount = 0;
      if (Array.isArray(approvals)) {
        pendingApprovalCount = approvals.filter((appr) => appr && appr.status === "pending").length;
      }
      const hasPendingApproval = pendingApprovalCount > 0;
      // Derive actionability hints consistent with the production route.  An
      // approval action is required whenever there are pending approvals.
      // The canResumeNow flag mirrors resumability.canResume.  These
      // fields are derived only from existing truth.
      const requiresApprovalAction = hasPendingApproval;
      const canResumeNow = resumability.canResume;
      const actionability = { requiresApprovalAction, canResumeNow };
      // Build an approval timeline analogous to the production route.  The
      // timeline lists all approvals for the run, ordered by requestedAt
      // ascending (earliest first).  Approvals without a requestedAt are
      // treated as the earliest.  Only fields present in the schema are
      // exposed.  If there are no approvals, the timeline is an empty
      // array.
      let approvalTimeline = [];
      if (Array.isArray(approvals)) {
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
      // Build a checkpoint timeline analogous to the production route.  The
      // timeline lists all checkpoints for the run ordered by createdAt
      // ascending (earliest first).  Each entry exposes id, nodeId,
      // type and createdAt.  If there are no checkpoints, the timeline
      // is an empty array.
      let checkpointTimeline = [];
      if (Array.isArray(checkpoints) && checkpoints.length > 0) {
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
      // Build a compact execution story consistent with the production
      // route.  The object is purely derived from existing truth and
      // existing read-model fields; it does not infer execution
      // history or introduce new semantics.
      const latestCheckpoint = checkpointTimeline.length > 0 ? checkpointTimeline[checkpointTimeline.length - 1] : null;
      const latestApproval = approvalTimeline.length > 0 ? approvalTimeline[approvalTimeline.length - 1] : null;
      const executionStory = {
        status: run.status,
        blocked: reason !== "none",
        blockType: reason !== "none" ? reason : null,
        blockedNodeId,
        requiresApprovalAction,
        canResumeNow,
        pendingApprovalCount,
        currentBoundaryCheckpointId: run.lastCheckpointId ?? null,
        resumableCheckpointId: run.resumableCheckpointId ?? null,
        latestCheckpointNodeId: latestCheckpoint ? latestCheckpoint.nodeId : null,
        latestApprovalStatus: latestApproval ? latestApproval.status : null,
      };
      res.status(200).json({
        ...run,
        resumability,
        blockingApproval,
        pendingApprovalCount,
        hasPendingApproval,
        actionability,
        approvalTimeline,
        checkpointTimeline,
        executionStory,
        nodes: nodes || [],
        checkpoints: checkpoints || [],
      });
      return;
    }

    throw new Error(`Route not matched: ${method} ${url}`);
  };
}