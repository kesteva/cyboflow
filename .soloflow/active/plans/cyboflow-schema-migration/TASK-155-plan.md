---
id: TASK-155
idea: IDEA-004
idea_id: IDEA-004
status: ready
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

   - **`it('fresh-install path: applies 006_cyboflow_schema.sql exactly once and records the ledger marker')`.** Construct a `DatabaseService` against a brand-new tmpfile path (no pre-seeded `user_preferences`). Call `initialize()`. Assert: (a) all 5 Cyboflow tables exist via `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workflows','workflow_runs','raw_events','messages','approvals')` returns 5 rows; (b) `SELECT value FROM user_preferences WHERE key = 'file_migration_applied:006_cyboflow_schema.sql'` returns `'true'`; (c) calling `initialize()` a second time on the same DB does NOT re-run the file (spy on the file-read side or count `console.log` calls containing `Applied file-based migration 006`).
   - **`it('existing-install path: auto-flags legacy 003/004/005 and applies 006 exactly once')`.** Bootstrap a fresh DB, manually insert the four legacy markers into `user_preferences` (`auto_commit_migrated`, `claude_panels_migrated`, `diff_panels_migrated`, `unified_panel_settings_migrated` all set to `'true'`) plus the inline-migration table state those markers imply (i.e. pre-create `tool_panels`, `claude_panel_state`, the unified-settings columns) to simulate a DB that was advanced through inline migrations 003/004/005 on a pre-TASK-151 build. Run `initialize()`. Assert: (a) `user_preferences` now also contains `file_migration_applied:003_add_tool_panels.sql`, `file_migration_applied:004_claude_panels.sql`, `file_migration_applied:005_unified_panel_settings.sql`, AND `file_migration_applied:006_cyboflow_schema.sql`; (b) no errors logged during the run (intercept `console.error`); (c) the 5 Cyboflow tables exist.
   - **`it('EXPLAIN QUERY PLAN for the canonical raw_events tail-read uses idx_raw_events_run_id_id')`.** After `initialize()` on a fresh DB, run `db.prepare('EXPLAIN QUERY PLAN SELECT * FROM raw_events WHERE run_id = ? ORDER BY id DESC LIMIT 100').all('test-run-id')`. Assert the returned rows, joined as a single string via `rows.map(r => r.detail).join(' ')`, includes the substring `'idx_raw_events_run_id_id'`. Document in the test body that this string-match is intentionally tight: if better-sqlite3 / SQLite upgrades change the EXPLAIN format, the test failure is the signal to re-verify that the index is still being chosen (see Lowest Confidence Area).

2. **One-time manual verification on a real Electron boot.** This covers the fresh-install path under real filesystem and `__dirname` conditions that the test environment mocks. From a clean shell:

   ```bash
   rm -rf ~/.cyboflow
   pnpm --filter main build
   pnpm electron-dev
   # In a second shell:
   tail -f crystal-backend-debug.log | grep -E 'Applied file-based migration|file_migration_applied'
   ```

   Confirm the log contains `[Database] Applied file-based migration 006_cyboflow_schema.sql` exactly once. Quit the app, relaunch `pnpm electron-dev`, confirm the log line does NOT appear a second time. Record the result (pass / actual log excerpt) in the commit message body — this is the AC-1 evidence trail.

3. **Update `docs/ARCHITECTURE.md` §Data Model.** Replace the misleading sentence on lines 87–88 (currently: "Schema in `main/src/database/schema.sql`; incremental migrations in `main/src/database/migrations/` (plain SQL files, applied in filename order by the migration runner)") with the actual two-phase description introduced by TASK-151:

   - Phase 1 — **inline migrations** inside `runMigrations()` in `main/src/database/database.ts`: hand-written `ALTER TABLE` / `CREATE TABLE` blocks gated on `PRAGMA table_info` checks and on `user_preferences` markers (e.g. `auto_commit_migrated`, `claude_panels_migrated`, `diff_panels_migrated`, `unified_panel_settings_migrated`, `folder_session_order_fix_applied`). These are the legacy inherit-from-Crystal migrations and stay in place untouched.
   - Phase 2 — **file-based migrations** via `runFileBasedMigrations()` (added in TASK-151), invoked at the tail of `runMigrations()`: reads `main/src/database/migrations/NNN_*.sql` files, sorts by the leading numeric prefix, and applies each whose `file_migration_applied:<filename>` marker is not yet present in `user_preferences`. The ledger is the same `user_preferences` table used by the inline migrations; the prefix `file_migration_applied:` namespaces it.
   - Note the auto-flag behaviour for legacy installs: when `runFileBasedMigrations()` detects the inline-migration markers (`unified_panel_settings_migrated` etc.) but no `file_migration_applied:` entries, it writes the `file_migration_applied:` markers for `003`/`004`/`005` without re-executing those files (the inline path already created the tables).

   The new prose must include the literal tokens `runFileBasedMigrations` and `file_migration_applied` so the AC-4 grep gate passes. Keep the §Data Model "Central tables" sentence intact; only the two-line schema/migration description is the edit target.

## Acceptance Criteria

All four frontmatter acceptance criteria must hold. In prose: (1) on a brand-new `~/.cyboflow/` directory, the first `pnpm electron-dev` boot must log the file-migration apply line for `006_cyboflow_schema.sql` exactly once, and a second boot must not log it again (idempotency proves the ledger is being consulted). (2) On a DB pre-seeded with the legacy inline-migration markers (a realistic upgrade from a pre-TASK-151 build), the file runner must auto-flag `003`/`004`/`005` as applied without re-executing them, and then apply `006`. (3) After `006` runs, `EXPLAIN QUERY PLAN SELECT * FROM raw_events WHERE run_id = ? ORDER BY id DESC LIMIT 100` must mention `idx_raw_events_run_id_id` (proof the canonical tail-read path uses the day-1 index from TASK-152, not a full table scan). (4) `docs/ARCHITECTURE.md` §Data Model must be rewritten to describe the actual two-phase migration system, and a grep for `runFileBasedMigrations|file_migration_applied` must hit at least twice.

## Test Strategy

Three integration tests in `main/src/database/__tests__/cyboflowSchema.test.ts` cover ACs 1–3 deterministically: fresh-install ordering, existing-install legacy-auto-flag behaviour, and EXPLAIN QUERY PLAN index pickup. The fresh-install test asserts the ledger marker is written and that a second `initialize()` does not re-apply the file; the existing-install test pre-seeds the DB to simulate a user upgrading from a pre-TASK-151 build and asserts the `file_migration_applied:003/004/005` markers appear without error; the EXPLAIN QUERY PLAN test does a string match on `idx_raw_events_run_id_id` in the plan output. AC-1 additionally requires a one-time manual Electron boot (`rm -rf ~/.cyboflow; pnpm --filter main build; pnpm electron-dev`) because the file-migration runner reads from `__dirname`-relative paths under real filesystem conditions that the integration-test harness mocks; the log excerpt from `crystal-backend-debug.log` is captured into the commit message body as the evidence trail. No new test file is created — all three cases live alongside the schema tests added in TASK-152.

## Hardest Decision

Whether to use `EXPLAIN QUERY PLAN` string-matching as the regression gate for AC-3, or instead write a behavioural benchmark (insert 100k rows, measure `WHERE run_id = ? ORDER BY id DESC LIMIT 100` latency, fail if above N ms). The string-match approach is deterministic and fast (<10ms), and the failure mode is clear: either SQLite stopped picking the index, or its EXPLAIN format changed. The benchmark approach is closer to user-visible behaviour but is slow (multi-second seed), order-of-magnitude flakier on CI, and a passing benchmark does not actually prove the index is the reason — it could be cache effects or row distribution. Choice: string-match in this task, with the Lowest Confidence Area documenting the format-stability risk. A separate perf-regression suite (out of scope for IDEA-004) is the right home for a behavioural benchmark.

## Rejected Alternatives

- **Skip the EXPLAIN test and rely on a row-count benchmark for AC-3.** Rejected: benchmarks are slow and CI-flaky; a passing benchmark does not isolate "the planner chose our index" from "the cache was warm". The string match against the plan output is deterministic and isolates the exact behaviour we care about.
- **Consolidate this task into TASK-152 instead of a standalone TASK-155.** Rejected: TASK-152 owns the index definitions (`raw_events(run_id, id)` etc.), while TASK-155 owns the orthogonal proof that the migration *runs* at the right time on both fresh and existing installs plus the docs correction. Mixing them would bloat the TASK-152 review and obscure the fact that ARCHITECTURE.md currently misstates the migration system.
- **Write a separate `queryPlan.test.ts` instead of extending `cyboflowSchema.test.ts`.** Rejected: the new tests share fixture setup (fresh `DatabaseService` against a tmpfile, the same 5-table assertions) with the existing schema tests. Colocation keeps fixtures DRY and signals to future readers that schema correctness and query-plan correctness are joint invariants of the same migration.

## Lowest Confidence Area

Whether the exact `idx_raw_events_run_id_id` substring is stable across better-sqlite3 / SQLite version bumps. Current `better-sqlite3` ships SQLite 3.x where EXPLAIN QUERY PLAN renders `SEARCH raw_events USING INDEX idx_raw_events_run_id_id (run_id=?)`; older or much newer versions could change `SEARCH` → `SCAN USING INDEX` or word the index reference differently. Verification path: (a) run the test today against the current pinned `better-sqlite3` version and confirm the substring hits; (b) record the better-sqlite3 version in the test file as a comment so a future upgrade triggers a deliberate re-verification; (c) if a future bump breaks the test, the first triage step is to print the raw EXPLAIN output and verify SQLite is still choosing the index — the test assertion is then updated to match the new format. If SQLite ever stops choosing the index, that is the actual regression we want to catch; the format-change false-positive is acceptable maintenance cost. **ESCALATE TO HUMAN** only if a future SQLite version reports the index is unused — that means the day-1 index design from IDEA-004 slice 2 needs revisiting.
