-- Migration 068: run_evals.jury_json — per-slot eval-jury provenance (nullable).
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
-- ⚠️ MIGRATION-NUMBER COLLISION: 068 is intentional because 066/067 are
-- claimed by a sibling branch. The ledger is filename-keyed, so the integrator
-- MUST verify no other 068_*.sql exists at merge time and renumber if needed.

ALTER TABLE run_evals ADD COLUMN jury_json TEXT;
