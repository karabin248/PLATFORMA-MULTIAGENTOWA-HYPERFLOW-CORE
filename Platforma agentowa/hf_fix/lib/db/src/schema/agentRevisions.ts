import { pgTable, text, timestamp, jsonb, integer, serial } from "drizzle-orm/pg-core";
import { agentsTable } from "./agents";

export const agentRevisionsTable = pgTable("agent_revisions", {
  id: serial("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agentsTable.id),
  revisionNumber: integer("revision_number").notNull(),
  spec: jsonb("spec").$type<{
    name: string;
    version: string;
    description: string;
    status: string;
    role: string;
    capabilities: string[];
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    runtimeMode: string;
    executionPolicy: Record<string, unknown>;
    promptTemplate: string;
    tags: string[];
    owner: string | null;
  }>().notNull(),
  changedFields: jsonb("changed_fields").$type<string[]>().default([]),
  changedBy: text("changed_by").default("operator"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AgentRevision = typeof agentRevisionsTable.$inferSelect;
export type InsertAgentRevision = typeof agentRevisionsTable.$inferInsert;
