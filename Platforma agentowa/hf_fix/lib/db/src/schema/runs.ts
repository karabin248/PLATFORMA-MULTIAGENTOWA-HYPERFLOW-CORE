import { pgTable, text, real, timestamp, pgEnum } from "drizzle-orm/pg-core";

export const runStatusEnum = pgEnum("run_status", [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const runTypeEnum = pgEnum("run_type", ["workflow", "agent", "scan"]);

export const runsTable = pgTable("runs", {
  runId: text("run_id").primaryKey(),
  workflowId: text("workflow_id"),
  agentId: text("agent_id"),
  type: runTypeEnum("type").notNull(),
  name: text("name").notNull(),
  status: runStatusEnum("status").notNull().default("pending"),
  progress: real("progress").notNull().default(0),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Run = typeof runsTable.$inferSelect;
