import { pgTable, text, timestamp, jsonb, integer, real, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { agentsTable } from "./agents";

export const agentRunsTable = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull().references(() => agentsTable.id),
    agentVersion: text("agent_version").notNull(),
    status: text("status").notNull().default("queued"),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    resolvedPrompt: text("resolved_prompt"),
    runtimeRequest: jsonb("runtime_request").$type<Record<string, unknown>>(),
    runtimeResponse: jsonb("runtime_response").$type<Record<string, unknown>>(),
    output: jsonb("output").$type<Record<string, unknown>>(),
    normalizedOutput: jsonb("normalized_output").$type<{
      summary: string;
      structured: Record<string, unknown>;
      artifacts: string[];
      qualityScore: number | null;
      warnings: string[];
      nextSuggestedAction: string | null;
    }>(),
    rawOutput: jsonb("raw_output").$type<Record<string, unknown>>(),
    error: text("error"),
    errorCode: text("error_code"),
    errorCategory: text("error_category"),
    runtimeRunId: text("runtime_run_id"),
    canonicalTrace: jsonb("canonical_trace").$type<{
      canonical_combo: string;
      canonical_phases: string[];
      phases_completed: string[];
      terminal_phase: string;
      order_preserved: boolean;
      cycle_version: string;
      mps_level: number;
      mps_name: string;
      canonical_combo_detected: boolean;
    }>(),
    // EDDE phase trace — one entry per canonical phase
    // (perceive, extract_essence, sense_direction, synthesize, generate_options, choose).
    // Each phase is the raw bundle["phases"][name] dict produced by the Python core,
    // including phase-local degraded flags (e.g. synthesize.degraded=true when the
    // stub fallback was used). Persisting this enables operators to inspect quality
    // drift over time without replaying runs against the core.
    phases: jsonb("phases").$type<Record<string, Record<string, unknown>>>(),
    degraded: jsonb("degraded").$type<{ degraded: boolean; reason: string | null }>(),
    checkpointRefs: jsonb("checkpoint_refs").$type<string[]>().default([]),
    qualityScore: real("quality_score"),
    parentRunId: text("parent_run_id"),
    originRunId: text("origin_run_id"),
    retryCount: integer("retry_count").default(0),
    retryReason: text("retry_reason"),
    requestedBy: text("requested_by").default("operator"),
    correlationId: text("correlation_id"),
    idempotencyKey: text("idempotency_key"),
    queuedAt: timestamp("queued_at"),
    admittedAt: timestamp("admitted_at"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    failedAt: timestamp("failed_at"),
    cancelledAt: timestamp("cancelled_at"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ([
    // Persistence-backed uniqueness: prevents duplicate runs under idempotency race.
    // INSERT ... ON CONFLICT (idempotency_key) DO NOTHING is only safe with this constraint.
    uniqueIndex("agent_runs_idempotency_key_idx").on(table.idempotencyKey),
  ]),
);

export const insertAgentRunSchema = createInsertSchema(agentRunsTable).omit({
  createdAt: true,
});

export type InsertAgentRun = z.infer<typeof insertAgentRunSchema>;
export type AgentRun = typeof agentRunsTable.$inferSelect;
