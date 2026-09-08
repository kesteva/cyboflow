import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmDbTestDir, sweepLeakedDbTestDirs } from './cleanupDbTestDir';
import { DatabaseService, MigrationFailedError } from '../database';

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
    sweepLeakedDbTestDirs(tmpdir());
    rmDbTestDir(dbDir);
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

  it('fails closed on a broken .sql: rolls back, stamps nothing, and aborts the chain', () => {
    // Broken migration references a table that does not exist
    writeFileSync(
      join(migrationsDir, '998_broken.sql'),
      'SELECT * FROM no_such_table_xxx;'
    );
    // Good migration after the broken one — must NOT run: the runner stops at
    // the first real failure rather than booting on a half-migrated schema.
    writeFileSync(
      join(migrationsDir, '999_good.sql'),
      'CREATE TABLE ok_table (id INTEGER);'
    );

    const errorSpy = vi.spyOn(console, 'error');

    const svc = new DatabaseService(dbPath);
    svc.setMigrationsDirForTesting(migrationsDir);

    // The error propagates out of initialize() — this is the boot-abort path
    // that main/src/index.ts turns into the blocking "could not update its
    // database" dialog.
    let thrown: unknown;
    try {
      svc.initialize();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MigrationFailedError);
    expect((thrown as MigrationFailedError).migration).toBe('998_broken.sql');
    expect((thrown as Error).message).toMatch(/998_broken\.sql/);

    const Database = require('better-sqlite3');
    const db = new Database(dbPath);

    // The later file never ran.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ok_table'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(0);

    // Neither file is stamped: 998 rolled back, 999 was never attempted.
    const brokenRow = db
      .prepare("SELECT value FROM user_preferences WHERE key = 'file_migration_applied:998_broken.sql'")
      .get() as { value: string } | undefined;
    expect(brokenRow).toBeUndefined();

    const goodRow = db
      .prepare("SELECT value FROM user_preferences WHERE key = 'file_migration_applied:999_good.sql'")
      .get() as { value: string } | undefined;
    expect(goodRow).toBeUndefined();

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

  it('fails closed on a syntax error: nothing is stamped and the error names the file', () => {
    writeFileSync(join(migrationsDir, '997_syntax.sql'), 'CREATE TABLE ( bogus;');

    const errorSpy = vi.spyOn(console, 'error');
    const svc = new DatabaseService(dbPath);
    svc.setMigrationsDirForTesting(migrationsDir);
    expect(() => svc.initialize()).toThrow(/997_syntax\.sql/);

    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    const row = db
      .prepare("SELECT value FROM user_preferences WHERE key = 'file_migration_applied:997_syntax.sql'")
      .get() as { value: string } | undefined;
    expect(row).toBeUndefined();
    db.close();
    errorSpy.mockRestore();
  });

  it('duplicate-column mid-file: the surrounding statements still apply and the file stamps once', () => {
    // THE regression this suite exists for. The runner used to exec the whole
    // file as one blob and, on "duplicate column name", stamp the ledger from a
    // catch — but the throw had already rolled the transaction back, so
    // statements 1 and 3 were silently discarded FOREVER while the ledger
    // claimed the migration had applied.
    writeFileSync(
      join(migrationsDir, '001_base.sql'),
      `CREATE TABLE multi (id INTEGER PRIMARY KEY);
       ALTER TABLE multi ADD COLUMN collide TEXT;`
    );
    writeFileSync(
      join(migrationsDir, '002_multi.sql'),
      `-- header comment with a semicolon; and prose
       ALTER TABLE multi ADD COLUMN before_col TEXT;
       ALTER TABLE multi ADD COLUMN collide TEXT;
       ALTER TABLE multi ADD COLUMN after_col TEXT;
       INSERT INTO multi (id, after_col) VALUES (1, 'ran');`
    );

    const svc1 = new DatabaseService(dbPath);
    svc1.setMigrationsDirForTesting(migrationsDir);
    // 001 creates `collide`; 002 then hits it on its middle ALTER.
    expect(() => svc1.initialize()).not.toThrow();

    const Database = require('better-sqlite3');
    const db = new Database(dbPath);

    const cols = (db.prepare('PRAGMA table_info(multi)').all() as { name: string }[]).map(
      (c) => c.name
    );
    expect(cols).toContain('before_col'); // statement BEFORE the collision
    expect(cols).toContain('after_col'); // statement AFTER the collision
    expect(cols).toContain('collide');

    // The trailing INSERT ran too — the whole file completed.
    const rows = db.prepare('SELECT after_col FROM multi').all() as { after_col: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].after_col).toBe('ran');

    // Stamped exactly once.
    const stamps = db
      .prepare("SELECT key FROM user_preferences WHERE key = 'file_migration_applied:002_multi.sql'")
      .all() as { key: string }[];
    expect(stamps).toHaveLength(1);

    db.close();
  });

  it('renamed (renumbered) migration re-applies harmlessly end-to-end', () => {
    // The ledger tracks by FILENAME, so renumbering a migration makes it
    // re-apply against a DB where its statements already ran (113-118 were
    // renumbered twice in Aug 2026). Every statement must be a no-op or skipped,
    // and the new filename must end up stamped.
    const body = `ALTER TABLE renamed_target ADD COLUMN alpha TEXT;
      ALTER TABLE renamed_target ADD COLUMN beta TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_renamed_alpha ON renamed_target(alpha);
      UPDATE renamed_target SET beta = 'backfilled' WHERE beta IS NULL;`;

    writeFileSync(
      join(migrationsDir, '900_seed.sql'),
      "CREATE TABLE renamed_target (id INTEGER PRIMARY KEY);"
    );
    writeFileSync(join(migrationsDir, '901_feature.sql'), body);

    const svc1 = new DatabaseService(dbPath);
    svc1.setMigrationsDirForTesting(migrationsDir);
    svc1.initialize();

    // Seed a row so the backfill UPDATE has work to do on the re-run too.
    const Database = require('better-sqlite3');
    const seedDb = new Database(dbPath);
    seedDb.prepare("INSERT INTO renamed_target (id, alpha) VALUES (1, 'a')").run();
    seedDb.close();

    // Renumber: same content, new filename → unknown to the ledger → re-applies.
    rmSync(join(migrationsDir, '901_feature.sql'));
    writeFileSync(join(migrationsDir, '903_feature.sql'), body);

    const svc2 = new DatabaseService(dbPath);
    svc2.setMigrationsDirForTesting(migrationsDir);
    expect(() => svc2.initialize()).not.toThrow();

    const db = new Database(dbPath);

    // The new filename is stamped, and the old one's stamp is untouched.
    const newStamp = db
      .prepare("SELECT value FROM user_preferences WHERE key = 'file_migration_applied:903_feature.sql'")
      .get() as { value: string } | undefined;
    expect(newStamp?.value).toBe('true');

    // The whole file ran on the re-application: the backfill UPDATE (which sits
    // AFTER both colliding ALTERs) took effect. Under the old file-level
    // stamp-on-error path this row would still be NULL.
    const row = db.prepare('SELECT beta FROM renamed_target WHERE id = 1').get() as {
      beta: string | null;
    };
    expect(row.beta).toBe('backfilled');

    db.close();
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

  it('FK-toggle path: child rows survive a PRAGMA foreign_keys=OFF table-recreation migration run through DatabaseService', () => {
    // This test exercises the exact needsFkOff branch in runFileBasedMigrations()
    // (database.ts lines 1597-1624): when a migration SQL contains the literal
    // "PRAGMA foreign_keys=OFF", the runner must toggle the pragma OUTSIDE the
    // this.transaction() wrapper so the DROP TABLE does not CASCADE-delete child rows.
    //
    // The fixture uses a minimal self-contained schema so this test does not depend
    // on real migration files (006/007/010). It proves the DatabaseService code path —
    // complementing migration010.test.ts test 7 which tests the same SQLite semantics
    // via a local helper that mirrors (but does not call) the production runner.

    // Migration A: create a parent table and a child table with FK ON DELETE CASCADE.
    const migrationA = `
CREATE TABLE fk_parent (
  id TEXT PRIMARY KEY
);
CREATE TABLE fk_child (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES fk_parent(id) ON DELETE CASCADE
);
`;

    // Migration B: rebuild fk_parent via the table-recreation recipe with FK off.
    // The rebuilt table is identical — the point is that the DROP + RENAME must NOT
    // cascade-delete the child rows. This mirrors the migration 010 recipe exactly.
    const migrationB = `
PRAGMA foreign_keys=OFF;
CREATE TABLE fk_parent_new (
  id TEXT PRIMARY KEY,
  extra TEXT
);
INSERT INTO fk_parent_new (id) SELECT id FROM fk_parent;
DROP TABLE fk_parent;
ALTER TABLE fk_parent_new RENAME TO fk_parent;
PRAGMA foreign_keys=ON;
`;

    writeFileSync(join(migrationsDir, '001_fk_setup.sql'), migrationA);
    writeFileSync(join(migrationsDir, '002_fk_rebuild.sql'), migrationB);

    const svc = new DatabaseService(dbPath);
    svc.setMigrationsDirForTesting(migrationsDir);
    svc.initialize();

    // Seed rows: must be done after initialize() since the runner creates the tables.
    // Open the raw DB directly to insert parent + child rows.
    const BetterSqlite = require('better-sqlite3');
    const rawDb = new BetterSqlite(dbPath);
    rawDb.pragma('foreign_keys = ON');
    rawDb.prepare("INSERT INTO fk_parent (id) VALUES ('p-1')").run();
    rawDb.prepare("INSERT INTO fk_child (id, parent_id) VALUES ('c-1', 'p-1')").run();
    rawDb.close();

    // Now initialize again — the second initialize is a no-op for 001 and 002
    // (already marked applied). This confirms idempotency doesn't break the test,
    // but the real assertion is about the DATA surviving the first migration run.
    //
    // Instead, simulate re-running migration B's SQL directly via a third migration
    // that uses the same pragma pattern against the already-seeded data.
    const migrationC = `
PRAGMA foreign_keys=OFF;
CREATE TABLE fk_parent_v2 (
  id TEXT PRIMARY KEY,
  extra TEXT,
  v2_col TEXT
);
INSERT INTO fk_parent_v2 (id) SELECT id FROM fk_parent;
DROP TABLE fk_parent;
ALTER TABLE fk_parent_v2 RENAME TO fk_parent;
PRAGMA foreign_keys=ON;
`;
    writeFileSync(join(migrationsDir, '003_fk_rebuild_v2.sql'), migrationC);

    const svc2 = new DatabaseService(dbPath);
    svc2.setMigrationsDirForTesting(migrationsDir);
    svc2.initialize();

    // Child rows MUST survive the DROP TABLE fk_parent in migration C.
    const db = new BetterSqlite(dbPath);
    const childCount = (db.prepare('SELECT COUNT(*) AS n FROM fk_child').get() as { n: number }).n;
    expect(childCount).toBe(1);

    // The child row's parent_id still correctly references the rebuilt parent.
    const parentCount = (db.prepare("SELECT COUNT(*) AS n FROM fk_parent WHERE id = 'p-1'").get() as { n: number }).n;
    expect(parentCount).toBe(1);

    // Both migrations C's ledger marker is recorded.
    const markerC = db
      .prepare("SELECT value FROM user_preferences WHERE key = 'file_migration_applied:003_fk_rebuild_v2.sql'")
      .get() as { value: string } | undefined;
    expect(markerC?.value).toBe('true');

    db.close();
  });
});
