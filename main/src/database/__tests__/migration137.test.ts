/**
 * Migration 137_task_executor.sql — `tasks.executor` (agent|human), the WHO of a
 * task. Tasks-only: ideas/epics do not execute, so they must NOT gain the column.
 *
 * Mirrors migration117.test.ts's two-boot real-upgrade-path pattern: a DB is
 * migrated by a DatabaseService whose migrations dir OMITS 137, a row is seeded
 * in the pre-137 shape, then a second DatabaseService pointed at the full dir
 * boots on the same file — exactly what happens when a user updates the app.
 * Asserts the four things the plan pins: fresh apply, idempotent re-apply, the
 * CHECK rejecting a third value, and pre-existing rows backfilling to 'agent'.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_137 = '137_task_executor.sql';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration137-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A migrations dir holding every real migration except 137 — i.e. the pre-137 app. */
function migrationsDirWithout137(): string {
  const dir = join(tmpDir, 'migrations-pre-137');
  mkdirSync(dir);
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (name === MIGRATION_137) continue;
    if (!/^\d{3}_.*\.sql$/.test(name)) continue;
    copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
  }
  return dir;
}

function openAt(migrationsDir: string): DatabaseService {
  const svc = new DatabaseService(dbPath);
  svc.setMigrationsDirForTesting(migrationsDir);
  svc.initialize();
  return svc;
}

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function columnInfo(db: Database.Database, table: string, column: string): TableInfoRow | undefined {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[]).find((c) => c.name === column);
}

function seedProjectAndBoard(db: Database.Database): void {
  db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/p137')`).run();
  db.prepare(
    `INSERT INTO boards (id, project_id, name, kind, is_default) VALUES ('board-1', 1, 'Default', 'default', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO board_stages (id, board_id, label, color_oklch, position, write_policy, is_terminal, hidden_by_default)
     VALUES ('stage-1', 'board-1', 'Idea', 'oklch(0.5 0 0)', 1, 'asserted', 0, 0)`,
  ).run();
}

function insertTask(db: Database.Database, id: string, executor?: string): void {
  if (executor === undefined) {
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id)
       VALUES (?, 1, ?, ?, 'board-1', 'stage-1')`,
    ).run(id, `TASK-${id}`, id);
    return;
  }
  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, executor)
     VALUES (?, 1, ?, ?, 'board-1', 'stage-1', ?)`,
  ).run(id, `TASK-${id}`, id, executor);
}

describe('Migration 137: tasks.executor (agent|human)', () => {
  it('(a) fresh apply: the column exists on tasks, NOT NULL, DEFAULT agent — and NOT on ideas/epics', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();

    const col = columnInfo(db, 'tasks', 'executor');
    expect(col).toBeDefined();
    expect(col?.type).toBe('TEXT');
    expect(col?.notnull).toBe(1);
    expect(String(col?.dflt_value)).toBe("'agent'");

    // Tasks-only: ideas/epics never execute, so the column must not spread.
    expect(columnInfo(db, 'ideas', 'executor')).toBeUndefined();
    expect(columnInfo(db, 'epics', 'executor')).toBeUndefined();

    svc.close();
  });

  it('(b) upgrades a pre-137 DB: the column is absent before, and every pre-existing row backfills to agent', () => {
    const pre137 = migrationsDirWithout137();
    const pre = openAt(pre137);
    seedProjectAndBoard(pre.getDb());
    expect(columnInfo(pre.getDb(), 'tasks', 'executor')).toBeUndefined();
    insertTask(pre.getDb(), 'legacy');
    pre.close();

    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    const row = db.prepare('SELECT executor FROM tasks WHERE id = ?').get('legacy') as { executor: string };
    expect(row.executor).toBe('agent');
    svc.close();
  });

  it('(c) re-applying the file is an idempotent no-op (duplicate column name is tolerated)', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    seedProjectAndBoard(db);
    insertTask(db, 'before', 'human');

    // The ledger keys on FILENAME, so a renumber re-applies the file wholesale.
    // Simulate that by executing the statement a second time the way the runner
    // would — the tolerated error must be exactly "duplicate column name".
    const sql = readFileSync(join(MIGRATIONS_DIR, MIGRATION_137), 'utf-8');
    expect(() => db.exec(sql)).toThrow(/duplicate column name/i);

    // Nothing was disturbed by the failed re-apply.
    const row = db.prepare('SELECT executor FROM tasks WHERE id = ?').get('before') as { executor: string };
    expect(row.executor).toBe('human');
    svc.close();
  });

  it('(d) the CHECK accepts agent + human and rejects anything else', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    seedProjectAndBoard(db);

    expect(() => insertTask(db, 'a', 'agent')).not.toThrow();
    expect(() => insertTask(db, 'h', 'human')).not.toThrow();
    expect(() => insertTask(db, 'r', 'robot')).toThrow(/CHECK constraint failed/i);
    expect(() => insertTask(db, 'e', '')).toThrow(/CHECK constraint failed/i);

    svc.close();
  });

  it('(e) an insert omitting executor defaults to agent', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    seedProjectAndBoard(db);
    insertTask(db, 'default');
    const row = db.prepare('SELECT executor FROM tasks WHERE id = ?').get('default') as { executor: string };
    expect(row.executor).toBe('agent');
    svc.close();
  });
});
