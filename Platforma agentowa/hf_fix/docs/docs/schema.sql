-- =============================================================================
-- Hyperflow-PLATFORM — Initial database schema
-- =============================================================================
-- Generated from lib/db/src/schema/*.ts (drizzle-orm definitions).
-- Run this ONCE against a fresh PostgreSQL database before starting api-server.
--
-- Usage (Railway):
--   1. Open Postgres service → "Query" tab
--   2. Paste this entire file
--   3. Click "Run"
--
-- Usage (docker-compose):
--   docker compose exec postgres psql -U hyperflow -d hyperflow < docs/schema.sql
--
-- Idempotent: uses IF NOT EXISTS so it's safe to re-run.
-- =============================================================================

-- -------------------------------------------------------------------- agents
CREATE TABLE IF NOT EXISTS agents (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  version             TEXT NOT NULL DEFAULT '1.0.0',
  description         TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'active',
  role                TEXT NOT NULL DEFAULT 'assistant',
  capabilities        JSONB NOT NULL DEFAULT '[]'::jsonb,
  input_schema        JSONB DEFAULT '{}'::jsonb,
  output_schema       JSONB DEFAULT '{}'::jsonb,
  runtime_mode        TEXT NOT NULL DEFAULT 'standard',
  execution_policy    JSONB DEFAULT '{}'::jsonb,
  prompt_template     TEXT NOT NULL DEFAULT '',
  tags                JSONB DEFAULT '[]'::jsonb,
  owner               TEXT,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------- agent_runs
CREATE TABLE IF NOT EXISTS agent_runs (
  id                  TEXT PRIMARY KEY,
  agent_id            TEXT NOT NULL REFERENCES agents(id),
  agent_version       TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued',
  input               JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved_prompt     TEXT,
  runtime_request     JSONB,
  runtime_response    JSONB,
  output              JSONB,
  normalized_output   JSONB,
  raw_output          JSONB,
  error               TEXT,
  error_code          TEXT,
  error_category      TEXT,
  runtime_run_id      TEXT,
  canonical_trace     JSONB,
  checkpoint_refs     JSONB DEFAULT '[]'::jsonb,
  quality_score       REAL,
  parent_run_id       TEXT,
  origin_run_id       TEXT,
  retry_count         INTEGER DEFAULT 0,
  retry_reason        TEXT,
  requested_by        TEXT DEFAULT 'operator',
  correlation_id      TEXT,
  idempotency_key     TEXT,
  queued_at           TIMESTAMP,
  admitted_at         TIMESTAMP,
  started_at          TIMESTAMP,
  completed_at        TIMESTAMP,
  failed_at           TIMESTAMP,
  cancelled_at        TIMESTAMP,
  duration_ms         INTEGER,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_idempotency_key_idx
  ON agent_runs(idempotency_key);

-- ---------------------------------------------------------- agent_revisions
CREATE TABLE IF NOT EXISTS agent_revisions (
  id                  SERIAL PRIMARY KEY,
  agent_id            TEXT NOT NULL REFERENCES agents(id),
  revision_number     INTEGER NOT NULL,
  spec                JSONB NOT NULL,
  changed_fields      JSONB DEFAULT '[]'::jsonb,
  changed_by          TEXT DEFAULT 'operator',
  created_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------- workflow_approvals
-- M-01 fix: partial unique index prevents duplicate pending approvals for the
-- same (run_id, node_id) pair. The WHERE clause scopes the constraint to
-- status='pending' so decided records don't block future approval requests
-- on the same node after a re-run.
CREATE TABLE IF NOT EXISTS workflow_approvals (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES workflow_runs(id),
  node_id             TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  reason              TEXT NOT NULL,
  objective           TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  decided_at          TIMESTAMP,
  actor_id            TEXT,
  note                TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS workflow_approvals_run_node_pending_unique
  ON workflow_approvals(run_id, node_id)
  WHERE status = 'pending';
