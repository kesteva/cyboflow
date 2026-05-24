/**
 * Integration test for migration 009_sessions_run_id.sql.
 *
 * Uses the REAL DatabaseService with the REAL migrations directory (no
 * setMigrationsDirForTesting override). Two test cases:
 *   1. Shape — after initialize(), PRAGMA table_info('sessions') reports
 *      run_id with type='TEXT', notnull=0, dflt_value=null, pk=0.
 *   2. Idempotency — a second initialize() against the same DB does not
 *      throw and records exactly one file_migration_applied:009_sessions_run_id.sql row.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DatabaseService } from '../database';

// better-sqlite3 PRAGMA table_info row shape
interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

describe('migration 009 — sessions.run_id column', () => {
  let dbDir: string;
  let dbPath: string;

  beforeEach(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'cyboflow-009-test-'));
    dbPath = join(dbDir, 'test.db');
  });

  afterEach(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('adds a nullable TEXT run_id column to sessions after initialize()', () => {
    // Use the real DatabaseService with the real migrations directory
    const svc = new DatabaseService(dbPath);
    svc.initialize();

    // Open the raw DB to inspect schema
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);

    // Assert column shape
    const cols = db.prepare("PRAGMA table_info('sessions')").all() as TableInfoRow[];
    const runIdCol = cols.find((c) => c.name === 'run_id');

    expect(runIdCol).toBeDefined();
    expect(runIdCol?.type).toBe('TEXT');
    expect(runIdCol?.notnull).toBe(0);
    expect(runIdCol?.dflt_value).toBeNull();
    expect(runIdCol?.pk).toBe(0);

    // Assert applied marker is recorded
    const row = db
      .prepare("SELECT value FROM user_preferences WHERE key = 'file_migration_applied:009_sessions_run_id.sql'")
      .get() as { value: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.value).toBe('true');

    db.close();
  });

  it('is idempotent — second initialize() does not throw and records exactly one marker', () => {
    // First initialization
    const svc1 = new DatabaseService(dbPath);
    svc1.initialize();

    // Second initialization against the same DB
    const svc2 = new DatabaseService(dbPath);
    expect(() => svc2.initialize()).not.toThrow();

    // Assert exactly one 009 applied marker row
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);

    const rows = db
      .prepare("SELECT key FROM user_preferences WHERE key LIKE 'file_migration_applied:009_%'")
      .all() as { key: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('file_migration_applied:009_sessions_run_id.sql');

    db.close();
  });
});
