-- Migration 060: widen artifacts.atype CHECK to include 'compound-recommendations'.
--
-- The 'compound-recommendations' templated artifact is the Compound flow's
-- summary-of-recommendations doc, surfaced for the approve-learnings gate. Unlike
-- the entity-backed templated atypes (idea-spec / arch-design re-derive from an
-- idea body), it has NO entity source: the compound orchestrator composes the
-- markdown from the drafted learnings and reports it in payload_json.markdown, so
-- source_ref stays NULL and the renderer reads the payload verbatim (like the
-- canvas atypes, but rendered through the markdown template).
--
-- WHY a table recreate: SQLite cannot ALTER a CHECK constraint, and the
-- file-keyed migration ledger applies each .sql once, so editing 035/045 in place
-- would silently never re-apply on an already-migrated DB. We therefore recreate
-- the artifacts table with the widened atype CHECK and copy the rows — the same
-- recipe 045 uses. The leading `PRAGMA foreign_keys=OFF` is detected by the
-- migration runner, which toggles FK enforcement OFF *outside* the wrapping
-- transaction so DROP TABLE does not cascade.

PRAGMA foreign_keys=OFF;

CREATE TABLE artifacts_new (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  session_id   TEXT,
  atype        TEXT NOT NULL CHECK (atype IN ('idea-spec', 'decomposed-stories', 'screenshots', 'ui-prototype', 'generic', 'arch-design', 'compound-recommendations')),
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
