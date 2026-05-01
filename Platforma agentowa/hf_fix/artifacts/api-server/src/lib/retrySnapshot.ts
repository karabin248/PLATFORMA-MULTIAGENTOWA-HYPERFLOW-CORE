export interface ImmutableRuntimeRequest {
  prompt: string;
  agent_id?: string;
  agent_version?: string;
  agent_role?: string;
  agent_capabilities?: string[];
  run_policy?: Record<string, unknown>;
}

export interface StoredRunSnapshot {
  id: string;
  agentId: string;
  agentVersion: string;
  resolvedPrompt?: string | null;
  runtimeRequest?: Record<string, unknown> | null;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.every((item) => typeof item === "string") ? value : undefined;
}

export function buildImmutableRetryRequest(run: StoredRunSnapshot): ImmutableRuntimeRequest {
  const snapshot = (run.runtimeRequest ?? {}) as Record<string, unknown>;
  const prompt = typeof snapshot.prompt === "string" && snapshot.prompt.length > 0
    ? snapshot.prompt
    : typeof run.resolvedPrompt === "string" && run.resolvedPrompt.length > 0
      ? run.resolvedPrompt
      : null;

  if (!prompt) {
    throw new Error(`Immutable retry unavailable for legacy run '${run.id}' — runtime snapshot is missing.`);
  }

  const request: ImmutableRuntimeRequest = {
    prompt,
    agent_id: typeof snapshot.agent_id === "string" ? snapshot.agent_id : run.agentId,
    agent_version: typeof snapshot.agent_version === "string" ? snapshot.agent_version : run.agentVersion,
  };

  if (typeof snapshot.agent_role === "string" && snapshot.agent_role.length > 0) {
    request.agent_role = snapshot.agent_role;
  }

  const capabilities = asStringArray(snapshot.agent_capabilities);
  if (capabilities) {
    request.agent_capabilities = capabilities;
  }

  if (snapshot.run_policy && typeof snapshot.run_policy === "object" && !Array.isArray(snapshot.run_policy)) {
    request.run_policy = snapshot.run_policy as Record<string, unknown>;
  }

  return request;
}
