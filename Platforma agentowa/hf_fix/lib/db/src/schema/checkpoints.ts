import { pgTable, text, timestamp, jsonb, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workflowRunsTable } from "./workflowRuns";

export const checkpointsTable = pgTable(
  "workflow_checkpoints",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => workflowRunsTable.id),
    nodeId: text("node_id").notNull(),
    nodeName: text("node_name").notNull().default(""),
    checkpointType: text("checkpoint_type").notNull().default("workflow.node"),
    status: text("status").notNull().default("active"),
    resumable: boolean("resumable").notNull().default(true),
    state: jsonb("state").$type<Record<string, unknown>>().notNull().default({}),
    memoryRefs: jsonb("memory_refs").$type<string[]>().notNull().default([]),
    traceRefs: jsonb("trace_refs").$type<string[]>().notNull().default([]),
    savedAt: timestamp("saved_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    activePerNodeIdx: uniqueIndex("workflow_checkpoints_active_per_node_idx")
      .on(table.runId, table.nodeId)
      .where(sql`${table.status} = 'active'`),
  }),
);

export type WorkflowCheckpoint = typeof checkpointsTable.$inferSelect;
export type InsertWorkflowCheckpoint = typeof checkpointsTable.$inferInsert;
