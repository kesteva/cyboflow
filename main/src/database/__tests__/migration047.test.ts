/**
 * Integration tests for migration 047_session_in_place.sql.
 *
 * Adds a `in_place BOOLEAN DEFAULT 0` column to `sessions` (opt-out worktree
 * isolation — "in-place" quick sessions that work directly in the project
 * checkout). Mirrors the migration021 pattern: a minimal inline `sessions` table
 * stands in for the legacy schema, then the real .sql file is applied so a typo
 * in the file itself is caught.
 *
 * Targets: column exists + defaults 0, legacy rows read the default, in_place=1
 * round-trips, and a re-run raises the "duplicate column name" idempotency signal.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

function baseSessions(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT)');
  db.prepare("INSERT INTO sessions (id, name) VALUES ('s1', 'legacy')").run();
  return db;
}

interface Col {
  name: string;
  notnull: number;
  dflt_value: unknown;
}

describe('Migration 047: sessions.in_place', () => {
  it('adds an in_place column defaulting to 0; legacy rows read 0', () => {
    const db = baseSessions();
    db.exec(readMigration('047_session_in_place.sql'));

    const col = (db.prepare('PRAGMA table_info(sessions)').all() as Col[]).find(
      (c) => c.name === 'in_place',
    );
    expect(col).toBeDefined();
    // DEFAULT 0 — sqlite records the default literal for the column.
    expect(String(col!.dflt_value)).toBe('0');

    // A row inserted BEFORE the column existed reads the default (0), never NULL.
    const row = db.prepare("SELECT in_place AS v FROM sessions WHERE id='s1'").get() as {
      v: number;
    };
    expect(row.v).toBe(0);
    db.close();
  });

  it('round-trips in_place=1', () => {
    const db = baseSessions();
    db.exec(readMigration('047_session_in_place.sql'));
    db.prepare("UPDATE sessions SET in_place=1 WHERE id='s1'").run();
    const row = db.prepare("SELECT in_place AS v FROM sessions WHERE id='s1'").get() as {
      v: number;
    };
    expect(row.v).toBe(1);
    db.close();
  });

  it('a freshly inserted row defaults in_place to 0', () => {
    const db = baseSessions();
    db.exec(readMigration('047_session_in_place.sql'));
    db.prepare("INSERT INTO sessions (id, name) VALUES ('s2', 'fresh')").run();
    const row = db.prepare("SELECT in_place AS v FROM sessions WHERE id='s2'").get() as {
      v: number;
    };
    expect(row.v).toBe(0);
    db.close();
  });

  it('re-running raises duplicate column name (the idempotency signal)', () => {
    const db = baseSessions();
    db.exec(readMigration('047_session_in_place.sql'));
    expect(() => db.exec(readMigration('047_session_in_place.sql'))).toThrow(
      /duplicate column name: in_place/i,
    );
    db.close();
  });
});
