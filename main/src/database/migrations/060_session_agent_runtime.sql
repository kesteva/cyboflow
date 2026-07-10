-- Migration 060: sessions.agent_runtime.
--
-- Session default agent runtime. This is broader than workflow runtime because
-- quick sessions can use codex-pty. codex-exec remains internal-only.

ALTER TABLE sessions
  ADD COLUMN agent_runtime TEXT NOT NULL DEFAULT 'claude-sdk'
    CHECK (agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk','codex-pty'));
