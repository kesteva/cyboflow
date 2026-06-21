-- Migration 032: per-step results for programmatic runs (Stage 3).
--
-- The programmatic WorkflowController settles each step with a structured outcome
-- (done | skipped | failed | rejected | canceled) + attempt count + an optional
-- summary/error. Until now those StepReport records lived only in memory and were
-- returned at run end — lost on a crash. Persisting them HOST-SIDE as each step
-- settles gives two things:
--   1. deterministic, queryable per-step results (for the supervisor / UI), and
--   2. SHARPER crash-safe resume: the controller can skip steps that INDIVIDUALLY
--      completed before a restart, instead of only fast-forwarding to the coarse
--      workflow_runs.current_step_id pointer (which re-runs a finished-but-not-yet-
--      advanced step).
--
-- One row per (run_id, step_id); the latest settle wins (a looped-back step that
-- re-runs OVERWRITES its prior row via INSERT OR REPLACE). Distinct from the
-- step→agent map in workflow_runs.steps_snapshot_json (a different concern).
--
-- NOTE: No explicit BEGIN/COMMIT — runFileBasedMigrations() wraps every file in a
-- transaction. CREATE TABLE IF NOT EXISTS is idempotent for the ledger re-run guard.

CREATE TABLE IF NOT EXISTS step_results (
  run_id     TEXT NOT NULL,
  step_id    TEXT NOT NULL,
  phase_id   TEXT,
  outcome    TEXT NOT NULL CHECK (outcome IN ('done', 'skipped', 'failed', 'rejected', 'canceled')),
  attempts   INTEGER NOT NULL DEFAULT 1,
  summary    TEXT,
  error      TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_step_results_run ON step_results (run_id);
