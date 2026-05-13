---
id: TASK-151
idea: IDEA-004
idea_id: IDEA-004
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/database/database.ts
files_readonly:
  - main/src/database/migrations/003_add_tool_panels.sql
  - main/src/database/migrations/004_claude_panels.sql
  - main/src/database/migrations/005_unified_panel_settings.sql
  - main/src/database/schema.sql
  - main/package.json
  - docs/CODE-PATTERNS.md
  - docs/ARCHITECTURE.md
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
acceptance_criteria:
  - criterion: DatabaseService.runMigrations() invokes a new private method runFileBasedMigrations() at the END of its body (after all existing inline migrations).
    verification: "grep -n 'runFileBasedMigrations' main/src/database/database.ts shows the call is the last logical step inside runMigrations() (after the folder_session_order_fix_applied block)."
  - criterion: "runFileBasedMigrations() reads the directory `__dirname/migrations/`, filters entries matching the regex /^(\\d{3})_.*\\.sql$/, sorts ascending by the captured 3-digit prefix, and applies each file's SQL via db.exec() inside a transaction."
    verification: "Read the implementation; confirm it uses fs.readdirSync, a regex with a 3-digit numeric prefix capture group, .sort() on the prefix as integer, and db.exec() (which handles multi-statement SQL). Also confirm files without a matching numeric prefix are skipped (logged at WARN)."
  - criterion: "Idempotency is tracked via the existing user_preferences table with key 'file_migration_applied:<filename>'. A file already recorded as applied is skipped without re-execution."
    verification: "grep -n 'file_migration_applied' main/src/database/database.ts shows: (a) a SELECT to check applied state, (b) the SELECT result gates db.exec, (c) an INSERT after successful application. Unit-test by re-running runMigrations() on the same DB and confirming no errors and no duplicate inserts."
  - criterion: "Existing numbered files 003_add_tool_panels.sql, 004_claude_panels.sql, 005_unified_panel_settings.sql are recorded as already-applied in their existing-DB state (NOT re-applied), because their corresponding inline migrations have run."
    verification: "Implementation marks 003/004/005 as applied at runner entry IF their inline marker (e.g., 'unified_panel_settings_migrated') is already set in user_preferences, so the file runner never tries to re-execute them on existing installs."
  - criterion: "If a file's SQL fails mid-execution, the transaction rolls back, no user_preferences row is inserted, and the error is logged with the filename. The app continues to start (does not crash on migration failure, matching Crystal's existing pattern of try/catch around migration 004/005)."
    verification: "grep -n 'try' main/src/database/database.ts around the new method shows a try/catch wrapping each per-file db.exec inside a db.transaction(); on catch, console.error logs the filename and error, and execution moves on to the next file."
  - criterion: "copy:assets npm script in main/package.json already copies migrations/*.sql to dist; no changes needed there. Verify it still works."
    verification: "grep -n 'copy:assets' main/package.json shows the existing 'cp src/database/migrations/*.sql dist/main/src/database/migrations/' clause is unchanged."
  - criterion: "Unit test covers: (1) a fresh DB with the new runner finds and applies a fixture .sql file, (2) running the runner twice does not re-apply the file, (3) a broken .sql file logs an error and does not crash."
    verification: vitest --run main/src/database/__tests__/fileMigrationRunner.test.ts exits 0 with at least 3 passing test cases.
depends_on: []
estimated_complexity: medium
epic: cyboflow-schema-migration
test_strategy:
  needed: true
  justification: This task introduces the migration loader that all downstream cyboflow schema migrations depend on. A regression here silently breaks fresh installs. Test coverage is mandatory.
  targets:
    - behavior: "Fresh DB: runner applies a fixture .sql file and records it in user_preferences."
      test_file: main/src/database/__tests__/fileMigrationRunner.test.ts
      type: unit
    - behavior: "Re-running runMigrations() on a DB that already has all files applied is a no-op (no INSERTs, no errors)."
      test_file: main/src/database/__tests__/fileMigrationRunner.test.ts
      type: unit
    - behavior: "A .sql file with invalid SQL logs an error, rolls back its transaction, and the next file in the queue still applies."
      test_file: main/src/database/__tests__/fileMigrationRunner.test.ts
      type: unit
    - behavior: "Existing inline migrations 003-005 are detected via their user_preferences markers and the corresponding .sql files are auto-flagged as applied so they don't run again."
      test_file: main/src/database/__tests__/fileMigrationRunner.test.ts
      type: unit
---
# Add Numeric-Prefix File-Based Migration Runner

## Objective

The IDEA-004 epic assumes Crystal applies numbered `.sql` files in order. Codebase inspection proves this assumption is **wrong**: `runMigrations()` in `main/src/database/database.ts` is hybrid-inline-only — every existing migration (including ones labeled "Migration 003-006" in comments) lives as inline `ALTER TABLE` / `CREATE TABLE` calls gated by `PRAGMA table_info()` or `user_preferences` keys. The `.sql` files under `main/src/database/migrations/` are documentation, never executed. Before `006_cyboflow_schema.sql` can do any work, a real numeric-prefix file runner must exist. This task adds that runner and integrates it as the final phase of `runMigrations()`.

## Implementation Steps

1. **Read the tail of `runMigrations()`** — Open `main/src/database/database.ts` and confirm the method ends near line 1299. The new runner invocation goes inside the method body, after the existing `folder_session_order_fix_applied` block and before the closing brace.

2. **Add a private method `runFileBasedMigrations()` on `DatabaseService`** in `main/src/database/database.ts`. Skeleton:
   