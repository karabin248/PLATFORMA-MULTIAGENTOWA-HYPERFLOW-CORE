import { randomUUID } from "crypto";

const START_TIME = Date.now();

export function makeResponseMeta() {
  return {
    requestId: randomUUID(),
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  };
}

export function makeOkResponse<T>(data: T) {
  return {
    status: "ok" as const,
    data,
    meta: makeResponseMeta(),
  };
}

export function makeErrorResponse(error: string) {
  return {
    status: "error" as const,
    error,
    meta: makeResponseMeta(),
  };
}

export function getHealthData() {
  return {
    status: "ok",
    version: "1.0.0",
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
  };
}
