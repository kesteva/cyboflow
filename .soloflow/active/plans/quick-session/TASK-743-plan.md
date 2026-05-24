---
id: TASK-743
idea: IDEA-024
status: ready
created: "2026-05-23T00:00:00Z"
files_owned:
  - main/src/database/migrations/009_sessions_run_id.sql
  - main/src/database/__tests__/sessionsRunIdMigration.test.ts
  - main/src/database/__tests__/fileMigrationRunner.test.ts
  - scripts/__tests__/verify-schema-parity.test.js
files_readonly:
  - main/src/database/schema.sql
  - main/src/database/database.ts
  - main/src/database/migrations/007_add_stuck_reason.sql
  - main/src/database/migrations/008_permission_mode_approve_default.sql
  - main/src/database/__tests__/fileMigrationRunner.test.ts
  - scripts/verify-schema-parity.js
  - scripts/__tests__/verify-schema-parity.test.js
  - main/package.json
acceptance_criteria:
  - criterion: "Migration file 009 exists at the canonical path with the numeric-prefix `NNN_*.sql` naming the file runner expects."
    verification: "test -f main/src/database/migrations/009_sessions_run_id.sql && [ \"$(ls main/src/database/migrations/009_*.sql | wc -l | tr -d ' ')\" = \"1\" ]"
  - criterion: "Migration 009 adds a single nullable `run_id TEXT` column to the sessions table; it MUST NOT declare NOT NULL, MUST NOT declare a default, and MUST NOT declare a FOREIGN KEY."
    verification: "grep -E 'ALTER TABLE sessions ADD COLUMN run_id TEXT' main/src/database/migrations/009_sessions_run_id.sql returns exactly 1 match AND grep -iE '(NOT NULL|DEFAULT|FOREIGN KEY|REFERENCES)' main/src/database/migrations/009_sessions_run_id.sql returns 0 matches"
  - criterion: "After running the file migration runner, the `sessions` table has a `run_id` column of type TEXT, notnull=0, dflt_value=NULL."
    verification: "vitest run in main/src/database/__tests__/sessionsRunIdMigration.test.ts asserts PRAGMA table_info('sessions') contains { name: 'run_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 } after a real DatabaseService.initialize() pointed at the real migrations dir."
  - criterion: "Migration 009 is idempotent under the runner: a second `DatabaseService.initialize()` against the same DB does not throw and does not re-execute the ALTER (verified by the `file_migration_applied:009_sessions_run_id.sql` marker)."
    verification: "vitest run for the new test exercises a two-initialize cycle and asserts (a) exit without throw, (b) exactly one row in user_preferences with key 'file_migration_applied:009_sessions_run_id.sql'."
  - criterion: "Schema parity check still passes after migration 009 lands. Path-2 (migrations-only) tolerates the `no such table: sessions` from migration 009's ALTER, and the diff reports no drift."
    verification: node scripts/verify-schema-parity.js exits 0 AND node scripts/__tests__/verify-schema-parity.test.js exits 0
  - criterion: "The full unit suite (`pnpm test:unit`) is green after migration 009 lands."
    verification: "pnpm test:unit exits 0"
depends_on: []
estimated_complexity: low
epic: quick-session
test_strategy:
  needed: true
  justification: "The migration is small but it is the schema foundation T2 depends on. A dedicated migration test pins the post-migration shape of the sessions table (column name/type/nullability) and the idempotency guarantee. The sibling test file `main/src/database/__tests__/fileMigrationRunner.test.ts` exists in the same directory and exercises the runner with fixture migrations — it does NOT cover real migration files, so it cannot be relied on to catch a malformed 009. We also re-run the existing schema-parity script to confirm 009 does not introduce a path-1/path-2 drift signal."
  targets:
    - behavior: "After DatabaseService.initialize() with the real migrations directory, the sessions table has a nullable run_id TEXT column (PRAGMA table_info reports notnull=0, dflt_value=null, pk=0)."
      test_file: main/src/database/__tests__/sessionsRunIdMigration.test.ts
      type: integration
    - behavior: "A second DatabaseService.initialize() against the same DB is a no-op for migration 009 (no throw, exactly one file_migration_applied:009_sessions_run_id.sql marker)."
      test_file: main/src/database/__tests__/sessionsRunIdMigration.test.ts
      type: integration
    - behavior: "The existing fileMigrationRunner suite continues to pass against the unchanged runner — sanity gate that 009's presence in the real migrations dir does not break the synthetic-fixture tests (which override the dir and never see 009)."
      test_file: main/src/database/__tests__/fileMigrationRunner.test.ts
      type: integration
    - behavior: "scripts/verify-schema-parity.js still exits 0 (sessions table is in the path-1-only set, so 009's ALTER produces no diff)."
      test_file: scripts/__tests__/verify-schema-parity.test.js
      type: integration
---
# Add nullable run_id migration to sessions table

## Objective

Land the schema change that the rest of the `quick-session` epic depends on: a nullable `run_id TEXT` column on the `sessions` table. The user-locked design answer to Q1 is "nullable run_id; skip WorkflowRun" — this migration is the precondition that lets T2 (`sessions:create-quick`) write `run_id = NULL` for quick sessions, and lets T3 (NULL-harden run-aware queries) treat `run_id IS NULL` as a first-class state. This task does not touch any IPC handler, query, or TypeScript type — it only adds the column so subsequent tasks can rely on it existing.

## Implementation Steps

1. **Confirm the precondition.** Run `grep -nE 'run_id' main/src/database/schema.sql` and `grep -rnE 'ALTER TABLE sessions ADD COLUMN run_id' main/src/database/migrations/` — both MUST return 0 matches before authoring 009. If either returns a hit, stop and reconcile (someone already landed this column and the task is moot or duplicative).

2. **Create the migration file** at `main/src/database/migrations/009_sessions_run_id.sql` with this exact body (no DEFAULT, no NOT NULL, no FK — the user explicitly chose nullable / no-FK in IDEA-024 Q1):

   ```sql
   -- Migration 009: Add nullable run_id to sessions for quick-session support.
   --
   -- Context: IDEA-024 ("quick-session") establishes that quick sessions
   -- created outside any flow are not associated with a workflow_runs row.
   -- The chosen design (user-locked answer to Q1) is a nullable run_id on
   -- sessions — quick sessions persist run_id = NULL; flow sessions will
   -- continue to be backfilled by their owning run when the runtime path
   -- that writes this column lands (T2: sessions:create-quick handler;
   -- flow-side backfill is out of scope for this migration).

   ALTER TABLE sessions ADD COLUMN run_id TEXT;
   ```

3. **Author the migration test** at `main/src/database/__tests__/sessionsRunIdMigration.test.ts` modeled on `main/src/database/__tests__/fileMigrationRunner.test.ts`. Use the real `DatabaseService` against a temp dir and the **real** migrations directory (do NOT use `setMigrationsDirForTesting`). Two test cases:
   - **Shape test.** After `svc.initialize()`, open the raw better-sqlite3 DB and assert `PRAGMA table_info('sessions')` includes a row matching `{ name: 'run_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 }`. Also assert `user_preferences` contains `key = 'file_migration_applied:009_sessions_run_id.sql'` with `value = 'true'`.
   - **Idempotency test.** Re-initialize a fresh `DatabaseService` against the same `dbPath`; assert no throw, and assert exactly one row in `user_preferences` matching `key LIKE 'file_migration_applied:009_%'`.

4. **Confirm build packaging picks up the new file.** The `copy:assets` script (`main/package.json:10`) globs `src/database/migrations/*.sql` and copies into `dist/main/src/database/migrations/`. The new file matches the glob — no script edit needed. Sanity: run `pnpm --filter main build && ls main/dist/main/src/database/migrations/009_sessions_run_id.sql` and confirm exit 0.

5. **Run the schema-parity guard.** Run `node scripts/verify-schema-parity.js --verbose` and confirm exit 0. Then run `node scripts/__tests__/verify-schema-parity.test.js` and confirm all four cases pass.

6. **Run the full unit gate.** `pnpm test:unit` from the repo root MUST exit 0.

## Acceptance Criteria

- **Migration file exists** at `main/src/database/migrations/009_sessions_run_id.sql` and is the only `009_*.sql` in that directory.
- **Migration is exactly an `ALTER TABLE sessions ADD COLUMN run_id TEXT`** — no NOT NULL, no DEFAULT, no FOREIGN KEY / REFERENCES.
- **Post-migration column shape is nullable TEXT** — `PRAGMA table_info('sessions')` reports `run_id` with `type='TEXT'`, `notnull=0`, `dflt_value=null`, `pk=0`.
- **Migration is idempotent** — re-running `DatabaseService.initialize()` against the same DB does not throw and does not re-execute the ALTER.
- **Schema-parity script remains green.**
- **`pnpm test:unit` exits 0.**

## Test Strategy

A new integration test at `main/src/database/__tests__/sessionsRunIdMigration.test.ts` exercises the migration end-to-end via the real `DatabaseService` and the real migrations directory. The shape assertion is the structural contract T2 and T3 depend on; the idempotency assertion locks in the runner's "applied marker prevents re-execution" guarantee.

## Hardest Decision

Whether to also update `main/src/database/schema.sql` so fresh installs get the column without needing the migration. Chose **migration-only** (do NOT edit schema.sql) — matches the precedent set by every column-add migration in the repo (007 adds `stuck_detected_at` to `workflow_runs` without re-stating it in schema.sql; 008 backfills without touching schema.sql). The schema-parity script is engineered for exactly this asymmetry: it filters sessions out of the diff because the table lives in schema.sql but its column evolutions live in migrations. Editing schema.sql would cause `duplicate column name: run_id` errors on fresh installs because the migration runner runs AFTER schema.sql.

## Rejected Alternatives

1. **Add a synthetic `WorkflowRun` row per quick session.** Rejected by the user in the IDEA.
2. **Make `run_id` a foreign key with `ON DELETE CASCADE`.** Rejected — orchestrator reaps workflow_runs independently; CASCADE would silently vaporize session rows.
3. **Add an index on `run_id`.** Rejected for now — forward lookup (session → run) is per-session and efficient; reverse lookup not a hot path.
4. **Add a CHECK constraint on `run_id`.** Rejected — NULL must be a first-class value.

## Lowest Confidence Area

The schema-parity interaction. The path-2 (migrations-only) build will execute 009's ALTER against a database where the sessions table does not exist; SQLite raises `no such table: sessions` which the parity script's `buildPath2Db` tolerates. The sessions table is then filtered out of the path-1/path-2 diff. This handling already covers 008's UPDATE-on-sessions. Step 5 re-runs the parity script as empirical confirmation.
