-- Migration 063 (renumbered from 062 at rebase): allow ONE idea-spec artifact PER idea within a run.
--
-- IDEA-009 "Planner should accept multiple ideas": a planner run now plans a
-- BATCH of up to 4 ideas (migration 060 added workflow_runs.seed_idea_ids). The
-- artifacts table's table-level UNIQUE (run_id, atype) — carried verbatim through
-- 035 -> 045 -> 061 — capped the run at ONE 'idea-spec' row, so only the first
-- idea ever got a deliverable tab. This migration relaxes that constraint for the
-- 'idea-spec' atype ONLY: idea-spec identity becomes (run_id, atype, source_ref)
-- so each seeded/owned idea gets its own idea-spec artifact (source_ref = ideaId).
-- Every OTHER atype keeps the strict one-per-(run,atype) rule.
--
-- WHY a table recreate: SQLite cannot ALTER a table-level UNIQUE constraint away,
-- and the file-keyed migration ledger applies each .sql once, so editing 061 in
-- place would silently never re-apply on an already-migrated DB. We therefore
-- recreate the artifacts table WITHOUT the table-level UNIQUE and add two partial
-- unique indexes that encode the split rule, then copy the rows — the same
-- recreate recipe 035/045/061 use. The leading `PRAGMA foreign_keys=OFF` is
-- detected by the migration runner, which toggles FK enforcement OFF *outside* the
-- wrapping transaction so DROP TABLE does not cascade.

PRAGMA foreign_keys=OFF;

CREATE TABLE artifacts_new (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  session_id   TEXT,
  atype        TEXT NOT NULL CHECK (atype IN ('idea-spec', 'decomposed-stories', 'screenshots', 'ui-prototype', 'generic', 'arch-design', 'approve-ideas')),
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

-- Split identity rule (replaces the old table-level UNIQUE (run_id, atype)):
--   * every atype EXCEPT idea-spec stays one-per-(run, atype);
--   * idea-spec is one-per-(run, atype, source_ref) so a multi-idea planner batch
--     holds one idea-spec per idea. COALESCE(source_ref, '') keeps a NULL
--     source_ref from escaping the unique check (two NULL-sourced idea-specs in
--     one run would otherwise both be allowed, since NULLs are distinct in a
--     plain UNIQUE index).
CREATE UNIQUE INDEX idx_artifacts_one_per_atype
  ON artifacts(run_id, atype) WHERE atype != 'idea-spec';
CREATE UNIQUE INDEX idx_artifacts_idea_spec_per_source
  ON artifacts(run_id, atype, COALESCE(source_ref, '')) WHERE atype = 'idea-spec';

PRAGMA foreign_keys=ON;
