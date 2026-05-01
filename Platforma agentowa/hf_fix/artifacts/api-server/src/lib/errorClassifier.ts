export type ErrorCategory =
  | "validation_error"
  | "core_unreachable"
  | "core_error"
  | "core_execution_error"
  | "timeout"
  | "auth_error"
  | "rate_limited"
  | "concurrency_limit"
  | "persistence_error"
  | "payload_too_large"
  | "conflict"
  | "not_found"
  | "internal_error";

export interface ClassifiedError {
  category: ErrorCategory;
  code: string;
  message: string;
  statusCode: number;
  retryable: boolean;
}

export function classifyError(err: unknown, context?: string): ClassifiedError {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();

    if (msg.includes("timeout") || msg.includes("aborted") || msg.includes("timed out")) {
      return {
        category: "timeout",
        code: "TIMEOUT",
        message: err.message,
        statusCode: 504,
        retryable: true,
      };
    }

    if (msg.includes("econnrefused") || msg.includes("unreachable")) {
      return {
        category: "core_unreachable",
        code: "CORE_UNREACHABLE",
        message: err.message,
        statusCode: 503,
        retryable: true,
      };
    }

    if (msg.includes("core_execution_error") || msg.includes("execution error")) {
      return {
        category: "core_execution_error",
        code: "CORE_EXECUTION_ERROR",
        message: err.message,
        statusCode: 422,
        retryable: false,
      };
    }

    if (msg.includes("core error") || msg.includes("core returned")) {
      return {
        category: "core_error",
        code: "CORE_ERROR",
        message: err.message,
        statusCode: 502,
        retryable: true,
      };
    }

    if (msg.includes("validation") || msg.includes("invalid") || msg.includes("required")) {
      return {
        category: "validation_error",
        code: "VALIDATION_ERROR",
        message: err.message,
        statusCode: 400,
        retryable: false,
      };
    }

    if (msg.includes("too large") || msg.includes("payload")) {
      return {
        category: "payload_too_large",
        code: "PAYLOAD_TOO_LARGE",
        message: err.message,
        statusCode: 413,
        retryable: false,
      };
    }

    if (msg.includes("database") || msg.includes("pg") || msg.includes("sql") || msg.includes("drizzle")) {
      return {
        category: "persistence_error",
        code: "PERSISTENCE_ERROR",
        message: err.message,
        statusCode: 500,
        retryable: true,
      };
    }
  }

  return {
    category: "internal_error",
    code: "INTERNAL_ERROR",
    message: err instanceof Error ? err.message : String(err),
    statusCode: 500,
    retryable: false,
  };
}

export function classifyCoreError(coreCode: string, message: string): ClassifiedError {
  switch (coreCode) {
    case "CORE_UNREACHABLE":
      return { category: "core_unreachable", code: coreCode, message, statusCode: 503, retryable: true };
    case "CORE_TIMEOUT":
      return { category: "timeout", code: coreCode, message, statusCode: 504, retryable: true };
    case "CORE_ERROR":
    case "CORE_UNHEALTHY":
      return { category: "core_error", code: coreCode, message, statusCode: 502, retryable: true };
    case "CORE_EXECUTION_ERROR":
      return { category: "core_execution_error", code: coreCode, message, statusCode: 422, retryable: false };
    case "RUN_CANCELLED":
      return { category: "conflict", code: coreCode, message, statusCode: 499, retryable: false };
    case "CONCURRENCY_LIMIT":
      return { category: "concurrency_limit", code: coreCode, message, statusCode: 429, retryable: true };
    default:
      return { category: "internal_error", code: coreCode, message, statusCode: 500, retryable: false };
  }
}
