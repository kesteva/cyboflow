-- Migration 152: hosts — the Environments registry ("This Mac" plus user-added SSH machines).
--
-- hosts                  one row per execution host; the seeded 'local' row is This Mac
-- host_project_checkouts per (host, project) remote checkout path (M2 stamps it; M1 only creates the table)
-- projects.default_host_id, sessions.host_id, workflow_runs.host_id: NULL means This Mac (legacy rows).
-- workflow_runs.merge_back_state / merge_back_sha: reserved for M2 remote merge-back (code-validated).
--
-- HostStore (orchestrator/hosts/hostStore.ts) is the SOLE writer of hosts and host_project_checkouts and of
-- projects.default_host_id (enforced by hostsSoleWriter.test.ts). kind / tier / lifecycle enums are
-- code-validated: NO CHECK constraints (migration-123 lesson). Timestamps are ISO-8601 text written by the
-- app (Date#toISOString) — no datetime('now') column defaults. The strftime() in the seed INSERT is an
-- expression for the one seeded row, not a default.
--
-- Not mirrored into schema.sql: new tables reach both parity paths through the migration alone.
-- IF NOT EXISTS everywhere because the ledger tracks by filename — a renumbered file re-applies wholesale.
-- Numbered 152: 149 is muted-field's remote sync, 150 the cloud account, 151 persistent agents. Re-check at merge.

CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,                -- local | ssh   (herdr | sandbox | cloud_vm later)
  config_json TEXT NOT NULL,         -- ssh: {"sshTarget":"cybo-mbp","remoteRoot":"~/cf-remote/<id>"}
  secret_ciphertext BLOB,            -- reserved (provider keys, later kinds); SSH keys stay in ssh-agent
  arch TEXT,
  os_version TEXT,
  toolchain_hash TEXT,
  detected_tier TEXT,                -- cli | full | NULL (never probed)
  user_cap_tier TEXT,                -- cli | NULL (no cap); never above detected
  preflight_json TEXT,               -- last REACHABLE PreflightResult (JSON)
  preflight_at TEXT,
  preflight_app_version TEXT,
  lifecycle_state TEXT,              -- online | asleep | starting | stopped | unreachable
  last_seen_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hosts_label_live ON hosts(label) WHERE archived_at IS NULL;

INSERT OR IGNORE INTO hosts (id, label, kind, config_json, detected_tier, lifecycle_state, created_at, updated_at)
  VALUES ('local', 'This Mac', 'local', '{}', 'full', 'online',
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

ALTER TABLE projects      ADD COLUMN default_host_id TEXT REFERENCES hosts(id);
ALTER TABLE sessions      ADD COLUMN host_id TEXT REFERENCES hosts(id);   -- NULL = local (legacy)
ALTER TABLE workflow_runs ADD COLUMN host_id TEXT REFERENCES hosts(id);   -- NULL = local; immutable
ALTER TABLE workflow_runs ADD COLUMN merge_back_state TEXT;               -- M2 (code-validated)
ALTER TABLE workflow_runs ADD COLUMN merge_back_sha TEXT;                 -- M2

CREATE TABLE IF NOT EXISTS host_project_checkouts (
  host_id TEXT NOT NULL REFERENCES hosts(id),
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  remote_repo_path TEXT NOT NULL,
  initialized_at TEXT,
  PRIMARY KEY (host_id, project_id)
);
