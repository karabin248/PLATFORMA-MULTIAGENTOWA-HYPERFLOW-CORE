import { Router, type IRouter } from "express";
import type { Request, Response } from "express";
import { db } from "@workspace/db";
import { repositoriesTable, runsTable } from "@workspace/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import {
  callPythonRepositoryScan,
  callPythonRepositoryGraph,
  PythonCoreUnavailable,
  PythonCoreError,
} from "../lib/pythonClient";
import { makeOkResponse, makeErrorResponse } from "../lib/response";

const router: IRouter = Router();

router.get("/repositories", async (_req: Request, res: Response) => {
  try {
    const repos = await db
      .select()
      .from(repositoriesTable)
      .orderBy(desc(repositoriesTable.createdAt));

    const lastScanRows = await db
      .select({
        status: runsTable.status,
        startedAt: runsTable.startedAt,
      })
      .from(runsTable)
      .where(eq(runsTable.type, "scan"))
      .orderBy(desc(runsTable.createdAt))
      .limit(1);

    const lastScan = lastScanRows[0] ?? null;

    type ValidScanStatus = "pending" | "running" | "completed" | "failed";

    const lastScanStatus: ValidScanStatus | null =
      lastScan && lastScan.status !== "cancelled"
        ? (lastScan.status as ValidScanStatus)
        : null;

    const data = repos.map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      language: r.language,
      classification: r.classification,
      dependencyCount: r.dependencyCount,
      overlapScore: r.overlapScore,
      lastScannedAt: lastScan ? new Date(lastScan.startedAt) : null,
      lastScanStatus,
    }));

    res.json(makeOkResponse(data));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json(makeErrorResponse(message));
  }
});

router.get("/repositories/graph", async (_req: Request, res: Response) => {
  try {
    const repos = await db
      .select({
        id: repositoriesTable.id,
        name: repositoriesTable.name,
        language: repositoriesTable.language,
        classification: repositoriesTable.classification,
        dependencyCount: repositoriesTable.dependencyCount,
      })
      .from(repositoriesTable);

    if (repos.length === 0) {
      res.json(
        makeOkResponse({ nodes: [], edges: [], overlapPairs: [] }),
      );
      return;
    }

    const graphResult = await callPythonRepositoryGraph({
      repositories: repos.map((r) => ({
        id: r.id,
        name: r.name,
        language: r.language ?? "unknown",
        classification: r.classification ?? "unknown",
        dependencyCount: r.dependencyCount ?? 0,
      })),
    });

    res.json(makeOkResponse(graphResult));
  } catch (err) {
    if (err instanceof PythonCoreUnavailable) {
      res
        .status(503)
        .json(makeErrorResponse(`Python Core unavailable: ${err.message}`));
      return;
    }
    if (err instanceof PythonCoreError) {
      res.status(502).json(makeErrorResponse(err.message));
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json(makeErrorResponse(message));
  }
});

router.post("/repositories/scan", async (_req: Request, res: Response) => {
  try {
    const repos = await db
      .select({
        id: repositoriesTable.id,
        name: repositoriesTable.name,
        url: repositoriesTable.url,
      })
      .from(repositoriesTable);

    if (repos.length === 0) {
      res
        .status(400)
        .json(makeErrorResponse("No repositories to scan"));
      return;
    }

    const requestedIds = new Set(repos.map((r) => r.id));

    let pythonResp: Awaited<ReturnType<typeof callPythonRepositoryScan>>;
    try {
      pythonResp = await callPythonRepositoryScan({
        repositories: repos.map((r) => ({
          id: r.id,
          name: r.name,
          url: r.url,
        })),
      });
    } catch (err) {
      if (err instanceof PythonCoreUnavailable) {
        res.status(503).json(makeErrorResponse(err.message));
        return;
      }
      if (err instanceof PythonCoreError) {
        res.status(502).json(makeErrorResponse(err.message));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json(makeErrorResponse(message));
      return;
    }

    if (pythonResp.status === "completed" && pythonResp.repos.length > 0) {
      const unknownIds = pythonResp.repos
        .filter((r) => !requestedIds.has(r.id))
        .map((r) => r.id);

      if (unknownIds.length > 0) {
        res.status(500).json(
          makeErrorResponse(
            `Python scan returned unknown repository IDs: ${unknownIds.join(", ")}`,
          ),
        );
        return;
      }

      const validClassifications = new Set([
        "service", "library", "tool", "infrastructure", "unknown",
      ]);
      const invalidClassifications = pythonResp.repos
        .filter((r) => !validClassifications.has(r.classification))
        .map((r) => `${r.id}=${r.classification}`);

      if (invalidClassifications.length > 0) {
        res.status(502).json(
          makeErrorResponse(
            `Python scan returned invalid classifications: ${invalidClassifications.join(", ")}`,
          ),
        );
        return;
      }
    }

    await db.transaction(async (tx) => {
      await tx
        .insert(runsTable)
        .values({
          runId: pythonResp.runId,
          workflowId: null,
          agentId: null,
          type: "scan",
          name: "Repository Scan",
          status: pythonResp.status,
          progress: pythonResp.progress,
          startedAt: pythonResp.startedAt,
          completedAt: pythonResp.completedAt ?? null,
          errorMessage:
            pythonResp.status === "failed"
              ? (pythonResp.error ?? "Scan failed")
              : null,
        })
        .onConflictDoUpdate({
          target: runsTable.runId,
          set: {
            status: sql`excluded.status`,
            progress: sql`excluded.progress`,
            completedAt: sql`excluded.completed_at`,
            errorMessage: sql`excluded.error_message`,
          },
        });

      if (pythonResp.status === "completed") {
        for (const repo of pythonResp.repos) {
          await tx
            .update(repositoriesTable)
            .set({
              language: repo.language,
              classification: repo.classification as typeof repositoriesTable.classification.enumValues[number],
              dependencyCount: repo.dependencyCount,
              overlapScore: repo.overlapScore,
              updatedAt: new Date(),
            })
            .where(eq(repositoriesTable.id, repo.id));
        }
      }
    });

    res.json(
      makeOkResponse({
        runId: pythonResp.runId,
        type: "scan" as const,
        name: "Repository Scan",
        status: pythonResp.status,
        progress: pythonResp.progress,
        startedAt: new Date(pythonResp.startedAt),
        completedAt: pythonResp.completedAt
          ? new Date(pythonResp.completedAt)
          : null,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json(makeErrorResponse(message));
  }
});

export default router;
