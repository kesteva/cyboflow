---
id: TASK-155
idea: IDEA-004
idea_id: IDEA-004
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - docs/ARCHITECTURE.md
files_readonly:
  - main/src/database/database.ts
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/database/migrations/003_add_tool_panels.sql
  - main/src/database/migrations/004_claude_panels.sql
  - main/src/database/migrations/005_unified_panel_settings.sql
  - main/src/services/cyboflow/transitions.ts
  - main/src/services/cyboflow/stateMachine.ts
  - main/package.json
  - docs/CODE-PATTERNS.md
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
acceptance_criteria:
  - criterion: "On a fresh-clone install (delete ~/.cyboflow/, run `pnpm electron-dev` to first boot), the file-migration runner introduced in TASK-151 applies 006_cyboflow_schema.sql exactly once. The log line `[Database] Applied file-based migration 006_cyboflow_schema.sql` appears."
    verification: "Manual verification: rm -rf ~/.cyboflow; pnpm --filter main build; pnpm electron-dev. Tail crystal-backend-debug.log for the expected log line. Then quit the app, restart, confirm the log line does NOT appear again (idempotency)."
  - criterion: "On an existing-install simulation (a DB that already has the inline migrations 003/004/005 applied via user_preferences markers), the file-migration runner auto-flags 003/004/005 files as applied AND applies 006 exactly once."
    verification: "Integration test in main/src/database/__tests__/cyboflowSchema.test.ts that: (a) bootstraps a DB seeded with the inline migration markers, (b) runs DatabaseService.initialize(), (c) asserts user_preferences contains both the legacy 'unified_panel_settings_migrated' AND 'file_migration_applied:006_cyboflow_schema.sql', (d) asserts no errors logged for re-applying 003/004/005."
  - criterion: "After 006_cyboflow_schema.sql runs, SQLite reports it can use the day-1 indexes for the canonical query patterns: EXPLAIN QUERY PLAN for `SELECT * FROM raw_events WHERE run_id = ? ORDER BY id DESC LIMIT 100` mentions idx_raw_events_run_id_id (NOT a full table scan)."
    verification: "Add an integration test step (in cyboflowSchema.test.ts or a new queryPlan.test.ts) that runs `db.prepare('EXPLAIN QUERY PLAN SELECT * FROM raw_events WHERE run_id = ? ORDER BY id DESC LIMIT 100').all('test')` and asserts the result includes the string 'idx_raw_events_run_id_id'."
  - criterion: "docs/ARCHITECTURE.md is updated to accurately describe the migration system: (a) inline migrations in runMigrations() apply ALTER/CREATE statements gated on PRAGMA + user_preferences, (b) numeric-prefix .sql files in migrations/ are applied by runFileBasedMigrations() at the end of runMigrations(), (c) the file-migration ledger is in user_preferences with prefix 'file_migration_applied:'."
    verification: "Read docs/ARCHITECTURE.md §Data Model; the prior misleading claim that '.sql files are applied in filename order' must be replaced with the actual two-phase pattern. grep -nE 'runFileBasedMigrations|file_migration_applied' docs/ARCHITECTURE.md returns at least 2 matches."
depends_on:
  - TASK-151
  - TASK-152
estimated_complexity: low
epic: cyboflow-schema-migration
test_strategy:
  needed: true
  justification: "The integration tests for ordering + query-plan-uses-index are the only objective proof that the migration actually does what the spec promises. Manual verification is necessary for the fresh-install path because file-migration timing during Electron boot involves real fs reads under __dirname, which test environments mock differently."
  targets:
    - behavior: "Fresh DB: DatabaseService.initialize() ends with all 5 new tables present and file_migration_applied:006_cyboflow_schema.sql in user_preferences."
      test_file: main/src/database/__tests__/cyboflowSchema.test.ts
      type: integration
    - behavior: "Existing-install simulation: DB pre-seeded with inline-migration markers; after initialize(), the legacy .sql files are auto-flagged applied AND 006 is applied."
      test_file: main/src/database/__tests__/cyboflowSchema.test.ts
      type: integration
    - behavior: EXPLAIN QUERY PLAN on the canonical raw_events query uses idx_raw_events_run_id_id.
      test_file: main/src/database/__tests__/cyboflowSchema.test.ts
      type: integration
---
# Migration Ordering Verification and Architecture Docs Update

## Objective

This task is the IDEA-004 slice 5 deliverable: verify that the migration pipeline introduced in TASK-151 + TASK-152 actually runs at the right time on both fresh installs and existing-DB installs, that the indexes from TASK-152 are actually picked up by the query planner, and that `docs/ARCHITECTURE.md` accurately describes the migration system. Codebase audit during refinement revealed `docs/ARCHITECTURE.md` currently misstates the migration system as "plain SQL files, applied in filename order" — but until TASK-151 lands, no file loader exists. After TASK-151+TASK-152, the docs must catch up to ground truth.

This task adds end-to-end ordering integration tests, runs a one-time manual verification on a real Electron boot, and corrects ARCHITECTURE.md.

## Implementation Steps

1. **Extend `main/src/database/__tests__/cyboflowSchema.test.ts`** (already created in TASK-152) with three additional `it()` cases (do NOT create a separate test file — keep schema/ordering tests colocated):

   