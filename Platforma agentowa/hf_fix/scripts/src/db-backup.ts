import pg from "pg";
import { writeFileSync } from "fs";
import { join } from "path";

const { Pool } = pg;

async function backup() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: dbUrl });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = process.argv[2] || ".";
  const outputFile = join(outputDir, `hyperflow-backup-${timestamp}.json`);

  try {
    const agents = await pool.query("SELECT * FROM agents ORDER BY created_at");
    const agentRevisions = await pool.query("SELECT * FROM agent_revisions ORDER BY created_at");
    const agentRuns = await pool.query("SELECT * FROM agent_runs ORDER BY created_at");

    const backup = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      tables: {
        agents: { count: agents.rows.length, rows: agents.rows },
        agent_revisions: { count: agentRevisions.rows.length, rows: agentRevisions.rows },
        agent_runs: { count: agentRuns.rows.length, rows: agentRuns.rows },
      },
    };

    writeFileSync(outputFile, JSON.stringify(backup, null, 2));
    console.log(`Backup written to ${outputFile}`);
    console.log(`  agents: ${agents.rows.length}`);
    console.log(`  agent_revisions: ${agentRevisions.rows.length}`);
    console.log(`  agent_runs: ${agentRuns.rows.length}`);
  } catch (err) {
    console.error("Backup failed:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

backup();
