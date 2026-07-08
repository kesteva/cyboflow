-- Migration 051: workflow_runs.agent_provider.
--
-- Workflow-run agent provider stamp. Existing rows default to Claude.

ALTER TABLE workflow_runs
  ADD COLUMN agent_provider TEXT NOT NULL DEFAULT 'claude'
    CHECK (agent_provider IN ('claude','codex'));

