/**
 * Integration tests for migration 027_session_substrate.sql.
 *
 * Adds a NULLABLE `substrate` TEXT column to `sessions` (the opt-in interactive
 * PTY quick-session marker; NULL means legacy/SDK). Validation is in-code
 * (isCliSubstrate) — no CHECK constraint — so any string writes.
 *
 * Targets: column exists + nullable, legacy rows read NULL, both union values
 * write, and a re-run raises the "duplicate column name" idempotency signal.
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

describe('Migration 027: sessions.substrate', () => {
  it('adds a nullable substrate column; legacy rows read NULL', () => {
    const db = baseSessions();
    db.exec(readMigration('027_session_substrate.sql'));

    const col = (db.prepare('PRAGMA table_info(sessions)').all() as Col[]).find(
      (c) => c.name === 'substrate',
    );
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);

    const row = db.prepare("SELECT substrate AS s FROM sessions WHERE id='s1'").get() as {
      s: string | null;
    };
    expect(row.s).toBeNull();
    db.close();
  });

  it('accepts both CliSubstrate union values (no CHECK constraint)', () => {
    const db = baseSessions();
    db.exec(readMigration('027_session_substrate.sql'));
    for (const value of ['sdk', 'interactive']) {
      db.prepare('UPDATE sessions SET substrate=? WHERE id=?').run(value, 's1');
      const row = db.prepare("SELECT substrate AS s FROM sessions WHERE id='s1'").get() as {
        s: string;
      };
      expect(row.s).toBe(value);
    }
    db.close();
  });

  it('re-running raises duplicate column name (the idempotency signal)', () => {
    const db = baseSessions();
    db.exec(readMigration('027_session_substrate.sql'));
    expect(() => db.exec(readMigration('027_session_substrate.sql'))).toThrow(
      /duplicate column name: substrate/i,
    );
    db.close();
  });
});
