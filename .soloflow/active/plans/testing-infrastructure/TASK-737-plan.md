---
id: TASK-737
idea: SPRINT-035-compound
status: in-flight
created: "2026-05-23T12:00:00Z"
files_owned:
  - main/src/database/__tests__/migration007.test.ts
files_readonly:
  - main/src/database/migrations/006_cyboflow_schema.sql
  - main/src/database/migrations/007_add_stuck_reason.sql
  - main/src/database/__tests__/cyboflowSchema.test.ts
  - main/src/orchestrator/__test_fixtures__/orchestratorTestDb.ts
acceptance_criteria:
  - criterion: A new test file `main/src/database/__tests__/migration007.test.ts` exists and is invoked by `pnpm --filter main test`.
    verification: "test -f main/src/database/__tests__/migration007.test.ts && pnpm --filter main test -- migration007 (exits 0; vitest reports the file's test count >= 2)"
  - criterion: The test reads `007_add_stuck_reason.sql` from disk via `readFileSync` and applies it on top of `006_cyboflow_schema.sql`.
    verification: "grep -n \"007_add_stuck_reason\" main/src/database/__tests__/migration007.test.ts shows at least one readFileSync call referencing that filename"
  - criterion: "A test asserts `PRAGMA table_info(workflow_runs)` returns a row with `name='stuck_detected_at'` AND `type='INTEGER'`."
    verification: "grep -n \"stuck_detected_at\" main/src/database/__tests__/migration007.test.ts shows a PRAGMA table_info assertion checking both name and INTEGER type"
  - criterion: "A test asserts `SELECT name FROM sqlite_master WHERE type='index'` returns a row named `idx_workflow_runs_status_stuck_at`."
    verification: "grep -n \"idx_workflow_runs_status_stuck_at\" main/src/database/__tests__/migration007.test.ts shows the index-presence assertion"
  - criterion: "The test does NOT call `createTestDb` from `orchestratorTestDb.ts` (because that fixture uses inline ALTER, not the SQL file)."
    verification: "grep -n \"from .*orchestratorTestDb\" main/src/database/__tests__/migration007.test.ts returns 0 hits AND grep -n \"createTestDb\" main/src/database/__tests__/migration007.test.ts returns 0 hits"
  - criterion: "`pnpm --filter main test` exits 0 with the new file included."
    verification: "pnpm --filter main test exits with code 0; vitest summary shows the new file's tests as passing"
depends_on: []
estimated_complexity: low
epic: testing-infrastructure
test_strategy:
  needed: true
  justification: This task IS the test — restoring deleted coverage for migration 007. The plan creates the test file; verification runs it.
  targets:
    - behavior: Reading 007_add_stuck_reason.sql from disk and applying it on top of 006_cyboflow_schema.sql adds the stuck_detected_at INTEGER column to workflow_runs
      test_file: main/src/database/__tests__/migration007.test.ts
      type: integration
    - behavior: Reading 007_add_stuck_reason.sql from disk and applying it creates the idx_workflow_runs_status_stuck_at index
      test_file: main/src/database/__tests__/migration007.test.ts
      type: integration
---
# Restore Migration-007 idempotency tests

## Objective

TASK-733 deleted the two `Migration 007 idempotency` test cases from `stuckDetector.test.ts` (commit `aae52be`) on the false premise that `orchestratorTestDb.ts:createTestDb` exercises the SQL file. It does not — `createTestDb` uses an inline `ALTER TABLE workflow_runs ADD COLUMN stuck_detected_at INTEGER` statement (`orchestratorTestDb.ts:57`), so any typo, dropped index, or column-type change in `007_add_stuck_reason.sql` is now invisible to the test suite. This task creates a dedicated `migration007.test.ts` that reads the SQL file from disk, applies it on top of `006_cyboflow_schema.sql`, and asserts the column and index actually exist as declared by the file.

## Implementation Steps

1. Create `main/src/database/__tests__/migration007.test.ts`. Imports: `describe, it, expect` from `vitest`; `Database` (default) from `better-sqlite3`; `readFileSync` from `node:fs`; `join` from `node:path`.

2. Add a top-level helper `applyMigrations006And007(): Database.Database`:
   - Open a fresh `new Database(':memory:')`.
   - Read `main/src/database/migrations/006_cyboflow_schema.sql` via `readFileSync(join(__dirname, '..', 'migrations', '006_cyboflow_schema.sql'), 'utf-8')` and `db.exec(sql)`.
   - Read `main/src/database/migrations/007_add_stuck_reason.sql` the same way and `db.exec(sql)`.
   - Return `db`.

3. Add `describe('Migration 007: stuck_detected_at column and index', () => { ... })` containing at least these two cases:
   - **`it('adds stuck_detected_at INTEGER to workflow_runs', () => { ... })`** — call `applyMigrations006And007()`, run `PRAGMA table_info(workflow_runs)` via `db.prepare(...).all()`, find the row with `name === 'stuck_detected_at'`, assert it is defined AND `String(row.type).toUpperCase() === 'INTEGER'`. (SQLite reports affinity case-insensitively; normalize before comparison.)
   - **`it('creates idx_workflow_runs_status_stuck_at index', () => { ... })`** — call `applyMigrations006And007()`, run `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_workflow_runs_status_stuck_at'` via `db.prepare(...).all()`, assert the result has length 1.

4. Optional third case (recommended, low cost): **`it('is idempotent when re-applied via IF NOT EXISTS index clause', () => { ... })`** — apply 006+007, then attempt to re-`exec` ONLY the index creation line from 007 (since the `ALTER TABLE` does not use `IF NOT EXISTS` and would error). Assert the re-exec does NOT throw. This guards the `IF NOT EXISTS` clause on `CREATE INDEX` (line 15 of the SQL file).

5. Do NOT import `createTestDb` from `orchestratorTestDb.ts`. The whole point of this test is to validate the SQL file itself, not the inline `ALTER` in the fixture.

6. Run `pnpm --filter main test -- migration007` locally to confirm the new file passes; then run the full `pnpm --filter main test` to confirm no neighbor-test regressions.

## Acceptance Criteria

- New file `main/src/database/__tests__/migration007.test.ts` exists.
- It calls `readFileSync` on both `006_cyboflow_schema.sql` and `007_add_stuck_reason.sql`.
- It contains a `PRAGMA table_info(workflow_runs)` assertion for `stuck_detected_at` with INTEGER type.
- It contains a `sqlite_master` assertion for `idx_workflow_runs_status_stuck_at`.
- It does NOT import or call `createTestDb`.
- `pnpm --filter main test` exits 0.

## Test Strategy

This task IS the test. The two `targets` in the frontmatter are the behaviors restored. No sibling tests need updating (the deleted cases were the only on-disk-SQL coverage of migration 007). The companion `cyboflowSchema.test.ts` already covers 006 from disk; this file does the same for 007 in isolation, so the two files together provide per-file coverage.

## Hardest Decision

**Where to put the test: standalone file vs. additional `describe` block in `cyboflowSchema.test.ts`.** Chose standalone (`migration007.test.ts`) because: (a) the failure signal is sharper — when the next migration arrives, "migration007.test.ts failing" is more actionable than "cyboflowSchema.test.ts has a 007 block that failed"; (b) `cyboflowSchema.test.ts` is already 740 lines and growing — adding more makes it harder to navigate; (c) the test fixture is different (006-only vs. 006+007), so the helper function diverges naturally.

## Rejected Alternatives

- **Append to `cyboflowSchema.test.ts`.** Rejected for the file-size / mixed-fixture reasons above. Would reconsider if the team prefers a single `migrations.test.ts` mega-file convention — currently each migration test sits in its own location.
- **Restore the original code block under `stuckDetector.test.ts`.** Rejected because the deletion rationale acknowledged the block was misplaced (stuck-detector tests should test the detector, not the SQL file). The new file is the proper home.
- **Generate the test programmatically from a registry of all migration files.** Rejected as over-engineering for two assertions; would only pay off when there are 5+ migrations with the same pattern.

## Lowest Confidence Area

The `PRAGMA table_info().type` field. SQLite returns the column type as declared, but the comparison should be case-insensitive (`String(row.type).toUpperCase() === 'INTEGER'`) in case better-sqlite3 ever normalizes differently across versions. If a future SQLite/better-sqlite3 upgrade changes the case or surfaces the type as the empty string for affinity, the assertion is the place to fix.
