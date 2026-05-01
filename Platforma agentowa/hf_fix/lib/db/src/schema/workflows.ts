import { pgTable, text, timestamp, jsonb, integer, serial, uniqueIndex } from "drizzle-orm/pg-core";

export const workflowsTable = pgTable("workflows", {
  id: text("id").primaryKey(),
  version: text("version").notNull().default("1.0.0"),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("active"),
  definition: jsonb("definition").$type<{
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  }>().notNull().default({ nodes: [], edges: [] }),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  owner: text("owner"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const workflowRevisionsTable = pgTable("workflow_revisions", {
  id: serial("id").primaryKey(),
  workflowId: text("workflow_id").notNull().references(() => workflowsTable.id),
  revisionNumber: integer("revision_number").notNull(),
  spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
  changedFields: jsonb("changed_fields").$type<string[]>().notNull().default([]),
  changedBy: text("changed_by").default("operator"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ([
  uniqueIndex("workflow_revisions_workflow_revision_idx").on(table.workflowId, table.revisionNumber),
]));

export type Workflow = typeof workflowsTable.$inferSelect;
export type InsertWorkflow = typeof workflowsTable.$inferInsert;
export type WorkflowRevision = typeof workflowRevisionsTable.$inferSelect;
export type InsertWorkflowRevision = typeof workflowRevisionsTable.$inferInsert;
