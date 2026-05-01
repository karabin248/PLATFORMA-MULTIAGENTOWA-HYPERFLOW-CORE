-- =============================================================================
-- Migration 0001: Add partial unique index to workflow_approvals (M-01 fix)
-- =============================================================================
-- Security fix: prevents duplicate pending approval records for the same
-- (run_id, node_id) pair that could arise from the previous non-atomic
-- read-check-insert sequence in routes/approvals.ts.
--
-- The WHERE clause scopes the constraint to status='pending' only, so:
--   - decided/rejected approvals do not block future requests on the same node
--   - re-runs of the same workflow can create new pending approvals freely
--
-- This index is idempotent (CREATE ... IF NOT EXISTS) and safe to apply to a
-- live database without locking the table.
--
-- Apply with:
--   psql -U hyperflow -d hyperflow < docs/migrations/0001_approvals_pending_unique.sql
-- =============================================================================

BEGIN;

-- Create workflow_approvals table if it doesn't exist yet (for fresh installs
-- that have not yet applied schema.sql).
CREATE TABLE IF NOT EXISTS workflow_approvals (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
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

-- Partial unique index — the security-critical part of this migration.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_approvals_run_node_pending_unique
  ON workflow_approvals(run_id, node_id)
  WHERE status = 'pending';

COMMIT;
