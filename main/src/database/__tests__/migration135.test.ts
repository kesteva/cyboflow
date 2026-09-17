/**
 * Migration 135_project_solution_thoroughness.sql — projects.solution_thoroughness.
 *
 * Mirrors migration127.test.ts's two-boot real-upgrade pattern (the sibling
 * `ALTER TABLE projects ADD COLUMN … CHECK (… IS NULL OR …)` precedent): a DB is
 * migrated by a DatabaseService whose migrations dir OMITS 134, a project row is
 * seeded in the pre-134 shape, then a second DatabaseService pointed at the full
 * dir boots on the same file — exactly what happens when a user updates the app.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_135 = '135_project_solution_thoroughness.sql';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration134-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A migrations dir holding every real migration except 134 — i.e. the pre-134 app. */
function migrationsDirWithout134(): string {
  const dir = join(tmpDir, 'migrations-pre-134');
  mkdirSync(dir);
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (name === MIGRATION_135) continue;
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

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function seedProject(db: Database.Database, id: number, path: string): void {
  db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(id, `Proj ${id}`, path);
}

describe('migration 134: projects.solution_thoroughness', () => {
  it('(a) upgrades a pre-134 DB: existing projects land at NULL (never established)', () => {
    const pre = openAt(migrationsDirWithout134());
    seedProject(pre.getDb(), 1, '/tmp/p134-legacy');
    expect(columnNames(pre.getDb(), 'projects')).not.toContain('solution_thoroughness');
    pre.close();

    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();

    expect(columnNames(db, 'projects')).toContain('solution_thoroughness');
    const row = db.prepare('SELECT solution_thoroughness FROM projects WHERE id = ?').get(1) as {
      solution_thoroughness: string | null;
    };
    expect(row.solution_thoroughness).toBeNull();
    svc.close();
  });

  it('(b) accepts NULL/prototype/v1/production and rejects anything else', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();

    for (const [id, value] of [
      [10, null],
      [11, 'prototype'],
      [12, 'v1'],
      [13, 'production'],
    ] as const) {
      expect(
        () =>
          db
            .prepare(
              'INSERT INTO projects (id, name, path, solution_thoroughness) VALUES (?, ?, ?, ?)',
            )
            .run(id, `Proj ${id}`, `/tmp/p134-${id}`, value),
        `value=${value}`,
      ).not.toThrow();
    }

    expect(() =>
      db
        .prepare(
          "INSERT INTO projects (id, name, path, solution_thoroughness) VALUES (14, 'Bad', '/tmp/p134-bad', 'thorough')",
        )
        .run(),
    ).toThrow(/CHECK/i);

    svc.close();
  });

  it('(c) a fresh-install DB carries the column, defaulting to NULL', () => {
    const svc = openAt(MIGRATIONS_DIR);
    seedProject(svc.getDb(), 1, '/tmp/p134-fresh');

    const row = svc
      .getDb()
      .prepare('SELECT solution_thoroughness FROM projects WHERE id = ?')
      .get(1) as { solution_thoroughness: string | null };
    expect(row.solution_thoroughness).toBeNull();
    svc.close();
  });

  it('(d) DatabaseService.updateProject / getProject round-trip solution_thoroughness', () => {
    const svc = openAt(MIGRATIONS_DIR);
    seedProject(svc.getDb(), 1, '/tmp/p134-roundtrip');

    expect(svc.getProject(1)?.solution_thoroughness).toBeFalsy();

    expect(svc.updateProject(1, { solution_thoroughness: 'v1' })?.solution_thoroughness).toBe('v1');
    expect(svc.getProject(1)?.solution_thoroughness).toBe('v1');

    expect(svc.updateProject(1, { solution_thoroughness: 'production' })?.solution_thoroughness).toBe(
      'production',
    );
    expect(svc.getProject(1)?.solution_thoroughness).toBe('production');

    svc.close();
  });
});
