import { Router, type Request, type Response } from "express";
import { db, checkpointsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

/**
 * Checkpoint routes surface checkpoint metadata for workflow runs.
 * This mirrors the donor orchestration API which exposes a checkpoint listing endpoint.
 *
 * GET /checkpoints/:runId → { runId, checkpoints: Checkpoint[] }
 */
const router = Router();

router.get("/checkpoints/:runId", async (req: Request, res: Response) => {
  const runId = String(req.params.runId);
  // fetch checkpoints for the given run ordered by creation time (most recent first)
  const rows = await db
    .select()
    .from(checkpointsTable)
    .where(eq(checkpointsTable.runId, runId))
    .orderBy(desc(checkpointsTable.createdAt));
  res.json({ runId, checkpoints: rows });
});

export default router;