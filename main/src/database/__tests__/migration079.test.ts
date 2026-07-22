/**
 * Integration tests for migration 079_workflow_archived_at.sql.
 *
 * 079 adds a nullable `archived_at` TEXT column to `workflows` (mirrors the
 * entity `archived_at` soft-hide pattern from migration 024): NULL = active,
 * an ISO timestamp = archived. No cascade to any other table — a single ALTER.
 *
 * Applies against a minimal workflows table via the production transaction
 * wrapper (mirrors migration054.test.ts's convention for an ALTER-only
 * migration onto an existing table).
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
  // Minimal pre-079 workflows shape.
  db.exec(
    `CREATE TABLE workflows (id TEXT PRIMARY KEY, project_id INTEGER, name TEXT NOT NULL, spec_json TEXT NOT NULL DEFAULT '{}');`,
  );
  return db;
}

describe('Migration 079: workflows.archived_at soft-archive stamp', () => {
  it('applies cleanly on a fresh DB', () => {
    const db = buildDb();
    expect(() => runMigrationViaProductionPath(db, readMigration('079_workflow_archived_at.sql'))).not.toThrow();
    db.close();
  });

  it('adds a nullable archived_at column to workflows (PRAGMA table_info)', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration('079_workflow_archived_at.sql'));
    const col = (db.prepare('PRAGMA table_info(workflows)').all() as Array<{ name: string; notnull: number }>).find(
      (c) => c.name === 'archived_at',
    );
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
    db.close();
  });

  it('existing rows default to NULL (active)', () => {
    const db = buildDb();
    db.prepare("INSERT INTO workflows (id, project_id, name) VALUES ('wf-1', 1, 'planner')").run();
    runMigrationViaProductionPath(db, readMigration('079_workflow_archived_at.sql'));
    const row = db.prepare('SELECT archived_at FROM workflows WHERE id = ?').get('wf-1') as {
      archived_at: string | null;
    };
    expect(row.archived_at).toBeNull();
    db.close();
  });

  it('the column is writable to an ISO timestamp and back to NULL', () => {
    const db = buildDb();
    db.prepare("INSERT INTO workflows (id, project_id, name) VALUES ('wf-1', 1, 'planner')").run();
    runMigrationViaProductionPath(db, readMigration('079_workflow_archived_at.sql'));

    db.prepare("UPDATE workflows SET archived_at = datetime('now') WHERE id = ?").run('wf-1');
    const archived = db.prepare('SELECT archived_at FROM workflows WHERE id = ?').get('wf-1') as {
      archived_at: string | null;
    };
    expect(archived.archived_at).not.toBeNull();

    db.prepare('UPDATE workflows SET archived_at = NULL WHERE id = ?').run('wf-1');
    const cleared = db.prepare('SELECT archived_at FROM workflows WHERE id = ?').get('wf-1') as {
      archived_at: string | null;
    };
    expect(cleared.archived_at).toBeNull();
    db.close();
  });
});
