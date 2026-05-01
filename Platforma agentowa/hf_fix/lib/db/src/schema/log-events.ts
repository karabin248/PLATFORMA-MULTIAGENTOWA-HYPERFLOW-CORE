import { pgTable, text, jsonb } from "drizzle-orm/pg-core";

export const logEventsTable = pgTable("log_events", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  correlationId: text("correlation_id").notNull(),
  severity: text("severity").notNull(),
  message: text("message").notNull(),
  summary: text("summary").notNull(),
  context: jsonb("context").notNull().default({}),
  timestamp: text("timestamp").notNull(),
});

export type LogEventRow = typeof logEventsTable.$inferSelect;
