import app from "./app";
import { logger } from "./lib/logger";
import { getConfig } from "./lib/config";
import { pool, db, agentsTable } from "@workspace/db";
import { pythonClient } from "./lib/pythonClient";
import { startExecutor, stopExecutor } from "./lib/workflowExecutor";

const config = getConfig();

async function verifySchema(): Promise<void> {
  await db.select({ id: agentsTable.id }).from(agentsTable).limit(1);
  logger.info("Database schema verified");
}

export async function checkDependencies(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    logger.info("Database connection verified");
  } finally {
    client.release();
  }

  await verifySchema();

  const coreResult = await pythonClient.health();
  if (!coreResult.ok) {
    throw new Error(`Hyperflow Core health verification failed: ${coreResult.error.code} ${coreResult.error.message}`);
  }

  logger.info("Hyperflow Core connection verified");
}

export async function startServer(): Promise<void> {
  const rawPort = process.env["PORT"];

  if (!rawPort) {
    throw new Error("PORT environment variable is required but was not provided.");
  }

  const port = Number(rawPort);

  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: \"${rawPort}\"`);
  }

  await checkDependencies();

  await new Promise<void>((resolve, reject) => {
    app.listen(port, (err) => {
      if (err) {
        reject(err);
        return;
      }

      logger.info(
        {
          port,
          mode: config.hardenedMode ? "hardened" : "development",
          coreUrl: config.coreUrl,
        },
        "Server listening",
      );
      resolve();
    });
  });

  // Start durable workflow executor — runs in background, survives individual HTTP requests.
  startExecutor();

  // Graceful shutdown: stop executor loop on SIGTERM/SIGINT.
  const shutdown = () => {
    logger.info("Shutdown signal received, stopping executor");
    stopExecutor();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

const isMainModule = process.argv[1] != null && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMainModule) {
  startServer().catch((err) => {
    logger.fatal({ err }, "Server startup failed");
    process.exit(1);
  });
}
