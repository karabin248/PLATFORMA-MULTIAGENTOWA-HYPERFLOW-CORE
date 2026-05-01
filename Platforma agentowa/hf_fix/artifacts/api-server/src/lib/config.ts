import { logger } from "./logger";
import { emitAuditEvent } from "./audit";

export interface PlatformConfig {
  nodeEnv: string;
  hardenedMode: boolean;
  apiToken: string | null;
  coreUrl: string;
  coreTimeoutMs: number;
  defaultRunTimeoutMs: number;
  maxConcurrentRuns: number;
  maxRetryCount: number;
  bodyLimitBytes: number;
  promptMaxLength: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  rateLimitRunMaxRequests: number;
  corsOrigin: string | string[] | false;
  /** M-06: maximum number of steps allowed in a single workflow definition. */
  maxWorkflowSteps: number;
  /** M-06: maximum number of edges allowed in a single workflow definition. */
  maxWorkflowEdges: number;
}

function env(key: string, fallback?: string): string | undefined {
  return process.env[key] ?? fallback;
}

function requireEnv(key: string, hardenedMode: boolean): string {
  const value = process.env[key];
  if (!value && hardenedMode) {
    logger.fatal({ key }, "Required env var missing in hardened mode");
    process.exit(1);
  }
  return value ?? "";
}

export function loadConfig(): PlatformConfig {
  const nodeEnv = env("NODE_ENV", "development") as string;
  const hardenedMode = env("HARDENED_MODE", "true") === "true";

  const apiToken = hardenedMode
    ? requireEnv("API_TOKEN", hardenedMode)
    : env("API_TOKEN") ?? null;

  const coreUrl = env("HYPERFLOW_CORE_URL", "http://localhost:8000") as string;
  const coreTimeoutMs = Number(env("CORE_TIMEOUT_MS", "30000"));
  const defaultRunTimeoutMs = Number(env("DEFAULT_RUN_TIMEOUT_MS", "60000"));
  const maxConcurrentRuns = Number(env("MAX_CONCURRENT_RUNS", "10"));
  const maxRetryCount = Number(env("MAX_RETRY_COUNT", "3"));
  const bodyLimitBytes = Number(env("BODY_LIMIT_BYTES", "1048576"));
  const promptMaxLength = Number(env("PROMPT_MAX_LENGTH", "50000"));
  const rateLimitWindowMs = Number(env("RATE_LIMIT_WINDOW_MS", "60000"));
  const rateLimitMaxRequests = Number(env("RATE_LIMIT_MAX_REQUESTS", "100"));
  const rateLimitRunMaxRequests = Number(env("RATE_LIMIT_RUN_MAX_REQUESTS", "20"));
  const maxWorkflowSteps = Number(env("MAX_WORKFLOW_STEPS", "50"));
  const maxWorkflowEdges = Number(env("MAX_WORKFLOW_EDGES", "200"));

  const corsOriginRaw = env("CORS_ORIGIN");
  // Always trim+filter, then fold a single-element list back to a string.
  // This keeps " https://panel.example " and " a, b ,c" both well-formed,
  // and surfaces malformed values like " , " as an empty array which we
  // treat as fatal under hardened mode below.
  const corsOriginParsed: string[] = corsOriginRaw
    ? corsOriginRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const corsOrigin: string | string[] | false = hardenedMode
    ? (corsOriginParsed.length === 1
        ? corsOriginParsed[0]
        : corsOriginParsed.length > 1
          ? corsOriginParsed
          : false)
    : "*" as unknown as string;

  if (hardenedMode) {
    logger.info("Starting in HARDENED mode");
    if (!apiToken) {
      logger.fatal("API_TOKEN is required in hardened mode");
      process.exit(1);
    }
    // HYPERFLOW_CORE_TOKEN must be present so the TS shell can authenticate
    // every call to the Python core. Without it pythonClient.ts sends an empty
    // string as x-internal-token and Python rejects every request with 403 —
    // the system silently stops routing execution with no startup-time signal.
    if (!process.env.HYPERFLOW_CORE_TOKEN) {
      logger.fatal(
        "HYPERFLOW_CORE_TOKEN is required in hardened mode — " +
        "the TS shell cannot authenticate to the Python execution core. " +
        "Set HYPERFLOW_CORE_TOKEN to the same value as the Python core's HYPERFLOW_CORE_TOKEN.",
      );
      process.exit(1);
    }
    // O-1 fix: CORS_ORIGIN is mandatory under HARDENED_MODE. Without it the
    // browser-facing operator panel cannot authenticate (CORS blocks the
    // preflight) and silently floods the audit log with auth.failed events.
    // We check the *parsed* list so values like " , " or "  " also fatal,
    // not just an empty env var.
    if (corsOriginParsed.length === 0) {
      logger.fatal(
        "CORS_ORIGIN is required in hardened mode — without it browser " +
        "clients (operator panel) are blocked by CORS, cannot send the " +
        "Authorization header, and every poll lands as auth.failed. " +
        "Set CORS_ORIGIN to the panel's origin (comma-separated for multiple).",
      );
      process.exit(1);
    }
  } else {
    logger.warn(
      "⚠️  DEVELOPMENT MODE — HARDENED_MODE is not 'true'. " +
      "ALL ROUTES ARE PUBLIC (no Bearer token required). " +
      "Rate-limiting is the only remaining protection. " +
      "Set HARDENED_MODE=true and API_TOKEN in production. " +
      "Never deploy with HARDENED_MODE=false outside a private network.",
    );
    // Observability fix: emit a structured audit event so that SIEM/alerting
    // tooling can detect non-hardened startups. A warn log alone is too easy
    // to miss in aggregated log streams.
    emitAuditEvent({
      action: "server.started_insecure",
      details: {
        hardenedMode: false,
        apiTokenSet: Boolean(process.env.API_TOKEN),
        nodeEnv,
        message: "Server started with HARDENED_MODE=false — all routes are unauthenticated.",
      },
    });
  }

  return {
    nodeEnv,
    hardenedMode,
    apiToken,
    coreUrl,
    coreTimeoutMs,
    defaultRunTimeoutMs,
    maxConcurrentRuns,
    maxRetryCount,
    bodyLimitBytes,
    promptMaxLength,
    rateLimitWindowMs,
    rateLimitMaxRequests,
    rateLimitRunMaxRequests,
    corsOrigin,
    maxWorkflowSteps,
    maxWorkflowEdges,
  };
}

let _config: PlatformConfig | null = null;

export function getConfig(): PlatformConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}
