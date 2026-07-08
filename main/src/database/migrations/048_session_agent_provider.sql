-- Migration 048: sessions.agent_provider.
--
-- Session default agent provider. Existing rows default to Claude.

ALTER TABLE sessions
  ADD COLUMN agent_provider TEXT NOT NULL DEFAULT 'claude'
    CHECK (agent_provider IN ('claude','codex'));

