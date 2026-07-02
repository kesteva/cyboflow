/**
 * Integration tests for migration 028_idea_attachments.sql.
 *
 * Adds a NULLABLE `attachments` TEXT (JSON metadata array) column to `ideas`.
 * A minimal `projects` + `ideas` table (with the 015 projects FK ON DELETE
 * CASCADE) stands in for the full entity-model schema, then the real 028 .sql
 * is applied so a typo in the file is caught.
 *
 * Targets: column exists + nullable, a JSON metadata array round-trips, the
 * attachments die with their parent idea on cascade delete, and a re-run raises
 * the "duplicate column name" idempotency signal.
 *
 * NOTE (spec framing): the B8 plan calls this "idea_attachments FK/cascade on
 * parent-idea delete". 028 does NOT create a dedicated attachments table — the
 * metadata lives in a JSON column ON the idea — so the cascade under test is the
 * ideas→projects FK carrying the attachment metadata away when the idea's
 * project is deleted.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

function baseIdeas(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE ideas (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL,
      ref TEXT NOT NULL,
      title TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);
  db.prepare('INSERT INTO projects (id, name) VALUES (1, ?)').run('P');
  db.prepare("INSERT INTO ideas (id, project_id, ref, title) VALUES ('ide_1', 1, 'IDEA-1', 'T')").run();
  return db;
}

interface Col {
  name: string;
  notnull: number;
}

describe('Migration 028: ideas.attachments', () => {
  it('adds a nullable attachments column; existing ideas read NULL', () => {
    const db = baseIdeas();
    db.exec(readMigration('028_idea_attachments.sql'));

    const col = (db.prepare('PRAGMA table_info(ideas)').all() as Col[]).find(
      (c) => c.name === 'attachments',
    );
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);

    const row = db.prepare("SELECT attachments AS a FROM ideas WHERE id='ide_1'").get() as {
      a: string | null;
    };
    expect(row.a).toBeNull();
    db.close();
  });

  it('round-trips a JSON IdeaAttachment[] metadata array', () => {
    const db = baseIdeas();
    db.exec(readMigration('028_idea_attachments.sql'));
    const meta = [{ id: 'a1', name: 'shot.png', path: '/tmp/shot.png', type: 'image/png', size: 42 }];
    db.prepare('UPDATE ideas SET attachments=? WHERE id=?').run(JSON.stringify(meta), 'ide_1');

    const row = db.prepare("SELECT attachments AS a FROM ideas WHERE id='ide_1'").get() as {
      a: string;
    };
    expect(JSON.parse(row.a)).toEqual(meta);
    db.close();
  });

  it('carries attachments away with the idea when the parent project cascades', () => {
    const db = baseIdeas();
    db.exec(readMigration('028_idea_attachments.sql'));
    db.prepare("UPDATE ideas SET attachments='[{\"id\":\"a1\"}]' WHERE id='ide_1'").run();

    db.prepare('DELETE FROM projects WHERE id=1').run();
    const remaining = db.prepare("SELECT id FROM ideas WHERE id='ide_1'").get();
    expect(remaining).toBeUndefined();
    db.close();
  });

  it('re-running raises duplicate column name (the idempotency signal)', () => {
    const db = baseIdeas();
    db.exec(readMigration('028_idea_attachments.sql'));
    expect(() => db.exec(readMigration('028_idea_attachments.sql'))).toThrow(
      /duplicate column name: attachments/i,
    );
    db.close();
  });
});
