/**
 * Integration tests for migration 021_session_agent_permission_mode.sql.
 *
 * Adds a NULLABLE `agent_permission_mode` TEXT column to `sessions` (the
 * per-session 4-mode override). Mirrors the migration040 pattern: a minimal
 * inline `sessions` table stands in for the legacy schema.sql table, then the
 * real .sql file is applied so a typo in the file itself is caught.
 *
 * Targets: column exists + nullable, legacy rows read NULL, a value round-trips,
 * and a re-run raises the "duplicate column name" idempotency signal.
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

describe('Migration 021: sessions.agent_permission_mode', () => {
  it('adds a nullable agent_permission_mode column; legacy rows read NULL', () => {
    const db = baseSessions();
    db.exec(readMigration('021_session_agent_permission_mode.sql'));

    const col = (db.prepare('PRAGMA table_info(sessions)').all() as Col[]).find(
      (c) => c.name === 'agent_permission_mode',
    );
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0); // nullable

    const row = db.prepare("SELECT agent_permission_mode AS m FROM sessions WHERE id='s1'").get() as {
      m: string | null;
    };
    expect(row.m).toBeNull();
    db.close();
  });

  it('round-trips a 4-mode value', () => {
    const db = baseSessions();
    db.exec(readMigration('021_session_agent_permission_mode.sql'));
    db.prepare("UPDATE sessions SET agent_permission_mode='acceptEdits' WHERE id='s1'").run();
    const row = db.prepare("SELECT agent_permission_mode AS m FROM sessions WHERE id='s1'").get() as {
      m: string | null;
    };
    expect(row.m).toBe('acceptEdits');
    db.close();
  });

  it('re-running raises duplicate column name (the idempotency signal)', () => {
    const db = baseSessions();
    db.exec(readMigration('021_session_agent_permission_mode.sql'));
    expect(() => db.exec(readMigration('021_session_agent_permission_mode.sql'))).toThrow(
      /duplicate column name: agent_permission_mode/i,
    );
    db.close();
  });
});
