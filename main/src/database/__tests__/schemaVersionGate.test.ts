import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmDbTestDir, sweepLeakedDbTestDirs } from './cleanupDbTestDir';
import { DatabaseService } from '../database';

/**
 * The schema-version gate lets an OLDER build detect that a NEWER build advanced
 * the shared ~/.cyboflow database (both packaged variants share it). initialize()
 * stamps PRAGMA user_version with the highest migration this binary ships, and
 * reports `tooNew` when the on-disk value exceeds it. See docs/UPDATES.md.
 */
describe('schema-version gate', () => {
  let dbDir: string;
  let dbPath: string;

  const writeMigration = (dir: string, name: string) =>
    writeFileSync(join(dir, name), 'CREATE TABLE IF NOT EXISTS gate_fixture (id INTEGER PRIMARY KEY);');

  const readUserVersion = (path: string): number => {
    const Database = require('better-sqlite3');
    const db = new Database(path);
    const v = db.pragma('user_version', { simple: true }) as number;
    db.close();
    return v;
  };

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'cyboflow-gate-test-'));
    dbPath = join(dbDir, 'test.db');
  });

  afterEach(() => {
    sweepLeakedDbTestDirs(tmpdir());
    rmDbTestDir(dbDir);
  });

  it('stamps user_version to the highest migration prefix and reports not-too-new on a fresh DB', () => {
    const migrationsDir = join(dbDir, 'm');
    mkdirSync(migrationsDir, { recursive: true });
    writeMigration(migrationsDir, '001_a.sql');
    writeMigration(migrationsDir, '005_b.sql');

    const svc = new DatabaseService(dbPath);
    svc.setMigrationsDirForTesting(migrationsDir);
    svc.initialize();

    expect(svc.getSchemaVersionStatus()).toEqual({ onDisk: 0, appMax: 5, tooNew: false });
    expect(readUserVersion(dbPath)).toBe(5);
  });

  it('detects tooNew when an older binary opens a DB a newer build advanced', () => {
    // Newer build: ships migrations up to 050 → stamps user_version = 50.
    const newerDir = join(dbDir, 'newer');
    mkdirSync(newerDir, { recursive: true });
    writeMigration(newerDir, '050_future.sql');
    const newer = new DatabaseService(dbPath);
    newer.setMigrationsDirForTesting(newerDir);
    newer.initialize();
    expect(readUserVersion(dbPath)).toBe(50);

    // Older binary: only knows up to 005, opens the same DB.
    const olderDir = join(dbDir, 'older');
    mkdirSync(olderDir, { recursive: true });
    writeMigration(olderDir, '001_a.sql');
    writeMigration(olderDir, '005_b.sql');
    const older = new DatabaseService(dbPath);
    older.setMigrationsDirForTesting(olderDir);
    older.initialize();

    expect(older.getSchemaVersionStatus()).toEqual({ onDisk: 50, appMax: 5, tooNew: true });
    // The older binary must NOT lower the newer build's stamp.
    expect(readUserVersion(dbPath)).toBe(50);
  });

  it('readSchemaVersionStatus reports tooNew without mutating the newer DB (pre-gate read)', () => {
    // Newer build stamps user_version = 50.
    const newerDir = join(dbDir, 'newer');
    mkdirSync(newerDir, { recursive: true });
    writeMigration(newerDir, '050_future.sql');
    const newer = new DatabaseService(dbPath);
    newer.setMigrationsDirForTesting(newerDir);
    newer.initialize();
    newer.getDb().close();

    // Older binary reads the verdict BEFORE initialize() — the boot sequence
    // shows the too-new dialog on this value, and on Quit initialize() never
    // runs. Nothing may have been written: no baseline DDL, no ledger-missing
    // migration, no stamp change.
    const olderDir = join(dbDir, 'older');
    mkdirSync(olderDir, { recursive: true });
    writeFileSync(
      join(olderDir, '005_old.sql'),
      'CREATE TABLE IF NOT EXISTS gate_older_marker (id INTEGER PRIMARY KEY);'
    );
    const older = new DatabaseService(dbPath);
    older.setMigrationsDirForTesting(olderDir);

    expect(older.readSchemaVersionStatus()).toEqual({ onDisk: 50, appMax: 5, tooNew: true });
    // Idempotent: initialize() (the "Open Anyway" path) reuses the cached
    // pre-migration verdict rather than recomputing it.
    expect(older.getSchemaVersionStatus()).toEqual({ onDisk: 50, appMax: 5, tooNew: true });

    const marker = older
      .getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gate_older_marker'")
      .all();
    expect(marker).toEqual([]);
    expect(older.getDb().pragma('user_version', { simple: true })).toBe(50);
    older.getDb().close();
  });

  it('reports not-too-new when reopening with the same migration set', () => {
    const migrationsDir = join(dbDir, 'm');
    mkdirSync(migrationsDir, { recursive: true });
    writeMigration(migrationsDir, '010_x.sql');

    const first = new DatabaseService(dbPath);
    first.setMigrationsDirForTesting(migrationsDir);
    first.initialize();

    const second = new DatabaseService(dbPath);
    second.setMigrationsDirForTesting(migrationsDir);
    second.initialize();

    expect(second.getSchemaVersionStatus()).toEqual({ onDisk: 10, appMax: 10, tooNew: false });
  });
});
