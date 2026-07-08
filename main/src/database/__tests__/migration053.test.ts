/**
 * Integration tests for migration 053_experiment_arm_entities.sql (A/B testing).
 *
 * 053 adds `experiment_arm` to ideas/epics/tasks so the TaskChangeRouter sandbox
 * guard can require BOTH experiment_id AND arm to match (closing the cross-arm
 * write/read hole where both arms shared one experiment_id). It applies against
 * minimal ideas/epics/tasks tables (created inline here, mirroring the post-049
 * shape) via the production transaction wrapper, and asserts: the chain applies
 * cleanly, the column exists on all three tables (PRAGMA table_info), the CHECK
 * rejects a value outside (A,B), and NULL is allowed (the default, unowned state).
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
  // Minimal ideas/epics/tasks shapes carrying the migration-049 experiment_id
  // column — 053 only ALTERs each to add experiment_arm.
  for (const t of ['ideas', 'epics', 'tasks']) {
    db.exec(`CREATE TABLE ${t} (id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, experiment_id TEXT);`);
    db.prepare(`INSERT INTO ${t} (id, project_id, experiment_id) VALUES ('${t}1', 1, NULL)`).run();
  }
  return db;
}

describe('Migration 053: ideas/epics/tasks.experiment_arm', () => {
  it('applies cleanly', () => {
    const db = buildDb();
    expect(() => runMigrationViaProductionPath(db, readMigration('053_experiment_arm_entities.sql'))).not.toThrow();
    db.close();
  });

  it('adds experiment_arm to all three entity tables (PRAGMA table_info)', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration('053_experiment_arm_entities.sql'));
    for (const t of ['ideas', 'epics', 'tasks']) {
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('experiment_arm');
    }
    db.close();
  });

  it("CHECK rejects an experiment_arm outside ('A','B'), admits 'A'/'B' and NULL", () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration('053_experiment_arm_entities.sql'));

    expect(() =>
      db.prepare("INSERT INTO tasks (id, project_id, experiment_arm) VALUES ('bad', 1, 'C')").run(),
    ).toThrow(/CHECK/);

    expect(() =>
      db.prepare("INSERT INTO tasks (id, project_id, experiment_id, experiment_arm) VALUES ('okA', 1, 'exp-1', 'A')").run(),
    ).not.toThrow();
    expect(() =>
      db.prepare("INSERT INTO tasks (id, project_id, experiment_id, experiment_arm) VALUES ('okB', 1, 'exp-1', 'B')").run(),
    ).not.toThrow();
    // NULL is the default (unowned / normal board entity).
    expect(() =>
      db.prepare("INSERT INTO tasks (id, project_id, experiment_arm) VALUES ('okNull', 1, NULL)").run(),
    ).not.toThrow();
    db.close();
  });
});
