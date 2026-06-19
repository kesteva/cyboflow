/**
 * Shared SQL fixture for cyboflow registry tests.
 *
 * Source of truth:
 *   - REGISTRY_SCHEMA (workflows, workflow_runs):
 *       main/src/database/schema.sql (post-TASK-598 reconciliation).
 *   - GATE_SCHEMA additions (approvals, raw_events):
 *       main/src/database/migrations/006_cyboflow_schema.sql.
 * Any column added to those tables at the canonical site MUST be
 * mirrored here too.
 *
 * NOTE: workflows.project_id is NULLABLE (migration 030, NULL ⇒ global). The
 * canonical schema.sql also carries a `FOREIGN KEY (project_id) REFERENCES
 * projects(id) ON DELETE CASCADE`, but this hermetic fixture deliberately OMITS
 * that FK so registry tests need not seed a `projects` table — these test DBs
 * exercise the workflows/workflow_runs registry in isolation.
 *
 * The fixture intentionally inlines the DDL (rather than reading the canonical
 * files at test runtime) so the test surface is hermetic — reading the source
 * files at runtime would couple tests to their exact byte layout, which is
 * fragile.
 *
 * GATE_SCHEMA extends REGISTRY_SCHEMA with the approvals + raw_events tables
 * needed by the day-3 gate integration harness (tests/helpers/cyboflowTestHarness.ts).
 */

export const REGISTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  project_id INTEGER,
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
`;

/**
 * GATE_SCHEMA extends REGISTRY_SCHEMA with the approvals + raw_events tables
 * needed by the day-3 gate integration harness.
 * Source of truth for these tables: main/src/database/migrations/006_cyboflow_schema.sql.
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
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, created_at);

CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_raw_events_run_id ON raw_events(run_id, id);
`;
