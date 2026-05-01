import { pgTable, text, serial, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { runsTable } from "./runs";

export const nodeStatusEnum = pgEnum("node_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
]);

export const runNodesTable = pgTable("run_nodes", {
  id: serial("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => runsTable.runId, { onDelete: "cascade" }),
  nodeId: text("node_id").notNull(),
  name: text("name").notNull(),
  status: nodeStatusEnum("status").notNull().default("pending"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  result: jsonb("result"),
  error: text("error"),
});

export type RunNode = typeof runNodesTable.$inferSelect;
