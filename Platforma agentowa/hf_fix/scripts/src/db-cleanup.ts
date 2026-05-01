import pg from "pg";

const { Pool } = pg;

async function cleanup() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const retentionDays = Number(process.argv[2] || 90);
  const dryRun = process.argv.includes("--dry-run");

  const pool = new Pool({ connectionString: dbUrl });

  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    console.log(`Retention policy: ${retentionDays} days`);
    console.log(`Cutoff date: ${cutoff.toISOString()}`);
    if (dryRun) console.log("DRY RUN — no data will be deleted");

    const countResult = await pool.query(
      "SELECT count(*) FROM agent_runs WHERE created_at < $1 AND status IN ('completed', 'failed', 'cancelled')",
      [cutoff],
    );
    const count = Number(countResult.rows[0].count);
    console.log(`Runs eligible for cleanup: ${count}`);

    if (!dryRun && count > 0) {
      const deleteResult = await pool.query(
        "DELETE FROM agent_runs WHERE created_at < $1 AND status IN ('completed', 'failed', 'cancelled') RETURNING id",
        [cutoff],
      );
      console.log(`Deleted ${deleteResult.rowCount} runs`);
    }

    const traceFiles = ["storage/traces.jsonl", "storage/knowledge_store.jsonl"];
    console.log("\nRuntime trace files (manual cleanup if needed):");
    for (const f of traceFiles) {
      console.log(`  artifacts/hyperflow-core/${f}`);
    }
    console.log("Note: Truncate these files manually if they grow too large.");
  } catch (err) {
    console.error("Cleanup failed:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

cleanup();
