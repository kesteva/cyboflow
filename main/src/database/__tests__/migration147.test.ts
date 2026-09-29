/**
 * Migration 147_session_web_tabs.sql — web-viewer tab rows + the web audit trail.
 *
 * (a)-(c) run the file over a minimal `sessions` base; (d) proves it lands
 * through the real DatabaseService.initialize() chain.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../database';

const MIG_DIR = join(__dirname, '..', 'migrations');
const SQL = readFileSync(join(MIG_DIR, '147_session_web_tabs.sql'), 'utf-8');

function baseDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT);`);
  db.prepare(`INSERT INTO sessions (id, name) VALUES ('s1', 'one')`).run();
  return db;
}

function insertTab(db: Database.Database, id: string, openedBy = 'user'): void {
  db.prepare(
    `INSERT INTO session_web_tabs (id, session_id, initial_url, position, opened_by)
     VALUES (?, 's1', 'https://example.com/', 0, ?)`,
  ).run(id, openedBy);
}

describe('migration 147 — session_web_tabs + session_web_events', () => {
  it('(a) creates both tables and their indexes', () => {
    const db = baseDb();
    db.exec(SQL);
    const names = (db.prepare(`SELECT name FROM sqlite_master`).all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'session_web_tabs',
        'session_web_events',
        'idx_session_web_tabs_session',
        'idx_session_web_events_session',
      ]),
    );
    db.close();
  });

  it('(b) is idempotent — the ledger tracks by filename, so a renumber re-applies it', () => {
    const db = baseDb();
    db.exec(SQL);
    insertTab(db, 'web:a');
    expect(() => db.exec(SQL)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM session_web_tabs').get()).toEqual({ n: 1 });
    db.close();
  });

  it('(c) constrains opened_by and cascades both tables on a REAL session delete', () => {
    const db = baseDb();
    db.exec(SQL);
    expect(() => insertTab(db, 'web:bad', 'robot')).toThrow(/CHECK/);
    insertTab(db, 'web:a');
    db.prepare(
      `INSERT INTO session_web_events (id, session_id, kind, created_at) VALUES ('e1', 's1', 'tab_opened', 'x')`,
    ).run();
    db.prepare(`DELETE FROM sessions WHERE id = 's1'`).run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM session_web_tabs').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM session_web_events').get()).toEqual({ n: 0 });
    db.close();
  });

  it('(d) a fresh DatabaseService.initialize() run applies the migration cleanly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-migration147-'));
    let svc: DatabaseService | undefined;
    try {
      svc = new DatabaseService(join(dir, 'test.db'));
      svc.setMigrationsDirForTesting(MIG_DIR);
      svc.initialize();
      const cols = (svc.getDb().prepare('PRAGMA table_info(session_web_tabs)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(cols).toEqual(
        expect.arrayContaining(['id', 'session_id', 'initial_url', 'human_touched', 'opened_by_run_id']),
      );
    } finally {
      try { svc?.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
