-- 149_remote_sync.sql — client state for cross-machine backlog sync (protocol 1).
--
-- Additive only, and deliberately free of CHECK constraints (the lesson of
-- migration 130: a CHECK that a later value outgrows needs a table rebuild).
-- Nothing reads these tables unless the dev-build gate and the remoteSync flag
-- are both on (ConfigManager.isRemoteSyncEnabled).
--
-- The AFTER DELETE tombstone triggers on ideas/epics/tasks are NOT created
-- here: DatabaseService.ensureRemoteSyncTriggers() creates them after every
-- migration run, because any later table-rebuild migration of those tables
-- (CREATE new / DROP / RENAME) silently drops their triggers.
--
-- Every statement is IF NOT EXISTS: the ledger tracks by filename, so a
-- renumbered copy re-applies wholesale.

-- This machine's sign-in. One row (singleton = 1) at most.
CREATE TABLE IF NOT EXISTS remote_sync_account (
  singleton         INTEGER PRIMARY KEY,
  origin            TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  workspace_id      TEXT,             -- not returned by registration; sync creates it lazily
  device_id         TEXT NOT NULL,
  device_name       TEXT NOT NULL,
  device_code       TEXT NOT NULL,
  token_ciphertext  TEXT NOT NULL,
  last_hlc          TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- One row per local project that is opted in. Removing the local project
-- cascades away every remote_sync_* row for it ("stop syncing on this machine").
CREATE TABLE IF NOT EXISTS remote_sync_projects (
  project_id         INTEGER PRIMARY KEY,
  remote_project_id  TEXT UNIQUE,
  fingerprint        TEXT,
  status             TEXT NOT NULL DEFAULT 'pending',
  status_detail      TEXT,
  cursor             INTEGER NOT NULL DEFAULT 0,
  reset_next_pull    INTEGER NOT NULL DEFAULT 0,   -- 1 after the user resumes from a rewind
  epoch              INTEGER,
  last_sync_at       TEXT,
  log_json           TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Per-entity sync state: base B, dirty D and inbox I, each a JSON object
-- keyed by field name (desktop doc, "Client state and apply rules").
CREATE TABLE IF NOT EXISTS remote_sync_entities (
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  project_id    INTEGER NOT NULL,
  ref           TEXT,
  version       INTEGER NOT NULL DEFAULT 0,
  base_json     TEXT NOT NULL DEFAULT '{}',
  dirty_json    TEXT NOT NULL DEFAULT '{}',
  inbox_json    TEXT NOT NULL DEFAULT '{}',
  deleted       INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id),
  FOREIGN KEY (project_id) REFERENCES remote_sync_projects(project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_remote_sync_entities_project ON remote_sync_entities(project_id);

-- Local deletes awaiting push, written by the AFTER DELETE triggers.
CREATE TABLE IF NOT EXISTS remote_sync_tombstones (
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  project_id   INTEGER NOT NULL,
  ref          TEXT,
  deleted_at   TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id),
  FOREIGN KEY (project_id) REFERENCES remote_sync_projects(project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_remote_sync_tombstones_project ON remote_sync_tombstones(project_id);

-- The one frozen push batch in flight per project; re-sent identically after a crash.
CREATE TABLE IF NOT EXISTS remote_sync_batches (
  project_id    INTEGER PRIMARY KEY,
  batch_id      TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES remote_sync_projects(project_id) ON DELETE CASCADE
);

-- Conflict records (server-filed via the feed or push results, or client-filed).
CREATE TABLE IF NOT EXISTS remote_sync_conflicts (
  id                  TEXT PRIMARY KEY,
  project_id          INTEGER NOT NULL,
  entity_id           TEXT NOT NULL,
  kind                TEXT NOT NULL,
  record_json         TEXT NOT NULL,
  seq                 INTEGER,
  resolved_at         INTEGER,
  pending_upload      INTEGER NOT NULL DEFAULT 0,
  pending_resolution  TEXT,
  FOREIGN KEY (project_id) REFERENCES remote_sync_projects(project_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_remote_sync_conflicts_project ON remote_sync_conflicts(project_id, resolved_at);
CREATE INDEX IF NOT EXISTS idx_remote_sync_conflicts_entity ON remote_sync_conflicts(entity_id);

-- Old refs renamed by an M1b join, for fail-closed ambiguous_ref resolution.
CREATE TABLE IF NOT EXISTS entity_ref_aliases (
  project_id  INTEGER NOT NULL,
  ref         TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  renamed_to  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, ref),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
