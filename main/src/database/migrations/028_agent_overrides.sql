-- Migration 028: agent_overrides — per-project builtin shadows + custom agents.
--
-- Stores user edits to the 13 builtin cyboflow agents AND fully-custom agents,
-- scoped per project. One row per (project_id, agent_key).
--
-- IDENTITY = CANONICAL BASENAME: `agent_key` is the canonical kebab key, which
-- is ALWAYS exactly the bundled agent file's basename (e.g. 'implement'). The
-- frontmatter `name` column is ALWAYS exactly 'cyboflow-'+agent_key — the
-- orchestrator prose dispatches subagents by this name and the SDK auto-discovers
-- by it, so `name` is NEVER user-editable and renderAgentMarkdown emits it
-- regardless of any stored value. A builtin override may change ONLY description,
-- system_prompt (body), and tools — NOT the key, NOT the frontmatter name, NOT
-- the role. base_agent_key NULL marks a custom agent; otherwise it equals
-- agent_key and names the builtin this row shadows.
--
-- MODEL-AGNOSTIC: there is deliberately NO model column — agents inherit the
-- run's model, never pin one of their own.
--
-- 'human' IS A GATE, NOT AN AGENT: it is never a valid agent_key and never gets
-- a row here.
--
-- VALIDATION-IN-CODE, NOT CHECK: the CliTool[] in tools_json, the agent_key
-- canonicality, the name == 'cyboflow-'+agent_key invariant, and the
-- base_agent_key == agent_key (when non-null) rule are all enforced in code
-- (mirrors migrations 016/026, which keep enum/shape validation out of CHECK
-- constraints).
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call, so an inner BEGIN would nest.
--
-- Idempotency: CREATE uses IF NOT EXISTS and the index uses IF NOT EXISTS, so
-- re-applying the file (after a ledger reset) is a no-op.
--
-- Field-for-field source of truth for the row shape is
-- main/src/database/models.ts (AgentOverrideRow); entitySchemaParity.test.ts
-- pins them.

-- ---------------------------------------------------------------------------
-- agent_overrides — per-project agent edits + custom agents.
--
--   id             TEXT PK ('ago_'+10-byte hex).
--   project_id     FK->projects ON DELETE CASCADE (the override dies with the project).
--   agent_key      canonical kebab key == bundled file basename.
--   base_agent_key NULL = custom agent; else == agent_key (the builtin it shadows).
--   name           frontmatter name == 'cyboflow-'+agent_key (NEVER user-editable).
--   role           free-form role label (nullable).
--   description     short description (editable on a builtin override).
--   system_prompt   agent body / system prompt (editable on a builtin override).
--   tools_json      JSON CliTool[] (editable on a builtin override; code-validated).
--   is_custom       0|1 — convenience flag mirroring (base_agent_key IS NULL).
--   version         optimistic-concurrency counter, DEFAULT 1.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_overrides (
  id             TEXT PRIMARY KEY,                  -- 'ago_'+10-byte hex
  project_id     INTEGER NOT NULL,
  agent_key      TEXT NOT NULL,                     -- canonical kebab key == bundled file basename
  base_agent_key TEXT,                              -- NULL = custom; else == agent_key (builtin shadowed)
  name           TEXT NOT NULL,                     -- frontmatter name == 'cyboflow-'+agent_key
  role           TEXT,                              -- free-form role label (nullable)
  description    TEXT NOT NULL,
  system_prompt  TEXT NOT NULL,                     -- agent body / system prompt
  tools_json     TEXT NOT NULL,                     -- JSON CliTool[] (code-validated)
  is_custom      INTEGER NOT NULL DEFAULT 0,        -- 0|1, mirrors (base_agent_key IS NULL)
  version        INTEGER NOT NULL DEFAULT 1,        -- optimistic-concurrency counter
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (project_id, agent_key),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Per-project agent listing (the dominant read: load all overrides for a project).
CREATE INDEX IF NOT EXISTS idx_agent_overrides_project ON agent_overrides(project_id);
