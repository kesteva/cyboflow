-- Migration 058: rotation-experiment tracking (A/B testing, phase 1 schema).
--
-- Makes randomized ROTATIONS first-class experiment records alongside the
-- existing side-by-side head-to-heads. Three deliberate changes to `experiments`
-- (everything else carries over verbatim from 049 + 052):
--
--   1. kind CHECK widens to (kind IN ('side_by_side','rotation')). A rotation
--      experiment is per-WORKFLOW (its N arms are the workflow's live baseline +
--      its active variants), not a two-arm head-to-head.
--   2. status CHECK gains 'superseded'. A rotation experiment is closed as
--      `superseded` when its ARM-SET MEMBERSHIP changes (a variant is activated /
--      retired, or the baseline is opted in/out): the old row is superseded and a
--      SUCCESSOR row opens to track the new arm set. A pure WEIGHT change does NOT
--      close a rotation experiment (same arms, different odds) — only membership.
--   3. project_id / base_branch / base_sha / variant_a_id / variant_b_id lose
--      NOT NULL. A rotation experiment has no fixed two-arm pair (its arms live in
--      the new experiment_rotation_arms table), pins no base SHA, and — for a
--      GLOBAL workflow — has no project. Side-by-side rows still populate all five.
--
-- SQLite cannot ALTER a CHECK constraint in place, so widening the kind/status
-- CHECKs requires the table-rebuild recipe (mirrors 046 / 010 / 020 / 030): create
-- experiments_new with the FULL post-052 column set (verified column-by-column
-- against 049 + 052) but the widened CHECKs + relaxed NOT NULLs, copy every row
-- across with an explicit column list, DROP the old table, RENAME, and recreate
-- every index. All cross-table links stay SOFT (no FK clauses); PRAGMA
-- foreign_keys is OFF during the rebuild so the DROP/RENAME can never fire a
-- CASCADE/SET NULL side effect. database.ts string-scans the literal
-- 'PRAGMA foreign_keys=OFF' and manages the restore OUTSIDE the transaction (a
-- pragma toggle is a no-op inside one).
--
-- CRITICAL INVARIANT: rotation attribution must NOT reuse
-- workflow_runs.experiment_id — that column drives the side-by-side entity
-- sandbox (hidden entity clones, arm guards, migs 049/053) and rotation runs are
-- NORMAL runs. Hence the separate workflow_runs.rotation_experiment_id column
-- added below, written by the resolver at pick time.
--
-- NOTE: No explicit BEGIN/COMMIT — runFileBasedMigrations() in database.ts wraps
-- every file in a this.transaction(...) call, so an inner BEGIN would nest. The
-- PRAGMA toggles are applied OUTSIDE that transaction by the runner.

PRAGMA foreign_keys=OFF;

-- ---------------------------------------------------------------------------
-- 1. Rebuild experiments with the widened kind/status CHECKs + relaxed NOT NULLs.
--    Column set + order is the authoritative post-052 shape: the 049 columns in
--    their original order, with 052's promoted_variant_id/promoted_arm/promoted_at
--    appended after updated_at (the order the ALTERs produced).
-- ---------------------------------------------------------------------------
CREATE TABLE experiments_new (
  id                    TEXT PRIMARY KEY,                 -- 'exp_' + hex
  project_id            INTEGER,                          -- nullable: a global-workflow rotation has no project
  workflow_id           TEXT NOT NULL,
  kind                  TEXT NOT NULL DEFAULT 'side_by_side'
                          CHECK (kind IN ('side_by_side','rotation')),
  base_branch           TEXT,                    -- nullable: a rotation pins no base branch
  base_sha              TEXT,                    -- nullable: a rotation pins no SHA
  variant_a_id          TEXT,                    -- nullable: a rotation's arms live in experiment_rotation_arms
  variant_b_id          TEXT,                    -- nullable: see variant_a_id
  run_a_id              TEXT,                    -- workflow_runs.id, NULL until arm A launched
  run_b_id              TEXT,
  session_a_id          TEXT,
  session_b_id          TEXT,
  seed_idea_id          TEXT,                    -- ORIGINAL idea; NULL = unseeded experiment
  seed_idea_clone_a_id  TEXT,                    -- per-arm hidden clone; NULL when unseeded
  seed_idea_clone_b_id  TEXT,
  status                TEXT NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running','grading','decided','abandoned','superseded')),
  winner_run_id         TEXT,
  winner_arm            TEXT CHECK (winner_arm IN ('A','B')),
  merge_sha             TEXT,                    -- denormalized mirror of winner run's merge_sha
  decided_at            TEXT,
  -- Soft chain link (experiments.rerun): the source experiment this head-to-head
  -- was re-run from. NULL for an original experiment.
  rerun_of_experiment_id TEXT,
  created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Migration 052 — the VARIANT-OUTCOME promotion verdict (all NULL until promoted).
  promoted_variant_id   TEXT,
  promoted_arm          TEXT CHECK (promoted_arm IN ('A','B')),
  promoted_at           TEXT
);

INSERT INTO experiments_new (
  id, project_id, workflow_id, kind, base_branch, base_sha, variant_a_id,
  variant_b_id, run_a_id, run_b_id, session_a_id, session_b_id, seed_idea_id,
  seed_idea_clone_a_id, seed_idea_clone_b_id, status, winner_run_id, winner_arm,
  merge_sha, decided_at, rerun_of_experiment_id, created_at, updated_at,
  promoted_variant_id, promoted_arm, promoted_at
)
SELECT
  id, project_id, workflow_id, kind, base_branch, base_sha, variant_a_id,
  variant_b_id, run_a_id, run_b_id, session_a_id, session_b_id, seed_idea_id,
  seed_idea_clone_a_id, seed_idea_clone_b_id, status, winner_run_id, winner_arm,
  merge_sha, decided_at, rerun_of_experiment_id, created_at, updated_at,
  promoted_variant_id, promoted_arm, promoted_at
FROM experiments;

DROP TABLE experiments;
ALTER TABLE experiments_new RENAME TO experiments;

-- Recreate the two 049 indexes + ADD the running-rotation lookup index
-- (find the open rotation for a workflow by kind+status).
CREATE INDEX IF NOT EXISTS idx_experiments_project       ON experiments(project_id);
CREATE INDEX IF NOT EXISTS idx_experiments_status        ON experiments(status);
CREATE INDEX IF NOT EXISTS idx_experiments_workflow_kind ON experiments(workflow_id, kind, status);

-- ---------------------------------------------------------------------------
-- 2. Arm-set snapshot for a rotation experiment. One row per arm at the moment
--    the rotation opened; the label + weight are denormalized so the snapshot
--    survives a later variant delete / re-weight. The '__baseline__' sentinel
--    marks the live-baseline arm.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS experiment_rotation_arms (
  experiment_id  TEXT NOT NULL,   -- experiments.id (soft link, no FK)
  variant_id     TEXT NOT NULL,   -- '__baseline__' sentinel for the live-baseline arm
  label          TEXT NOT NULL,   -- denormalized display label at open (survives variant delete)
  weight_at_open INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (experiment_id, variant_id)
);

-- ---------------------------------------------------------------------------
-- 3. Resolver-assigned rotation attribution on the run. SEPARATE from
--    experiment_id (the side-by-side sandbox tag) per the CRITICAL INVARIANT
--    above — rotation runs are normal runs.
-- ---------------------------------------------------------------------------
ALTER TABLE workflow_runs ADD COLUMN rotation_experiment_id TEXT;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_rotation_experiment ON workflow_runs(rotation_experiment_id);

PRAGMA foreign_keys=ON;
