-- Migration 047: workflow A/B testing (slice B) — side-by-side experiments
-- umbrella + entity-sandbox / attribution columns + run merge-sha close-out.
--
-- PRAGMA foreign_keys is OFF during migration (database.ts), so all cross-table
-- links below are SOFT (no FK clauses); ALTER ADD COLUMN is idempotent via the
-- filename-keyed ledger. Runs inside runFileBasedMigrations' transaction wrapper.
--
-- Migration ownership (cross-slice contract): 046 owns the workflow_variants
-- table + the four workflow_runs stamp columns (experiment_id / experiment_arm /
-- variant_id / variant_label); 047 (this file) owns the experiments table, the
-- ideas/epics/tasks sandbox+attribution columns, and workflow_runs.merge_sha;
-- 048 (slice C) owns experiment_comparisons.
--
-- ⚠️ MIGRATION-NUMBER COLLISION: sibling branches have previously claimed 043/044.
-- The ledger is filename-keyed; whichever lands second must renumber. The
-- integrator MUST verify no other 047_*.sql exists at merge time.

CREATE TABLE IF NOT EXISTS experiments (
  id                    TEXT PRIMARY KEY,                 -- 'exp_' + hex
  project_id            INTEGER NOT NULL,
  workflow_id           TEXT NOT NULL,
  kind                  TEXT NOT NULL DEFAULT 'side_by_side'
                          CHECK (kind IN ('side_by_side')),
  base_branch           TEXT NOT NULL,
  base_sha              TEXT NOT NULL,           -- resolved ONCE; both arm worktrees pin this
  variant_a_id          TEXT NOT NULL,
  variant_b_id          TEXT NOT NULL,
  run_a_id              TEXT,                    -- workflow_runs.id, NULL until arm A launched
  run_b_id              TEXT,
  session_a_id          TEXT,
  session_b_id          TEXT,
  seed_idea_id          TEXT,                    -- ORIGINAL idea; NULL = unseeded experiment
  seed_idea_clone_a_id  TEXT,                    -- per-arm hidden clone; NULL when unseeded
  seed_idea_clone_b_id  TEXT,
  status                TEXT NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running','grading','decided','abandoned')),
  winner_run_id         TEXT,
  winner_arm            TEXT CHECK (winner_arm IN ('A','B')),
  merge_sha             TEXT,                    -- denormalized mirror of winner run's merge_sha
  decided_at            TEXT,
  -- Soft chain link (experiments.rerun): the source experiment this head-to-head
  -- was re-run from. NULL for an original experiment. The dashboard (slice C)
  -- groups repeated head-to-heads into a series via this chain.
  rerun_of_experiment_id TEXT,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_experiments_project ON experiments(project_id);
CREATE INDEX IF NOT EXISTS idx_experiments_status  ON experiments(status);

-- Entity-sandbox tag: a non-null experiment_id marks the row as an experiment
-- draft (hidden from the board, sandbox-scoped for updates). Cleared on promote.
ALTER TABLE ideas ADD COLUMN experiment_id TEXT;
ALTER TABLE epics ADD COLUMN experiment_id TEXT;
ALTER TABLE tasks ADD COLUMN experiment_id TEXT;

-- Post-merge bug attribution (v1 manual link): the run that introduced this
-- entity. Set via TaskChangeRouter; read by slice 3 stats joined to merge_sha.
ALTER TABLE ideas ADD COLUMN caused_by_run_id TEXT;
ALTER TABLE epics ADD COLUMN caused_by_run_id TEXT;
ALTER TABLE tasks ADD COLUMN caused_by_run_id TEXT;

-- The merge commit SHA where this run's code landed, stamped at merge close-out.
-- (046 owns experiment_id/experiment_arm/variant_id/variant_label on
--  workflow_runs; 047 owns ONLY this close-out column.)
ALTER TABLE workflow_runs ADD COLUMN merge_sha TEXT;

CREATE INDEX IF NOT EXISTS idx_ideas_experiment ON ideas(experiment_id);
CREATE INDEX IF NOT EXISTS idx_epics_experiment ON epics(experiment_id);
CREATE INDEX IF NOT EXISTS idx_tasks_experiment ON tasks(experiment_id);
