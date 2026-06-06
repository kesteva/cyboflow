-- Migration 020: Add 'paused' to the workflow_runs.status CHECK enum (Phase 4b).
--
-- SDK-only Pause/Resume (Phase 4b) introduces a NON-terminal 'paused' status.
-- SQLite has no ALTER TABLE … DROP/ADD CONSTRAINT, so widening a CHECK requires
-- the canonical create-new-table + copy + DROP + RENAME recipe (same as
-- migration 010 which added the 9th status, 'awaiting_input').
--
-- The new table mirrors the authoritative post-019 workflow_runs shape — all 26
-- columns in their existing order — and only changes the status CHECK literal to
-- add 'paused' as the 10th allowed value. FK on approvals.run_id, raw_events.run_id,
-- and questions.run_id reference workflow_runs.id ON DELETE CASCADE, so
-- foreign_keys must be OFF for the duration to keep child rows intact.
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call, so an inner BEGIN would nest.

PRAGMA foreign_keys=OFF;

CREATE TABLE workflow_runs_new (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','starting','running','awaiting_review','stuck','completed','failed','canceled','awaiting_input','paused')),
  permission_mode_snapshot TEXT NOT NULL DEFAULT 'default',
  worktree_path TEXT,
  branch_name TEXT,
  policy_json TEXT,
  stuck_at DATETIME,
  stuck_reason TEXT,
  stuck_detected_at INTEGER,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  ended_at DATETIME,
  current_step_id TEXT,
  substrate TEXT NOT NULL DEFAULT 'sdk' CHECK (substrate IN ('sdk','interactive')),
  task_id TEXT,
  outcome TEXT,
  base_branch TEXT,
  base_sha TEXT,
  steps_snapshot_json TEXT,
  seed_idea_id TEXT,
  claude_session_id TEXT,
  session_id TEXT,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

INSERT INTO workflow_runs_new (
  id, workflow_id, project_id, status, permission_mode_snapshot,
  worktree_path, branch_name, policy_json, stuck_at, stuck_reason,
  stuck_detected_at, error_message, created_at, updated_at, started_at, ended_at,
  current_step_id, substrate, task_id, outcome, base_branch, base_sha,
  steps_snapshot_json, seed_idea_id, claude_session_id, session_id
)
SELECT
  id, workflow_id, project_id, status, permission_mode_snapshot,
  worktree_path, branch_name, policy_json, stuck_at, stuck_reason,
  stuck_detected_at, error_message, created_at, updated_at, started_at, ended_at,
  current_step_id, substrate, task_id, outcome, base_branch, base_sha,
  steps_snapshot_json, seed_idea_id, claude_session_id, session_id
FROM workflow_runs;

DROP TABLE workflow_runs;
ALTER TABLE workflow_runs_new RENAME TO workflow_runs;

-- Recreate every index that existed on workflow_runs through migration 019
-- (006 day-1 + 007 stuck index + 014 task index + 019 session index).
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_created ON workflow_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_stuck_at ON workflow_runs(status, stuck_detected_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_task_id ON workflow_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_session_id ON workflow_runs(session_id);

PRAGMA foreign_keys=ON;
