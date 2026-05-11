---
id: TASK-152
idea: IDEA-004
idea_id: IDEA-004
status: ready
created: 2026-05-11T00:00:00Z
files_owned:
  - main/src/database/migrations/006_cyboflow_schema.sql
  - shared/types/cyboflow.ts
files_readonly:
  - main/src/database/migrations/003_add_tool_panels.sql
  - main/src/database/migrations/004_claude_panels.sql
  - main/src/database/migrations/005_unified_panel_settings.sql
  - main/src/database/database.ts
  - main/src/database/schema.sql
  - shared/types/models.ts
  - docs/cyboflow_system_design.md
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
acceptance_criteria:
  - criterion: "File `main/src/database/migrations/006_cyboflow_schema.sql` exists and creates exactly these 5 tables, in this order: workflows, workflow_runs, raw_events, messages, approvals. Every CREATE TABLE uses `IF NOT EXISTS`."
    verification: "grep -nE 'CREATE TABLE IF NOT EXISTS (workflows|workflow_runs|raw_events|messages|approvals)' main/src/database/migrations/006_cyboflow_schema.sql returns exactly 5 lines in the order listed."
  - criterion: "workflow_runs has a `status` column with a CHECK constraint accepting exactly these 8 values: queued, starting, running, awaiting_review, stuck, completed, failed, canceled."
    verification: "grep -nE \"status TEXT NOT NULL.*CHECK.*\\('queued',\\s*'starting',\\s*'running',\\s*'awaiting_review',\\s*'stuck',\\s*'completed',\\s*'failed',\\s*'canceled'\\)\" main/src/database/migrations/006_cyboflow_schema.sql returns one match."
  - criterion: "workflow_runs has the columns required for the state machine and stuck-state detection: id (TEXT PK), workflow_id (TEXT), project_id (INTEGER), worktree_path (TEXT), status, policy_json (TEXT), stuck_at (DATETIME), stuck_reason (TEXT), created_at, updated_at, started_at, ended_at."
    verification: "For each column listed, grep -nE '^\\s*<col>\\s+' inside the workflow_runs CREATE TABLE block returns a match."
  - criterion: "No foreign key clause references Crystal's `sessions` or `tool_panels` tables anywhere in the file. `FOREIGN KEY` is only used internally between the 5 new tables (e.g., raw_events.run_id → workflow_runs.id, approvals.run_id → workflow_runs.id, messages.run_id → workflow_runs.id)."
    verification: "grep -nE 'REFERENCES (sessions|tool_panels)' main/src/database/migrations/006_cyboflow_schema.sql returns 0 lines. grep -nE 'REFERENCES workflow_runs' returns at least 3 lines (one per dependent table)."
  - criterion: "Day-1 indexes are created: raw_events(run_id, id), raw_events(event_type, run_id), approvals(status, created_at), workflow_runs(status, created_at). All use `CREATE INDEX IF NOT EXISTS`."
    verification: "grep -cE 'CREATE INDEX IF NOT EXISTS .*ON (raw_events|approvals|workflow_runs)' main/src/database/migrations/006_cyboflow_schema.sql returns 4 or more."
  - criterion: "approvals table has columns: id (TEXT PK), run_id, tool_name (TEXT), tool_input_json (TEXT), tool_use_id (TEXT), rationale (TEXT), status (TEXT CHECK in pending/approved/rejected/timed_out), decided_at (DATETIME), decided_by (TEXT), created_at."
    verification: "grep -nE \"status TEXT NOT NULL DEFAULT 'pending' CHECK.*\\('pending',\\s*'approved',\\s*'rejected',\\s*'timed_out'\\)\" main/src/database/migrations/006_cyboflow_schema.sql returns one match inside the approvals block."
  - criterion: "TypeScript types for the new schema exist in `shared/types/cyboflow.ts`, exporting interfaces WorkflowRow, WorkflowRunRow, RawEventRow, MessageRow, ApprovalRow, plus a `WorkflowRunStatus` union type listing all 8 status values and an `ApprovalStatus` union of the 4 approval statuses."
    verification: "grep -nE 'export (interface|type) (WorkflowRow|WorkflowRunRow|RawEventRow|MessageRow|ApprovalRow|WorkflowRunStatus|ApprovalStatus)' shared/types/cyboflow.ts returns 7 lines."
  - criterion: "After running `pnpm --filter main test` in a clean tree, the file-runner test from TASK-151 plus an integration test that asserts the new tables and indexes exist after migration both pass."
    verification: "vitest --run main/src/database/__tests__/cyboflowSchema.test.ts exits 0; the test queries sqlite_master and asserts presence of every table and index from this migration."
depends_on: [TASK-151]
estimated_complexity: medium
epic: cyboflow-schema-migration
test_strategy:
  needed: true
  justification: "The 5-table schema is load-bearing for every downstream Cyboflow feature. A typo in a CHECK constraint or a missing index silently degrades the entire orchestrator. Schema-level tests catch this at migration time, not at first prod usage."
  targets:
    - behavior: "After DatabaseService.initialize(), all 5 tables (workflows, workflow_runs, raw_events, messages, approvals) exist with the expected column set."
      test_file: "main/src/database/__tests__/cyboflowSchema.test.ts"
      type: integration
    - behavior: "All 4 day-1 indexes exist on the expected (table, column) tuples."
      test_file: "main/src/database/__tests__/cyboflowSchema.test.ts"
      type: integration
    - behavior: "INSERTing a workflow_runs row with an invalid status value (e.g., 'foo') fails the CHECK constraint."
      test_file: "main/src/database/__tests__/cyboflowSchema.test.ts"
      type: integration
    - behavior: "INSERTing an approvals row with an invalid status (e.g., 'maybe') fails the CHECK constraint."
      test_file: "main/src/database/__tests__/cyboflowSchema.test.ts"
      type: integration
---

# Author 006_cyboflow_schema.sql with 5 Tables, State Columns, and Day-1 Indexes

## Objective

Create the single migration file that lands all 5 new Cyboflow tables along with the day-1 indexes and the full 8-state machine column set on `workflow_runs`. The migration must be self-contained (no FKs to Crystal tables), idempotent (`IF NOT EXISTS` everywhere), and complete in one diff. Co-locate the TypeScript row types in `shared/types/cyboflow.ts` so both `main/` and `frontend/` can import them. This task assumes TASK-151 has landed the file-based migration runner that will actually apply this `.sql` file.

## Implementation Steps

1. **Create new file `main/src/database/migrations/006_cyboflow_schema.sql`** with the following structure. Every CREATE statement uses `IF NOT EXISTS`. Use ISO timestamps via `DATETIME DEFAULT CURRENT_TIMESTAMP` to match Crystal's convention. The file:

   