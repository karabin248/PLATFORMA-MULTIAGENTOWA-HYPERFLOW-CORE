-- =============================================================================
-- Migration 0002: Scope workflow run idempotency by workflow_id
-- =============================================================================
-- Replaces global unique constraint on workflow_runs.idempotency_key with
-- composite uniqueness on (workflow_id, idempotency_key).
--
-- This preserves idempotency for retries within the same workflow while
-- allowing different workflows to reuse the same idempotency key.
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS workflow_runs_idempotency_key_idx;

CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_workflow_id_idempotency_key_idx
  ON workflow_runs(workflow_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMIT;
