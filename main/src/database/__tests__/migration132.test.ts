/**
 * Migration 132_custom_views.sql — `custom_views`, `custom_widgets`, and the
 * `widget_action_log` side table (docs/proposals/CUSTOM-VIEWS.md §3.2).
 *
 * Same technique as migration129.test.ts/migration130.test.ts: the FULL real
 * migration chain via DatabaseService.initialize(), from a fresh on-disk DB.
 * All three tables are brand new (`CREATE TABLE IF NOT EXISTS` /
 * `CREATE UNIQUE INDEX IF NOT EXISTS`), so the interesting properties here
 * are the exact column shape, the unique-name-per-surface index, the
 * `widget_action_log` FK/UNIQUE constraints, and that a re-applied file is a
 * true no-op (every statement is idempotent, per AGENTS.md).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const MIGRATION_132 = readFileSync(join(__dirname, '..', 'migrations', '132_custom_views.sql'), 'utf-8');

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration132-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function columnNames(raw: Database.Database, table: string): string[] {
  return (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function tableInfo(raw: Database.Database, table: string): Array<{ name: string; notnull: number; pk: number; dflt_value: unknown }> {
  return raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    notnull: number;
    pk: number;
    dflt_value: unknown;
  }>;
}

describe('Migration 132: Custom Views tables', () => {
  it('creates custom_views with the designed columns and the (surface, name) unique index', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();

    expect(columnNames(raw, 'custom_views')).toEqual([
      'id',
      'surface',
      'name',
      'layout_json',
      'revision',
      'created_at',
      'updated_at',
    ]);

    const indexes = (
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'custom_views'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain('idx_custom_views_surface_name');

    const insert = raw.prepare(
      `INSERT INTO custom_views (id, surface, name, layout_json) VALUES (?, ?, ?, ?)`,
    );
    insert.run('v1', 'review-queue', 'My View', '{"version":1,"items":[]}');
    // Case-insensitive collision on the same surface is rejected.
    expect(() => insert.run('v2', 'review-queue', 'my view', '{"version":1,"items":[]}')).toThrow(/UNIQUE/i);
    // Same name on a DIFFERENT surface is fine — the index is per-surface.
    expect(() => insert.run('v3', 'project-overview', 'My View', '{"version":1,"items":[]}')).not.toThrow();
    // An unknown surface is rejected by the CHECK constraint.
    expect(() => insert.run('v4', 'bogus-surface', 'Other', '{"version":1,"items":[]}')).toThrow(/CHECK constraint/i);

    raw.close();
  });

  it('creates custom_widgets with the designed columns, defaulting revision to 1', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();

    expect(columnNames(raw, 'custom_widgets')).toEqual([
      'id',
      'name',
      'description',
      'published_spec_json',
      'draft_spec_json',
      'authoring_session_id',
      'revision',
      'thread_id',
      'created_at',
      'updated_at',
    ]);

    raw.prepare(`INSERT INTO custom_widgets (id, name) VALUES ('w1', 'My Widget')`).run();
    expect(raw.prepare(`SELECT revision, published_spec_json, draft_spec_json FROM custom_widgets WHERE id = 'w1'`).get()).toEqual({
      revision: 1,
      published_spec_json: null,
      draft_spec_json: null,
    });

    raw.close();
  });

  it('creates widget_action_log with a UNIQUE operation_id and CASCADEs off agent_proposals', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();
    raw.pragma('foreign_keys = ON');

    expect(columnNames(raw, 'widget_action_log')).toEqual([
      'proposal_id',
      'operation_id',
      'view_id',
      'view_revision',
      'instance_id',
      'action_id',
      'created_at',
    ]);

    raw.prepare(`INSERT INTO agent_threads (id) VALUES ('t1')`).run();
    raw
      .prepare(
        `INSERT INTO agent_proposals (id, thread_id, kind, payload_json) VALUES ('p1', 't1', 'launch-run', '{}')`,
      )
      .run();
    const insertLog = raw.prepare(
      `INSERT INTO widget_action_log (proposal_id, operation_id, view_id, view_revision, instance_id, action_id)
       VALUES (?, ?, 'view-1', 1, 'instance-1', 'action-1')`,
    );
    insertLog.run('p1', 'op-1');

    // operation_id is UNIQUE — a second row (even for a different proposal) with the same op id is rejected.
    raw
      .prepare(`INSERT INTO agent_proposals (id, thread_id, kind, payload_json) VALUES ('p2', 't1', 'launch-run', '{}')`)
      .run();
    expect(() => insertLog.run('p2', 'op-1')).toThrow(/UNIQUE/i);

    // FK CASCADEs off agent_proposals, matching every other proposal-scoped child row.
    raw.prepare(`DELETE FROM agent_proposals WHERE id = 'p1'`).run();
    expect(raw.prepare(`SELECT COUNT(*) AS n FROM widget_action_log WHERE proposal_id = 'p1'`).get()).toEqual({ n: 0 });

    raw.close();
  });

  it('is idempotent: re-applying 132 directly is a no-op (same columns, existing rows untouched)', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();

    raw.prepare(`INSERT INTO custom_views (id, surface, name, layout_json) VALUES ('v1', 'review-queue', 'My View', '{"version":1,"items":[]}')`).run();
    raw.prepare(`INSERT INTO custom_widgets (id, name) VALUES ('w1', 'My Widget')`).run();

    const beforeViews = tableInfo(raw, 'custom_views');
    const beforeWidgets = tableInfo(raw, 'custom_widgets');
    const beforeLog = tableInfo(raw, 'widget_action_log');

    expect(() => raw.exec(MIGRATION_132)).not.toThrow();

    expect(tableInfo(raw, 'custom_views')).toEqual(beforeViews);
    expect(tableInfo(raw, 'custom_widgets')).toEqual(beforeWidgets);
    expect(tableInfo(raw, 'widget_action_log')).toEqual(beforeLog);
    expect(raw.prepare(`SELECT id, name FROM custom_views WHERE id = 'v1'`).get()).toEqual({ id: 'v1', name: 'My View' });
    expect(raw.prepare(`SELECT id, name FROM custom_widgets WHERE id = 'w1'`).get()).toEqual({ id: 'w1', name: 'My Widget' });

    raw.close();
  });

  it('replay convergence: a ledger-wiped re-run reproduces the same three tables and preserves existing rows', () => {
    const svc1 = new DatabaseService(dbPath);
    svc1.initialize();
    const raw1 = svc1.getDb();
    raw1.prepare(`INSERT INTO custom_views (id, surface, name, layout_json) VALUES ('v1', 'review-queue', 'My View', '{"version":1,"items":[]}')`).run();
    raw1.close();

    const rawWipe = new Database(dbPath);
    rawWipe.prepare("DELETE FROM user_preferences WHERE key LIKE 'file_migration_applied:%'").run();
    rawWipe.close();

    const svc2 = new DatabaseService(dbPath);
    expect(() => svc2.initialize()).not.toThrow();
    const raw2 = svc2.getDb();

    expect(columnNames(raw2, 'custom_views')).toEqual(['id', 'surface', 'name', 'layout_json', 'revision', 'created_at', 'updated_at']);
    expect(raw2.prepare(`SELECT id, name FROM custom_views WHERE id = 'v1'`).get()).toEqual({ id: 'v1', name: 'My View' });

    raw2.close();
  });
});
