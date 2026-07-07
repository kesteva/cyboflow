-- Migration 051: workflow A/B testing — per-arm SEED-TASK clone mapping.
--
-- The side-by-side experiment feature (migs 048-050) seeds an experiment from an
-- optional IDEA. A SPRINT experiment is task-driven instead: each arm runs a real
-- task set, so startSideBySide CLONES every selected seed task PER ARM (each clone
-- experiment-tagged, so it is board-hidden + sandbox-scoped) and launches the arm
-- with the arm's clone `taskIds` — the normal sprint stage/lane machinery then runs
-- inside the sandbox. This table records (experiment, arm, original -> clone) so
-- decide can fold each winner clone's outcome back onto its ORIGINAL task and sweep
-- every clone (both arms) on decide / discard / abandon / boot recovery.
--
-- NOT an entity table: the ideas/epics/tasks chokepoint does not touch it. Its
-- writes are direct helpers in experimentStore (insert on start, DELETE on
-- decide/abandon); the clone ROWS in `tasks` are still created/swept exclusively
-- through TaskChangeRouter. clone_task_id is the sandbox tag's mirror here.
--
-- PRAGMA foreign_keys is OFF during migration (database.ts), so the cross-table
-- links below are SOFT (no FK clauses); the ledger is filename-keyed and this runs
-- inside runFileBasedMigrations' transaction wrapper.
--
-- Migration ownership (cross-slice contract): 048 owns workflow_variants + the four
-- workflow_runs stamp columns; 049 owns the experiments table + the ideas/epics/
-- tasks sandbox+attribution columns + workflow_runs.merge_sha; 050 owns
-- experiment_comparisons; 051 (this file) owns ONLY experiment_seed_tasks.
--
-- ⚠️ MIGRATION-NUMBER COLLISION: numbers 043/044/045 were previously claimed by
-- sibling branches. The ledger is filename-keyed; whichever lands second must
-- renumber. The integrator MUST verify no other 051_*.sql exists at merge time.

CREATE TABLE IF NOT EXISTS experiment_seed_tasks (
  experiment_id    TEXT NOT NULL,
  arm              TEXT NOT NULL CHECK (arm IN ('A','B')),
  original_task_id TEXT NOT NULL,           -- the board task the user selected
  clone_task_id    TEXT NOT NULL,           -- the per-arm experiment-tagged clone
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- One clone per (experiment, arm, original) — start inserts exactly this set.
  UNIQUE (experiment_id, arm, original_task_id),
  -- Each clone belongs to exactly one mapping row (sweep enumerates by clone id).
  UNIQUE (clone_task_id)
);

CREATE INDEX IF NOT EXISTS idx_experiment_seed_tasks_experiment
  ON experiment_seed_tasks(experiment_id);
