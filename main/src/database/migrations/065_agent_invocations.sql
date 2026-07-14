-- Migration 065: provider-neutral agent invocation persistence.
--
-- Each row represents one concrete agent turn. Invocation rows are append-only
-- except for the one-time external_session_id capture performed after a
-- provider reports its Claude session id or Codex thread id.

CREATE TABLE IF NOT EXISTS agent_invocations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_invocation_id   TEXT NOT NULL UNIQUE,
  run_id                TEXT NOT NULL,
  step_id               TEXT,
  agent_provider        TEXT NOT NULL
                          CHECK (agent_provider IN ('claude', 'codex')),
  agent_runtime         TEXT NOT NULL
                          CHECK (agent_runtime IN ('claude-sdk', 'claude-interactive', 'codex-sdk')),
  model                 TEXT,
  external_session_id   TEXT,
  created_at            TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

-- Supports newest-first lookup for both top-level (step_id IS NULL) and
-- step-scoped invocations without adding a second write-side index.
CREATE INDEX IF NOT EXISTS idx_agent_invocations_run_step_latest
  ON agent_invocations (run_id, step_id, id DESC);

-- Materialize the legacy run-level resume handle as a top-level invocation.
-- The deterministic id makes the backfill safe to replay after a partial or
-- ledger-less migration attempt.
INSERT OR IGNORE INTO agent_invocations (
  agent_invocation_id,
  run_id,
  step_id,
  agent_provider,
  agent_runtime,
  model,
  external_session_id,
  created_at
)
SELECT
  'legacy:' || id,
  id,
  NULL,
  agent_provider,
  agent_runtime,
  model,
  claude_session_id,
  COALESCE(created_at, CURRENT_TIMESTAMP)
FROM workflow_runs
WHERE claude_session_id IS NOT NULL
  AND trim(claude_session_id) <> '';
