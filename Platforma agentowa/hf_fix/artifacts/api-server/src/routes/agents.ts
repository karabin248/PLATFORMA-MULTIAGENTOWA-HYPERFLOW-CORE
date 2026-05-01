import { Router, type IRouter, type Request, type Response } from "express";
import { db, agentsTable, agentRevisionsTable } from "@workspace/db";
import { eq, desc, max } from "drizzle-orm";
import { resolveAgent, seedAgents } from "../domain/catalog";
import { validateCreateAgent, validateUpdateAgent } from "../lib/agentValidation";
import { logger } from "../lib/logger";
import { emitAuditEvent } from "../lib/auditLog";
import { classifyError } from "../lib/errorClassifier";

const router: IRouter = Router();

function normalizedError(res: Response, statusCode: number, error: string, code: string, category: string, retryable: boolean, correlationId?: string) {
  res.status(statusCode).json({ error, code, category, retryable, correlationId });
}

router.get("/agents", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    let q = db.select().from(agentsTable).$dynamic();

    if (req.query.status) {
      q = q.where(eq(agentsTable.status, String(req.query.status)));
    }
    if (req.query.role) {
      q = q.where(eq(agentsTable.role, String(req.query.role)));
    }

    const agents = await q.limit(limit).offset(offset);
    res.json({ agents, total: agents.length });
  } catch (err) {
    const classified = classifyError(err, "list_agents");
    logger.error({ err, category: classified.category }, "Failed to list agents");
    normalizedError(res, classified.statusCode, classified.message, classified.code, classified.category, classified.retryable, req.correlationId);
  }
});

router.get("/agents/:id", async (req: Request, res: Response) => {
  try {
    const agent = await resolveAgent(String(req.params.id));
    if (!agent) {
      normalizedError(res, 404, "Agent not found", "NOT_FOUND", "not_found", false, req.correlationId);
      return;
    }
    res.json(agent);
  } catch (err) {
    const classified = classifyError(err, "get_agent");
    logger.error({ err, category: classified.category }, "Failed to get agent");
    normalizedError(res, classified.statusCode, classified.message, classified.code, classified.category, classified.retryable, req.correlationId);
  }
});

router.get("/agents/:id/revisions", async (req: Request, res: Response) => {
  try {
    const agent = await resolveAgent(String(req.params.id));
    if (!agent) {
      normalizedError(res, 404, "Agent not found", "NOT_FOUND", "not_found", false, req.correlationId);
      return;
    }

    const revisions = await db
      .select()
      .from(agentRevisionsTable)
      .where(eq(agentRevisionsTable.agentId, String(req.params.id)))
      .orderBy(desc(agentRevisionsTable.revisionNumber));

    res.json({ agentId: req.params.id, revisions, total: revisions.length });
  } catch (err) {
    const classified = classifyError(err, "list_revisions");
    logger.error({ err, category: classified.category }, "Failed to list revisions");
    normalizedError(res, classified.statusCode, classified.message, classified.code, classified.category, classified.retryable, req.correlationId);
  }
});

router.post("/agents", async (req: Request, res: Response) => {
  try {
    const validation = validateCreateAgent(req.body);
    if (!validation.ok) {
      res.status(400).json({ error: "Validation failed", code: "VALIDATION_ERROR", category: "validation_error", retryable: false, correlationId: req.correlationId, details: validation.errors });
      return;
    }

    const existing = await resolveAgent(validation.data.id);
    if (existing) {
      normalizedError(res, 409, `Agent '${validation.data.id}' already exists`, "CONFLICT", "conflict", false, req.correlationId);
      return;
    }

    const now = new Date();
    await db.insert(agentsTable).values({
      ...validation.data,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(agentRevisionsTable).values({
      agentId: validation.data.id,
      revisionNumber: 1,
      spec: {
        name: validation.data.name,
        version: validation.data.version,
        description: validation.data.description ?? "",
        status: validation.data.status ?? "active",
        role: validation.data.role ?? "assistant",
        capabilities: validation.data.capabilities ?? [],
        inputSchema: validation.data.inputSchema ?? {},
        outputSchema: validation.data.outputSchema ?? {},
        runtimeMode: validation.data.runtimeMode ?? "standard",
        executionPolicy: validation.data.executionPolicy ?? {},
        promptTemplate: validation.data.promptTemplate ?? "{{input.prompt}}",
        tags: validation.data.tags ?? [],
        owner: validation.data.owner ?? null,
      },
      changedFields: ["*"],
      changedBy: "operator",
    });

    const created = await resolveAgent(validation.data.id);
    emitAuditEvent({ action: "agent.created", resourceType: "agent", resourceId: validation.data.id, correlationId: req.correlationId });
    res.status(201).json(created);
  } catch (err) {
    const classified = classifyError(err, "create_agent");
    logger.error({ err, category: classified.category }, "Failed to create agent");
    normalizedError(res, classified.statusCode, classified.message, classified.code, classified.category, classified.retryable, req.correlationId);
  }
});

router.patch("/agents/:id", async (req: Request, res: Response) => {
  try {
    const agent = await resolveAgent(String(req.params.id));
    if (!agent) {
      normalizedError(res, 404, "Agent not found", "NOT_FOUND", "not_found", false, req.correlationId);
      return;
    }

    const validation = validateUpdateAgent(req.body);
    if (!validation.ok) {
      res.status(400).json({ error: "Validation failed", code: "VALIDATION_ERROR", category: "validation_error", retryable: false, correlationId: req.correlationId, details: validation.errors });
      return;
    }

    const updates = validation.data;
    const changedFields = Object.keys(updates).filter(
      (k) => (updates as Record<string, unknown>)[k] !== undefined
    );

    if (changedFields.length === 0) {
      res.status(400).json({ error: "No fields to update", code: "VALIDATION_ERROR", category: "validation_error", retryable: false, correlationId: req.correlationId });
      return;
    }

    const now = new Date();
    await db
      .update(agentsTable)
      .set({ ...updates, updatedAt: now })
      .where(eq(agentsTable.id, agent.id));

    const maxRevResult = await db
      .select({ maxRev: max(agentRevisionsTable.revisionNumber) })
      .from(agentRevisionsTable)
      .where(eq(agentRevisionsTable.agentId, agent.id));
    const nextRev = ((maxRevResult[0]?.maxRev) ?? 0) + 1;

    const updated = await resolveAgent(agent.id);
    if (updated) {
      await db.insert(agentRevisionsTable).values({
        agentId: agent.id,
        revisionNumber: nextRev,
        spec: {
          name: updated.name,
          version: updated.version,
          description: updated.description,
          status: updated.status,
          role: updated.role,
          capabilities: updated.capabilities,
          inputSchema: updated.inputSchema as Record<string, unknown>,
          outputSchema: updated.outputSchema as Record<string, unknown>,
          runtimeMode: updated.runtimeMode,
          executionPolicy: (updated.executionPolicy ?? {}) as Record<string, unknown>,
          promptTemplate: updated.promptTemplate,
          tags: updated.tags ?? [],
          owner: updated.owner,
        },
        changedFields,
        changedBy: "operator",
      });
    }

    emitAuditEvent({ action: "agent.updated", resourceType: "agent", resourceId: agent.id, correlationId: req.correlationId, details: { changedFields } });
    res.json(updated);
  } catch (err) {
    const classified = classifyError(err, "update_agent");
    logger.error({ err, category: classified.category }, "Failed to update agent");
    normalizedError(res, classified.statusCode, classified.message, classified.code, classified.category, classified.retryable, req.correlationId);
  }
});

router.post("/agents/:id/disable", async (req: Request, res: Response) => {
  try {
    const agent = await resolveAgent(String(req.params.id));
    if (!agent) {
      normalizedError(res, 404, "Agent not found", "NOT_FOUND", "not_found", false, req.correlationId);
      return;
    }

    if (agent.status === "disabled") {
      normalizedError(res, 409, "Agent is already disabled", "CONFLICT", "conflict", false, req.correlationId);
      return;
    }

    await db
      .update(agentsTable)
      .set({ status: "disabled", updatedAt: new Date() })
      .where(eq(agentsTable.id, agent.id));

    const updated = await resolveAgent(agent.id);
    emitAuditEvent({ action: "agent.disabled", resourceType: "agent", resourceId: agent.id, correlationId: req.correlationId });
    res.json(updated);
  } catch (err) {
    const classified = classifyError(err, "disable_agent");
    logger.error({ err, category: classified.category }, "Failed to disable agent");
    normalizedError(res, classified.statusCode, classified.message, classified.code, classified.category, classified.retryable, req.correlationId);
  }
});

router.post("/agents/:id/enable", async (req: Request, res: Response) => {
  try {
    const agent = await resolveAgent(String(req.params.id));
    if (!agent) {
      normalizedError(res, 404, "Agent not found", "NOT_FOUND", "not_found", false, req.correlationId);
      return;
    }

    if (agent.status === "active") {
      normalizedError(res, 409, "Agent is already active", "CONFLICT", "conflict", false, req.correlationId);
      return;
    }

    await db
      .update(agentsTable)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(agentsTable.id, agent.id));

    const updated = await resolveAgent(agent.id);
    emitAuditEvent({ action: "agent.enabled", resourceType: "agent", resourceId: agent.id, correlationId: req.correlationId });
    res.json(updated);
  } catch (err) {
    const classified = classifyError(err, "enable_agent");
    logger.error({ err, category: classified.category }, "Failed to enable agent");
    normalizedError(res, classified.statusCode, classified.message, classified.code, classified.category, classified.retryable, req.correlationId);
  }
});

router.post("/agents/seed", async (req: Request, res: Response) => {
  try {
    const result = await seedAgents();
    emitAuditEvent({ action: "agent.seeded", correlationId: req.correlationId });
    res.json(result);
  } catch (err) {
    const classified = classifyError(err, "seed_agents");
    logger.error({ err, category: classified.category }, "Failed to seed agents");
    normalizedError(res, classified.statusCode, classified.message, classified.code, classified.category, classified.retryable, req.correlationId);
  }
});

export default router;
