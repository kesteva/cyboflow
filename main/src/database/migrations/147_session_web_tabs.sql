-- Migration 147: web-viewer tab rows + the web audit trail.
--
-- session_web_tabs — one row per web-viewer tab, so a session's tabs survive a
-- restart. `id` is the tab's OPAQUE id (`web:<uuid>`), not a URL: it is the
-- correlation key across the renderer strip, the main-process view map, consent
-- grants and the telemetry cursor, and a restore REUSES it. Restored tabs come
-- back unloaded; `human_touched` is restored with the row, so a tab a human typed
-- into before the restart stays consent-gated after it.
--
-- session_web_events — the AUDIT trail, in its own table on purpose: a human tab
-- open belongs to no run, and `raw_events` is run-scoped and cascade-deleted
-- with the run (006), so an audit kept there would vanish exactly when someone
-- wants to consult it. `tab_id` / `run_id` are nullable for that reason, `origin`
-- is the redacted origin only, and `detail` never carries a full URL.
--
-- Session dismissal ARCHIVES (no row delete), so the CASCADEs below fire only on
-- a real session delete. The manager's session teardown deletes the TAB rows
-- explicitly; the audit rows are kept until the session itself is deleted.
--
-- Not mirrored into schema.sql: new tables reach both parity paths through the
-- migration alone (the dual-source rule is about column changes to tables
-- schema.sql already declares). IF NOT EXISTS because the ledger tracks by
-- filename — a renumbered file re-applies wholesale.
--
-- Numbered 147: 146 went to usage accounting on main first.
-- See docs/proposals/native-web-viewer.md §5.

CREATE TABLE IF NOT EXISTS session_web_tabs (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  initial_url      TEXT NOT NULL,
  current_url      TEXT,
  title            TEXT,
  position         INTEGER NOT NULL,
  opened_by        TEXT NOT NULL CHECK (opened_by IN ('user','agent')),
  opened_by_run_id TEXT,
  human_touched    INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT,
  last_active_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_session_web_tabs_session
  ON session_web_tabs(session_id, position);

CREATE TABLE IF NOT EXISTS session_web_events (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tab_id      TEXT,
  run_id      TEXT,
  kind        TEXT NOT NULL,
  origin      TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_web_events_session
  ON session_web_events(session_id, created_at);
