import { pgTable, text, timestamp, jsonb, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const agentsTable = pgTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: text("version").notNull().default("1.0.0"),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("active"),
  role: text("role").notNull().default("assistant"),
  capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
  inputSchema: jsonb("input_schema").$type<Record<string, unknown>>().default({}),
  outputSchema: jsonb("output_schema").$type<Record<string, unknown>>().default({}),
  runtimeMode: text("runtime_mode").notNull().default("standard"),
  executionPolicy: jsonb("execution_policy").$type<{
    timeoutMs?: number;
    maxRetries?: number;
    runtimeMode?: string;
    modelHint?: string;
    safeConstraintProfile?: string;
  }>().default({}),
  promptTemplate: text("prompt_template").notNull().default(""),
  tags: jsonb("tags").$type<string[]>().default([]),
  owner: text("owner"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertAgentSchema = createInsertSchema(agentsTable).omit({
  createdAt: true,
  updatedAt: true,
});

export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Agent = typeof agentsTable.$inferSelect;
