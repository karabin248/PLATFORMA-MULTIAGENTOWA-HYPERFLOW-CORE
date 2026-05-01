import { logger } from "./logger";
import { getConfig } from "./config";

// ---------------------------------------------------------------------------
// M-3 FIX: Runtime schema validation for Python core responses
//
// Previously every response was cast via `(await resp.json()) as CoreResponse`
// — TypeScript's structural cast is compile-time only and provides zero
// runtime protection.  A malformed Python response (partial failure, shape
// change, missing field) propagated silently into downstream code, causing
// undefined-property access and false-success states.
//
// We introduce a thin Zod-style manual validator that checks the fields
// every call site actually uses.  This is intentionally minimal — we do not
// replicate the full Pydantic model — but it catches the category of errors
// that cause real production failures: missing status, missing nodes array,
// and non-string error values.
//
// Validation failures surface as CoreError { code: "CORE_RESPONSE_INVALID" }
// so callers treat them identically to any other core error and do not
// proceed with undefined data.
// ---------------------------------------------------------------------------

function validateWorkflowResponse(data: unknown): asserts data is Record<string, unknown> & { status: string } {
  if (typeof data !== "object" || data === null) {
    throw new Error(`Expected object response from Python core, got ${typeof data}`);
  }
  const d = data as Record<string, unknown>;
  if (typeof d.status !== "string") {
    throw new Error(`Python core response missing required field 'status' (got ${typeof d.status})`);
  }
  if ("nodes" in d && !Array.isArray(d.nodes)) {
    throw new Error(`Python core response field 'nodes' is not an array (got ${typeof d.nodes})`);
  }
  if ("error" in d && d.error !== null && d.error !== undefined && typeof d.error !== "string") {
    throw new Error(`Python core response field 'error' is not a string (got ${typeof d.error})`);
  }
}

function getCoreUrl(): string {
  return getConfig().coreUrl;
}

function getCoreTimeoutMs(): number {
  return getConfig().coreTimeoutMs;
}

function getCoreToken(): string {
  return process.env.HYPERFLOW_CORE_TOKEN ?? "";
}

export interface CoreRunRequest {
  prompt: string;
  agent_id?: string;
  agent_version?: string;
  agent_role?: string;
  agent_capabilities?: string[];
  run_policy?: Record<string, unknown>;
}

export interface CoreResponse {
  run_id: string;
  intent: string;
  mode: string;
  output_type: string;
  result: Record<string, unknown>;
  contract: Record<string, unknown> & {
    /** Real runtime model used for the LLM call — reflects modelHint if provided. */
    modelUsed?: string;
  };
  quality_score: number;
  canonical_combo: string;
  canonical_phases: string[];
  canonical_trace: {
    canonical_combo: string;
    canonical_phases: string[];
    phases_completed: string[];
    terminal_phase: string;
    order_preserved: boolean;
    cycle_version: string;
    mps_level: number;
    mps_name: string;
    canonical_combo_detected: boolean;
  };
  status: string;
  startedAt: string;
  completedAt: string;
  /** Real runtime model used for the LLM call — top-level convenience field. */
  modelUsed?: string;
  degraded?: boolean;
  degraded_reason?: string;
  [key: string]: unknown;
}



export interface CoreWorkflowEdge {
  from: string;
  to: string;
  condition?: string;
}

export interface CoreWorkflowStepBase {
  id: string;
  type: string;
  name: string;
  dependsOn?: string[];
  input?: Record<string, unknown>;
  retryPolicy?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CoreWorkflowAgentStep extends CoreWorkflowStepBase {
  type: "agent";
  prompt: string;
  requiredCapabilities?: string[];
  handoffContract?: {
    schemaVersion?: string;
    intent: string;
    targetHint?: string;
    artifactKeys?: string[];
    openQuestions?: string[];
    successSignal?: string;
  };
  agentRef?: {
    id: string;
    version?: string;
    role?: string;
    capabilities?: string[];
    runPolicy?: Record<string, unknown>;
  };
}

export interface CoreWorkflowToolStep extends CoreWorkflowStepBase {
  type: "tool";
  action: string;
}

export interface CoreWorkflowConditionStep extends CoreWorkflowStepBase {
  type: "condition";
  expression: string;
}

export interface CoreWorkflowApprovalStep extends CoreWorkflowStepBase {
  type: "approval";
  reason: string;
  objective?: string;
  metadata?: Record<string, unknown>;
}

export interface CoreWorkflowHumanStep extends CoreWorkflowStepBase {
  type: "human";
  instruction: string;
  expectedInputSchema?: Record<string, unknown>;
}

export interface CoreWorkflowJoinStep extends CoreWorkflowStepBase {
  type: "join";
  mergePolicy?: string;
}

export interface CoreWorkflowCompensationStep extends CoreWorkflowStepBase {
  type: "compensation";
  targetNodeId: string;
  strategy?: string;
}

export type CoreWorkflowStep =
  | CoreWorkflowAgentStep
  | CoreWorkflowToolStep
  | CoreWorkflowConditionStep
  | CoreWorkflowApprovalStep
  | CoreWorkflowHumanStep
  | CoreWorkflowJoinStep
  | CoreWorkflowCompensationStep;

export interface CoreWorkflowRunRequest {
  workflowId: string;
  name?: string;
  input?: Record<string, unknown>;
  steps: CoreWorkflowStep[];
  edges?: CoreWorkflowEdge[];
  [key: string]: unknown;
}

export interface CoreWorkflowResumeRequest extends CoreWorkflowRunRequest {
  runId: string;
  completedNodes: Array<{
    nodeId: string;
    name: string;
    result?: Record<string, unknown>;
    startedAt?: string;
    completedAt?: string;
  }>;
  /**
   * Optional checkpoint boundary for resume.
   *
   * When provided, the Python core validates that this node ID is the last
   * completed node and that `completedNodes` form a contiguous topological
   * prefix up to this boundary. Requests that violate the boundary are
   * rejected with a resume validation error.
   *
   * Enforced by: workflow/executors.py :: _validate_resume_boundary()
   *
   * Omitting this field means no boundary constraint — Python resumes
   * execution from all nodes in `completedNodes` without prefix enforcement.
   */
  checkpointId?: string;
}

export interface CoreError {
  code: string;
  message: string;
  status: number;
  details?: Record<string, unknown>;
}

export type CoreResult =
  | { ok: true; data: CoreResponse }
  | { ok: false; error: CoreError };

function makeCoreError(status: number, message: string, code: string, details?: Record<string, unknown>): CoreError {
  return { code, message, status, details };
}

async function fetchCore(path: string, options: RequestInit & { timeoutMs?: number; correlationId?: string; externalSignal?: AbortSignal } = {}): Promise<Response> {
  const { timeoutMs = getCoreTimeoutMs(), correlationId, externalSignal, ...fetchOpts } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (externalSignal) {
    externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const headers: Record<string, string> = {
    ...(fetchOpts.headers as Record<string, string> || {}),
  };
  if (correlationId) {
    headers["x-correlation-id"] = correlationId;
  }
  if (timeoutMs) {
    headers["x-timeout-hint-ms"] = String(timeoutMs);
  }
  const coreToken = getCoreToken();
  if (coreToken) {
    headers["x-internal-token"] = coreToken;
  }

  try {
    const resp = await fetch(`${getCoreUrl()}${path}`, {
      ...fetchOpts,
      headers,
      signal: controller.signal,
    });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

export async function health(): Promise<CoreResult> {
  try {
    const resp = await fetchCore("/v1/health");
    if (!resp.ok) {
      return { ok: false, error: makeCoreError(resp.status, "Core health check failed", "CORE_UNHEALTHY") };
    }
    const data = (await resp.json()) as unknown;
    try {
      validateWorkflowResponse(data);
    } catch (validationErr) {
      const msg = validationErr instanceof Error ? validationErr.message : String(validationErr);
      logger.error({ msg, url: "/v1/health" }, "Python core response failed validation");
      return { ok: false, error: makeCoreError(502, msg, "CORE_RESPONSE_INVALID") };
    }
    return { ok: true, data: data as CoreResponse };
  } catch (err) {
    logger.error({ err }, "Core health check unreachable");
    return { ok: false, error: makeCoreError(503, "Core unreachable", "CORE_UNREACHABLE") };
  }
}

export async function run(prompt: string, timeoutMs?: number, correlationId?: string, externalSignal?: AbortSignal): Promise<CoreResult> {
  try {
    const resp = await fetchCore("/v1/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
      timeoutMs,
      correlationId,
      externalSignal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "unknown");
      return {
        ok: false,
        error: makeCoreError(resp.status, `Core returned ${resp.status}: ${text.slice(0, 200)}`, "CORE_ERROR"),
      };
    }

    const data = (await resp.json()) as unknown;
    try {
      validateWorkflowResponse(data);
    } catch (validationErr) {
      const msg = validationErr instanceof Error ? validationErr.message : String(validationErr);
      logger.error({ msg, url: "/v1/run" }, "Python core response failed validation");
      return { ok: false, error: makeCoreError(502, msg, "CORE_RESPONSE_INVALID") };
    }
    if ((data as Record<string, unknown>).error) {
      return {
        ok: false,
        error: makeCoreError(422, String((data as Record<string, unknown>).error), "CORE_EXECUTION_ERROR", data as unknown as Record<string, unknown>),
      };
    }
    return { ok: true, data: data as CoreResponse };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      if (externalSignal?.aborted) {
        return { ok: false, error: makeCoreError(499, "Run cancelled", "RUN_CANCELLED") };
      }
      return { ok: false, error: makeCoreError(504, "Core request timed out", "CORE_TIMEOUT") };
    }
    logger.error({ err }, "Core run call failed");
    return { ok: false, error: makeCoreError(503, "Core unreachable", "CORE_UNREACHABLE") };
  }
}

export async function runAgent(request: CoreRunRequest, timeoutMs?: number, correlationId?: string, externalSignal?: AbortSignal): Promise<CoreResult> {
  try {
    const resp = await fetchCore("/v1/agent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      timeoutMs,
      correlationId,
      externalSignal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "unknown");
      return {
        ok: false,
        error: makeCoreError(resp.status, `Core returned ${resp.status}: ${text.slice(0, 200)}`, "CORE_ERROR"),
      };
    }

    const data = (await resp.json()) as unknown;
    try {
      validateWorkflowResponse(data);
    } catch (validationErr) {
      const msg = validationErr instanceof Error ? validationErr.message : String(validationErr);
      logger.error({ msg, url: "/v1/agent/run" }, "Python core response failed validation");
      return { ok: false, error: makeCoreError(502, msg, "CORE_RESPONSE_INVALID") };
    }
    if ((data as Record<string, unknown>).error) {
      return {
        ok: false,
        error: makeCoreError(422, String((data as Record<string, unknown>).error), "CORE_EXECUTION_ERROR", data as unknown as Record<string, unknown>),
      };
    }
    return { ok: true, data: data as CoreResponse };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      if (externalSignal?.aborted) {
        return { ok: false, error: makeCoreError(499, "Run cancelled", "RUN_CANCELLED") };
      }
      return { ok: false, error: makeCoreError(504, "Core request timed out", "CORE_TIMEOUT") };
    }
    logger.error({ err }, "Core agent run call failed");
    return { ok: false, error: makeCoreError(503, "Core unreachable", "CORE_UNREACHABLE") };
  }
}



export async function runWorkflow(request: CoreWorkflowRunRequest, timeoutMs?: number, correlationId?: string, externalSignal?: AbortSignal): Promise<CoreResult> {
  try {
    const resp = await fetchCore("/v1/workflow/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      timeoutMs,
      correlationId,
      externalSignal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "unknown");
      return { ok: false, error: makeCoreError(resp.status, `Core returned ${resp.status}: ${text.slice(0, 200)}`, "CORE_ERROR") };
    }

    const data = (await resp.json()) as unknown;
    // M-3 FIX: validate response shape before returning to callers.
    try {
      validateWorkflowResponse(data);
    } catch (validationErr) {
      const msg = validationErr instanceof Error ? validationErr.message : String(validationErr);
      logger.error({ msg, url: "/v1/workflow/run" }, "Python core response failed validation");
      return { ok: false, error: makeCoreError(502, msg, "CORE_RESPONSE_INVALID") };
    }
    return { ok: true, data: data as CoreResponse };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      if (externalSignal?.aborted) {
        return { ok: false, error: makeCoreError(499, "Workflow run cancelled", "RUN_CANCELLED") };
      }
      return { ok: false, error: makeCoreError(504, "Workflow request timed out", "CORE_TIMEOUT") };
    }
    logger.error({ err }, "Core workflow run call failed");
    return { ok: false, error: makeCoreError(503, "Core unreachable", "CORE_UNREACHABLE") };
  }
}

export async function resumeWorkflow(request: CoreWorkflowResumeRequest, timeoutMs?: number, correlationId?: string, externalSignal?: AbortSignal): Promise<CoreResult> {
  try {
    const resp = await fetchCore("/v1/workflow/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      timeoutMs,
      correlationId,
      externalSignal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "unknown");
      return { ok: false, error: makeCoreError(resp.status, `Core returned ${resp.status}: ${text.slice(0, 200)}`, "CORE_ERROR") };
    }

    const data = (await resp.json()) as unknown;
    // M-3 FIX: validate response shape before returning to callers.
    try {
      validateWorkflowResponse(data);
    } catch (validationErr) {
      const msg = validationErr instanceof Error ? validationErr.message : String(validationErr);
      logger.error({ msg, url: "/v1/workflow/resume" }, "Python core response failed validation");
      return { ok: false, error: makeCoreError(502, msg, "CORE_RESPONSE_INVALID") };
    }
    return { ok: true, data: data as CoreResponse };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      if (externalSignal?.aborted) {
        return { ok: false, error: makeCoreError(499, "Workflow resume cancelled", "RUN_CANCELLED") };
      }
      return { ok: false, error: makeCoreError(504, "Workflow resume timed out", "CORE_TIMEOUT") };
    }
    logger.error({ err }, "Core workflow resume call failed");
    return { ok: false, error: makeCoreError(503, "Core unreachable", "CORE_UNREACHABLE") };
  }
}

// ---------------------------------------------------------------------------
// Continuation types
// ---------------------------------------------------------------------------

export interface CoreApprovalContinuationRequest {
  runId: string;
  nodeId: string;
  workflowId: string;
  name?: string;
  input?: Record<string, unknown>;
  steps: CoreWorkflowStep[];
  edges?: CoreWorkflowEdge[];
  completedNodes: Array<{
    nodeId: string;
    name: string;
    result?: Record<string, unknown>;
    startedAt?: string;
    completedAt?: string;
  }>;
  approvedBy?: string;
  note?: string;
}

export interface CoreHumanInputContinuationRequest {
  runId: string;
  nodeId: string;
  workflowId: string;
  name?: string;
  input?: Record<string, unknown>;
  steps: CoreWorkflowStep[];
  edges?: CoreWorkflowEdge[];
  completedNodes: Array<{
    nodeId: string;
    name: string;
    result?: Record<string, unknown>;
    startedAt?: string;
    completedAt?: string;
  }>;
  humanInput: Record<string, unknown>;
  actorId?: string;
}

export async function continueApproval(
  request: CoreApprovalContinuationRequest,
  timeoutMs?: number,
  correlationId?: string,
  externalSignal?: AbortSignal,
): Promise<CoreResult> {
  try {
    const resp = await fetchCore("/v1/workflow/continue/approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      timeoutMs,
      correlationId,
      externalSignal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "unknown");
      return { ok: false, error: makeCoreError(resp.status, `Core returned ${resp.status}: ${text.slice(0, 200)}`, "CORE_ERROR") };
    }
    const data = (await resp.json()) as unknown;
    try {
      validateWorkflowResponse(data);
    } catch (validationErr) {
      const msg = validationErr instanceof Error ? validationErr.message : String(validationErr);
      logger.error({ msg, url: "/v1/workflow/continue/approval" }, "Python core response failed validation");
      return { ok: false, error: makeCoreError(502, msg, "CORE_RESPONSE_INVALID") };
    }
    return { ok: true, data: data as CoreResponse };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      if (externalSignal?.aborted) return { ok: false, error: makeCoreError(499, "Approval continuation cancelled", "RUN_CANCELLED") };
      return { ok: false, error: makeCoreError(504, "Approval continuation timed out", "CORE_TIMEOUT") };
    }
    logger.error({ err }, "Core approval continuation call failed");
    return { ok: false, error: makeCoreError(503, "Core unreachable", "CORE_UNREACHABLE") };
  }
}

export async function continueHumanInput(
  request: CoreHumanInputContinuationRequest,
  timeoutMs?: number,
  correlationId?: string,
  externalSignal?: AbortSignal,
): Promise<CoreResult> {
  try {
    const resp = await fetchCore("/v1/workflow/continue/human-input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      timeoutMs,
      correlationId,
      externalSignal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "unknown");
      return { ok: false, error: makeCoreError(resp.status, `Core returned ${resp.status}: ${text.slice(0, 200)}`, "CORE_ERROR") };
    }
    const data = (await resp.json()) as unknown;
    try {
      validateWorkflowResponse(data);
    } catch (validationErr) {
      const msg = validationErr instanceof Error ? validationErr.message : String(validationErr);
      logger.error({ msg, url: "/v1/workflow/continue/human-input" }, "Python core response failed validation");
      return { ok: false, error: makeCoreError(502, msg, "CORE_RESPONSE_INVALID") };
    }
    return { ok: true, data: data as CoreResponse };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      if (externalSignal?.aborted) return { ok: false, error: makeCoreError(499, "Human-input continuation cancelled", "RUN_CANCELLED") };
      return { ok: false, error: makeCoreError(504, "Human-input continuation timed out", "CORE_TIMEOUT") };
    }
    logger.error({ err }, "Core human-input continuation call failed");
    return { ok: false, error: makeCoreError(503, "Core unreachable", "CORE_UNREACHABLE") };
  }
}

export const pythonClient = { health, run, runAgent, runWorkflow, resumeWorkflow, continueApproval, continueHumanInput };
export default pythonClient;

// ---------------------------------------------------------------------------
// Named-export wrappers used by repositories.ts and runs.ts routes.
// These call the Python core directly and throw typed exceptions on failure.
// ---------------------------------------------------------------------------

export class PythonCoreUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PythonCoreUnavailable";
  }
}

export class PythonCoreError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "PythonCoreError";
    this.status = status;
  }
}

/**
 * PythonWorkflowStep was a narrow agent-only interface (id, name, prompt, dependsOn)
 * that lacked the required `type` field, making it unusable for non-agent steps.
 * Replaced with CoreWorkflowStep for full contract alignment with the Python runtime.
 *
 * If you need to constrain to agent-only steps, use:
 *   CoreWorkflowStep & { type: "agent" }
 */
export type PythonWorkflowStep = CoreWorkflowStep;

export interface PythonRepositoryScanInput {
  repositories: Array<{ id: string; name: string; url: string }>;
}

export type PythonScanStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface PythonRepositoryScanResponse {
  runId: string;
  status: PythonScanStatus;
  progress: number;
  startedAt: string;
  completedAt?: string | null;
  error?: string | null;
  repos: Array<{
    id: string;
    language: string;
    classification: string;
    dependencyCount: number;
    overlapScore: number | null;
  }>;
}

export interface PythonRepositoryGraphInput {
  repositories: Array<{
    id: string;
    name: string;
    language: string;
    classification: string;
    dependencyCount: number;
  }>;
}

export interface PythonRepositoryGraphResponse {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  overlapPairs: Array<Record<string, unknown>>;
}

export interface PythonResumeNodeRecord {
  nodeId: string;
  name: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped" | "compensated" | "succeeded" | "waiting_approval" | "waiting_input";
  startedAt: string | null;
  completedAt: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

/**
 * WorkflowResumeResponse — the true shape returned by Python /v1/workflow/resume.
 *
 * Previously this was typed as PythonWorkflowResumeResponse using PythonScanStatus
 * and a `progress` field — a copy-paste from the repository-scan response. That was
 * incorrect. Python's workflow resume endpoint returns execution state, not scan
 * progress. This type now reflects the actual response documented in main.py and
 * enforced by the bridge-contract test (section H).
 *
 * Fields:
 *   runId               — stable run identity (from CoreWorkflowResumeRequest.runId)
 *   workflowId          — workflow identity
 *   name                — workflow name
 *   status              — final execution status from Python core
 *   nodes               — per-node execution records
 *   startedAt           — ISO-8601 resume start timestamp
 *   completedAt         — ISO-8601 resume end timestamp
 *   checkpointId        — last checkpoint node ID if execution paused at a boundary
 *   blockedNodeId       — node ID that blocked progression (approval / human gate)
 *   resumabilityReason  — why execution is resumable or "none"
 *   degraded            — true if any node ran in degraded mode
 *   degraded_reason     — human-readable degraded reason
 *   error               — top-level error string on terminal failure
 */
export interface WorkflowResumeResponse {
  runId: string;
  workflowId: string;
  name: string;
  status: string;
  nodes: PythonResumeNodeRecord[];
  startedAt: string;
  completedAt: string;
  checkpointId?: string | null;
  blockedNodeId?: string | null;
  resumabilityReason?: string;
  degraded?: boolean;
  degraded_reason?: string | null;
  error?: string | null;
}

/**
 * @deprecated Use WorkflowResumeResponse.
 * PythonWorkflowResumeResponse was incorrectly modelled as a scan-progress payload
 * (PythonScanStatus + progress: number). The actual /v1/workflow/resume response is
 * execution state, not scan state. This alias exists only to avoid a hard break if
 * any existing internal callers still reference the old name; new code must use
 * WorkflowResumeResponse directly.
 */
export type PythonWorkflowResumeResponse = WorkflowResumeResponse;
export interface PythonWorkflowResumeInput {
  runId: string;
  workflowId: string;
  name: string;
  steps: PythonWorkflowStep[];
  completedNodes: Array<{
    nodeId: string;
    name: string;
    result?: Record<string, unknown> | null;
    startedAt?: string | null;
    completedAt?: string | null;
  }>;
}

async function postCore<T>(path: string, body: unknown): Promise<T> {
  let resp: Response;
  try {
    resp = await fetchCore(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PythonCoreUnavailable(`Python core unreachable: ${message}`);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new PythonCoreError(
      `Python core returned ${resp.status}: ${text.slice(0, 500)}`,
      resp.status,
    );
  }

  return (await resp.json()) as T;
}

export async function callPythonRepositoryScan(
  input: PythonRepositoryScanInput,
): Promise<PythonRepositoryScanResponse> {
  return postCore<PythonRepositoryScanResponse>("/v1/repositories/scan", input);
}

export async function callPythonRepositoryGraph(
  input: PythonRepositoryGraphInput,
): Promise<PythonRepositoryGraphResponse> {
  return postCore<PythonRepositoryGraphResponse>(
    "/v1/repositories/graph",
    input,
  );
}

export async function callPythonWorkflowResume(
  input: PythonWorkflowResumeInput,
): Promise<WorkflowResumeResponse> {
  return postCore<WorkflowResumeResponse>(
    "/v1/workflow/resume",
    input,
  );
}
