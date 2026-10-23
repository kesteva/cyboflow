/** Migration 153_session_merge_backs.sql — table shape, idempotence, and landing via DatabaseService. */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../database';

const MIG_DIR = join(__dirname, '..', 'migrations');
const SQL = readFileSync(join(MIG_DIR, '153_session_merge_backs.sql'), 'utf-8');
const NOW = '2026-10-22T12:00:00.000Z';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
           CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT);
           CREATE TABLE hosts (id TEXT PRIMARY KEY, label TEXT);
           INSERT INTO projects (id, name) VALUES (1, 'p');
           INSERT INTO sessions (id, status) VALUES ('s1', 'x');
           INSERT INTO hosts (id, label) VALUES ('h1', 'Box');`);
  db.exec(SQL);
  return db;
}

function insert(db: Database.Database, sessionId: string, hostId = 'h1'): void {
  db.prepare(
    `INSERT INTO session_merge_backs (session_id, host_id, project_id, merge_key, branch, state, created_at, updated_at)
     VALUES (?, ?, 1, 'k', 'b', 'bare_ready', ?, ?)`,
  ).run(sessionId, hostId, NOW, NOW);
}

describe('migration 153 — session_merge_backs', () => {
  it('creates the table with the spec columns', () => {
    const db = freshDb();
    const cols = (db.prepare('PRAGMA table_info(session_merge_backs)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual([
      'session_id', 'host_id', 'project_id', 'merge_key', 'branch', 'remote_worktree_path', 'state', 'base_sha',
      'import_sha', 'checkpoint_sha', 'local_worktree_path', 'last_error', 'created_at', 'updated_at',
    ]);
    db.close();
  });

  it('applies twice idempotently without losing rows', () => {
    const db = freshDb();
    insert(db, 's1');
    expect(() => db.exec(SQL)).not.toThrow();
    expect((db.prepare('SELECT COUNT(*) AS n FROM session_merge_backs').get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('enforces the session, host and project FKs and one row per session', () => {
    const db = freshDb();
    insert(db, 's1');
    expect(() => insert(db, 's1')).toThrow(/UNIQUE|PRIMARY/);
    expect(() => insert(db, 'nope')).toThrow(/FOREIGN KEY/);
    db.exec(`INSERT INTO sessions (id, status) VALUES ('s2', 'x')`);
    expect(() => insert(db, 's2', 'nohost')).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it('has no CHECK constraint and no datetime(now) default', () => {
    const code = SQL.replace(/--.*$/gm, '');
    expect(code).not.toMatch(/\bCHECK\b/i);
    expect(code).not.toMatch(/DEFAULT\s*\(?\s*datetime/i);
  });

  it('lands through DatabaseService.initialize()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-mig153-'));
    const svc = new DatabaseService(join(dir, 'test.db'));
    try {
      svc.initialize();
      const tables = (svc.getDb().prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
        .map((r) => r.name);
      expect(tables).toContain('session_merge_backs');
    } finally {
      try { svc.close(); } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
