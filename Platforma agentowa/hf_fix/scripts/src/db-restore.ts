import pg from "pg";
import { readFileSync } from "fs";

const { Pool } = pg;

interface BackupData {
  version: string;
  exportedAt: string;
  tables: {
    agents: { count: number; rows: Record<string, unknown>[] };
    agent_revisions: { count: number; rows: Record<string, unknown>[] };
    agent_runs: { count: number; rows: Record<string, unknown>[] };
  };
}

async function insertRows(
  client: pg.PoolClient,
  table: string,
  rows: Record<string, unknown>[],
): Promise<number> {
  let inserted = 0;
  for (const row of rows) {
    const keys = Object.keys(row);
    const values = Object.values(row);
    const placeholders = keys.map((_, i) => `$${i + 1}`);
    const cols = keys.map((k) => `"${k}"`);
    const result = await client.query(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders.join(", ")}) ON CONFLICT (id) DO NOTHING`,
      values,
    );
    if (result.rowCount && result.rowCount > 0) inserted++;
  }
  return inserted;
}

async function restore() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error("Usage: db-restore <backup-file.json>");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: dbUrl });

  try {
    const raw = readFileSync(inputFile, "utf-8");
    const data: BackupData = JSON.parse(raw);

    console.log(`Restoring backup from ${data.exportedAt} (version ${data.version})`);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query("DELETE FROM agent_runs");
      await client.query("DELETE FROM agent_revisions");
      await client.query("DELETE FROM agents");

      const agentCount = await insertRows(client, "agents", data.tables.agents.rows);
      const revisionCount = await insertRows(client, "agent_revisions", data.tables.agent_revisions.rows);
      const runCount = await insertRows(client, "agent_runs", data.tables.agent_runs.rows);

      await client.query("COMMIT");
      console.log("Restore completed:");
      console.log(`  agents: ${agentCount}/${data.tables.agents.count}`);
      console.log(`  agent_revisions: ${revisionCount}/${data.tables.agent_revisions.count}`);
      console.log(`  agent_runs: ${runCount}/${data.tables.agent_runs.count}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Restore failed:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

restore();
