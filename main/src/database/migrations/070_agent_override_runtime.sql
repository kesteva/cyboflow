-- Migration 070: agent_overrides.runtime + agent_overrides.codex_model.
--
-- Per-agent CLI runtime for a reusable global agent (the Agents-pane editor).
-- `runtime` pins one of the WORKFLOW_AGENT_RUNTIMES
-- ('claude-sdk' | 'claude-interactive' | 'codex-sdk'); NULL means "inherit the
-- run-level provider/runtime" (byte-identical to before this migration).
-- `codex_model` is the free-form Codex model id used only when
-- runtime = 'codex-sdk'; NULL means the Codex runtime default. Mirrors how
-- migration 036 added the `model` column. Validation lives in code (no CHECK).

ALTER TABLE agent_overrides ADD COLUMN runtime TEXT;
ALTER TABLE agent_overrides ADD COLUMN codex_model TEXT;
