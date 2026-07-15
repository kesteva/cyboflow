-- Migration 066: workflow_variants.agent_provider / agent_runtime.
--
-- Per-variant agent provider/runtime default — lets an A/B variant declare
-- "run this whole flow on Codex" the same way it already declares a per-variant
-- model / execution_model default. NULL = inherit the launch default (no pin),
-- mirroring workflow_variants.model / execution_model.
--
-- Codex PTY is intentionally excluded: workflow runs need structured events,
-- usage, MCP progress, and review-queue integration, so a Codex variant resolves
-- to codex-sdk (matches WORKFLOW_AGENT_RUNTIMES in shared/types/agentRuntime.ts).

ALTER TABLE workflow_variants
  ADD COLUMN agent_provider TEXT
    CHECK (agent_provider IS NULL OR agent_provider IN ('claude','codex'));

ALTER TABLE workflow_variants
  ADD COLUMN agent_runtime TEXT
    CHECK (agent_runtime IS NULL OR agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk'));
