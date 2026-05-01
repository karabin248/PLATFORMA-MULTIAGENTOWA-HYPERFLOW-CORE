import { Router, type IRouter } from "express";
import healthRouter from "./health";
import metricsRouter from "./metrics";
import agentsRouter from "./agents";
import agentRunsRouter from "./agentRuns";
import workflowsRouter from "./workflows";
import approvalsRouter from "./approvals";
import checkpointsRouter from "./checkpoints";
import humanInputsRouter from "./humanInputs";
import { requireAuth } from "../middlewares/auth";
import { rateLimiter } from "../middlewares/rateLimiter";

const router: IRouter = Router();

router.use(healthRouter);
router.use(requireAuth);
router.use(metricsRouter);

router.post("/agents/run", rateLimiter("run"));
router.post("/agent-runs/:id/retry", rateLimiter("run"));
router.post("/workflows/run", rateLimiter("run"));
router.post("/workflow-runs/:id/resume", rateLimiter("run"));

router.use(agentsRouter);
router.use(agentRunsRouter);
router.use(workflowsRouter);
router.use(approvalsRouter);
router.use(humanInputsRouter);
// Expose checkpoint metadata listings for runs. This does not perform any execution itself.
router.use(checkpointsRouter);

export default router;
