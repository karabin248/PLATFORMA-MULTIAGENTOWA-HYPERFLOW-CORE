import { pgTable, text, timestamp, jsonb, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { workflowRunsTable } from "./workflowRuns";

export const workflowRunNodesTable = pgTable("workflow_run_nodes", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => workflowRunsTable.id),
  nodeId: text("node_id").notNull(),
  nodeType: text("node_type").notNull(),
  status: text("status").notNull().default("pending"),
  attempt: integer("attempt").notNull().default(0),
  input: jsonb("input").$type<Record<string, unknown>>(),
  output: jsonb("output").$type<Record<string, unknown>>(),
  error: text("error"),
  waitingOn: jsonb("waiting_on").$type<string[]>().notNull().default([]),
  checkpointRef: text("checkpoint_ref"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ([
  uniqueIndex("workflow_run_nodes_run_node_idx").on(table.runId, table.nodeId),
]));

export type WorkflowRunNode = typeof workflowRunNodesTable.$inferSelect;
export type InsertWorkflowRunNode = typeof workflowRunNodesTable.$inferInsert;
