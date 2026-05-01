import type { WorkflowRun } from "@workspace/db";
import type { WorkflowCheckpoint } from "@workspace/db";

export interface ResumeValidationResult {
  ok: boolean;
  checkpointId?: string;
  error?: string;
}

/**
 * Validate that a resume attempt is coherent with the current run and its checkpoint lineage.
 *
 * - If a checkpointId is provided explicitly, it must belong to the run and must be the latest
 *   checkpoint recorded for that run. Otherwise it is considered stale or invalid.
 * - If no checkpointId is provided, the run's resumableCheckpointId or lastCheckpointId will be
 *   used. If none exist, the run is not resumable.
 *
 * This function does not check approval gating or terminal status; those checks should occur
 * separately in the route handler.
 */
export function validateResumeCheckpoint(
  run: Partial<WorkflowRun> & { id: string; resumableCheckpointId?: string | null; lastCheckpointId?: string | null },
  checkpointId: string | undefined | null,
  checkpoints: Array<Pick<WorkflowCheckpoint, "id" | "runId">>,
): ResumeValidationResult {
  // Determine the candidate checkpoint ID: explicit param or the run's resumable/latest checkpoint
  const candidateId = checkpointId ?? run.resumableCheckpointId ?? run.lastCheckpointId ?? null;
  if (!candidateId) {
    return { ok: false, error: "No resumable checkpoint available" };
  }
  // Ensure the checkpoint belongs to this run
  const found = checkpoints.some((c) => c.id === candidateId && c.runId === run.id);
  if (!found) {
    return { ok: false, error: "Checkpoint does not belong to this run" };
  }
  // Ensure the checkpoint is the latest one to prevent resuming from stale state
  if (run.lastCheckpointId && candidateId !== run.lastCheckpointId) {
    return { ok: false, error: "Checkpoint is not the latest resumable checkpoint" };
  }
  return { ok: true, checkpointId: candidateId };
}