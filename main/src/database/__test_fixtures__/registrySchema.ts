/**
 * Shared SQL fixture for cyboflow registry tests.
 *
 * Source of truth: main/src/database/schema.sql (post-TASK-598 reconciliation).
 * Any column added to workflows or workflow_runs in schema.sql MUST be added
 * here too. The fixture intentionally inlines the DDL (rather than reading
 * schema.sql at test runtime) so the test surface is hermetic — reading
 * schema.sql at runtime would couple tests to the file's exact byte layout,
 * which is fragile.
 *
 * GATE_SCHEMA extends REGISTRY_SCHEMA with the approvals + raw_events tables
 * needed by the day-3 gate integration harness (tests/helpers/cyboflowTestHarness.ts).
 */

export const REGISTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  spec_json TEXT NOT NULL DEFAULT '{}',
  workflow_path TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_workflows_project_id ON workflows(project_id);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'starting', 'running', 'awaiting_review', 'stuck', 'completed', 'failed', 'canceled')),
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
`;

/**
 * GATE_SCHEMA extends REGISTRY_SCHEMA with the approvals + raw_events tables
 * needed by the day-3 gate integration harness.
 */
export const GATE_SCHEMA = REGISTRY_SCHEMA + `
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input_json TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'timed_out')),
  decided_at DATETIME,
  decided_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, created_at);

CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_raw_events_run_id ON raw_events(run_id, id);
`;
