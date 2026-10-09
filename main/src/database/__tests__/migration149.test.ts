/**
 * Migration 149_remote_sync.sql + the tombstone triggers (remoteSyncTriggers.ts).
 *
 * (a) the migration is idempotent; (b)-(f) run the real DatabaseService chain
 * and pin the trigger contract: tombstones only for opted-in projects, never
 * for experiment rows or a project removal, and a table rebuild that drops the
 * triggers is repaired by the next initialize().
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../database';
import { remoteSyncTriggerName, ensureRemoteSyncTriggers } from '../remoteSyncTriggers';

const MIG_DIR = join(__dirname, '..', 'migrations');
const SQL = readFileSync(join(MIG_DIR, '149_remote_sync.sql'), 'utf-8');
const TRIGGERS = ['ideas', 'epics', 'tasks'].map(remoteSyncTriggerName);

describe('migration 149 — remote sync tables', () => {
  it('(a) creates every table and is idempotent', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT);`);
    db.exec(SQL);
    expect(() => db.exec(SQL)).not.toThrow();
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'remote_sync_device',
        'remote_sync_projects',
        'remote_sync_entities',
        'remote_sync_tombstones',
        'remote_sync_batches',
        'remote_sync_conflicts',
        'remote_sync_tracker_claims',
        'entity_ref_aliases',
      ]),
    );
    // No CHECK constraints anywhere (migration 130's lesson).
    const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE name LIKE 'remote_sync_%' OR name = 'entity_ref_aliases'`)
      .all() as Array<{ sql: string | null }>).map((r) => r.sql ?? '');
    expect(ddl.join('\n')).not.toMatch(/\bCHECK\s*\(/i);
    db.close();
  });
});

describe('remote sync tombstone triggers (full chain)', () => {
  let dir: string;
  let svc: DatabaseService;
  let db: BetterSqlite3.Database;
  let synced: number;
  let unsynced: number;

  const now = new Date().toISOString();
  const stage = (pid: number, pos: number): string => `stage-board-${pid}-default-${pos}`;

  function insertIdea(pid: number, id: string, experimentId: string | null = null): void {
    db.prepare(
      `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id, experiment_id)
       VALUES (?, ?, ?, 't', ?, ?, ?)`,
    ).run(id, pid, `IDEA-${id}`, `board-${pid}-default`, stage(pid, 1), experimentId);
  }
  function insertEpic(pid: number, id: string, ideaId: string | null): void {
    db.prepare(
      `INSERT INTO epics (id, project_id, ref, title, board_id, stage_id, originating_idea_id)
       VALUES (?, ?, ?, 't', ?, ?, ?)`,
    ).run(id, pid, `EPIC-${id}`, `board-${pid}-default`, stage(pid, 1), ideaId);
  }
  function insertTask(pid: number, id: string, epicId: string | null): void {
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id, parent_epic_id)
       VALUES (?, ?, ?, 't', ?, ?, ?)`,
    ).run(id, pid, `TASK-${id}`, `board-${pid}-default`, stage(pid, 1), epicId);
  }
  function optIn(pid: number): void {
    db.prepare(`INSERT INTO remote_sync_projects (project_id, created_at, updated_at) VALUES (?, ?, ?)`).run(pid, now, now);
  }
  function tombstones(): Array<{ entity_type: string; entity_id: string; project_id: number; ref: string }> {
    return db
      .prepare(`SELECT entity_type, entity_id, project_id, ref FROM remote_sync_tombstones ORDER BY entity_id`)
      .all() as Array<{ entity_type: string; entity_id: string; project_id: number; ref: string }>;
  }
  function triggerNames(): string[] {
    return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'remote_sync_%' ORDER BY name`)
      .all() as Array<{ name: string }>).map((r) => r.name);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cyboflow-migration149-'));
    svc = new DatabaseService(join(dir, 'test.db'));
    svc.setMigrationsDirForTesting(MIG_DIR);
    svc.initialize();
    db = svc.getDb();
    synced = svc.createProject('Synced', join(dir, 'a')).id;
    unsynced = svc.createProject('Local', join(dir, 'b')).id;
    optIn(synced);
  });

  afterEach(() => {
    try { svc.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it('(b) initialize() installs one trigger per entity table', () => {
    expect(triggerNames()).toEqual([...TRIGGERS].sort());
  });

  it('(c) records a tombstone per deleted entity in an opted-in project only', () => {
    insertIdea(synced, 'i1');
    insertTask(synced, 't1', null);
    insertIdea(unsynced, 'i2');
    db.prepare(`DELETE FROM ideas WHERE id IN ('i1', 'i2')`).run();
    db.prepare(`DELETE FROM tasks WHERE id = 't1'`).run();
    expect(tombstones()).toEqual([
      { entity_type: 'idea', entity_id: 'i1', project_id: synced, ref: 'IDEA-i1' },
      { entity_type: 'task', entity_id: 't1', project_id: synced, ref: 'TASK-t1' },
    ]);
  });

  it('(d) skips experiment-sandbox rows, and a parent delete never tombstones SET NULL children', () => {
    insertIdea(synced, 'iexp', 'exp-1');
    insertIdea(synced, 'i1');
    insertEpic(synced, 'e1', 'i1');
    insertTask(synced, 't1', 'e1');
    db.prepare(`DELETE FROM ideas WHERE id = 'iexp'`).run();
    db.prepare(`DELETE FROM ideas WHERE id = 'i1'`).run();
    expect(tombstones().map((t) => t.entity_id)).toEqual(['i1']);
    const epic = db.prepare(`SELECT originating_idea_id FROM epics WHERE id = 'e1'`).get() as { originating_idea_id: string | null };
    expect(epic.originating_idea_id).toBeNull();
  });

  it('(e) removing a project records nothing and cascades its sync rows away', () => {
    insertIdea(synced, 'i1');
    insertTask(synced, 't1', null);
    db.prepare(
      `INSERT INTO remote_sync_entities (entity_type, entity_id, project_id, updated_at) VALUES ('idea', 'i1', ?, ?)`,
    ).run(synced, now);
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(synced);
    expect(tombstones()).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM remote_sync_projects`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM remote_sync_entities`).get()).toEqual({ n: 0 });
  });

  it('(f) a table rebuild drops the triggers and the next initialize() restores them', () => {
    // The shape a future rebuild migration would take.
    const { sql: ideasDdl } = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ideas'`).get() as { sql: string };
    db.pragma('foreign_keys = OFF');
    db.exec(`
      ${ideasDdl.replace(/^CREATE TABLE (IF NOT EXISTS )?"?ideas"?/, 'CREATE TABLE ideas_rebuilt')};
      INSERT INTO ideas_rebuilt SELECT * FROM ideas;
      DROP TABLE ideas;
      ALTER TABLE ideas_rebuilt RENAME TO ideas;
    `);
    db.pragma('foreign_keys = ON');
    expect(triggerNames()).not.toContain(remoteSyncTriggerName('ideas'));

    svc.close();
    svc = new DatabaseService(join(dir, 'test.db'));
    svc.setMigrationsDirForTesting(MIG_DIR);
    svc.initialize();
    db = svc.getDb();
    expect(triggerNames()).toEqual([...TRIGGERS].sort());

    insertIdea(synced, 'i9');
    db.prepare(`DELETE FROM ideas WHERE id = 'i9'`).run();
    expect(tombstones().map((t) => t.entity_id)).toEqual(['i9']);
  });

  it('(g) ensureRemoteSyncTriggers is a no-op before migration 149', () => {
    const bare = new Database(':memory:');
    bare.exec(`CREATE TABLE ideas (id TEXT PRIMARY KEY, project_id INTEGER, ref TEXT, experiment_id TEXT)`);
    expect(() => ensureRemoteSyncTriggers(bare)).not.toThrow();
    expect(bare.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'`).get()).toEqual({ n: 0 });
    bare.close();
  });
});
