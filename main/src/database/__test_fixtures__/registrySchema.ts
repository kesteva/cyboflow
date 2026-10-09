/**
 * Shared SQL fixture for cyboflow registry tests.
 *
 * Source of truth:
 *   - REGISTRY_SCHEMA (workflows, workflow_runs):
 *       main/src/database/schema.sql (post-TASK-598 reconciliation).
 *   - GATE_SCHEMA additions (approvals, raw_events):
 *       main/src/database/migrations/006_cyboflow_schema.sql and
 *       main/src/database/migrations/071_raw_events_dedup.sql.
 *   - workflows.tuning_level / workflow_runs.tuning_level:
 *       main/src/database/migrations/124_workflow_tuning_level.sql.
 *   - workflows.runtime_mix / workflow_runs.runtime_mix:
 *       main/src/database/migrations/128_workflow_runtime_mix.sql.
 *   - workflow_runs.host_id / merge_back_state / merge_back_sha:
 *       main/src/database/migrations/152_hosts.sql.
 * Any column added to those tables at the canonical site MUST be
 * mirrored here too — AND the migration that adds it listed in
 * __tests__/orchestratorTestDb.test.ts's `laterMigrations`, or the
 * column-parity guard drifts silently.
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
  -- migration 124: the tuning-level stamp every WorkflowRow SELECT projects.
  -- Inlined here rather than hidden behind a createTestDb flag because the
  -- registry's own reads (getById / listByProject / createRun) project it
  -- unconditionally — a flag would make every registry test opt in to a column
  -- the code under test always needs. Kept in parity by listing 124 in
  -- orchestratorTestDb.test.ts's laterMigrations list.
  tuning_level TEXT NOT NULL DEFAULT 'standard'
    CHECK (tuning_level IN ('efficient','standard','thorough','custom')),
  -- migration 128: the runtime-mix stamp, projected by the same WorkflowRow
  -- SELECTs and stamped onto every run — inlined for the same reason as
  -- tuning_level above. Kept in parity by listing 127 in
  -- orchestratorTestDb.test.ts's laterMigrations list.
  runtime_mix TEXT NOT NULL DEFAULT 'claude'
    CHECK (runtime_mix IN ('claude','claude-primary','codex-primary','codex')),
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
  -- migration 124: the run's frozen tuning level. NULL = pre-feature or a
  -- variant run (a variant is its own frozen spec, so no level is attributable).
  -- Nothing writes it until phase 3 stamps it at createRun; the column is here
  -- so the fixture's column set stays in parity with the real schema.
  tuning_level TEXT
    CHECK (tuning_level IS NULL OR tuning_level IN ('efficient','standard','thorough','custom')),
  -- migration 128: the run's frozen runtime mix. NULL = pre-feature, a variant
  -- run, a non-built-in flow, or an omp/pi lane — never read as 'claude'.
  runtime_mix TEXT
    CHECK (runtime_mix IS NULL OR runtime_mix IN ('claude','claude-primary','codex-primary','codex')),
  -- migration 152: the run's immutable execution-host stamp (NULL = This Mac) and
  -- the M2 remote merge-back columns. host_id's FK to hosts(id) is omitted here:
  -- this hermetic fixture has no hosts table.
  host_id TEXT,
  merge_back_state TEXT,
  merge_back_sha TEXT,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_created ON workflow_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
`;

/**
 * GATE_SCHEMA extends REGISTRY_SCHEMA with the approvals + raw_events tables
 * needed by the day-3 gate integration harness.
 * Source of truth for these tables: main/src/database/migrations/006_cyboflow_schema.sql
 * plus main/src/database/migrations/071_raw_events_dedup.sql and
 * main/src/database/migrations/111_approval_awaited.sql.
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
  -- Migration 111: is a requester actually blocked on this ask right now? Only
  -- the omp-sdk gate ever writes 0 (it hangs up at ~25s and the model may not
  -- retry); every other transport blocks for the whole window, hence DEFAULT 1.
  awaited INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, created_at);

CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  dedup_key TEXT,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_raw_events_run_id ON raw_events(run_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_events_dedup ON raw_events(dedup_key) WHERE dedup_key IS NOT NULL;
`;
