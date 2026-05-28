---
id: TASK-787
idea: IDEA-027
status: done
created: "2026-05-27T18:00:00Z"
files_owned:
  - main/src/database/migrations/012_quick_workflow_sentinel.sql
  - main/src/orchestrator/workflowRegistry.ts
  - main/src/database/database.ts
  - main/src/database/models.ts
  - main/src/database/__tests__/cyboflowSchema.test.ts
  - main/src/database/__tests__/migration012.test.ts
  - main/src/orchestrator/__tests__/workflowRegistry.test.ts
files_readonly:
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/database/migrations/009_sessions_run_id.sql
  - main/src/database/schema.sql
  - main/src/orchestrator/__tests__/workflowRegistry.test.ts
  - main/src/orchestrator/types.ts
  - shared/types/workflows.ts
acceptance_criteria:
  - criterion: Migration 012 adds is_quick BOOLEAN DEFAULT 0 to sessions
    verification: "cat main/src/database/migrations/012_quick_workflow_sentinel.sql | grep 'ALTER TABLE sessions ADD COLUMN is_quick'"
  - criterion: Migration backfills is_quick = 1 for existing quick sessions
    verification: "grep 'UPDATE sessions SET is_quick' main/src/database/migrations/012_quick_workflow_sentinel.sql"
  - criterion: Migration inserts sentinel __quick__ workflow rows for all existing projects
    verification: "grep 'INSERT OR IGNORE INTO workflows' main/src/database/migrations/012_quick_workflow_sentinel.sql"
  - criterion: ensureQuickWorkflow(projectId) returns deterministic workflow_id and is idempotent
    verification: "pnpm --filter main test -- --reporter=verbose 2>&1 | grep -i 'ensureQuickWorkflow'"
  - criterion: getQuickSessions() filters by is_quick = 1 instead of run_id IS NULL
    verification: "grep -n 'is_quick' main/src/database/database.ts"
  - criterion: listByProject excludes __quick__ sentinel
    verification: "grep '__quick__' main/src/orchestrator/workflowRegistry.ts | grep -i 'filter\\|exclude\\|!='"
  - criterion: All existing tests pass
    verification: "pnpm test:unit exits 0"
depends_on: []
estimated_complexity: medium
epic: quick-session
test_strategy:
  needed: true
  justification: "Migration, ensureQuickWorkflow helper, and getQuickSessions discriminator change all need test coverage."
  targets:
    - behavior: "ensureQuickWorkflow creates sentinel row on first call, is idempotent on subsequent"
      test_file: main/src/orchestrator/__tests__/workflowRegistry.test.ts
      type: unit
    - behavior: listByProject excludes __quick__ sentinel
      test_file: main/src/orchestrator/__tests__/workflowRegistry.test.ts
      type: unit
    - behavior: "Migration 012 adds is_quick column, backfills, inserts sentinels"
      test_file: main/src/database/__tests__/migration012.test.ts
      type: integration
    - behavior: getQuickSessions returns sessions with is_quick=1 regardless of run_id
      test_file: main/src/database/__tests__/cyboflowSchema.test.ts
      type: integration
---
# Add sentinel __quick__ workflow migration and ensureQuickWorkflow helper

## Objective

Establish the database foundation for quick sessions to participate in the workflow_runs pipeline. Add a per-project sentinel `__quick__` workflow row, an `is_quick` boolean column on sessions, and an `ensureQuickWorkflow` helper for downstream tasks.

## Implementation Steps

1. Create migration `012_quick_workflow_sentinel.sql`: ALTER TABLE sessions ADD COLUMN is_quick BOOLEAN DEFAULT 0; backfill is_quick=1 for run_id IS NULL non-main-repo sessions; INSERT OR IGNORE sentinel workflows for all projects.
2. Add QUICK_WORKFLOW_NAME constant and ensureQuickWorkflow(projectId) method to WorkflowRegistry. Returns deterministic `wf-{projectId}-__quick__` id. Uses INSERT OR IGNORE for idempotency.
3. Update listByProject to exclude __quick__ sentinel (WHERE name != '__quick__').
4. Update getQuickSessions() in database.ts to filter by is_quick = 1 instead of run_id IS NULL.
5. Add is_quick?: boolean to Session interface in models.ts.
6. Update existing getQuickSessions tests to seed is_quick=1. Add test for is_quick=1 AND run_id IS NOT NULL.
7. Create migration012.test.ts following migration011.test.ts pattern.
8. Add ensureQuickWorkflow tests to workflowRegistry.test.ts.

## Acceptance Criteria

See frontmatter.
