/**
 * Integration tests for migration 085_review_item_audience.sql.
 *
 * 085 adds a NOT NULL `audience` column (CHECK human|machine, DEFAULT 'human') to
 * `review_items` — the axis that splits "does this park the run?" (`blocking`)
 * from "must a human see it?" (`audience`). Existing rows backfill to 'human' via
 * the DEFAULT, preserving pre-085 semantics exactly.
 *
 * Applies against a minimal review_items table via the production transaction
 * wrapper (mirrors migration079.test.ts's convention for an ALTER-only migration).
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
  // Minimal pre-085 review_items shape (the columns these tests touch).
  db.exec(
    `CREATE TABLE review_items (
       id TEXT PRIMARY KEY,
       project_id INTEGER NOT NULL,
       run_id TEXT,
       kind TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'pending',
       blocking INTEGER NOT NULL DEFAULT 0,
       title TEXT NOT NULL
     );`,
  );
  return db;
}

describe('Migration 085: review_items.audience (human/machine)', () => {
  it('adds a NOT NULL audience column defaulting to human (PRAGMA table_info)', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration('085_review_item_audience.sql'));
    const col = (
      db.prepare('PRAGMA table_info(review_items)').all() as Array<{ name: string; notnull: number; dflt_value: string }>
    ).find((c) => c.name === 'audience');
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(1);
    expect(col!.dflt_value).toContain('human');
    db.close();
  });

  it('backfills every existing row to human (preserving pre-085 semantics)', () => {
    const db = buildDb();
    db.prepare("INSERT INTO review_items (id, project_id, kind, blocking, title) VALUES ('rvw-1', 1, 'finding', 1, 'x')").run();
    runMigrationViaProductionPath(db, readMigration('085_review_item_audience.sql'));
    const row = db.prepare('SELECT audience FROM review_items WHERE id = ?').get('rvw-1') as { audience: string };
    expect(row.audience).toBe('human');
    db.close();
  });

  it('accepts machine + human and rejects any other value via the CHECK', () => {
    const db = buildDb();
    runMigrationViaProductionPath(db, readMigration('085_review_item_audience.sql'));
    expect(() =>
      db.prepare("INSERT INTO review_items (id, project_id, kind, title, audience) VALUES ('m', 1, 'finding', 'x', 'machine')").run(),
    ).not.toThrow();
    expect(() =>
      db.prepare("INSERT INTO review_items (id, project_id, kind, title, audience) VALUES ('h', 1, 'finding', 'x', 'human')").run(),
    ).not.toThrow();
    expect(() =>
      db.prepare("INSERT INTO review_items (id, project_id, kind, title, audience) VALUES ('b', 1, 'finding', 'x', 'nobody')").run(),
    ).toThrow();
    db.close();
  });
});
