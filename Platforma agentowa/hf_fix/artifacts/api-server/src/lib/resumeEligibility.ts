import { validateResumeCheckpoint } from "./resumeValidator";

/**
 * Determine whether a workflow run is eligible for resumption based on its status
 * and the number of outstanding approval requests. This helper centralises the
 * core resume gating logic used by the API server. It returns a simple
 * success/failure result and an explanatory error message when the run should
 * not be resumed. This function does not perform checkpoint lineage checks;
 * that responsibility remains with validateResumeCheckpoint().
 *
 * @param run The workflow run record including status and approvalState
 * @param pendingApprovals The number of pending approval requests for the run
 * @returns An object with ok=true when resume is allowed; otherwise ok=false and an error
 */
export function evaluateResumeEligibility(
  run: { status: string; approvalState?: string | null },
  pendingApprovals: number,
): { ok: true } | { ok: false; error: string } {
  // Terminal states cannot be resumed. Mirror the same logic from the route.
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    return { ok: false, error: `Cannot resume a run in terminal state '${run.status}'` };
  }
  // Any pending approvals (either via explicit approval records or approvalState) block resumption.
  if (pendingApprovals > 0 || run.approvalState === "pending") {
    return { ok: false, error: "Cannot resume while approvals are pending" };
  }
  return { ok: true };
}

/**
 * Execute a resume operation by first gating against the run status, approval
 * backlog and checkpoint lineage, then delegating to the Python core. This
 * helper encapsulates the orchestration semantics of resuming a workflow run.
 *
 * When the run is not eligible or the checkpoint lineage is invalid the
 * function returns an error and does not call the core. If eligible it will
 * construct a resume request by merging the run's runtimeRequest with the
 * run identifier and completedNodes.  When a checkpoint boundary exists it
 * will translate the persisted checkpoint UUID into the corresponding
 * workflow node identifier and forward that as `checkpointId`.  The Python
 * core interprets this boundary token as the identifier of the last
 * completed node and will enforce prefix/contiguity semantics.  Omitting
 * the field signals that no boundary should be imposed.
 *
 * @param run The workflow run record containing status, approvalState and runtimeRequest
 * @param requestedCheckpointId Optional checkpoint identifier supplied by the caller
 * @param completedNodes Array of node summaries already completed in this resume attempt
 * @param pendingApprovals Number of pending approval requests for this run
 * @param checkpoints Array of checkpoints belonging to the run, used for lineage validation
 * @param pythonClient The pythonClient with a resumeWorkflow method to call the core
 * @returns A promise resolving to either an error result or a success result with the core response and the resume request used
 */
export async function executeResumeOrchestration({
  run,
  requestedCheckpointId,
  completedNodes,
  pendingApprovals,
  checkpoints,
  pythonClient,
}: {
  run: {
    id: string;
    status: string;
    approvalState?: string | null;
    runtimeRequest: Record<string, unknown> | null;
    lastCheckpointId?: string | null;
    resumableCheckpointId?: string | null;
  };
  requestedCheckpointId?: string | null;
  completedNodes: Array<{ nodeId: string; name: string; result?: Record<string, unknown>; startedAt?: string; completedAt?: string }>;
  pendingApprovals: number;
  /**
   * Persisted checkpoint metadata for the run.  Each entry includes the
   * database‑backed checkpoint UUID as `id`, the owning run identifier as
   * `runId` and, when available, the associated workflow node identifier as
   * `nodeId`.  The Python core interprets `checkpointId` as the node
   * identifier of the last completed boundary, so this helper must translate
   * persisted checkpoint UUIDs into node IDs before forwarding.
   */
  checkpoints: Array<{ id: string; runId: string; nodeId?: string | null }>;
  pythonClient: {
    resumeWorkflow: (request: Record<string, unknown>) => Promise<{ ok: boolean; data?: Record<string, unknown>; error?: { message?: string } }>;
  };
}): Promise<
  | { ok: true; response: Record<string, unknown>; resumeRequest: Record<string, unknown> }
  | { ok: false; error: string }
> {
  // Ensure a runtime request exists on the run; if not, treat as not resumable
  if (!run.runtimeRequest) {
    return { ok: false, error: "Workflow run not found" };
  }
  // Apply basic status/approval gating
  const eligibility = evaluateResumeEligibility(run, pendingApprovals);
  if (!eligibility.ok) {
    return { ok: false, error: eligibility.error };
  }
  // Validate checkpoint lineage using the helper. This ensures the requested
  // checkpoint (or default) belongs to the run and is the latest resumable
  // checkpoint. The validator returns ok=false with an error message when
  // lineage conditions are not satisfied.
  const checkpointValidation = validateResumeCheckpoint(
    { id: run.id, lastCheckpointId: run.lastCheckpointId ?? null, resumableCheckpointId: run.resumableCheckpointId ?? null },
    requestedCheckpointId,
    checkpoints,
  );
  if (!checkpointValidation.ok) {
    return { ok: false, error: checkpointValidation.error ?? "Invalid checkpoint" };
  }
  // Construct the resume request by merging the runtimeRequest with the run
  // identifier and completedNodes. To derive the checkpoint boundary, first
  // determine the persisted checkpoint UUID that should serve as the boundary.
  // The caller may have supplied a checkpointId explicitly; if so, use it.
  // Otherwise fall back to the run's most recent resumable or last
  // checkpoint.  When all candidates are null, no checkpointId will be
  // forwarded.  Once a candidate persisted ID is selected, translate it to
  // the corresponding workflow node identifier because the Python core
  // interprets the checkpointId parameter as the identifier of the last
  // completed node and enforces contiguous-prefix semantics.  If a
  // persisted checkpoint lacks a nodeId mapping, omit the field.
  let candidatePersistedId: string | undefined;
  if (requestedCheckpointId) {
    candidatePersistedId = requestedCheckpointId;
  } else if (run.resumableCheckpointId) {
    candidatePersistedId = run.resumableCheckpointId;
  } else if (run.lastCheckpointId) {
    candidatePersistedId = run.lastCheckpointId;
  }
  // Translate the persisted checkpoint UUID into the corresponding workflow
  // node identifier.  The Python core interprets the checkpointId field as
  // the identifier of the last completed node.  If the mapping cannot be
  // resolved (e.g. missing nodeId), the field is omitted from the request.
  let checkpointToForward: string | undefined;
  if (candidatePersistedId) {
    const row = checkpoints.find((c) => c.id === candidatePersistedId && c.runId === run.id);
    if (row && row.nodeId) {
      checkpointToForward = String(row.nodeId);
    }
  }
  const resumeRequest: Record<string, unknown> = {
    ...(run.runtimeRequest ?? {}),
    runId: run.id,
    completedNodes,
    ...(checkpointToForward ? { checkpointId: checkpointToForward } : {}),
  };
  try {
    const coreResult = await pythonClient.resumeWorkflow(resumeRequest);
    if (!coreResult.ok) {
      const errorMsg = coreResult.error?.message ?? "Core resume failed";
      return { ok: false, error: errorMsg };
    }
    return { ok: true, response: coreResult.data ?? {}, resumeRequest };
  } catch (err) {
    // Surface unexpected errors as a generic failure. The API server's route
    // handler should wrap these via classifyError.
    return { ok: false, error: (err as Error).message ?? "Unknown resume error" };
  }
}