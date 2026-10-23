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
      'import_sha', 'checkpoint_sha', 'local_worktree_path', 'merged_sha', 'merged_at', 'closed_out_at', 'last_error',
      'created_at', 'updated_at',
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

  it('cascades a deleted session or project to its rows', () => {
    const db = freshDb();
    db.exec(`INSERT INTO projects (id, name) VALUES (2, 'q'); INSERT INTO sessions (id, status) VALUES ('s2', 'x'), ('s3', 'x')`);
    insert(db, 's1');
    db.prepare(
      `INSERT INTO session_merge_backs (session_id, host_id, project_id, merge_key, branch, state, created_at, updated_at)
       VALUES (?, 'h1', 2, ?, 'b', 'cleaned', ?, ?)`,
    ).run('s2', 'k2', NOW, NOW);
    db.prepare(
      `INSERT INTO session_merge_backs (session_id, host_id, project_id, merge_key, branch, state, created_at, updated_at)
       VALUES (?, 'h1', 2, ?, 'b', 'remote_ready', ?, ?)`,
    ).run('s3', 'k3', NOW, NOW);
    db.exec(`DELETE FROM sessions WHERE id = 's1'`);
    db.exec('DELETE FROM projects WHERE id = 2');
    expect((db.prepare('SELECT COUNT(*) AS n FROM session_merge_backs').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('a project whose remote sessions (live and cleaned) have rows deletes through DatabaseService', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-mig153-del-'));
    const svc = new DatabaseService(join(dir, 'test.db'));
    try {
      svc.initialize();
      const db = svc.getDb();
      db.prepare(
        `INSERT INTO hosts (id, label, kind, config_json, detected_tier, lifecycle_state, created_at, updated_at)
         VALUES ('h-ssh', 'Studio', 'ssh', '{}', 'full', 'online', ?, ?)`,
      ).run(NOW, NOW);
      const project = svc.createProject('p', join(dir, 'repo'));
      const keep = svc.createProject('keep', join(dir, 'other'));
      for (const [id, pid] of [['r1', project.id], ['r2', project.id], ['r3', keep.id]] as const) {
        svc.createSession({ id, name: id, initial_prompt: '', worktree_name: id, worktree_path: `/remote/wt/${id}`, project_id: pid, host_id: 'h-ssh' });
      }
      const row = db.prepare(
        `INSERT INTO session_merge_backs (session_id, host_id, project_id, merge_key, branch, state, created_at, updated_at)
         VALUES (?, 'h-ssh', ?, ?, ?, ?, ?, ?)`,
      );
      row.run('r1', project.id, 'r1', 'r1', 'cleaned', NOW, NOW);
      row.run('r2', project.id, 'r2', 'r2', 'remote_ready', NOW, NOW);
      row.run('r3', keep.id, 'r3', 'r3', 'remote_ready', NOW, NOW);
      db.prepare(`INSERT INTO host_project_checkouts (host_id, project_id, remote_repo_path) VALUES ('h-ssh', ?, '/r/1.git')`).run(project.id);

      expect(svc.deleteProject(project.id)).toBe(true);
      const left = (db.prepare('SELECT session_id FROM session_merge_backs ORDER BY session_id').all() as Array<{ session_id: string }>)
        .map((r) => r.session_id);
      expect(left).toEqual(['r3']);
    } finally {
      try { svc.close(); } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true });
    }
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
