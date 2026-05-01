import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

const poolStats = { totalErrors: 0, totalConnects: 0 };

pool.on("error", (err) => {
  poolStats.totalErrors++;
  console.error("Unexpected pool error", err.message);
});

pool.on("connect", () => {
  poolStats.totalConnects++;
});

export function getPoolStats() {
  return {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    activeCount: pool.totalCount - pool.idleCount,
    maxSize: 20,
    totalErrors: poolStats.totalErrors,
    totalConnects: poolStats.totalConnects,
  };
}

export const db = drizzle(pool, { schema });

export * from "./schema";
