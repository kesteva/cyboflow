/**
 * Migration 152_hosts.sql — the Environments registry.
 *
 * (a)-(f) run the file over a minimal projects/sessions/workflow_runs DDL with foreign keys on;
 * (g) proves it lands through the real DatabaseService.initialize() chain.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../database';

const MIG_DIR = join(__dirname, '..', 'migrations');
const SQL = readFileSync(join(MIG_DIR, '152_hosts.sql'), 'utf-8');
const NOW = '2026-10-09T12:00:00.000Z';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
           CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT);
           CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, status TEXT);`);
  db.exec(SQL);
  return db;
}

function cols(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function insertHost(db: Database.Database, id: string, label: string, archivedAt: string | null = null): void {
  db.prepare(
    `INSERT INTO hosts (id, label, kind, config_json, archived_at, created_at, updated_at)
     VALUES (?, ?, 'ssh', '{}', ?, ?, ?)`,
  ).run(id, label, archivedAt, NOW, NOW);
}

describe('migration 152 — hosts', () => {
  it('(a) creates hosts and host_project_checkouts and the live-label index', () => {
    const db = freshDb();
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','index')`).all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['hosts', 'host_project_checkouts', 'idx_hosts_label_live']));
    db.close();
  });

  it('(b) seeds exactly one local row with an ISO timestamp', () => {
    const db = freshDb();
    const rows = db.prepare('SELECT * FROM hosts').all() as Array<Record<string, string>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'local', label: 'This Mac', kind: 'local', detected_tier: 'full', lifecycle_state: 'online' });
    expect(rows[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    db.close();
  });

  it('(c) adds the host columns to projects / sessions / workflow_runs', () => {
    const db = freshDb();
    expect(cols(db, 'projects')).toContain('default_host_id');
    expect(cols(db, 'sessions')).toContain('host_id');
    expect(cols(db, 'workflow_runs')).toEqual(expect.arrayContaining(['host_id', 'merge_back_state', 'merge_back_sha']));
    db.close();
  });

  it('(d) live labels are unique but an archived label can be reused', () => {
    const db = freshDb();
    insertHost(db, 'h1', 'Box');
    expect(() => insertHost(db, 'h2', 'Box')).toThrow(/UNIQUE/);
    db.prepare('UPDATE hosts SET archived_at = ? WHERE id = ?').run(NOW, 'h1');
    expect(() => insertHost(db, 'h2', 'Box')).not.toThrow();
    db.close();
  });

  it('(e) project checkouts cascade with the project and enforce the host FK', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name) VALUES (1, 'p')`).run();
    insertHost(db, 'h1', 'Box');
    db.prepare(`INSERT INTO host_project_checkouts (host_id, project_id, remote_repo_path) VALUES ('h1', 1, '~/r')`).run();
    expect(() =>
      db.prepare(`INSERT INTO host_project_checkouts (host_id, project_id, remote_repo_path) VALUES ('nope', 1, '~/r')`).run(),
    ).toThrow(/FOREIGN KEY/);
    db.prepare('DELETE FROM projects WHERE id = 1').run();
    expect((db.prepare('SELECT COUNT(*) AS n FROM host_project_checkouts').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('(f) no column default uses datetime(now)', () => {
    expect(SQL.replace(/--.*$/gm, '')).not.toMatch(/DEFAULT\s*\(?\s*datetime/i);
  });

  it('(g) lands through DatabaseService.initialize()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-mig152-'));
    const svc = new DatabaseService(join(dir, 'test.db'));
    try {
      svc.initialize();
      const raw = svc.getDb();
      const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
        .map((r) => r.name);
      expect(tables).toEqual(expect.arrayContaining(['hosts', 'host_project_checkouts']));
      expect((raw.prepare(`SELECT label FROM hosts WHERE id='local'`).get() as { label: string }).label).toBe('This Mac');
      expect(cols(raw, 'workflow_runs')).toContain('host_id');
    } finally {
      try { svc.close(); } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
