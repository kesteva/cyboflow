-- Migration 070: two artifacts-table changes for the multi-idea planner design flow.
--
--   (A) Widen the artifacts.atype CHECK to add 'approve-designs' — the joint
--       human-approval surface for a multi-idea batch's architecture designs,
--       exactly mirroring 'approve-ideas' (migration 062). The recreated CHECK
--       carries every prior atype forward (idea-spec … approve-ideas) so no
--       existing row is stranded outside the constraint.
--
--   (B) Make 'arch-design' PER-ENTITY, mirroring what 063 did for 'idea-spec':
--       a multi-idea planner run now mints ONE arch-design artifact per owned
--       idea (source_ref = ideaId), so architecture designs follow the same
--       "separate artifact per idea + one joint approval" shape as ideas. This
--       generalizes 063's idea-spec-only split index to the set
--       {idea-spec, arch-design}: those two are one-per-(run, atype, source_ref);
--       every OTHER atype stays strictly one-per-(run, atype).
--
-- Runs AFTER 063_per_idea_spec_artifacts (the last artifacts-table recreate), so
-- this recreate reproduces 063's final shape — NO table-level UNIQUE (run_id,
-- atype); the split rule lives in the two partial unique indexes below — and only
-- (a) widens the CHECK and (b) extends the per-source exemption to arch-design.
--
-- WHY a table recreate: SQLite cannot ALTER a CHECK constraint, and the
-- file-keyed migration ledger applies each .sql once, so editing an earlier
-- migration in place would silently never re-apply on an already-migrated DB. We
-- recreate the artifacts table with the widened CHECK and copy the rows — the
-- same recipe 035/045/060/062/063 use. The leading `PRAGMA foreign_keys=OFF` is
-- detected by the migration runner, which toggles FK enforcement OFF *outside*
-- the wrapping transaction so DROP TABLE does not cascade.

PRAGMA foreign_keys=OFF;

CREATE TABLE artifacts_new (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  session_id   TEXT,
  atype        TEXT NOT NULL CHECK (atype IN ('idea-spec', 'decomposed-stories', 'screenshots', 'ui-prototype', 'generic', 'arch-design', 'compound-recommendations', 'approve-ideas', 'approve-designs')),
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

-- Split identity rule (generalizes 063 from {idea-spec} to {idea-spec, arch-design}):
--   * every atype EXCEPT the per-entity set stays one-per-(run, atype);
--   * idea-spec AND arch-design are one-per-(run, atype, source_ref) so a
--     multi-idea planner batch holds one of each per idea. COALESCE(source_ref,
--     '') keeps a NULL source_ref from escaping the unique check (two
--     NULL-sourced rows in one run would otherwise both be allowed, since NULLs
--     are distinct in a plain UNIQUE index).
CREATE UNIQUE INDEX idx_artifacts_one_per_atype
  ON artifacts(run_id, atype) WHERE atype NOT IN ('idea-spec', 'arch-design');
CREATE UNIQUE INDEX idx_artifacts_per_source
  ON artifacts(run_id, atype, COALESCE(source_ref, '')) WHERE atype IN ('idea-spec', 'arch-design');

PRAGMA foreign_keys=ON;
