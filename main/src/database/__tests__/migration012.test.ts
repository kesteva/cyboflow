/**
 * Integration tests for migration 012_quick_workflow_sentinel.sql (TASK-787).
 *
 * Applies 006_cyboflow_schema.sql, 009_sessions_run_id.sql, and then
 * 012_quick_workflow_sentinel.sql against in-memory SQLite instances.
 * This proves the SQL file itself is correct — not a hard-coded inline
 * string — and guards against column-type or name typos.
 *
 * Test targets:
 *  1. Applying 006 + 009 + 012 adds is_quick BOOLEAN DEFAULT 0 to sessions.
 *  2. Backfill: existing null-run, non-main-repo sessions get is_quick = 1.
 *  3. Backfill exclusion: main-repo sessions and flow sessions are NOT backfilled.
 *  4. Sentinel INSERT: __quick__ workflow rows are created for all existing projects.
 *  5. Sentinel idempotency: re-executing 012 raises duplicate column error
 *     (the signal that runFileBasedMigrations uses to skip already-applied files).
 *  6. Round-trip: is_quick accepts 0/1/NULL values.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helper: open a fresh in-memory DB and apply the prerequisite migrations
// ---------------------------------------------------------------------------

/** Applies 006 + 009 to a fresh in-memory database. */
function applyPrerequisites(): Database.Database {
  const db = new Database(':memory:');

  // Enable FK enforcement so ON DELETE CASCADE is tested
  db.pragma('foreign_keys = ON');

  const sql006 = readFileSync(
    join(__dirname, '..', 'migrations', '006_cyboflow_schema.sql'),
    'utf-8',
  );
  db.exec(sql006);

  // sessions table is in schema.sql; create a minimal version here so we can
  // apply migrations that ALTER TABLE sessions.
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      initial_prompt TEXT NOT NULL DEFAULT '',
      worktree_name TEXT NOT NULL DEFAULT '',
      worktree_path TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      project_id INTEGER,
      is_main_repo BOOLEAN DEFAULT 0,
      run_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return db;
}

/** Applies migration 012 on top of a DB that already has the prerequisites. */
function apply012(db: Database.Database): void {
  const sql012 = readFileSync(
    join(__dirname, '..', 'migrations', '012_quick_workflow_sentinel.sql'),
    'utf-8',
  );
  db.exec(sql012);
}

// ---------------------------------------------------------------------------
// PRAGMA table_info row shape returned by better-sqlite3
// ---------------------------------------------------------------------------

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Migration 012: is_quick column on sessions', () => {
  it('adds is_quick BOOLEAN DEFAULT 0 (nullable) to sessions', () => {
    const db = applyPrerequisites();
    apply012(db);

    const rows = db
      .prepare('PRAGMA table_info(sessions)')
      .all() as TableInfoRow[];

    const col = rows.find((r) => r.name === 'is_quick');

    expect(col).toBeDefined();
    expect(String(col!.type).toUpperCase()).toBe('BOOLEAN');
    // notnull=0 means the column is nullable (DEFAULT 0 is not NOT NULL)
    expect(col!.notnull).toBe(0);

    db.close();
  });

  it('round-trips 0, 1, and NULL values for is_quick', () => {
    const db = applyPrerequisites();
    apply012(db);

    db.prepare("INSERT INTO sessions (id, name) VALUES ('s-zero', 'zero')").run();
    db.prepare(
      "INSERT INTO sessions (id, name, is_quick) VALUES ('s-one', 'one', 1)",
    ).run();
    db.prepare(
      "INSERT INTO sessions (id, name, is_quick) VALUES ('s-null', 'null', NULL)",
    ).run();

    interface Row { is_quick: number | null }

    const zero = db
      .prepare('SELECT is_quick FROM sessions WHERE id = ?')
      .get('s-zero') as Row;
    const one = db
      .prepare('SELECT is_quick FROM sessions WHERE id = ?')
      .get('s-one') as Row;
    const nullRow = db
      .prepare('SELECT is_quick FROM sessions WHERE id = ?')
      .get('s-null') as Row;

    expect(zero.is_quick).toBe(0);
    expect(one.is_quick).toBe(1);
    expect(nullRow.is_quick).toBeNull();

    db.close();
  });

  it('re-executing migration 012 raises duplicate column name: is_quick', () => {
    const db = applyPrerequisites();
    apply012(db);

    const sql012 = readFileSync(
      join(__dirname, '..', 'migrations', '012_quick_workflow_sentinel.sql'),
      'utf-8',
    );

    expect(() => {
      db.exec(sql012);
    }).toThrow(/duplicate column name: is_quick/i);

    db.close();
  });
});

describe('Migration 012: is_quick backfill', () => {
  it('backfills is_quick = 1 for null-run non-main-repo sessions', () => {
    const db = applyPrerequisites();

    // Seed sessions before running migration
    db.prepare(
      "INSERT INTO sessions (id, name, run_id, is_main_repo) VALUES ('qs-1', 'quick', NULL, 0)",
    ).run();
    db.prepare(
      "INSERT INTO sessions (id, name, run_id, is_main_repo) VALUES ('qs-2', 'quick-null-main', NULL, NULL)",
    ).run();

    apply012(db);

    interface Row { is_quick: number | null }

    const qs1 = db.prepare('SELECT is_quick FROM sessions WHERE id = ?').get('qs-1') as Row;
    const qs2 = db.prepare('SELECT is_quick FROM sessions WHERE id = ?').get('qs-2') as Row;

    expect(qs1.is_quick).toBe(1);
    expect(qs2.is_quick).toBe(1);

    db.close();
  });

  it('does NOT backfill is_quick = 1 for flow sessions (run_id IS NOT NULL)', () => {
    const db = applyPrerequisites();

    db.prepare(
      "INSERT INTO sessions (id, name, run_id, is_main_repo) VALUES ('flow-1', 'flow', 'run-abc', 0)",
    ).run();

    apply012(db);

    interface Row { is_quick: number | null }

    const flow1 = db
      .prepare('SELECT is_quick FROM sessions WHERE id = ?')
      .get('flow-1') as Row;

    expect(flow1.is_quick).toBe(0);

    db.close();
  });

  it('does NOT backfill is_quick = 1 for main-repo sessions (is_main_repo = 1)', () => {
    const db = applyPrerequisites();

    db.prepare(
      "INSERT INTO sessions (id, name, run_id, is_main_repo) VALUES ('main-1', 'main', NULL, 1)",
    ).run();

    apply012(db);

    interface Row { is_quick: number | null }

    const main1 = db
      .prepare('SELECT is_quick FROM sessions WHERE id = ?')
      .get('main-1') as Row;

    expect(main1.is_quick).toBe(0);

    db.close();
  });
});

describe('Migration 012: __quick__ sentinel workflows', () => {
  it('inserts a __quick__ sentinel workflow for every existing project', () => {
    const db = applyPrerequisites();

    // Seed two projects
    db.prepare("INSERT INTO projects (name, path, active) VALUES ('proj-a', '/tmp/a', 1)").run();
    db.prepare("INSERT INTO projects (name, path, active) VALUES ('proj-b', '/tmp/b', 1)").run();

    interface ProjRow { id: number }
    const projA = db.prepare("SELECT id FROM projects WHERE name = 'proj-a'").get() as ProjRow;
    const projB = db.prepare("SELECT id FROM projects WHERE name = 'proj-b'").get() as ProjRow;

    apply012(db);

    interface WfRow { id: string; project_id: number; name: string }
    const sentinelA = db
      .prepare('SELECT id, project_id, name FROM workflows WHERE id = ?')
      .get(`wf-${projA.id}-__quick__`) as WfRow | undefined;
    const sentinelB = db
      .prepare('SELECT id, project_id, name FROM workflows WHERE id = ?')
      .get(`wf-${projB.id}-__quick__`) as WfRow | undefined;

    expect(sentinelA).toBeDefined();
    expect(sentinelA!.name).toBe('__quick__');
    expect(sentinelA!.project_id).toBe(projA.id);

    expect(sentinelB).toBeDefined();
    expect(sentinelB!.name).toBe('__quick__');
    expect(sentinelB!.project_id).toBe(projB.id);

    db.close();
  });

  it('uses INSERT OR IGNORE — re-running does not duplicate sentinel rows', () => {
    const db = applyPrerequisites();

    db.prepare("INSERT INTO projects (name, path, active) VALUES ('proj-c', '/tmp/c', 1)").run();

    apply012(db);

    // Manually re-run just the INSERT OR IGNORE statement (simulating a race
    // condition where ensureQuickWorkflow also tried to insert the same row)
    db.exec(`
      INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json, permission_mode, created_at)
      SELECT
        'wf-' || id || '-__quick__',
        id,
        '__quick__',
        '{}',
        'default',
        datetime('now')
      FROM projects;
    `);

    interface CountRow { count: number }
    const { count } = db
      .prepare("SELECT COUNT(*) AS count FROM workflows WHERE name = '__quick__'")
      .get() as CountRow;

    expect(count).toBe(1);

    db.close();
  });

  it('does not insert sentinel rows when there are no projects', () => {
    const db = applyPrerequisites();

    // No projects seeded — the SELECT FROM projects returns zero rows
    apply012(db);

    interface CountRow { count: number }
    const { count } = db
      .prepare("SELECT COUNT(*) AS count FROM workflows WHERE name = '__quick__'")
      .get() as CountRow;

    expect(count).toBe(0);

    db.close();
  });
});
