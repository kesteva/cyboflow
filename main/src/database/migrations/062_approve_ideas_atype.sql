-- Migration 062: widen artifacts.atype CHECK to include 'approve-ideas'.
--
-- Renumbered from 061 at rebase time. Runs AFTER 060_compound_recommendations_atype,
-- so the recreated CHECK below carries 060's 'compound-recommendations' forward —
-- dropping it here would strand existing compound artifacts outside the constraint.
--
-- IDEA-009 "Planner should accept multiple ideas": the multi-idea approve-plan
-- gate renders its own run-scoped center-pane tab ('approve-ideas') so the
-- reviewer can see which of the seeded ideas were selected/decomposed, mirroring
-- the 'arch-design' templated-artifact contract added by 045.
--
-- WHY a table recreate: SQLite cannot ALTER a CHECK constraint, and the
-- file-keyed migration ledger applies each .sql once, so editing
-- 045_arch_design_atype.sql in place would silently never re-apply on an
-- already-migrated DB. We therefore recreate the artifacts table with the
-- widened atype CHECK and copy the rows — the same recipe 035/045 use. The
-- leading `PRAGMA foreign_keys=OFF` is detected by the migration runner, which
-- toggles FK enforcement OFF *outside* the wrapping transaction so DROP TABLE
-- does not cascade.

PRAGMA foreign_keys=OFF;

CREATE TABLE artifacts_new (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  session_id   TEXT,
  atype        TEXT NOT NULL CHECK (atype IN ('idea-spec', 'decomposed-stories', 'screenshots', 'ui-prototype', 'generic', 'arch-design', 'compound-recommendations', 'approve-ideas')),
  label        TEXT NOT NULL,
  step_origin  TEXT,
  mode         TEXT NOT NULL DEFAULT 'canvas' CHECK (mode IN ('template', 'canvas')),
  committed    INTEGER NOT NULL DEFAULT 0,
  session_only INTEGER NOT NULL DEFAULT 1,
  is_new       INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT,
  source_ref   TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  committed_at DATETIME,
  UNIQUE (run_id, atype),
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

INSERT INTO artifacts_new (id, run_id, session_id, atype, label, step_origin, mode, committed,
                           session_only, is_new, payload_json, source_ref, created_at, committed_at)
  SELECT id, run_id, session_id, atype, label, step_origin, mode, committed,
         session_only, is_new, payload_json, source_ref, created_at, committed_at
  FROM artifacts;

DROP TABLE artifacts;
ALTER TABLE artifacts_new RENAME TO artifacts;

CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_run_committed ON artifacts(run_id, committed);

PRAGMA foreign_keys=ON;
