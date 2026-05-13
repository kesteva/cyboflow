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

   ```ts
   private runFileBasedMigrations(): void {
     // Bootstrap: legacy inline migrations 003-005 ran before this runner existed.
     // If their inline markers are set, auto-flag the corresponding .sql files as
     // already applied so we never double-apply on upgrade.
     this.backfillLegacyFileMigrationFlags();

     // Resolve the migrations dir relative to the compiled main bundle.
     // copy:assets places files at dist/main/src/database/migrations/*.sql at build
     // time, so __dirname resolves correctly in both dev (tsx) and packaged (asar) runs.
     const migrationsDir = join(__dirname, 'migrations');

     let entries: string[];
     try {
       entries = readdirSync(migrationsDir);
     } catch (err) {
       console.warn('[Database] No migrations directory found at', migrationsDir, err);
       return;
     }

     const PREFIX_RE = /^(\d{3})_.*\.sql$/;

     const ordered = entries
       .map((name) => {
         const match = PREFIX_RE.exec(name);
         if (!match) {
           console.warn(`[Database] Skipping non-numeric migration file: ${name}`);
           return null;
         }
         return { name, prefix: parseInt(match[1], 10) };
       })
       .filter((x): x is { name: string; prefix: number } => x !== null)
       .sort((a, b) => a.prefix - b.prefix);

     const selectApplied = this.db.prepare(
       "SELECT value FROM user_preferences WHERE key = ?"
     );
     const insertApplied = this.db.prepare(
       "INSERT INTO user_preferences (key, value) VALUES (?, 'true')"
     );

     for (const { name } of ordered) {
       const key = `file_migration_applied:${name}`;
       if (selectApplied.get(key)) {
         continue; // idempotent: already recorded
       }

       const sqlPath = join(migrationsDir, name);
       let sql: string;
       try {
         sql = readFileSync(sqlPath, 'utf-8');
       } catch (err) {
         console.error(`[Database] Could not read migration ${name}:`, err);
         continue;
       }

       try {
         this.transaction(() => {
           this.db.exec(sql);
           insertApplied.run(key);
         });
         console.log(`[Database] Applied file migration: ${name}`);
       } catch (err) {
         // Match Crystal's existing tolerance pattern (try/catch around 004/005):
         // log + continue so a single broken file does not brick the app boot.
         console.error(`[Database] Migration ${name} failed:`, err);
       }
     }
   }
   ```

   Notes:
   - `readdirSync` and `readFileSync` come from `fs` — extend the existing top-of-file import (`import { readFileSync, mkdirSync } from 'fs';`) to also include `readdirSync`.
   - `db.exec()` is the correct API here because every migration file may contain multiple statements separated by `;`. The existing `initializeSchema()` splits manually because it predates this runner; do NOT copy that pattern — `exec()` handles it natively and respects `BEGIN`/`COMMIT` inside `db.transaction()`.
   - Wrapping each file in `this.transaction(() => ...)` is the rollback guarantee. If `db.exec(sql)` throws, the `insertApplied.run` never executes and SQLite rolls the file's partial changes back.

3. **Add `backfillLegacyFileMigrationFlags()` as a private helper.** This is the bridge that makes the runner safe on existing installs. The three inline migrations already ran with their own markers; we just need to teach the file runner about them.

   ```ts
   private backfillLegacyFileMigrationFlags(): void {
     const legacyMap: Array<{ inlineKey: string; file: string }> = [
       // Inline marker for 003 is implicit: presence of the tool_panels table.
       // We use a schema probe rather than a user_preferences key because
       // 003's inline implementation predates the marker convention.
       { inlineKey: '__schema_probe:tool_panels', file: '003_add_tool_panels.sql' },
       { inlineKey: 'claude_panels_migrated', file: '004_claude_panels.sql' },
       { inlineKey: 'unified_panel_settings_migrated', file: '005_unified_panel_settings.sql' },
     ];

     const selectPref = this.db.prepare(
       "SELECT value FROM user_preferences WHERE key = ?"
     );
     const insertPref = this.db.prepare(
       "INSERT INTO user_preferences (key, value) VALUES (?, 'true')"
     );

     for (const { inlineKey, file } of legacyMap) {
       const flagKey = `file_migration_applied:${file}`;
       if (selectPref.get(flagKey)) continue; // already backfilled

       let alreadyApplied = false;
       if (inlineKey.startsWith('__schema_probe:')) {
         const tableName = inlineKey.slice('__schema_probe:'.length);
         const row = this.db
           .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
           .get(tableName);
         alreadyApplied = !!row;
       } else {
         alreadyApplied = !!selectPref.get(inlineKey);
       }

       if (alreadyApplied) {
         insertPref.run(flagKey);
         console.log(`[Database] Backfilled file_migration_applied for ${file} (inline marker present)`);
       }
     }
   }
   ```

   The schema-probe branch for `003_add_tool_panels.sql` is necessary because Crystal's inline 003 (`database.ts:901`) gates on `SELECT name FROM sqlite_master ... AND name='tool_panels'` and never writes a `user_preferences` marker. The file runner has to use the same probe to detect the already-applied state.

4. **Wire `runFileBasedMigrations()` into `runMigrations()`.** Append the call at the very end of the method body, after the `folder_session_order_fix_applied` block (last line near `database.ts:1292`) and before the method's closing `}`:

   ```ts
       } // end of folder_session_order_fix block

       // Final phase: apply any numeric-prefix .sql migration files that have
       // not yet been recorded as applied. This is the entry point for all
       // cyboflow-era schema additions starting with 006_cyboflow_schema.sql.
       this.runFileBasedMigrations();
     } // end of runMigrations()
   ```

   The placement is load-bearing: file migrations must run *after* the inline 003/004/005 backfill has had a chance to mark them applied. Putting the call earlier risks the runner trying to apply `004_claude_panels.sql` on an upgrade install where the inline 004 has already created the columns — every `ALTER TABLE … ADD COLUMN` would throw "duplicate column" and (because we log-and-continue) the file would be silently skipped without an `applied` marker, causing the same failure on the next boot.

5. **Verify the existing `copy:assets` step still ships the `.sql` files.** Open `main/package.json` and confirm the line:

   ```json
   "copy:assets": "mkdirp dist/main/src/database/migrations && cp src/database/*.sql dist/main/src/database/ && cp src/database/migrations/*.sql dist/main/src/database/migrations/"
   ```

   is unchanged. No edit is required, but the verification gate in AC #6 (`grep -n 'copy:assets' main/package.json`) must pass. Run `pnpm --filter ./main build` and confirm `dist/main/src/database/migrations/003_add_tool_panels.sql` (and 004, 005) exist on disk after the build — this proves `__dirname` resolution works in the packaged layout.

6. **Add unit tests at `main/src/database/__tests__/fileMigrationRunner.test.ts`.** Use Vitest (Crystal's existing test runner) and `better-sqlite3` against an in-memory DB (`new DatabaseService(':memory:')`). Test skeleton:

   ```ts
   import { describe, it, expect, beforeEach, afterEach } from 'vitest';
   import { mkdtempSync, writeFileSync, rmSync } from 'fs';
   import { join } from 'path';
   import { tmpdir } from 'os';
   import { DatabaseService } from '../database';

   describe('runFileBasedMigrations', () => {
     let dbDir: string;
     let dbPath: string;

     beforeEach(() => {
       dbDir = mkdtempSync(join(tmpdir(), 'cyboflow-mig-test-'));
       dbPath = join(dbDir, 'test.db');
     });

     afterEach(() => {
       rmSync(dbDir, { recursive: true, force: true });
     });

     it('applies a fresh .sql file and records it in user_preferences', () => {
       // Arrange a fixture migrations dir (test-only override via env or test seam)
       // … create 999_fixture.sql with `CREATE TABLE fixture_target (id INTEGER PRIMARY KEY);`
       // … call svc.initialize()
       // Assert the table exists and key 'file_migration_applied:999_fixture.sql' is 'true'.
     });

     it('is idempotent on a second run', () => {
       // Run initialize() twice on the same dbPath; assert no errors thrown and
       // exactly one user_preferences row for the file_migration_applied:* key.
     });

     it('rolls back a broken .sql and continues with the next file', () => {
       // Two fixtures: 998_broken.sql (`SELECT * FROM no_such_table;`) and
       // 999_good.sql (`CREATE TABLE ok (id INTEGER);`).
       // After initialize(): table 'ok' exists; 'file_migration_applied:998_broken.sql'
       // is NOT present; 'file_migration_applied:999_good.sql' IS 'true'.
     });

     it('backfills 003/004/005 flags when inline markers are present', () => {
       // Pre-seed: insert tool_panels table directly, plus
       // user_preferences rows for 'claude_panels_migrated' and 'unified_panel_settings_migrated'.
       // Run initialize(); assert all three file_migration_applied:00{3,4,5}_*.sql
       // keys exist with value 'true', and that the underlying SQL was NOT re-applied
       // (no duplicate-column errors, no extra index rows).
     });
   });
   ```

   To make the migrations directory swappable from tests without polluting the production constructor, introduce a **single internal test seam**: change `runFileBasedMigrations` to read `this.migrationsDirOverride ?? join(__dirname, 'migrations')`, where `migrationsDirOverride` is a `private` field set only by a `setMigrationsDirForTesting(path: string)` method (annotated with `/** @internal — testing only */`). This is preferable to making the dir a constructor argument because it preserves the existing public surface.

7. **Manual smoke-test gate before commit.**
   - Run `pnpm dev` against a clean `~/.cyboflow/sessions.db`. Confirm the log shows `[Database] Applied file migration: 003_add_tool_panels.sql` (the very first time only, on a *fresh* DB this is a no-op because 003 lives inline; expect the backfill log instead).
   - Stop the app, re-run `pnpm dev` against the same DB. Confirm there are **zero** `[Database] Applied file migration:` lines (idempotency proof in dev).
   - `sqlite3 ~/.cyboflow/sessions.db "SELECT key FROM user_preferences WHERE key LIKE 'file_migration_applied:%';"` lists at minimum the three legacy filenames after one upgrade boot.

## Acceptance Criteria

The seven frontmatter ACs collapse into five verification gates the executor must hit before closing the task:

1. **Integration gate** — `grep -n 'runFileBasedMigrations' main/src/database/database.ts` shows two hits: the method definition and a single call site, where the call site is the last logical line inside `runMigrations()` (after the `folder_session_order_fix_applied` block, line ~1292). (AC #1.)
2. **Algorithm gate** — Reading the implementation confirms (a) `readdirSync(__dirname/migrations)`, (b) regex `/^(\d{3})_.*\.sql$/` with a numeric prefix capture group, (c) `.sort()` on the parsed `int`, (d) `db.exec()` inside `this.transaction()`. Non-matching files are logged at `console.warn` and skipped. (AC #2.)
3. **Idempotency gate** — `grep -n 'file_migration_applied' main/src/database/database.ts` shows the `SELECT` check, the conditional gating `db.exec`, and the `INSERT` after success. Re-running `runMigrations()` on the same DB produces zero new `[Database] Applied file migration:` log lines. (AC #3.)
4. **Legacy-backfill gate** — `backfillLegacyFileMigrationFlags()` is called at the top of `runFileBasedMigrations()`. On an existing install with `claude_panels_migrated` and `unified_panel_settings_migrated` already set (plus the `tool_panels` table present), the three legacy files are auto-flagged and never re-executed. (AC #4.)
5. **Error-tolerance + build-assets gates** — Each file's `db.exec` is wrapped in `try { this.transaction(() => ...) } catch (err) { console.error(name, err); }`, the app boots even if a file fails, and `grep -n 'copy:assets' main/package.json` still shows the unchanged `cp src/database/migrations/*.sql dist/main/src/database/migrations/` clause. (ACs #5 and #6.)
6. **Test gate** — `pnpm --filter ./main vitest --run src/database/__tests__/fileMigrationRunner.test.ts` exits 0 with the four test cases from `test_strategy.targets` all passing. (AC #7.)

## Test Strategy

Four unit tests in `main/src/database/__tests__/fileMigrationRunner.test.ts`, all running against an on-disk SQLite file under `os.tmpdir()` (a real file is required because `better-sqlite3` `:memory:` does not survive the `setMigrationsDirForTesting` round-trip the same way and we want to keep the test as close to production as possible). Each test creates its own fixture `migrationsDir` so they cannot pollute each other.

1. **Fresh-DB application.** Seed an empty DB, write `999_fixture.sql` with `CREATE TABLE fixture_target (id INTEGER PRIMARY KEY);` into the fixture dir, call `svc.initialize()`. Assert `sqlite_master` lists `fixture_target` and `user_preferences` has `file_migration_applied:999_fixture.sql = 'true'`.
2. **Idempotency.** Same setup as (1), then construct a *second* `DatabaseService` against the same `dbPath` and call `initialize()` again. Assert (a) no exception, (b) the `user_preferences` count for keys matching `file_migration_applied:%` is unchanged.
3. **Broken-file tolerance.** Two fixtures: `998_broken.sql` containing `SELECT * FROM no_such_table_xxx;` (will throw at exec time) and `999_good.sql` containing `CREATE TABLE ok_table (id INTEGER);`. After `initialize()`, assert `ok_table` exists (the later file still ran), the `998` flag is NOT in `user_preferences` (rolled back), and `console.error` was called with a string containing `998_broken.sql` (capture via `vi.spyOn(console, 'error')`).
4. **Legacy backfill.** Pre-seed the DB by hand: `CREATE TABLE tool_panels (id TEXT PRIMARY KEY);` + INSERT rows into `user_preferences` for `claude_panels_migrated` and `unified_panel_settings_migrated`. Provide a fixture dir containing only the real `003`/`004`/`005` filenames (zero-byte placeholders are fine — the runner must never read them). After `initialize()`, assert all three `file_migration_applied:00{3,4,5}_*.sql` keys are `'true'` and no SQL from the placeholder files ran.

Run with `pnpm --filter ./main vitest --run src/database/__tests__/fileMigrationRunner.test.ts`. Exit code 0 with 4 passing tests is the gate.

## Hardest Decision

**How to detect that the legacy inline migrations 003/004/005 have already run, so the file runner does not double-apply them on upgrade installs.** This is the central correctness risk of the task. The naive approach — "just run every file whose `file_migration_applied:*` key is missing" — bricks every existing user, because 004's `ALTER TABLE session_outputs ADD COLUMN panel_id TEXT` throws `duplicate column name` on the second apply, and (per the task's log-and-continue contract) we would then loop forever flagging the file unapplied. The chosen solution is `backfillLegacyFileMigrationFlags()`: a one-time bridge that reads the inline-era markers (`claude_panels_migrated`, `unified_panel_settings_migrated`) and the schema-probe for 003 (because 003's inline implementation never wrote a `user_preferences` marker, only created the `tool_panels` table), then writes the corresponding `file_migration_applied:*` rows *before* the directory scan. The alternative — making each file idempotent at the SQL level via `ADD COLUMN IF NOT EXISTS` — fails because SQLite does not support that clause for `ALTER TABLE`, which is exactly why the inline runner uses `PRAGMA table_info` probes today.

## Rejected Alternatives

- **Use a dedicated `schema_migrations` table** (Rails-style). Rejected because `user_preferences` already carries the precedent for every existing inline migration marker (`auto_commit_migrated`, `claude_panels_migrated`, `unified_panel_settings_migrated`, `folder_session_order_fix_applied`) — adopting a second tracking table would fork the convention and create a chicken-and-egg bootstrap (the runner that creates `schema_migrations` would itself need a marker). The `file_migration_applied:<filename>` namespace keeps everything in one place.
- **Sort entries lexicographically instead of by parsed numeric prefix.** Rejected because `010_foo.sql` would sort before `9_foo.sql` (and even more pathologically, a stray non-prefixed file like `notes.sql` would sort between `006` and `100`). Parsing the prefix as `int` and sorting numerically is the only ordering that matches the epic's invariants. The regex filter ensures only files that *have* a numeric prefix are even considered.
- **Apply all files in a single outer transaction** (one BEGIN, one COMMIT for the whole batch). Rejected because a single broken file would roll back every other file's work, including legitimately-applied ones earlier in the same boot. Per-file transactions match Crystal's existing migration-tolerance pattern (look at the inline `claude_panels_migrated` block's try/catch — Crystal already lets one migration fail without bricking the others). One-transaction-per-file is the right granularity.
- **Use a constructor argument for `migrationsDir`** instead of a `setMigrationsDirForTesting` seam. Rejected because every call site (`new DatabaseService(dbPath)` in `main/src/index.ts` and elsewhere) would need updating, and the production code has no reason to ever vary the dir — `__dirname/migrations` is correct in dev (tsx) and in packaged builds (electron-builder + `copy:assets`). The internal-only seam keeps the public surface stable.

## Lowest Confidence Area

**`__dirname` resolution under Electron's asar packaging when reading `migrations/*.sql` at boot.** The `initializeSchema()` precedent (`database.ts:100`) reads `schema.sql` from `join(__dirname, 'schema.sql')` and works in production today, which is strong evidence that `join(__dirname, 'migrations')` will also resolve correctly — `copy:assets` puts both `schema.sql` and the `migrations/` subdir into `dist/main/src/database/`. But there are three failure modes to verify before sign-off:

1. **asar-packaged read.** Run `pnpm build:mac:arm64` (or the platform equivalent), unpack the resulting `.app`, and confirm `app.asar` contains `main/src/database/migrations/006_*.sql` at the expected path. If `electron-builder` excludes `*.sql` from the asar (unlikely given `schema.sql` already works), we need to add a `files` glob to the build config.
2. **`readdirSync` on asar.** Electron's asar shim *does* support `readdirSync` on asar paths, but it returns entries without trailing slashes and is read-only. Verify with a smoke test on the packaged build: log `readdirSync(join(__dirname, 'migrations'))` at first boot and confirm all numbered files appear.
3. **Dev-mode source-root drift.** In `pnpm dev`, `__dirname` resolves to `main/src/database/` (tsx) rather than `dist/...`. The `migrations/` subdir exists there too (it's the source of truth that `copy:assets` reads from), so both should work — but if a future tsconfig change moves the compiled output, this assumption breaks silently.

If any of these three smoke checks fails, **ESCALATE** rather than working around with a hard-coded path: a graceful `try/catch` around `readdirSync` already exists in the skeleton, but it would mask a legitimate packaging regression that would prevent every future cyboflow migration from running. The verification path is the manual `pnpm build:mac:arm64 && ./dist-electron/mac-arm64/cyboflow.app/Contents/MacOS/cyboflow` boot, watching the dev tools console for the expected `[Database] Applied file migration:` lines (or the absence thereof on a repeat boot).
   