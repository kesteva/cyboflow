-- Migration 053: workflow A/B testing — per-entity experiment ARM ownership.
--
-- Slice B stamped `experiment_id` on entities created inside a side-by-side
-- experiment (migration 049), but BOTH arms of one experiment share the same
-- experiment_id. The sandbox guard in TaskChangeRouter therefore only enforced
-- "this entity belongs to SOME arm of my experiment", not "this entity belongs
-- to MY arm" — so an arm run that obtained the other arm's entity id/ref could
-- mutate it (or wire a dependency to it), contaminating the head-to-head. This
-- column records WHICH arm created the entity, so the guard can require BOTH
-- experiment_id AND experiment_arm to match, and the read path (cyboflow_get_task)
-- can hide the other arm's hidden rows.
--
-- Stamped alongside experiment_id at CREATE (TaskChangeRouter): non-null exactly
-- when experiment_id is non-null; cleared (to NULL) together with experiment_id
-- when the winner is promoted out of the sandbox on decide. The value is
-- controlled entirely by the router; the CHECK is belt-and-braces (existing rows
-- are NULL, which the CHECK admits).
--
-- PRAGMA foreign_keys is OFF during migration (database.ts); ALTER ADD COLUMN is
-- idempotent via the filename-keyed ledger and runs inside runFileBasedMigrations'
-- transaction wrapper.
--
-- Migration ownership (cross-slice contract): 048 owns workflow_variants + the
-- four workflow_runs stamp columns (incl. workflow_runs.experiment_arm); 049 owns
-- the experiments table + the ideas/epics/tasks experiment_id/caused_by_run_id
-- columns + workflow_runs.merge_sha; 050 owns experiment_comparisons; 051 owns
-- experiment_seed_tasks; 052 owns the experiments promotion columns; 053 (this
-- file) owns ONLY the ideas/epics/tasks experiment_arm column.
--
-- ⚠️ MIGRATION-NUMBER COLLISION: numbers through 052 were previously claimed (at
-- various points) by sibling branches, per the collision notes on 049-052. The
-- ledger is filename-keyed; whichever branch lands second must renumber. The
-- integrator MUST verify no other 053_*.sql exists at merge time
-- (`ls main/src/database/migrations/`).

ALTER TABLE ideas ADD COLUMN experiment_arm TEXT CHECK (experiment_arm IN ('A','B'));
ALTER TABLE epics ADD COLUMN experiment_arm TEXT CHECK (experiment_arm IN ('A','B'));
ALTER TABLE tasks ADD COLUMN experiment_arm TEXT CHECK (experiment_arm IN ('A','B'));
