import { CreateAgentBody, UpdateAgentBody } from "@workspace/api-zod";
import { ZodError } from "zod";

export interface ValidationError {
  field: string;
  message: string;
}

export interface CreateAgentPayload {
  id: string;
  name: string;
  version: string;
  description: string;
  status: string;
  role: string;
  capabilities: string[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  runtimeMode: string;
  executionPolicy: Record<string, unknown>;
  promptTemplate: string;
  tags: string[];
  owner: string | null;
}

export type UpdateAgentPayload = Partial<Omit<CreateAgentPayload, "id">>;

function zodToValidationErrors(error: ZodError): ValidationError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "_",
    message: issue.message,
  }));
}

export function validateCreateAgent(
  data: unknown,
): { ok: true; data: CreateAgentPayload } | { ok: false; errors: ValidationError[] } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, errors: [{ field: "_", message: "Request body must be a JSON object" }] };
  }

  const result = CreateAgentBody.safeParse(data);
  if (!result.success) {
    return { ok: false, errors: zodToValidationErrors(result.error) };
  }

  const raw = data as Record<string, unknown>;
  const VALID_STATUSES = ["active", "disabled", "deprecated"];
  const rawStatus = typeof raw.status === "string" ? raw.status : undefined;
  const rawOwner = typeof raw.owner === "string" ? raw.owner : undefined;

  return {
    ok: true,
    data: {
      id: result.data.id,
      name: result.data.name,
      version: result.data.version,
      description: result.data.description ?? "",
      status: rawStatus && VALID_STATUSES.includes(rawStatus) ? rawStatus : "active",
      role: result.data.role ?? "assistant",
      capabilities: result.data.capabilities ?? [],
      inputSchema: (result.data.inputSchema ?? {}) as Record<string, unknown>,
      outputSchema: (result.data.outputSchema ?? {}) as Record<string, unknown>,
      runtimeMode: result.data.runtimeMode ?? "standard",
      executionPolicy: (result.data.executionPolicy ?? {}) as Record<string, unknown>,
      promptTemplate: result.data.promptTemplate ?? "{{input.prompt}}",
      tags: result.data.tags ?? [],
      owner: rawOwner ?? null,
    },
  };
}

export function validateUpdateAgent(
  data: unknown,
): { ok: true; data: UpdateAgentPayload } | { ok: false; errors: ValidationError[] } {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, errors: [{ field: "_", message: "Request body must be a JSON object" }] };
  }

  const result = UpdateAgentBody.safeParse(data);
  if (!result.success) {
    return { ok: false, errors: zodToValidationErrors(result.error) };
  }

  const updates: UpdateAgentPayload = {};
  if (result.data.name !== undefined) updates.name = result.data.name;
  if (result.data.version !== undefined) updates.version = result.data.version;
  if (result.data.description !== undefined) updates.description = result.data.description;
  if (result.data.role !== undefined) updates.role = result.data.role;
  if (result.data.capabilities !== undefined) updates.capabilities = result.data.capabilities;
  if (result.data.inputSchema !== undefined)
    updates.inputSchema = result.data.inputSchema as Record<string, unknown>;
  if (result.data.outputSchema !== undefined)
    updates.outputSchema = result.data.outputSchema as Record<string, unknown>;
  if (result.data.runtimeMode !== undefined) updates.runtimeMode = result.data.runtimeMode;
  if (result.data.executionPolicy !== undefined)
    updates.executionPolicy = result.data.executionPolicy as Record<string, unknown>;
  if (result.data.promptTemplate !== undefined) updates.promptTemplate = result.data.promptTemplate;
  if (result.data.tags !== undefined) updates.tags = result.data.tags;
  if (result.data.owner !== undefined) updates.owner = result.data.owner ?? null;

  return { ok: true, data: updates };
}
