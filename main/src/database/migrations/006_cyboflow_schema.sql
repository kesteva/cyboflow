-- Migration 006: Cyboflow orchestrator schema (5 net-new tables)
-- Strictly disjoint from Crystal's sessions/tool_panels — no cross-FK.
-- See docs/cyboflow_system_design.md §5.3 for the authoritative spec.

-- 1. workflows: user-authored workflow definitions
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  spec_json TEXT NOT NULL,           -- full workflow spec (prompt, policy, model, etc.)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. workflow_runs: one row per execution attempt; carries the 8-state machine
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  worktree_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'starting', 'running', 'awaiting_review', 'stuck', 'completed', 'failed', 'canceled')),
  policy_json TEXT NOT NULL,         -- snapshot of approval/tool policy at start
  stuck_at DATETIME,                 -- nullable; populated by stuck-detector (epic 10)
  stuck_reason TEXT,                 -- nullable; short tag, e.g. 'no_progress', 'awaiting_input'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  ended_at DATETIME,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

-- 3. raw_events: append-only event log per run (SDK messages, tool calls, status edges)
CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,          -- 'sdk_message' | 'tool_call' | 'status_change' | ...
  payload_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

-- 4. messages: derived conversation view (assistant/user/tool, ordered by created_at)
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,                -- 'user' | 'assistant' | 'tool' | 'system'
  content_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

-- 5. approvals: one row per tool-call decision point
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input_json TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'timed_out')),
  decided_at DATETIME,
  decided_by TEXT,                   -- 'user' | 'auto-policy' | 'timeout'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

-- Day-1 indexes (sized for the 115k-row/day projection in risks research §8)
CREATE INDEX IF NOT EXISTS idx_raw_events_run_id ON raw_events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_raw_events_type_run ON raw_events(event_type, run_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_created ON workflow_runs(status, created_at);
