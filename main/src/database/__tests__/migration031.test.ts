/**
 * Integration tests for migration 031_session_effort.sql.
 *
 * Adds a NULLABLE `effort` TEXT column to `sessions` (read-only effort pill;
 * only value today is 'ultracode'; NULL means no effort). Validation is in-code
 * — no CHECK constraint.
 *
 * Targets: column exists + nullable, legacy rows read NULL, 'ultracode'
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
}

describe('Migration 031: sessions.effort', () => {
  it('adds a nullable effort column; legacy rows read NULL', () => {
    const db = baseSessions();
    db.exec(readMigration('031_session_effort.sql'));

    const col = (db.prepare('PRAGMA table_info(sessions)').all() as Col[]).find(
      (c) => c.name === 'effort',
    );
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);

    const row = db.prepare("SELECT effort AS e FROM sessions WHERE id='s1'").get() as {
      e: string | null;
    };
    expect(row.e).toBeNull();
    db.close();
  });

  it('round-trips the ultracode value', () => {
    const db = baseSessions();
    db.exec(readMigration('031_session_effort.sql'));
    db.prepare("UPDATE sessions SET effort='ultracode' WHERE id='s1'").run();
    const row = db.prepare("SELECT effort AS e FROM sessions WHERE id='s1'").get() as {
      e: string | null;
    };
    expect(row.e).toBe('ultracode');
    db.close();
  });

  it('re-running raises duplicate column name (the idempotency signal)', () => {
    const db = baseSessions();
    db.exec(readMigration('031_session_effort.sql'));
    expect(() => db.exec(readMigration('031_session_effort.sql'))).toThrow(
      /duplicate column name: effort/i,
    );
    db.close();
  });
});
