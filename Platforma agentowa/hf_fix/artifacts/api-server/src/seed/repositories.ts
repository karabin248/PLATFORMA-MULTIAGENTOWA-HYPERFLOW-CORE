import { db } from "@workspace/db";
import { repositoriesTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const SEED_REPOS = [
  {
    id: "repo-hyperflow-core",
    name: "hyperflow-core",
    url: "https://github.com/example/hyperflow-core",
  },
  {
    id: "repo-hyperflow-ui",
    name: "hyperflow-ui",
    url: "https://github.com/example/hyperflow-ui",
  },
  {
    id: "repo-hyperflow-sdk",
    name: "hyperflow-sdk",
    url: "https://github.com/example/hyperflow-sdk",
  },
];

export async function seedRepositories(): Promise<void> {
  try {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(repositoriesTable);

    if (count > 0) {
      logger.info({ count }, "repositories already seeded — skipping");
      return;
    }

    await db
      .insert(repositoriesTable)
      .values(
        SEED_REPOS.map((r) => ({
          id: r.id,
          name: r.name,
          url: r.url,
        })),
      )
      .onConflictDoNothing();

    logger.info({ count: SEED_REPOS.length }, "repositories seeded");
  } catch (err) {
    logger.warn({ err }, "repository seed failed — continuing");
  }
}
