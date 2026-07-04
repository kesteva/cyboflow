-- Migration 048: workflow A/B testing — pairwise experiment comparison (slice C).
-- One pairwise-verdict row per side-by-side experiment (v1: exactly 2 arms => 1
-- comparison). The row is SELF-CONTAINED: both arms' frozen diffs + seed context
-- live on it so the pairwise judge survives worktree teardown and does not depend
-- on per-arm run_evals rows (which may be absent when eval is globally off). This
-- mirrors run_evals.diff_text's "freeze the diff at trigger" rationale.
--
-- run_id_a = the run tagged experiment_arm='A'; run_id_b = the run tagged 'B'
-- (arm identity comes from mig 046's workflow_runs.experiment_arm, NOT from
-- lexicographic ordering). Dedup + crash-safety via INSERT OR IGNORE on
-- UNIQUE(experiment_id). All FKs ON DELETE CASCADE (run/experiment deletion drops
-- the comparison; retention caveat documented in the plan Risks).
--
-- This migration does NOT touch workflow_runs (mig 046 owns experiment_id/
-- experiment_arm/variant_id/variant_label). Runs inside runFileBasedMigrations'
-- transaction wrapper (no explicit BEGIN/COMMIT). PRAGMA foreign_keys is OFF
-- during migration (database.ts), so the FKs below are recorded, not enforced now.
--
-- decision_review_item_id is written by THIS slice (the pairwise worker mints a
-- blocking kind='decision' review item) and read/resolved by slice B's
-- experiments.decide — the interface seam between slices for closing out the
-- human decision.
--
-- ⚠️ MIGRATION-NUMBER COLLISION: numbers 043/044/045 were previously claimed by
-- sibling branches. The ledger is filename-keyed; whichever lands second must
-- renumber. The integrator MUST verify no other 048_*.sql exists at merge time.

CREATE TABLE IF NOT EXISTS experiment_comparisons (
  id                      TEXT PRIMARY KEY,
  experiment_id           TEXT NOT NULL,
  run_id_a                TEXT NOT NULL,          -- run tagged experiment_arm='A'
  run_id_b                TEXT NOT NULL,          -- run tagged experiment_arm='B'

  eval_status             TEXT NOT NULL DEFAULT 'pending'
                            CHECK (eval_status IN ('pending','running','complete','failed','skipped')),

  -- Frozen inputs (captured at trigger; worktree-independent thereafter).
  base_sha                TEXT,
  diff_a_text             TEXT,
  diff_b_text             TEXT,
  diff_a_stats_json       TEXT,
  diff_b_stats_json       TEXT,
  seed_context            TEXT,                   -- idea body for idea-seeded experiments; NULL for unseeded

  -- K-sample verdict.
  sample_count            INTEGER,                -- valid samples that survived (<= K)
  per_sample_json         TEXT,                   -- [{sampleIndex, positionAFirst, rawPreference, preference, confidence, rationale}]
  preference              TEXT CHECK (preference IN ('A','B','tie')),  -- NULL until complete
  confidence              REAL,                   -- 0..1, mean confidence of winning-side samples
  rationale               TEXT,                   -- representative (highest-confidence winning-side) rationale
  a_count                 INTEGER NOT NULL DEFAULT 0,
  b_count                 INTEGER NOT NULL DEFAULT 0,
  tie_count               INTEGER NOT NULL DEFAULT 0,

  -- Provenance.
  judge_model             TEXT,
  judge_build_id          TEXT,
  prompt_hash             TEXT,
  error                   TEXT,

  -- Human-decision linkage: blocking kind='decision' review item minted by the
  -- pairwise worker; RESOLVED by slice B's experiments.decide.
  decision_review_item_id TEXT,

  snapshot_at             TEXT,
  completed_at            TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  UNIQUE (experiment_id),                          -- v1: one comparison per experiment (INSERT OR IGNORE dedup)

  FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id_a)      REFERENCES workflow_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id_b)      REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_experiment_comparisons_experiment ON experiment_comparisons(experiment_id);
CREATE INDEX IF NOT EXISTS idx_experiment_comparisons_status     ON experiment_comparisons(eval_status);
