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

-- BACKFILL. The new column stamps NULL on every existing row, but the arm-scoped
-- sandbox guard treats a tagged entity with a NULL arm as owned by NO arm — so an
-- in-flight experiment created before this migration (experiment_id set, arm NULL)
-- would strand its own runs (they could no longer read/update their entities).
-- Recover the arm for every already-tagged entity from its authoritative source.
-- (The A/B feature is unshipped, so in practice this only rescues a dev DB with a
--  live experiment across the upgrade — but it keeps the invariant self-consistent
--  and removes the trap if these migrations are ever squashed.)

-- 1. Orchestrator-created seed IDEA clones — arm is recorded directly on the
--    experiments row (these carry no run-created event to derive from).
UPDATE ideas SET experiment_arm = 'A'
 WHERE experiment_id IS NOT NULL AND experiment_arm IS NULL
   AND id IN (SELECT seed_idea_clone_a_id FROM experiments WHERE seed_idea_clone_a_id IS NOT NULL);
UPDATE ideas SET experiment_arm = 'B'
 WHERE experiment_id IS NOT NULL AND experiment_arm IS NULL
   AND id IN (SELECT seed_idea_clone_b_id FROM experiments WHERE seed_idea_clone_b_id IS NOT NULL);

-- 2. Orchestrator-created seed TASK clones (migration 051) — arm is recorded in the
--    per-arm clone mapping.
UPDATE tasks SET experiment_arm = (
  SELECT est.arm FROM experiment_seed_tasks est WHERE est.clone_task_id = tasks.id LIMIT 1
)
 WHERE experiment_id IS NOT NULL AND experiment_arm IS NULL
   AND id IN (SELECT clone_task_id FROM experiment_seed_tasks);

-- 3. Run-created entities (an arm agent's own epics/tasks/ideas) — derive the arm
--    from the creating run via the entity's EARLIEST event whose run belongs to the
--    same experiment and carries an arm. Seed clones (run_id NULL on their event)
--    are already handled above and skipped here by the experiment_arm IS NULL guard.
UPDATE ideas SET experiment_arm = (
  SELECT wr.experiment_arm FROM entity_events ee
    JOIN workflow_runs wr ON wr.id = ee.run_id
   WHERE ee.entity_type = 'idea' AND ee.entity_id = ideas.id
     AND wr.experiment_id = ideas.experiment_id AND wr.experiment_arm IS NOT NULL
   ORDER BY ee.seq ASC LIMIT 1
)
 WHERE experiment_id IS NOT NULL AND experiment_arm IS NULL;
UPDATE epics SET experiment_arm = (
  SELECT wr.experiment_arm FROM entity_events ee
    JOIN workflow_runs wr ON wr.id = ee.run_id
   WHERE ee.entity_type = 'epic' AND ee.entity_id = epics.id
     AND wr.experiment_id = epics.experiment_id AND wr.experiment_arm IS NOT NULL
   ORDER BY ee.seq ASC LIMIT 1
)
 WHERE experiment_id IS NOT NULL AND experiment_arm IS NULL;
UPDATE tasks SET experiment_arm = (
  SELECT wr.experiment_arm FROM entity_events ee
    JOIN workflow_runs wr ON wr.id = ee.run_id
   WHERE ee.entity_type = 'task' AND ee.entity_id = tasks.id
     AND wr.experiment_id = tasks.experiment_id AND wr.experiment_arm IS NOT NULL
   ORDER BY ee.seq ASC LIMIT 1
)
 WHERE experiment_id IS NOT NULL AND experiment_arm IS NULL;
