import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";

const contractPath = path.resolve(process.cwd(), "core/contracts/runtime-authority.json");
const contract = JSON.parse(fs.readFileSync(contractPath, "utf8")) as Record<string, unknown>;

const ajv = new Ajv({ allErrors: true });
const validateResponse = ajv.compile(contract);

export const EXECUTION_STATUS_REASON_MATRIX = (contract["x-statusReasonMatrix"] ?? {}) as Record<string, string[]>;

export function validateRuntimeAuthorityResponse(payload: unknown): void {
  if (!validateResponse(payload)) {
    const details = (validateResponse.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`).join("; ");
    throw new Error(`Runtime authority contract validation failed: ${details}`);
  }
}

export function assertKnownStatusReasonCombination(status: string, resumabilityReason?: string | null): void {
  const allowed = EXECUTION_STATUS_REASON_MATRIX[status];
  if (!allowed) {
    throw new Error(`Unknown execution status from runtime authority: ${status}`);
  }
  const effectiveReason = resumabilityReason ?? "none";
  if (!allowed.includes(effectiveReason)) {
    throw new Error(`Unknown status/reason combination from runtime authority: ${status}/${effectiveReason}`);
  }
}
