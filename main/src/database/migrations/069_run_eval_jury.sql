-- Migration 069: run_evals.jury_json — per-slot eval-jury provenance (nullable).
--
-- Stores per-slot jury provenance:
--   [{slot, provider, model, status, errorCode?, sampleIndex?}]
-- where status is one of 'ok' | 'unavailable' | 'failed'. NULL identifies a
-- legacy pre-jury row graded by the original single-judge implementation; it must
-- NOT be interpreted as a missing Codex juror.
--
-- NOTE: runFileBasedMigrations() in database.ts wraps every file in a
-- this.transaction(...) call, so no explicit BEGIN/COMMIT belongs here. ALTER
-- TABLE ADD COLUMN is idempotent via the filename-keyed ledger; a re-applied
-- "duplicate column name" is caught as idempotent-ok in runFileBasedMigrations
-- (same handling as migration 044 and the nullable ALTER migrations it cites).
--
-- HISTORY: originally authored as 068, renumbered to 069 at rebase onto main
-- because main's 068_workflow_variant_agent_provider_runtime.sql claimed 068.
-- The ledger is filename-keyed, so verify no other 069_*.sql exists at merge time.

ALTER TABLE run_evals ADD COLUMN jury_json TEXT;
