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

-- Workflow registry: seeded with five SoloFlow workflow definitions
CREATE TABLE IF NOT EXISTS workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  workflow_path TEXT NOT NULL,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_workflows_project_id ON workflows(project_id);

-- Workflow runs: one row per execution attempt
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'starting', 'running', 'awaiting_review', 'stuck', 'completed', 'failed', 'canceled')),
  permission_mode_snapshot TEXT NOT NULL,
  worktree_path TEXT,
  branch_name TEXT,
  policy_json TEXT,
  stuck_at DATETIME,
  stuck_reason TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_created ON workflow_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);