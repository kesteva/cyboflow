-- Migration 010: AskUserQuestion round-trip schema (IDEA-025).
--
-- Two parts inside a single transaction:
--   (1) New `questions` table — stores AskUserQuestion gates analogous to `approvals`.
--   (2) workflow_runs CHECK-constraint update — adds a 9th status value via the
--       SQLite table-recreation recipe (no ALTER TABLE for CHECK constraints).
--
-- Risk 2 in .soloflow/active/research/IDEA-025-research.md documents the
-- table-recreation recipe; this migration is its concrete application.
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call, so an inner BEGIN would nest.

-- ---------------------------------------------------------------------------
-- Part 1: questions table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  questions_json TEXT NOT NULL,             -- serialized QuestionPayload[]
  answer_json TEXT,                          -- serialized QuestionAnswer, null while pending
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'timed_out')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  answered_at DATETIME,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_questions_status_created ON questions(status, created_at);

-- ---------------------------------------------------------------------------
-- Part 2: workflow_runs CHECK-constraint update — widen the status enum to 9 values.
--
-- SQLite has no ALTER TABLE … DROP/ADD CONSTRAINT. We use the canonical
-- create-new-table + copy + DROP + RENAME recipe. FK on approvals.run_id and
-- raw_events.run_id reference workflow_runs.id ON DELETE CASCADE, so
-- foreign_keys must be OFF for the duration to keep child rows intact.
-- ---------------------------------------------------------------------------

PRAGMA foreign_keys=OFF;

CREATE TABLE workflow_runs_new (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'starting', 'running', 'awaiting_review', 'stuck', 'completed', 'failed', 'canceled', 'awaiting_input')),
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
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

INSERT INTO workflow_runs_new (
  id, workflow_id, project_id, status, permission_mode_snapshot,
  worktree_path, branch_name, policy_json, stuck_at, stuck_reason,
  stuck_detected_at, error_message, created_at, updated_at, started_at, ended_at
)
SELECT
  id, workflow_id, project_id, status, permission_mode_snapshot,
  worktree_path, branch_name, policy_json, stuck_at, stuck_reason,
  stuck_detected_at, error_message, created_at, updated_at, started_at, ended_at
FROM workflow_runs;

DROP TABLE workflow_runs;
ALTER TABLE workflow_runs_new RENAME TO workflow_runs;

-- Re-create all three pre-existing indexes (006 day-1 indexes + 007's stuck index).
-- Tier 2 reconciler in database.ts historically missed idx_workflow_runs_status_stuck_at;
-- we restore all three here so post-010 state is fully indexed.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_created ON workflow_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_stuck_at ON workflow_runs(status, stuck_detected_at);

PRAGMA foreign_keys=ON;
