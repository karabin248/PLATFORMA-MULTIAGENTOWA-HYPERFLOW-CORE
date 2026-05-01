import { Router, type IRouter, type Request, type Response } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool, db, agentsTable, getPoolStats } from "@workspace/db";
import { pythonClient } from "../lib/pythonClient";
import { logger } from "../lib/logger";
import { getConfig } from "../lib/config";
import { inFlightRegistry } from "../lib/inFlightRegistry";
import { requireAuth } from "../middlewares/auth";

function sanitizeError(err: unknown): string {
  if (getConfig().hardenedMode) {
    return "Unavailable";
  }
  return String(err);
}

const router: IRouter = Router();

router.get("/livez", (_req: Request, res: Response) => {
  res.json({ status: "alive", timestamp: new Date().toISOString() });
});

router.get("/readyz", requireAuth, async (_req: Request, res: Response) => {
  const checks: Record<string, { status: string; error?: string }> = {};

  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    checks.database = { status: "ok" };
  } catch (err) {
    checks.database = { status: "fail", error: sanitizeError(err) };
  }

  if (checks.database.status === "ok") {
    try {
      await db.select({ id: agentsTable.id }).from(agentsTable).limit(1);
      checks.schema = { status: "ok" };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("does not exist") || message.includes("relation")) {
        checks.schema = { status: "fail", error: "Required tables missing. Run 'pnpm --filter @workspace/db run push' to apply schema." };
      } else {
        checks.schema = { status: "fail", error: sanitizeError(err) };
      }
    }
  } else {
    checks.schema = { status: "fail", error: "Skipped — database unavailable" };
  }

  try {
    const coreResult = await pythonClient.health();
    checks.core = coreResult.ok
      ? { status: "ok" }
      : { status: "fail", error: sanitizeError(coreResult.error.message) };
  } catch (err) {
    checks.core = { status: "fail", error: sanitizeError(err) };
  }

  const allOk = Object.values(checks).every((c) => c.status === "ok");

  if (!allOk) {
    logger.warn({ checks }, "Readiness check failed");
  }

  res.status(allOk ? 200 : 503).json({
    status: allOk ? "ready" : "not_ready",
    checks,
    timestamp: new Date().toISOString(),
  });
});

router.get("/healthz", requireAuth, async (_req: Request, res: Response) => {
  const checks: Record<string, { status: string; error?: string; latencyMs?: number }> = {};

  const dbStart = Date.now();
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    checks.database = { status: "ok", latencyMs: Date.now() - dbStart };
  } catch (err) {
    checks.database = { status: "fail", error: sanitizeError(err), latencyMs: Date.now() - dbStart };
  }

  const coreStart = Date.now();
  try {
    const coreResult = await pythonClient.health();
    checks.core = coreResult.ok
      ? { status: "ok", latencyMs: Date.now() - coreStart }
      : { status: "fail", error: sanitizeError(coreResult.error.message), latencyMs: Date.now() - coreStart };
  } catch (err) {
    checks.core = { status: "fail", error: sanitizeError(err), latencyMs: Date.now() - coreStart };
  }

  const allOk = Object.values(checks).every((c) => c.status === "ok");

  const data = HealthCheckResponse.parse({ status: allOk ? "ok" : "degraded" });

  const config = getConfig();
  res.status(allOk ? 200 : 503).json({
    ...data,
    checks,
    pool: getPoolStats(),
    system: {
      activeRuns: inFlightRegistry.activeCount,
      maxConcurrentRuns: config.maxConcurrentRuns,
      utilizationPct: Math.round((inFlightRegistry.activeCount / config.maxConcurrentRuns) * 100),
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
