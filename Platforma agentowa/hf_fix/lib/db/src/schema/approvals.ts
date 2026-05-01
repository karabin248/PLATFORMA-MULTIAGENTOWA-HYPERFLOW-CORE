import { pgTable, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workflowRunsTable } from "./workflowRuns";

// M-01 fix: partial unique index prevents duplicate pending approvals for the
// same (run_id, node_id) pair. The WHERE clause scopes the constraint to
// status='pending' so decided/rejected records do not block future approval
// requests on the same node after a re-run. This index is the database-level
// enforcement companion to the ON CONFLICT guard in routes/approvals.ts.
export const approvalsTable = pgTable(
  "workflow_approvals",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => workflowRunsTable.id),
    nodeId: text("node_id").notNull(),
    status: text("status").notNull().default("pending"),
    reason: text("reason").notNull(),
    objective: text("objective"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    decidedAt: timestamp("decided_at"),
    actorId: text("actor_id"),
    note: text("note"),
  },
  (table) => [
    uniqueIndex("workflow_approvals_run_node_pending_unique")
      .on(table.runId, table.nodeId)
      .where(sql`${table.status} = 'pending'`),
  ],
);

export type WorkflowApproval = typeof approvalsTable.$inferSelect;
export type InsertWorkflowApproval = typeof approvalsTable.$inferInsert;
