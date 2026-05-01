import { Router, type IRouter, type Request, type Response } from "express";
import { db, agentRunsTable } from "@workspace/db";
import { eq, desc, gte, lte, and, like, sql } from "drizzle-orm";
import { RunAgentBody, RetryRunBody, ListRunsQueryParams, RunAgentResponse, GetRunResponse } from "@workspace/api-zod";
import { resolveAgent } from "../domain/catalog";
import type { AgentRunRequest } from "../domain/agentRuns";
import { pythonClient, type CoreResponse } from "../lib/pythonClient";
import { normalizeOutput } from "../lib/outputNormalizer";
import { canTransition, isRetryable, type RunStatus } from "../lib/runLifecycle";
import { hydrateTemplate } from "../lib/promptHydrator";
import { validateJsonSchema } from "../lib/schemaValidator";
import { logger } from "../lib/logger";
import { emitAuditEvent } from "../lib/auditLog";
import { classifyError, classifyCoreError } from "../lib/errorClassifier";
import { metrics } from "../lib/metrics";
import { inFlightRegistry } from "../lib/inFlightRegistry";
import { getConfig } from "../lib/config";
import { randomUUID } from "crypto";
import { buildImmutableRetryRequest } from "../lib/retrySnapshot";
import { parseWithSchema, assertResponseShape } from "../lib/contractValidation";

const router: IRouter = Router();

function zodErrorResponse(error: unknown) {
  const zodError = error as { issues?: Array<{ path: (string | number)[]; message: string }> };
  if (zodError.issues) {
    return zodError.issues.map((i) => ({
      field: i.path.join(".") || "_",
      message: i.message,
    }));
  }
  return [{ field: "_", message: String(error) }];
}

function buildRunUpdates(coreData: CoreResponse, startTime: Date) {
  const completedAt = new Date();
  const normalized = normalizeOutput(coreData);

  // Persist the full EDDE phase trace returned by the Python core so operators
  // can audit phase-level quality and detect stub-LLM regressions long after
  // the run completes. Cast through unknown — CoreResponse uses an index
  // signature for forward-compatible fields like phases.
  const phasesRaw = (coreData as unknown as { phases?: unknown }).phases;
  const phases =
    phasesRaw && typeof phasesRaw === "object" && !Array.isArray(phasesRaw)
      ? (phasesRaw as Record<string, Record<string, unknown>>)
      : null;

  const degraded = coreData.degraded === true;

  return {
    runtimeRunId: coreData.run_id || null,
    runtimeResponse: coreData as unknown as Record<string, unknown>,
    output: (coreData.result as Record<string, unknown>) || null,
    normalizedOutput: normalized as typeof agentRunsTable.$inferInsert.normalizedOutput,
    rawOutput: coreData as unknown as Record<string, unknown>,
    resolvedPrompt: null as string | null,
    qualityScore: coreData.quality_score ?? null,
    canonicalTrace: (coreData.canonical_trace ?? null) as typeof agentRunsTable.$inferInsert.canonicalTrace,
    phases: phases as typeof agentRunsTable.$inferInsert.phases,
    degraded: { degraded, reason: coreData.degraded_reason ?? null } as typeof agentRunsTable.$inferInsert.degraded,
    completedAt,
    durationMs: completedAt.getTime() - startTime.getTime(),
  };
}

function admittedTimeoutMsFromPolicy(runPolicy: Record<string, unknown> | null | undefined, fallback: number): number {
  const candidate = runPolicy?.timeoutMs;
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
    ? candidate
    : fallback;
}

function buildAdmittedRunPolicy(bodyRunPolicy: Record<string, unknown> | undefined, agentExecutionPolicy: Record<string, unknown> | null | undefined, defaultTimeoutMs: number): Record<string, unknown> {
  const merged = {
    ...(agentExecutionPolicy ?? {}),
    ...(bodyRunPolicy ?? {}),
  };

  return {
    ...merged,
    timeoutMs: admittedTimeoutMsFromPolicy(merged, defaultTimeoutMs),
  };
}

function sanitizeRunRecord<T extends Record<string, unknown>>(run: T): Omit<T, "resolvedPrompt" | "runtimeRequest" | "runtimeResponse" | "rawOutput" | "correlationId" | "idempotencyKey"> {
  const { resolvedPrompt, runtimeRequest, runtimeResponse, rawOutput, correlationId, idempotencyKey, ...safeRun } = run;
  return safeRun;
}

function buildRunListItem(run: Record<string, unknown>) {
  // List view: drop the heavy phases blob to keep response size bounded.
  // Operators fetch /agent-runs/:id for the full per-phase trace.
  const sanitized = sanitizeRunRecord(run);
  const { phases: _phases, ...slim } = sanitized as Record<string, unknown>;
  return slim;
}

function buildRunDetail(run: Record<string, unknown>) {
  return sanitizeRunRecord(run);
}

function buildTimeline(run: Record<string, unknown>) {
  return {
    created: run.createdAt,
    admitted: run.admittedAt ?? null,
    started: run.startedAt ?? null,
    // completedAt is only set for status=completed runs
    completed: run.completedAt ?? null,
    // failedAt is only set for status=failed runs
    failed: run.failedAt ?? null,
    // cancelledAt is only set for status=cancelled runs
    cancelled: run.cancelledAt ?? null,
    durationMs: run.durationMs ?? null,
  };
}

router.post("/agents/run", async (req: Request, res: Response) => {
  try {
    const parsed = parseWithSchema(RunAgentBody, req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", code: "VALIDATION_ERROR", category: "validation_error", retryable: false, correlationId: req.correlationId, details: zodErrorResponse(parsed.error) });
      return;
    }
    const body = parsed.data;
    const config = getConfig();

    const idempotencyKey = req.headers["idempotency-key"] as string | undefined;

    if (inFlightRegistry.activeCount >= config.maxConcurrentRuns) {
      metrics.recordConcurrencyDenied();
      logger.warn({ activeCount: inFlightRegistry.activeCount, limit: config.maxConcurrentRuns }, "Concurrency limit reached");
      res.status(429).json({
        error: "Too many concurrent runs",
        code: "CONCURRENCY_LIMIT",
        category: "concurrency_limit",
        retryable: true,
        retryAfterMs: 1000,
        activeRuns: inFlightRegistry.activeCount,
        maxConcurrentRuns: config.maxConcurrentRuns,
        correlationId: req.correlationId,
      }, "/agents/run"));
      return;
    }

    const agent = await resolveAgent(body.agentId);
    if (!agent) {
      res.status(404).json({ error: `Agent '${body.agentId}' not found`, code: "NOT_FOUND", category: "not_found", retryable: false, correlationId: req.correlationId });
      return;
    }

    if (agent.status !== "active") {
      res.status(409).json({ error: `Agent '${body.agentId}' is ${agent.status}`, code: "CONFLICT", category: "conflict", retryable: false, correlationId: req.correlationId });
      return;
    }

    const input = (body.input ?? {}) as Record<string, unknown>;

    const agentInputSchema = (agent.inputSchema ?? {}) as Record<string, unknown>;
    if (Object.keys(agentInputSchema).length > 0) {
      const inputCheck = validateJsonSchema(agentInputSchema, input);
      if (!inputCheck.valid) {
        res.status(400).json({
          error: "Input schema validation failed",
          code: "VALIDATION_ERROR",
          category: "validation_error",
          retryable: false,
          correlationId: req.correlationId,
          details: inputCheck.errors,
        });
        return;
      }
    }

    const runId = randomUUID();
    const now = new Date();

    const resolvedPrompt = hydrateTemplate(
      agent.promptTemplate || "{{input.prompt}}",
      input,
    );

    // --- PROMPT LENGTH ADMISSION GATE ---
    // Enforce the operator-configurable promptMaxLength limit (default 50,000 chars)
    // before any DB write or downstream call. This prevents unbounded token cost
    // and single-request denial-of-service via the body parser size limit bypass.
    // CONTRACT: config.promptMaxLength is loaded from PROMPT_MAX_LENGTH env var.
    if (resolvedPrompt.length > config.promptMaxLength) {
      metrics.recordValidationDenied?.();
      logger.warn(
        { agentId: body.agentId, promptLength: resolvedPrompt.length, limit: config.promptMaxLength },
        "Prompt exceeds promptMaxLength limit — rejecting run admission",
      );
      res.status(400).json({
        error: `Prompt length ${resolvedPrompt.length} exceeds the maximum allowed length of ${config.promptMaxLength} characters`,
        code: "PROMPT_TOO_LONG",
        category: "validation_error",
        retryable: false,
        correlationId: req.correlationId,
        details: [
          {
            field: "prompt",
            message: `Prompt length ${resolvedPrompt.length} exceeds maximum ${config.promptMaxLength}`,
          },
        ],
      });
      return;
    }

    const admittedRunPolicy = buildAdmittedRunPolicy(
      body.runPolicy as Record<string, unknown> | undefined,
      (agent.executionPolicy as Record<string, unknown> | null | undefined),
      config.defaultRunTimeoutMs,
    );
    const timeoutMs = admittedTimeoutMsFromPolicy(admittedRunPolicy, config.defaultRunTimeoutMs);
    const runtimeRequest = {
      prompt: resolvedPrompt,
      agent_id: agent.id,
      agent_version: agent.version,
      agent_role: agent.role,
      agent_capabilities: agent.capabilities,
      run_policy: admittedRunPolicy,
    } satisfies Record<string, unknown>;

    // --- ATOMIC IDEMPOTENCY ADMISSION ---
    // INSERT with onConflictDoNothing() is atomic against the DB UNIQUE constraint
    // on idempotency_key. Under a race, only one INSERT wins; the loser gets
    // rowCount=0 and we return the winner's cached run instead.
    if (idempotencyKey) {
      const insertResult = await db
        .insert(agentRunsTable)
        .values({
          id: runId,
          agentId: agent.id,
          agentVersion: agent.version,
          status: "running",
          input,
          resolvedPrompt,
          runtimeRequest,
          requestedBy: body.requestedBy || "operator",
          correlationId: body.correlationId || null,
          idempotencyKey,
          admittedAt: now,
          startedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: agentRunsTable.id });

      if (insertResult.length === 0) {
        // Conflict: another request already admitted this idempotency key.
        const existing = await db
          .select()
          .from(agentRunsTable)
          .where(eq(agentRunsTable.idempotencyKey, idempotencyKey))
          .limit(1);

        const existingRun = existing[0];
        metrics.recordIdempotencyHit();
        logger.info({ runId: existingRun?.id, idempotencyKey }, "Idempotency key hit — returning cached run");

        if (existingRun?.status === "running") {
          res.status(200).json(assertResponseShape(RunAgentResponse, {
            runId: existingRun.id,
            agentId: existingRun.agentId,
            status: "running",
            idempotencyHit: true,
            message: "Run already in progress with this idempotency key",
          }, "/agents/run"));
          return;
        }
        res.status(200).json(assertResponseShape(RunAgentResponse, {
          runId: existingRun?.id,
          agentId: existingRun?.agentId,
          status: existingRun?.status,
          output: existingRun?.output,
          normalizedOutput: existingRun?.normalizedOutput,
          qualityScore: existingRun?.qualityScore,
          canonicalTrace: existingRun?.canonicalTrace,
          durationMs: existingRun?.durationMs,
          idempotencyHit: true,
        }, "/agents/run"));
        return;
      }
    } else {
      // No idempotency key — plain insert.
      await db.insert(agentRunsTable).values({
        id: runId,
        agentId: agent.id,
        agentVersion: agent.version,
        status: "running",
        input,
        resolvedPrompt,
        runtimeRequest,
        requestedBy: body.requestedBy || "operator",
        correlationId: body.correlationId || null,
        idempotencyKey: null,
        admittedAt: now,
        startedAt: now,
      });
    }

    const abortController = new AbortController();
    inFlightRegistry.register({
      runId,
      agentId: agent.id,
      correlationId: req.correlationId,
      abortController,
      startedAt: now,
    });
    metrics.activeRuns = inFlightRegistry.activeCount;

    emitAuditEvent({ action: "run.started", resourceType: "run", resourceId: runId, correlationId: req.correlationId, details: { agentId: agent.id, timeoutMs } });

    try {
      const coreResult = await pythonClient.runAgent(
        runtimeRequest,
        timeoutMs,
        req.correlationId,
        abortController.signal,
      );

      if (!coreResult.ok) {
        const terminalAt = new Date();
        const durationMs = terminalAt.getTime() - now.getTime();
        const classified = classifyCoreError(coreResult.error.code, coreResult.error.message);
        const isCancelled = coreResult.error.code === "RUN_CANCELLED";
        const terminalStatus = isCancelled ? "cancelled" : "failed";

        if (coreResult.error.code === "CORE_TIMEOUT") {
          metrics.recordTimeout();
        }
        if (isCancelled) {
          metrics.recordCancel();
        }

        // Timeline semantics:
        //   cancelled → cancelledAt only, failedAt=null, completedAt=null
        //   failed    → failedAt only,    cancelledAt=null, completedAt=null
        await db
          .update(agentRunsTable)
          .set({
            status: terminalStatus,
            error: coreResult.error.message,
            errorCode: coreResult.error.code,
            errorCategory: classified.category,
            runtimeResponse: coreResult.error.details || null,
            failedAt: isCancelled ? null : terminalAt,
            cancelledAt: isCancelled ? terminalAt : null,
            completedAt: null,
            durationMs,
          })
          .where(and(eq(agentRunsTable.id, runId), eq(agentRunsTable.status, "running")));

        metrics.recordRun(false, durationMs);
        emitAuditEvent({
          action: isCancelled ? "run.cancelled" : "run.failed",
          resourceType: "run",
          resourceId: runId,
          correlationId: req.correlationId,
          details: { agentId: body.agentId, errorCode: coreResult.error.code, errorCategory: classified.category },
        });
        res.status(classified.statusCode).json({
          runId,
          status: terminalStatus,
          error: coreResult.error.message,
          code: coreResult.error.code,
          category: classified.category,
          retryable: classified.retryable,
          correlationId: req.correlationId,
        });
        return;
      }

      const coreData = coreResult.data;
      const updates = buildRunUpdates(coreData, now);
      updates.resolvedPrompt = resolvedPrompt;

      const agentOutputSchema = (agent.outputSchema ?? {}) as Record<string, unknown>;
      if (Object.keys(agentOutputSchema).length > 0 && updates.output) {
        const outputCheck = validateJsonSchema(agentOutputSchema, updates.output);
        if (!outputCheck.valid && updates.normalizedOutput) {
          const existing = updates.normalizedOutput as { warnings?: string[] };
          const warnings = [...(existing.warnings || [])];
          outputCheck.errors.forEach((e) => warnings.push(`output_schema: ${e}`));
          (updates.normalizedOutput as Record<string, unknown>).warnings = warnings;
        }
      }

      // Timeline semantics: completed → completedAt only, failedAt=null, cancelledAt=null
      await db
        .update(agentRunsTable)
        .set({ status: "completed", ...updates, failedAt: null, cancelledAt: null })
        .where(and(eq(agentRunsTable.id, runId), eq(agentRunsTable.status, "running")));

      metrics.recordRun(true, updates.durationMs ?? 0);
      emitAuditEvent({ action: "run.completed", resourceType: "run", resourceId: runId, correlationId: req.correlationId, details: { agentId: agent.id, durationMs: updates.durationMs } });
      res.json(assertResponseShape(RunAgentResponse, {
        runId,
        agentId: agent.id,
        status: "completed",
        output: updates.output,
        normalizedOutput: updates.normalizedOutput,
        qualityScore: updates.qualityScore,
        intent: coreData.intent || null,
        mode: coreData.mode || null,
        canonicalCombo: coreData.canonical_combo || null,
        canonicalPhases: coreData.canonical_phases || null,
        canonicalTrace: coreData.canonical_trace || null,
        durationMs: updates.durationMs,
      }, "/agents/run"));
    } finally {
      inFlightRegistry.remove(runId);
      metrics.activeRuns = inFlightRegistry.activeCount;
    }
  } catch (err) {
    const classified = classifyError(err, "agent_run");
    logger.error({ err, errorClass: classified.category, errorCode: classified.code }, "Agent run failed");
    res.status(classified.statusCode).json({ error: classified.message, code: classified.code, category: classified.category, retryable: classified.retryable, correlationId: req.correlationId });
  }
});

router.get("/agent-runs", async (req: Request, res: Response) => {
  try {
    const parsed = parseWithSchema(ListRunsQueryParams, req.query);
    const params = parsed.success ? parsed.data : req.query;

    const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 200);
    const offset = Math.max(Number(params.offset) || 0, 0);

    const conditions = [];

    if (params.agentId) {
      conditions.push(eq(agentRunsTable.agentId, String(params.agentId)));
    }
    if (params.agentVersion) {
      conditions.push(eq(agentRunsTable.agentVersion, String(params.agentVersion)));
    }
    if (params.status) {
      conditions.push(eq(agentRunsTable.status, String(params.status)));
    }
    if (params.requestedBy) {
      conditions.push(eq(agentRunsTable.requestedBy, String(params.requestedBy)));
    }
    if (params.from) {
      conditions.push(gte(agentRunsTable.createdAt, new Date(String(params.from))));
    }
    if (params.to) {
      conditions.push(lte(agentRunsTable.createdAt, new Date(String(params.to))));
    }
    if (params.hasError === "true") {
      conditions.push(sql`${agentRunsTable.error} IS NOT NULL`);
    }
    if (params.minQualityScore) {
      conditions.push(gte(agentRunsTable.qualityScore, Number(params.minQualityScore)));
    }
    if (params.retryOf) {
      conditions.push(eq(agentRunsTable.parentRunId, String(params.retryOf)));
    }
    if (params.q) {
      const term = `%${String(params.q)}%`;
      conditions.push(sql`(${agentRunsTable.resolvedPrompt} ILIKE ${term} OR ${agentRunsTable.error} ILIKE ${term} OR ${agentRunsTable.id} ILIKE ${term})`);
    }

    let q = db.select().from(agentRunsTable).orderBy(desc(agentRunsTable.createdAt)).$dynamic();

    if (conditions.length > 0) {
      q = q.where(and(...conditions));
    }

    const runs = await q.limit(limit).offset(offset);
    const safeRuns = runs.map((run) => buildRunListItem(run as unknown as Record<string, unknown>));

    const countResult = await (async () => {
      let cq = db.select({ count: sql<number>`count(*)` }).from(agentRunsTable).$dynamic();
      if (conditions.length > 0) {
        cq = cq.where(and(...conditions));
      }
      const r = await cq;
      return Number(r[0]?.count ?? 0);
    })();

    res.json({ runs: safeRuns, total: countResult, limit, offset });
  } catch (err) {
    const classified = classifyError(err, "list_runs");
    logger.error({ err, category: classified.category }, "Failed to list runs");
    res.status(classified.statusCode).json({ error: classified.message, code: classified.code, category: classified.category, retryable: classified.retryable, correlationId: req.correlationId });
  }
});

router.get("/agent-runs/metrics", async (_req: Request, res: Response) => {
  try {
    const result = await db.select({
      total: sql<number>`count(*)`,
      completed: sql<number>`count(*) filter (where ${agentRunsTable.status} = 'completed')`,
      failed: sql<number>`count(*) filter (where ${agentRunsTable.status} = 'failed')`,
      cancelled: sql<number>`count(*) filter (where ${agentRunsTable.status} = 'cancelled')`,
      timedOut: sql<number>`count(*) filter (where ${agentRunsTable.errorCode} = 'CORE_TIMEOUT')`,
      retried: sql<number>`count(*) filter (where ${agentRunsTable.parentRunId} is not null)`,
      avgDurationMs: sql<number>`avg(${agentRunsTable.durationMs})`,
      avgQualityScore: sql<number>`avg(${agentRunsTable.qualityScore})`,
    }).from(agentRunsTable);

    const m = result[0];
    res.json({
      total: Number(m?.total ?? 0),
      completed: Number(m?.completed ?? 0),
      failed: Number(m?.failed ?? 0),
      cancelled: Number(m?.cancelled ?? 0),
      timedOut: Number(m?.timedOut ?? 0),
      retried: Number(m?.retried ?? 0),
      avgDurationMs: m?.avgDurationMs ? Math.round(Number(m.avgDurationMs)) : null,
      avgQualityScore: m?.avgQualityScore ? Math.round(Number(m.avgQualityScore) * 1000) / 1000 : null,
      activeRuns: inFlightRegistry.activeCount,
      maxConcurrentRuns: getConfig().maxConcurrentRuns,
    });
  } catch (err) {
    const classified = classifyError(err, "run_metrics");
    logger.error({ err, category: classified.category }, "Failed to get metrics");
    res.status(classified.statusCode).json({ error: classified.message, code: classified.code, category: classified.category, retryable: classified.retryable });
  }
});

router.get("/agent-runs/:id", async (req: Request, res: Response) => {
  try {
    const rows = await db
      .select()
      .from(agentRunsTable)
      .where(eq(agentRunsTable.id, String(req.params.id)))
      .limit(1);

    if (rows.length === 0) {
      res.status(404).json({ error: "Run not found", code: "NOT_FOUND", category: "not_found", retryable: false, correlationId: req.correlationId });
      return;
    }

    const run = rows[0];

    const retryChain = run.parentRunId
      ? await db
          .select({
            id: agentRunsTable.id,
            status: agentRunsTable.status,
            parentRunId: agentRunsTable.parentRunId,
            errorCode: agentRunsTable.errorCode,
            errorCategory: agentRunsTable.errorCategory,
            durationMs: agentRunsTable.durationMs,
            createdAt: agentRunsTable.createdAt,
          })
          .from(agentRunsTable)
          .where(eq(agentRunsTable.originRunId, run.originRunId || run.id))
          .orderBy(agentRunsTable.createdAt)
      : [];

    const timeline = buildTimeline(run as unknown as Record<string, unknown>);

    const forensics = run.status === "failed" || run.status === "cancelled"
      ? { errorCode: run.errorCode, errorCategory: run.errorCategory }
      : undefined;

    const safeRun = buildRunDetail(run as unknown as Record<string, unknown>);
    res.json({ ...safeRun, retryChain, timeline, forensics });
  } catch (err) {
    const classified = classifyError(err, "get_run");
    logger.error({ err, category: classified.category }, "Failed to get run");
    res.status(classified.statusCode).json({ error: classified.message, code: classified.code, category: classified.category, retryable: classified.retryable, correlationId: req.correlationId });
  }
});

router.post("/agent-runs/:id/retry", async (req: Request, res: Response) => {
  try {
    const config = getConfig();

    const rows = await db
      .select()
      .from(agentRunsTable)
      .where(eq(agentRunsTable.id, String(req.params.id)))
      .limit(1);

    if (rows.length === 0) {
      res.status(404).json({ error: "Run not found", code: "NOT_FOUND", category: "not_found", retryable: false, correlationId: req.correlationId });
      return;
    }

    const original = rows[0];
    if (!isRetryable(original.status as RunStatus)) {
      res.status(409).json({ error: "Only failed runs can be retried", code: "CONFLICT", category: "conflict", retryable: false, correlationId: req.correlationId });
      return;
    }

    const retryCount = (original.retryCount ?? 0) + 1;
    if (retryCount > config.maxRetryCount) {
      res.status(409).json({
        error: `Maximum retry count (${config.maxRetryCount}) exceeded`,
        code: "RETRY_LIMIT_EXCEEDED",
        category: "conflict",
        retryable: false,
        retryCount: original.retryCount,
        maxRetryCount: config.maxRetryCount,
        correlationId: req.correlationId,
      });
      return;
    }

    if (original.errorCategory && !["timeout", "core_unreachable", "core_error", "persistence_error"].includes(original.errorCategory)) {
      res.status(409).json({
        error: `Error category '${original.errorCategory}' is not retryable`,
        code: "NOT_RETRYABLE",
        category: "conflict",
        retryable: false,
        originalErrorCategory: original.errorCategory,
        correlationId: req.correlationId,
      });
      return;
    }

    if (inFlightRegistry.activeCount >= config.maxConcurrentRuns) {
      metrics.recordConcurrencyDenied();
      res.status(429).json({
        error: "Too many concurrent runs",
        code: "CONCURRENCY_LIMIT",
        category: "concurrency_limit",
        retryable: true,
        retryAfterMs: 1000,
        correlationId: req.correlationId,
      });
      return;
    }

    const parsedBody = parseWithSchema(RetryRunBody, req.body || {});
    if (!parsedBody.success) {
      res.status(400).json({ error: "Validation failed", code: "VALIDATION_ERROR", category: "validation_error", retryable: false, correlationId: req.correlationId, details: zodErrorResponse(parsedBody.error) });
      return;
    }
    const retryReason = parsedBody.data.reason || "manual_retry";

    const originRunId = original.originRunId || original.id;

    const newRunId = randomUUID();
    const now = new Date();

    let immutableRuntimeRequest: ReturnType<typeof buildImmutableRetryRequest>;
    try {
      immutableRuntimeRequest = buildImmutableRetryRequest({
        id: original.id,
        agentId: original.agentId,
        agentVersion: original.agentVersion,
        resolvedPrompt: original.resolvedPrompt,
        runtimeRequest: original.runtimeRequest,
      });
    } catch (err) {
      res.status(409).json({
        error: err instanceof Error ? err.message : "Immutable retry unavailable",
        code: "IMMUTABLE_RETRY_UNAVAILABLE",
        category: "conflict",
        retryable: false,
        correlationId: req.correlationId,
      });
      return;
    }

    const timeoutMs = admittedTimeoutMsFromPolicy(immutableRuntimeRequest.run_policy, getConfig().defaultRunTimeoutMs);

    await db.insert(agentRunsTable).values({
      id: newRunId,
      agentId: original.agentId,
      agentVersion: original.agentVersion,
      status: "running",
      input: original.input,
      resolvedPrompt: immutableRuntimeRequest.prompt,
      runtimeRequest: immutableRuntimeRequest as unknown as Record<string, unknown>,
      requestedBy: original.requestedBy,
      parentRunId: original.id,
      originRunId,
      retryCount,
      retryReason,
      admittedAt: now,
      startedAt: now,
    });

    const abortController = new AbortController();
    inFlightRegistry.register({
      runId: newRunId,
      agentId: original.agentId,
      correlationId: req.correlationId,
      abortController,
      startedAt: now,
    });
    metrics.activeRuns = inFlightRegistry.activeCount;

    try {
      const coreResult = await pythonClient.runAgent(
        immutableRuntimeRequest,
        timeoutMs,
        req.correlationId,
        abortController.signal,
      );

      if (!coreResult.ok) {
        const terminalAt = new Date();
        const durationMs = terminalAt.getTime() - now.getTime();
        const classified = classifyCoreError(coreResult.error.code, coreResult.error.message);
        const isCancelled = coreResult.error.code === "RUN_CANCELLED";
        const terminalStatus = isCancelled ? "cancelled" : "failed";

        if (coreResult.error.code === "CORE_TIMEOUT") {
          metrics.recordTimeout();
        }
        if (isCancelled) {
          metrics.recordCancel();
        }

        // Timeline semantics (retry path mirrors run path)
        await db
          .update(agentRunsTable)
          .set({
            status: terminalStatus,
            error: coreResult.error.message,
            errorCode: coreResult.error.code,
            errorCategory: classified.category,
            runtimeResponse: coreResult.error.details || null,
            failedAt: isCancelled ? null : terminalAt,
            cancelledAt: isCancelled ? terminalAt : null,
            completedAt: null,
            durationMs,
          })
          .where(and(eq(agentRunsTable.id, newRunId), eq(agentRunsTable.status, "running")));

        metrics.recordRun(false, durationMs);
        emitAuditEvent({
          action: isCancelled ? "run.cancelled" : "run.failed",
          resourceType: "run",
          resourceId: newRunId,
          correlationId: req.correlationId,
          details: { retryOf: original.id, retryCount, errorCode: coreResult.error.code, errorCategory: classified.category },
        });
        res.status(classified.statusCode).json({
          originalRunId: original.id,
          retryRunId: newRunId,
          status: terminalStatus,
          retryCount,
          error: coreResult.error.message,
          code: coreResult.error.code,
          category: classified.category,
          retryable: classified.retryable,
          correlationId: req.correlationId,
        });
        return;
      }

      const coreData = coreResult.data;
      const updates = buildRunUpdates(coreData, now);
      updates.resolvedPrompt = immutableRuntimeRequest.prompt;

      // Timeline semantics: completed → completedAt only
      await db
        .update(agentRunsTable)
        .set({ status: "completed", ...updates, failedAt: null, cancelledAt: null })
        .where(and(eq(agentRunsTable.id, newRunId), eq(agentRunsTable.status, "running")));

      metrics.recordRun(true, updates.durationMs ?? 0);
      emitAuditEvent({ action: "run.retried", resourceType: "run", resourceId: newRunId, correlationId: req.correlationId, details: { retryOf: original.id, retryCount, durationMs: updates.durationMs } });
      res.json({
        originalRunId: original.id,
        retryRunId: newRunId,
        originRunId,
        retryCount,
        status: "completed",
        output: updates.output,
        normalizedOutput: updates.normalizedOutput,
        canonicalTrace: coreData.canonical_trace || null,
      });
    } finally {
      inFlightRegistry.remove(newRunId);
      metrics.activeRuns = inFlightRegistry.activeCount;
    }
  } catch (err) {
    const classified = classifyError(err, "retry");
    logger.error({ err, errorClass: classified.category }, "Retry failed");
    res.status(classified.statusCode).json({ error: classified.message, code: classified.code, retryable: classified.retryable });
  }
});

router.post("/agent-runs/:id/resume", async (req: Request, res: Response) => {
  res.status(405).json({
    error: "Resume is not supported",
    message: "Agent runs do not support resume. Use retry (POST /api/agent-runs/:id/retry) to re-execute a failed run.",
    supportedActions: ["retry"],
  });
});

router.post("/agent-runs/:id/cancel", async (req: Request, res: Response) => {
  try {
    const rows = await db
      .select()
      .from(agentRunsTable)
      .where(eq(agentRunsTable.id, String(req.params.id)))
      .limit(1);

    if (rows.length === 0) {
      res.status(404).json({ error: "Run not found", code: "NOT_FOUND", category: "not_found", retryable: false, correlationId: req.correlationId });
      return;
    }

    const run = rows[0];
    const transition = canTransition(run.status as RunStatus, "cancelled");
    if (!transition.ok) {
      res.status(409).json({ error: transition.error, code: "CONFLICT", category: "conflict", retryable: false, correlationId: req.correlationId });
      return;
    }

    // Interrupt the in-flight HTTP call to Python core (if still active).
    const aborted = inFlightRegistry.abort(run.id);

    const now = new Date();
    const previousStatus = run.status;
    const durationMs = run.startedAt ? now.getTime() - run.startedAt.getTime() : null;

    // Conditional update: only succeeds if run is still in 'running' state.
    // Timeline semantics: cancelledAt only — completedAt and failedAt remain null.
    const result = await db
      .update(agentRunsTable)
      .set({
        status: "cancelled",
        cancelledAt: now,
        completedAt: null,
        failedAt: null,
        errorCode: "RUN_CANCELLED",
        errorCategory: "conflict",
        durationMs,
      })
      .where(and(eq(agentRunsTable.id, run.id), eq(agentRunsTable.status, "running")));

    if (result.rowCount === 0) {
      const fresh = await db.select().from(agentRunsTable).where(eq(agentRunsTable.id, run.id)).limit(1);
      const currentStatus = fresh[0]?.status ?? "unknown";
      res.status(409).json({ error: `Run already terminated with status '${currentStatus}'`, code: "CONFLICT", category: "conflict", retryable: false, correlationId: req.correlationId });
      return;
    }

    metrics.recordCancel();
    metrics.activeRuns = inFlightRegistry.activeCount;
    emitAuditEvent({ action: "run.cancelled", resourceType: "run", resourceId: run.id, correlationId: req.correlationId, details: { previousStatus, interrupted: aborted } });
    res.json({ id: run.id, status: "cancelled", cancelledAt: now.toISOString(), interrupted: aborted });
  } catch (err) {
    const classified = classifyError(err, "cancel_run");
    logger.error({ err, category: classified.category }, "Cancel failed");
    res.status(classified.statusCode).json({ error: classified.message, code: classified.code, category: classified.category, retryable: classified.retryable, correlationId: req.correlationId });
  }
});

router.get("/system/pressure", async (_req: Request, res: Response) => {
  const config = getConfig();
  res.json({
    activeRuns: inFlightRegistry.activeCount,
    maxConcurrentRuns: config.maxConcurrentRuns,
    utilizationPct: Math.round((inFlightRegistry.activeCount / config.maxConcurrentRuns) * 100),
    activeRunDetails: inFlightRegistry.getActiveRuns(),
  });
});

export default router;
