-- Migration 061: workflow_runs.agent_runtime.
--
-- Workflow-run agent runtime stamp. Codex PTY is intentionally excluded:
-- workflows need structured events, usage, MCP progress, and review-queue
-- integration, so Codex workflow runs use codex-sdk.

ALTER TABLE workflow_runs
  ADD COLUMN agent_runtime TEXT NOT NULL DEFAULT 'claude-sdk'
    CHECK (agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk'));
