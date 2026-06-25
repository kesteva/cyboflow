-- Migration 035: run artifacts + 'artifact' entity_events audit type.
-- (Renumbered from 029 on rebase onto main, which owns 029_agent_overrides
--  through 034_findings_triage. Runs last; depends only on entity_events (015)
--  and workflow_runs (011), neither of which the intervening migrations alter.)
--
-- The tabbed center pane surfaces run-scoped "artifacts" (idea spec, decomposed
-- stories, screenshots, ui prototype, generic live canvas) as their own tabs.
-- This adds the `artifacts` table (one row per (run, atype)) and widens the
-- polymorphic `entity_events` audit log so the ArtifactRouter chokepoint can log
-- artifact deltas under entity_type='artifact'.
--
-- WHY the entity_events CHECK is widened HERE (not by editing migration 015):
-- the file-keyed migration ledger applies each .sql once, so editing 015 in place
-- would NEVER re-run on an already-migrated DB (it would silently never apply).
-- SQLite also cannot ALTER a CHECK constraint, so we recreate the table with the
-- widened constraint and copy the rows — the same table-recreate recipe
-- 010_questions.sql uses. The leading `PRAGMA foreign_keys=OFF` is detected by the
-- migration runner, which toggles FK enforcement OFF *outside* the wrapping
-- transaction so DROP TABLE does not cascade.

PRAGMA foreign_keys=OFF;

-- (1) Widen entity_events.entity_type to include 'artifact' via recreate-rename.
CREATE TABLE entity_events_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('idea', 'epic', 'task', 'review_item', 'artifact')),
  entity_id    TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  actor        TEXT NOT NULL,
  run_id       TEXT,
  changes_json TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (entity_type, entity_id, seq),
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE SET NULL
);

INSERT INTO entity_events_new (id, entity_type, entity_id, seq, kind, actor, run_id, changes_json, created_at)
  SELECT id, entity_type, entity_id, seq, kind, actor, run_id, changes_json, created_at
  FROM entity_events;

DROP TABLE entity_events;
ALTER TABLE entity_events_new RENAME TO entity_events;

CREATE INDEX IF NOT EXISTS idx_entity_events_entity ON entity_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_events_run_id ON entity_events(run_id);

-- (2) The run-scoped artifacts table.
--   mode         — 'template' (re-derived from the entity DB on read: idea-spec,
--                  decomposed-stories) vs 'canvas' (embedded live canvas /
--                  screenshots / generic; payload-backed).
--   committed    — persisted into the repo (git) vs not yet.
--   session_only — dropped when the session closes unless committed (lifecycle
--                  pruning is wired in a later milestone).
--   is_new       — freshly minted; drives the tab's pulsing "new" dot until focus.
--   payload_json — per-atype payload (e.g. screenshot fileNames, ui-prototype url,
--                  cached templated render).
--   source_ref   — soft link to the entity a templated artifact derives from
--                  (ideaId / epicId / taskId); NULL for user/agent canvases.
-- One artifact per (run_id, atype) in v1 — matches the per-atype center-pane tab
-- id (art:<atype>); multiple arbitrary artifacts per run is a future widening.
CREATE TABLE IF NOT EXISTS artifacts (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  session_id   TEXT,
  atype        TEXT NOT NULL CHECK (atype IN ('idea-spec', 'decomposed-stories', 'screenshots', 'ui-prototype', 'generic')),
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

CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_run_committed ON artifacts(run_id, committed);

PRAGMA foreign_keys=ON;
