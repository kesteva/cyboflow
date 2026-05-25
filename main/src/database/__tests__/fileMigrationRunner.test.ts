import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DatabaseService } from '../database';

describe('runFileBasedMigrations', () => {
  let dbDir: string;
  let dbPath: string;
  let migrationsDir: string;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'cyboflow-mig-test-'));
    dbPath = join(dbDir, 'test.db');
    migrationsDir = join(dbDir, 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('applies a fresh .sql file and records it in user_preferences', () => {
    // Arrange: write a fixture migration
    writeFileSync(
      join(migrationsDir, '999_fixture.sql'),
      'CREATE TABLE fixture_target (id INTEGER PRIMARY KEY);'
    );

    const svc = new DatabaseService(dbPath);
    svc.setMigrationsDirForTesting(migrationsDir);
    svc.initialize();

    // Assert: table was created
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fixture_target'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);

    // Assert: applied flag recorded
    const row = db
      .prepare("SELECT value FROM user_preferences WHERE key = 'file_migration_applied:999_fixture.sql'")
      .get() as { value: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.value).toBe('true');

    db.close();
  });

  it('is idempotent on a second run', () => {
    writeFileSync(
      join(migrationsDir, '999_fixture.sql'),
      'CREATE TABLE fixture_target2 (id INTEGER PRIMARY KEY);'
    );

    const svc1 = new DatabaseService(dbPath);
    svc1.setMigrationsDirForTesting(migrationsDir);
    svc1.initialize();

    // Second initialize on same DB
    const svc2 = new DatabaseService(dbPath);
    svc2.setMigrationsDirForTesting(migrationsDir);
    // Should not throw
    expect(() => svc2.initialize()).not.toThrow();

    // Assert: exactly one applied row for this file (no duplicates)
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    const rows = db
      .prepare(
        "SELECT key FROM user_preferences WHERE key LIKE 'file_migration_applied:999_%'"
      )
      .all() as { key: string }[];
    expect(rows).toHaveLength(1);

    db.close();
  });

  it('rolls back a broken .sql and continues with the next file', () => {
    // Broken migration references a table that does not exist
    writeFileSync(
      join(migrationsDir, '998_broken.sql'),
      'SELECT * FROM no_such_table_xxx;'
    );
    // Good migration after the broken one
    writeFileSync(
      join(migrationsDir, '999_good.sql'),
      'CREATE TABLE ok_table (id INTEGER);'
    );

    const errorSpy = vi.spyOn(console, 'error');

    const svc = new DatabaseService(dbPath);
    svc.setMigrationsDirForTesting(migrationsDir);
    svc.initialize();

    const Database = require('better-sqlite3');
    const db = new Database(dbPath);

    // ok_table was created (later file still ran)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ok_table'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);

    // 998 flag is NOT in user_preferences (rolled back)
    const brokenRow = db
      .prepare("SELECT value FROM user_preferences WHERE key = 'file_migration_applied:998_broken.sql'")
      .get() as { value: string } | undefined;
    expect(brokenRow).toBeUndefined();

    // 999 flag IS recorded
    const goodRow = db
      .prepare("SELECT value FROM user_preferences WHERE key = 'file_migration_applied:999_good.sql'")
      .get() as { value: string } | undefined;
    expect(goodRow?.value).toBe('true');

    // console.error was called with something mentioning the broken file
    const errorCalls = errorSpy.mock.calls;
    const mentionsBroken = errorCalls.some(
      (args) =>
        args.some(
          (arg) =>
            typeof arg === 'string' && arg.includes('998_broken.sql')
        )
    );
    expect(mentionsBroken).toBe(true);

    db.close();
    errorSpy.mockRestore();
  });

  it('backfills 003/004/005 flags when inline markers are present', () => {
    // Pre-seed the DB manually: create tool_panels table (003 marker),
    // and insert user_preferences rows for 004 and 005 inline markers.
    // We use the actual DatabaseService to get a fully-initialized schema,
    // then open the raw DB to insert the pre-existing markers.

    // First, create a fixture migrations dir with placeholder filenames only
    // (zero-byte so the runner cannot actually execute them)
    writeFileSync(join(migrationsDir, '003_add_tool_panels.sql'), '');
    writeFileSync(join(migrationsDir, '004_claude_panels.sql'), '');
    writeFileSync(join(migrationsDir, '005_unified_panel_settings.sql'), '');

    // Initialize DB so all inline migrations run (which will create tool_panels etc.)
    // Point the runner at our temp dir so zero-byte placeholders are used
    const svc = new DatabaseService(dbPath);
    svc.setMigrationsDirForTesting(migrationsDir);
    svc.initialize();

    const Database = require('better-sqlite3');
    const db = new Database(dbPath);

    // All three file_migration_applied flags should be set (backfilled because
    // the inline migrations ran during initialize() and left their markers)
    const flag003 = db
      .prepare("SELECT value FROM user_preferences WHERE key = 'file_migration_applied:003_add_tool_panels.sql'")
      .get() as { value: string } | undefined;
    const flag004 = db
      .prepare("SELECT value FROM user_preferences WHERE key = 'file_migration_applied:004_claude_panels.sql'")
      .get() as { value: string } | undefined;
    const flag005 = db
      .prepare("SELECT value FROM user_preferences WHERE key = 'file_migration_applied:005_unified_panel_settings.sql'")
      .get() as { value: string } | undefined;

    expect(flag003?.value).toBe('true');
    expect(flag004?.value).toBe('true');
    expect(flag005?.value).toBe('true');

    // Sanity: zero-byte files didn't cause SQL errors (no entries in sqlite_master
    // from the placeholder files — we just check that the table structure is intact)
    const toolPanels = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_panels'")
      .all() as { name: string }[];
    expect(toolPanels).toHaveLength(1);

    db.close();
  });

  it('skips non-numeric-prefix files and logs a warning for each', () => {
    // A file without the NNN_ prefix pattern must never be exec'd, and
    // console.warn must be called with the filename so the operator can see it.
    writeFileSync(join(migrationsDir, 'README.md'), 'just docs');
    writeFileSync(join(migrationsDir, 'notes.sql'), 'SELECT 1;');
    writeFileSync(
      join(migrationsDir, '999_valid.sql'),
      'CREATE TABLE valid_only (id INTEGER PRIMARY KEY);'
    );

    const warnSpy = vi.spyOn(console, 'warn');

    const svc = new DatabaseService(dbPath);
    svc.setMigrationsDirForTesting(migrationsDir);
    svc.initialize();

    const Database = require('better-sqlite3');
    const db = new Database(dbPath);

    // The valid file ran; the non-prefixed files did not create stray tables
    const valid = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='valid_only'")
      .all() as { name: string }[];
    expect(valid).toHaveLength(1);

    // No applied flag for the non-numeric files
    const notesRow = db
      .prepare("SELECT value FROM user_preferences WHERE key LIKE 'file_migration_applied:notes%'")
      .get() as { value: string } | undefined;
    expect(notesRow).toBeUndefined();

    // console.warn was called at least once mentioning one of the skipped filenames
    const warnCalls = warnSpy.mock.calls;
    const mentionsSkipped = warnCalls.some((args) =>
      args.some(
        (arg) => typeof arg === 'string' && (arg.includes('notes.sql') || arg.includes('README.md'))
      )
    );
    expect(mentionsSkipped).toBe(true);

    db.close();
    warnSpy.mockRestore();
  });

  it('treats duplicate-column-name as idempotent: records marker and warns instead of errors', () => {
    // Scenario: ledger marker is absent but the column already exists (e.g. a
    // previous run applied the migration then the marker was erased).  The runner
    // must record the marker and log at console.warn — NOT console.error.
    //
    // Setup:
    //   001_create_base.sql  — creates a table with one column
    //   002_add_col.sql      — ALTER TABLE ... ADD COLUMN (the column we'll collide on)

    writeFileSync(
      join(migrationsDir, '001_create_base.sql'),
      'CREATE TABLE dup_col_target (id INTEGER PRIMARY KEY);'
    );
    writeFileSync(
      join(migrationsDir, '002_add_col.sql'),
      'ALTER TABLE dup_col_target ADD COLUMN label TEXT;'
    );

    // First initialize: both migrations apply cleanly.
    const svc1 = new DatabaseService(dbPath);
    svc1.setMigrationsDirForTesting(migrationsDir);
    svc1.initialize();

    // Erase only the 002 ledger marker so the runner will try to re-apply it.
    const BetterSqlite = require('better-sqlite3');
    const rawDb = new BetterSqlite(dbPath);
    rawDb
      .prepare("DELETE FROM user_preferences WHERE key = 'file_migration_applied:002_add_col.sql'")
      .run();
    rawDb.close();

    // Second initialize: 001 is still marked (skipped); 002 marker is gone so
    // the runner attempts the ALTER — SQLite throws "duplicate column name: label".
    // The runner must catch it, record the marker, and warn (not error).
    const warnSpy = vi.spyOn(console, 'warn');
    const errorSpy = vi.spyOn(console, 'error');

    const svc2 = new DatabaseService(dbPath);
    svc2.setMigrationsDirForTesting(migrationsDir);
    expect(() => svc2.initialize()).not.toThrow();

    // Marker must be re-recorded after the duplicate-column path.
    const db = new BetterSqlite(dbPath);
    const row = db
      .prepare("SELECT value FROM user_preferences WHERE key = 'file_migration_applied:002_add_col.sql'")
      .get() as { value: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.value).toBe('true');

    // console.warn must have been called mentioning the file or "duplicate column".
    const warnMentions = warnSpy.mock.calls.some((args) =>
      args.some(
        (arg) =>
          typeof arg === 'string' &&
          (arg.includes('002_add_col.sql') || arg.toLowerCase().includes('duplicate column'))
      )
    );
    expect(warnMentions).toBe(true);

    // console.error must NOT have been called for the duplicate-column case.
    const errorMentions = errorSpy.mock.calls.some((args) =>
      args.some(
        (arg) => typeof arg === 'string' && arg.includes('002_add_col.sql')
      )
    );
    expect(errorMentions).toBe(false);

    db.close();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('applies files in numeric prefix order, not lexicographic order', () => {
    // If sorted lexicographically, '010' < '009' is false but '010' < '9' IS false —
    // more critically '010'.localeCompare('9') < 0 in some locales. The runner must
    // use numeric (integer) sort so 9 < 10 < 11.
    // We use a dependency chain: 011 reads from a table created by 009.
    // If 011 ran first (wrong order) it would fail; if 009 ran first (correct) both succeed.
    writeFileSync(
      join(migrationsDir, '011_child.sql'),
      // Inserts into the table that 009_parent.sql creates
      "INSERT INTO ordering_parent (label) VALUES ('from_011');"
    );
    writeFileSync(
      join(migrationsDir, '009_parent.sql'),
      'CREATE TABLE ordering_parent (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT);'
    );

    const svc = new DatabaseService(dbPath);
    svc.setMigrationsDirForTesting(migrationsDir);
    // Should not throw — 009 runs before 011
    expect(() => svc.initialize()).not.toThrow();

    const Database = require('better-sqlite3');
    const db = new Database(dbPath);

    // The INSERT from 011 succeeded (table existed when 011 ran)
    const rows = db
      .prepare("SELECT label FROM ordering_parent")
      .all() as { label: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('from_011');

    // Both files are recorded as applied
    const parent = db
      .prepare("SELECT value FROM user_preferences WHERE key = 'file_migration_applied:009_parent.sql'")
      .get() as { value: string } | undefined;
    const child = db
      .prepare("SELECT value FROM user_preferences WHERE key = 'file_migration_applied:011_child.sql'")
      .get() as { value: string } | undefined;
    expect(parent?.value).toBe('true');
    expect(child?.value).toBe('true');

    db.close();
  });
});
