-- Migration 153: session_merge_backs — per-session merge-back ledger for remote (SSH) sessions (M2).
--
-- One row per remote session; state walks bare_ready -> base_pushed -> remote_ready -> [checkpointed]* ->
-- import_intent -> imported -> local_ready -> merged -> cleaned, plus abandoned. The state enum is
-- code-validated (orchestrator/hosts/mergeBackState.ts): NO CHECK constraints (migration-123 lesson).
-- Timestamps are ISO-8601 text written by the app (Date#toISOString) — no datetime('now') defaults.
--
-- MergeBackStore (orchestrator/hosts/mergeBackStore.ts) is the SOLE writer (mergeBackSoleWriter.test.ts).
-- Not mirrored into schema.sql: like 152, new tables reach both parity paths through the migration alone.
-- IF NOT EXISTS because the ledger tracks by filename — a renumbered file re-applies wholesale.

CREATE TABLE IF NOT EXISTS session_merge_backs (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  host_id TEXT NOT NULL REFERENCES hosts(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  merge_key TEXT NOT NULL,
  branch TEXT NOT NULL,
  remote_worktree_path TEXT,
  state TEXT NOT NULL,
  base_sha TEXT,
  import_sha TEXT,
  checkpoint_sha TEXT,
  local_worktree_path TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_merge_backs_host ON session_merge_backs(host_id);
CREATE INDEX IF NOT EXISTS idx_session_merge_backs_state ON session_merge_backs(state);
