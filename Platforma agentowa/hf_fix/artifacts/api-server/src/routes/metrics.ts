import { Router, type Request, type Response } from "express";
import { metrics } from "../lib/metrics";
import { getPoolStats } from "@workspace/db";

const router = Router();

router.get("/metrics", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(metrics.toPrometheus(getPoolStats()));
});

export default router;
