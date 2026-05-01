// Extended run status to match richer orchestration semantics.
// The donor orchestration contracts include `waiting_approval` and `waiting_input`
// statuses for runs. When an approval is requested the run moves from `running`
// to `waiting_approval`. When a human-input node is reached it moves to
// `waiting_input`. Once the decision/input is supplied the run may transition
// back to `running` or end in a terminal state.
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Valid state transitions for workflow runs.
 *
 * The donor runtime exposes a richer set of lifecycle states including
 * `waiting_approval` and `waiting_input`. We allow runs to transition from
 * `queued` into either `running` or directly into a waiting state (for
 * workflows that start with an approval or human-input gate). A running run
 * can pause at either gate. Once the input/approval has been recorded, the run
 * can either continue running or move into a terminal state.
 */
const VALID_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued:           ["running", "waiting_approval", "waiting_input", "cancelled"],
  running:          ["waiting_approval", "waiting_input", "completed", "failed", "cancelled"],
  waiting_approval: ["running", "completed", "failed", "cancelled"],
  waiting_input:    ["running", "completed", "failed", "cancelled"],
  completed:        [],
  failed:           [],
  cancelled:        [],
};

export interface TransitionResult {
  ok: boolean;
  error?: string;
}

export function canTransition(from: RunStatus, to: RunStatus): TransitionResult {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) {
    return { ok: false, error: `Unknown status: ${from}` };
  }
  if (!allowed.includes(to)) {
    return { ok: false, error: `Invalid transition: ${from} → ${to}. Allowed: ${allowed.join(", ") || "none"}` };
  }
  return { ok: true };
}

export function isTerminal(status: RunStatus): boolean {
  // `waiting_approval` is not a terminal state because work can resume once a decision is made.
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function isRetryable(status: RunStatus): boolean {
  return status === "failed";
}
