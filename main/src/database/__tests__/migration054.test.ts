/**
 * Integration tests for migration 054_baseline_rotation.sql (A/B testing).
 *
 * 054 adds `baseline_in_rotation` (0/1) + `baseline_rotation_weight` (INTEGER) to
 * `workflows` so the live BASELINE can join randomized rotation on equal footing
 * with active variants. DEFAULT 0/1 preserves the pre-054 behaviour exactly (the
 * baseline is out of rotation until the user opts it in), so no backfill is needed.
 *
 * Applies against a minimal workflows table via the production transaction wrapper.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

function runMigrationViaProductionPath(db: Database.Database, sql: string): void {
  const txn = db.transaction(() => {
    db.exec(sql);
  });
  txn();
}

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Minimal pre-054 workflows shape.
  db.exec(
    `CREATE TABLE workflows (id TEXT PRIMARY KEY, project_id INTEGER, name TEXT NOT NULL, spec_json TEXT NOT NULL DEFAULT '{}');`,
  );
  return db;
}

describe('Migration 054: workflows baseline rotation columns', () => {
  it('applies cleanly', () => {
    const db = buildDb();
    expect(() => runMigrationViaProductionPath(db, readMigration('054_baseline_rotation.sql'))).not.toThrow();
    db.close();
  });

  it('adds both baseline columns to workflows (PRAGMA table_info)', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration('054_baseline_rotation.sql'));
    const cols = (db.prepare('PRAGMA table_info(workflows)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('baseline_in_rotation');
    expect(cols).toContain('baseline_rotation_weight');
    db.close();
  });

  it('DEFAULTs existing rows to out-of-rotation (0) with weight 1', () => {
    const db = buildDb();
    db.prepare("INSERT INTO workflows (id, project_id, name) VALUES ('wf-1', 1, 'planner')").run();
    runMigrationViaProductionPath(db, readMigration('054_baseline_rotation.sql'));
    const row = db
      .prepare('SELECT baseline_in_rotation AS inR, baseline_rotation_weight AS w FROM workflows WHERE id = ?')
      .get('wf-1') as { inR: number; w: number };
    expect(row.inR).toBe(0);
    expect(row.w).toBe(1);
    db.close();
  });

  it('the columns are writable to 1 / a custom weight', () => {
    const db = buildDb();
    db.prepare("INSERT INTO workflows (id, project_id, name) VALUES ('wf-1', 1, 'planner')").run();
    runMigrationViaProductionPath(db, readMigration('054_baseline_rotation.sql'));
    db.prepare('UPDATE workflows SET baseline_in_rotation = 1, baseline_rotation_weight = 3 WHERE id = ?').run('wf-1');
    const row = db
      .prepare('SELECT baseline_in_rotation AS inR, baseline_rotation_weight AS w FROM workflows WHERE id = ?')
      .get('wf-1') as { inR: number; w: number };
    expect(row.inR).toBe(1);
    expect(row.w).toBe(3);
    db.close();
  });
});
