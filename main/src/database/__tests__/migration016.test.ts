/**
 * Migration 016_review_items.sql — schema + constraint integration tests.
 *
 * Applies 006 -> 011 -> 014 -> 015 -> 016 against an in-memory SQLite instance
 * (with a minimal `projects` table seeded first so the FKs + project-scoped seed
 * have something to attach to). Proves:
 *   1. The review_items table exists with the spec'd columns.
 *   2. The three indexes exist: (project_id,status), (run_id,kind), (blocking,status).
 *   3. CHECK constraints reject bad kind / status / severity / entity_type.
 *   4. project_id FK CASCADEs: deleting a project deletes its review items.
 *   5. run_id FK SET NULLs: deleting a run nulls the link, item survives.
 *   6. The soft polymorphic entity link has NO hard FK (a dangling entity_id is
 *      accepted at the SQL layer — code validates it).
 *   7. Forward-only: re-applying 016 is a no-op (idempotent CREATE/indexes).
 *
 * Field-for-field row-shape parity (ReviewItemRow) lives in
 * entitySchemaParity.test.ts.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj One', '/tmp/p1');
  db.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Proj Two', '/tmp/p2');

  const migDir = join(__dirname, '..', 'migrations');
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
  db.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
  return db;
}

/** Seed a workflow + workflow_run so review_items.run_id has a real parent. */
function seedRun(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, 'wf-1', 1, 'running', 'default')`,
  ).run(runId);
}

/** Insert a minimal valid review item. */
function insertItem(
  db: Database.Database,
  id: string,
  overrides: Partial<{
    projectId: number;
    runId: string | null;
    entityType: string | null;
    entityId: string | null;
    kind: string;
    status: string;
    blocking: number;
    severity: string | null;
  }> = {},
): void {
  db.prepare(
    `INSERT INTO review_items
       (id, project_id, run_id, entity_type, entity_id, kind, status, blocking, title, severity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    overrides.projectId ?? 1,
    overrides.runId ?? null,
    overrides.entityType ?? null,
    overrides.entityId ?? null,
    overrides.kind ?? 'finding',
    overrides.status ?? 'pending',
    overrides.blocking ?? 0,
    'A title',
    overrides.severity ?? null,
  );
}

describe('Migration 016: review_items unified inbox', () => {
  it('creates the review_items table with the spec columns', () => {
    const db = buildDb();
    const cols = (db.prepare('PRAGMA table_info(review_items)').all() as { name: string }[])
      .map((r) => r.name)
      .sort();
    expect(cols).toEqual(
      [
        'id',
        'project_id',
        'run_id',
        'entity_type',
        'entity_id',
        'kind',
        'status',
        'blocking',
        'title',
        'body',
        'severity',
        'source',
        'payload_json',
        'created_at',
        'updated_at',
        'resolved_by',
        'resolution',
      ].sort(),
    );
    db.close();
  });

  it('creates the three documented indexes', () => {
    const db = buildDb();
    const idx = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'review_items'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(idx).toContain('idx_review_items_project_status');
    expect(idx).toContain('idx_review_items_run_kind');
    expect(idx).toContain('idx_review_items_blocking_status');
    db.close();
  });

  it('CHECK rejects an invalid kind', () => {
    const db = buildDb();
    expect(() => insertItem(db, 'rvw_badkind', { kind: 'nonsense' })).toThrow(/CHECK/i);
    db.close();
  });

  it('CHECK rejects an invalid status', () => {
    const db = buildDb();
    expect(() => insertItem(db, 'rvw_badstatus', { status: 'in_progress' })).toThrow(/CHECK/i);
    db.close();
  });

  it('CHECK rejects an invalid severity but accepts NULL severity', () => {
    const db = buildDb();
    expect(() => insertItem(db, 'rvw_badsev', { severity: 'fatal' })).toThrow(/CHECK/i);
    expect(() => insertItem(db, 'rvw_nullsev', { severity: null })).not.toThrow();
    db.close();
  });

  it('CHECK rejects an invalid entity_type but accepts the three entity types + NULL', () => {
    const db = buildDb();
    expect(() => insertItem(db, 'rvw_badentity', { entityType: 'project', entityId: 'p1' })).toThrow(/CHECK/i);
    for (const t of ['idea', 'epic', 'task']) {
      expect(() => insertItem(db, `rvw_${t}`, { entityType: t, entityId: `${t}_x` })).not.toThrow();
    }
    expect(() => insertItem(db, 'rvw_noentity', { entityType: null, entityId: null })).not.toThrow();
    db.close();
  });

  it('accepts all four kinds and all three statuses', () => {
    const db = buildDb();
    for (const k of ['finding', 'permission', 'decision', 'human_task']) {
      expect(() => insertItem(db, `rvw_k_${k}`, { kind: k })).not.toThrow();
    }
    for (const s of ['pending', 'resolved', 'dismissed']) {
      expect(() => insertItem(db, `rvw_s_${s}`, { status: s })).not.toThrow();
    }
    db.close();
  });

  it('project_id FK CASCADEs — deleting a project deletes its review items', () => {
    const db = buildDb();
    insertItem(db, 'rvw_p1', { projectId: 1 });
    insertItem(db, 'rvw_p2', { projectId: 2 });
    db.prepare('DELETE FROM projects WHERE id = 1').run();
    const remaining = db.prepare('SELECT id FROM review_items ORDER BY id').all() as { id: string }[];
    expect(remaining.map((r) => r.id)).toEqual(['rvw_p2']);
    db.close();
  });

  it('run_id FK SET NULLs — deleting a run nulls the link but the item survives', () => {
    const db = buildDb();
    seedRun(db, 'run-a');
    insertItem(db, 'rvw_run', { runId: 'run-a' });
    db.prepare("DELETE FROM workflow_runs WHERE id = 'run-a'").run();
    const row = db.prepare('SELECT run_id FROM review_items WHERE id = ?').get('rvw_run') as {
      run_id: string | null;
    };
    expect(row.run_id).toBeNull();
    db.close();
  });

  it('soft polymorphic entity link has NO hard FK — a dangling entity_id is accepted at the SQL layer', () => {
    const db = buildDb();
    // entity_id points at a non-existent task; SQL accepts it (code validates).
    expect(() =>
      insertItem(db, 'rvw_dangling', { entityType: 'task', entityId: 'tsk_does_not_exist' }),
    ).not.toThrow();
    db.close();
  });

  it('is idempotent — re-applying 016 does not error or duplicate rows', () => {
    const db = buildDb();
    insertItem(db, 'rvw_idem', {});
    const migDir = join(__dirname, '..', 'migrations');
    db.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
    const count = (db.prepare('SELECT COUNT(*) AS n FROM review_items').get() as { n: number }).n;
    expect(count).toBe(1);
    db.close();
  });
});
