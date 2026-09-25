-- Sessions table to store persistent session data
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  initial_prompt TEXT NOT NULL,
  worktree_name TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_output TEXT,
  exit_code INTEGER,
  pid INTEGER,
  claude_session_id TEXT
);

-- Session outputs table to store terminal output history
CREATE TABLE IF NOT EXISTS session_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Conversation messages table to track conversation history
CREATE TABLE IF NOT EXISTS conversation_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('user', 'assistant')),
  content TEXT NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_session_outputs_session_id ON session_outputs(session_id);
CREATE INDEX IF NOT EXISTS idx_session_outputs_timestamp ON session_outputs(timestamp);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_session_id ON conversation_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_timestamp ON conversation_messages(timestamp);

-- Workflow registry: global built-ins (project_id NULL) + per-project customs.
-- project_id is NULLABLE: NULL ⇒ global (shown across all projects), an integer
-- ⇒ project-scoped (migration 030). FK to projects(id) ON DELETE CASCADE, with
-- NULL allowed by the FK.
-- NOTE: numbered migrations 079/124/128 add archived_at/tuning_level/runtime_mix
-- on top of a fresh seed too, so a schema.sql lacking them was functionally
-- fine (this file only seeds a DB before migrations run). Reconciled here to
-- keep the seed shape matching the current numbered-migration truth.
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  project_id INTEGER,
  name TEXT NOT NULL,
  spec_json TEXT NOT NULL DEFAULT '{}',
  workflow_path TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  tuning_level TEXT NOT NULL DEFAULT 'standard'
    CHECK (tuning_level IN ('efficient','standard','thorough','custom')),
  runtime_mix TEXT NOT NULL DEFAULT 'claude'
    CHECK (runtime_mix IN ('claude','claude-primary','codex-primary','codex')),
  archived_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workflows_project_id ON workflows(project_id);

-- Workflow runs: one row per execution attempt
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'starting', 'running', 'awaiting_review', 'stuck', 'completed', 'failed', 'canceled', 'awaiting_input', 'paused')),
  permission_mode_snapshot TEXT NOT NULL DEFAULT 'default',
  worktree_path TEXT,
  branch_name TEXT,
  policy_json TEXT,
  stuck_at DATETIME,
  stuck_reason TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  ended_at DATETIME,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_created ON workflow_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);

-- Custom Views (migration 133, docs/proposals/CUSTOM-VIEWS.md §3.2): saved
-- per-surface widget layouts, the user's custom-widget library, and the
-- widget-action audit/idempotency side table. See 133's own header for why
-- widget_action_log is a side table rather than a column on agent_proposals.
CREATE TABLE IF NOT EXISTS custom_views (
  id TEXT PRIMARY KEY,
  surface TEXT NOT NULL CHECK (surface IN ('review-queue','project-overview')),
  name TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_views_surface_name
  ON custom_views (surface, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS custom_widgets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  published_spec_json TEXT,            -- NULL until first publish
  draft_spec_json TEXT,                -- NULL when no draft is pending
  authoring_session_id TEXT,           -- owner of draft_spec_json
  revision INTEGER NOT NULL DEFAULT 1,
  thread_id TEXT,                      -- soft link, no FK (threads may be reset)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS widget_action_log (
  proposal_id TEXT PRIMARY KEY REFERENCES agent_proposals(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL UNIQUE,
  view_id TEXT NOT NULL,
  view_revision INTEGER NOT NULL,
  instance_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);