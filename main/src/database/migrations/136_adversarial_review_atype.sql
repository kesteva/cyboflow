-- Migration 135: widen the artifacts.atype CHECK to include 'adversarial-review'.
--
-- The Launch/Planner/Ship `adversarial-review` step's critique becomes a real
-- run deliverable — its own markdown tab — instead of prose that evaporates when
-- the step's turn ends. The `approve-design` gate reads it (counts + blocking
-- titles in the gate body), a Revise threads it back into the design steps as
-- feedback, and an Approve files every remaining entry as a non-blocking
-- accepted-risk finding linked back to this tab. None of that has anywhere to
-- live without the atype.
--
-- WHY a table recreate: SQLite cannot ALTER a CHECK constraint, and the
-- file-keyed migration ledger applies each .sql exactly once, so editing 102 in
-- place would silently never re-apply on an already-migrated DB (the 062 lesson).
-- Same recipe as 060/062/073/089/091/097/099/102. The leading `PRAGMA
-- foreign_keys=OFF` is detected by the migration runner, which toggles FK
-- enforcement OFF *outside* the wrapping transaction so `DROP TABLE artifacts`
-- does not cascade (artifacts.run_id REFERENCES workflow_runs(id) ON DELETE
-- CASCADE).
--
-- Runs AFTER 102 (the previous artifacts recreate, which added 'idea-summary'),
-- so this reproduces 102's FULL schema — its column set (INCLUDING `revision`;
-- see 088's header for the replay hazard a recreate that forgets it re-opens,
-- breaking Design Mode's CAS binding), its whole atype list, and BOTH
-- split-identity unique indexes — changing ONLY the CHECK. Each recreate carries
-- only the atypes it NAMES, so dropping any of 102's from the list below would
-- strand every row of that kind.
--
-- 'adversarial-review' is NOT per-entity: it is ONE critique per RUN covering the
-- whole design surface (spec + prototype + architecture together), so it keeps
-- the strict one-per-(run, atype) rule and stays OUT of idx_artifacts_per_source.
-- Re-reporting it ENRICHES the single row (revision bump), which is what a
-- post-Revise re-review must do.

PRAGMA foreign_keys=OFF;

CREATE TABLE artifacts_new (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  session_id   TEXT,
  atype        TEXT NOT NULL CHECK (atype IN ('idea-spec', 'decomposed-stories', 'screenshots', 'ui-prototype', 'generic', 'interactive-prototype', 'arch-design', 'compound-recommendations', 'project-brief', 'approve-ideas', 'approve-designs', 'eval-report', 'verify-runbook', 'idea-summary', 'adversarial-review')),
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
  revision     INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

INSERT INTO artifacts_new (id, run_id, session_id, atype, label, step_origin, mode, committed,
                           session_only, is_new, payload_json, source_ref, created_at, committed_at, revision)
  SELECT id, run_id, session_id, atype, label, step_origin, mode, committed,
         session_only, is_new, payload_json, source_ref, created_at, committed_at, revision
  FROM artifacts;

DROP TABLE artifacts;
ALTER TABLE artifacts_new RENAME TO artifacts;

CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_run_committed ON artifacts(run_id, committed);

-- Split identity rule — 102's shape verbatim (the per-entity set is unchanged;
-- 'adversarial-review' joins the one-per-(run, atype) majority):
--   * every atype EXCEPT the per-entity set stays one-per-(run, atype);
--   * idea-spec, arch-design, AND idea-summary are one-per-(run, atype,
--     source_ref). COALESCE keeps a NULL source_ref from escaping the unique
--     check.
CREATE UNIQUE INDEX idx_artifacts_one_per_atype
  ON artifacts(run_id, atype) WHERE atype NOT IN ('idea-spec', 'arch-design', 'idea-summary');
CREATE UNIQUE INDEX idx_artifacts_per_source
  ON artifacts(run_id, atype, COALESCE(source_ref, '')) WHERE atype IN ('idea-spec', 'arch-design', 'idea-summary');

PRAGMA foreign_keys=ON;
