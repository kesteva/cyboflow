/**
 * Migration 029_artifacts.sql — schema + constraint integration tests.
 *
 * Applies 006 -> 011 -> 014 -> 015 -> 016 -> 029 against an in-memory SQLite
 * instance. Proves:
 *   1. The artifacts table exists with the spec'd columns + indexes.
 *   2. CHECK constraints reject bad atype / mode; accept the valid sets.
 *   3. UNIQUE(run_id, atype) rejects a duplicate artifact per run.
 *   4. run_id FK CASCADEs: deleting a run deletes its artifacts.
 *   5. The entity_events CHECK is widened to accept entity_type='artifact' (and
 *      still accepts the original types; rejects a bogus type).
 *   6. The recreate-rename preserves pre-existing entity_events rows.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIG_DIR = join(__dirname, '..', 'migrations');

function seedProject(db: Database.Database): void {
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
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');
}

function apply(db: Database.Database, files: string[]): void {
  for (const f of files) db.exec(readFileSync(join(MIG_DIR, f), 'utf-8'));
}

const THROUGH_016 = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
];

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  seedProject(db);
  apply(db, [...THROUGH_016, '029_artifacts.sql']);
  return db;
}

function seedRun(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'planner', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, 'wf-1', 1, 'running', 'default')`,
  ).run(runId);
}

function insertArtifact(
  db: Database.Database,
  id: string,
  overrides: Partial<{ runId: string; atype: string; mode: string }> = {},
): void {
  db.prepare('INSERT INTO artifacts (id, run_id, atype, label, mode) VALUES (?, ?, ?, ?, ?)').run(
    id,
    overrides.runId ?? 'run-1',
    overrides.atype ?? 'idea-spec',
    'A label',
    overrides.mode ?? 'template',
  );
}

describe('Migration 029: artifacts + entity_events artifact type', () => {
  it('creates the artifacts table with the spec columns', () => {
    const db = buildDb();
    const cols = (db.prepare('PRAGMA table_info(artifacts)').all() as { name: string }[])
      .map((r) => r.name)
      .sort();
    expect(cols).toEqual(
      [
        'id', 'run_id', 'session_id', 'atype', 'label', 'step_origin', 'mode',
        'committed', 'session_only', 'is_new', 'payload_json', 'source_ref',
        'created_at', 'committed_at',
      ].sort(),
    );
    db.close();
  });

  it('creates the documented indexes', () => {
    const db = buildDb();
    const idx = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'artifacts'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(idx).toContain('idx_artifacts_run');
    expect(idx).toContain('idx_artifacts_run_committed');
    db.close();
  });

  it('CHECK rejects a bad atype, accepts the five valid ones', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    expect(() => insertArtifact(db, 'art_bad', { atype: 'nonsense' })).toThrow(/CHECK/i);
    const valid = ['idea-spec', 'decomposed-stories', 'screenshots', 'ui-prototype', 'generic'];
    valid.forEach((a, i) => {
      expect(() => insertArtifact(db, `art_ok_${i}`, { atype: a, mode: 'canvas' })).not.toThrow();
    });
    db.close();
  });

  it('CHECK rejects a bad mode', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    expect(() => insertArtifact(db, 'art_badmode', { mode: 'weird' })).toThrow(/CHECK/i);
    db.close();
  });

  it('UNIQUE(run_id, atype) rejects a duplicate per run', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    insertArtifact(db, 'art_a', { atype: 'idea-spec' });
    expect(() => insertArtifact(db, 'art_b', { atype: 'idea-spec' })).toThrow(/UNIQUE/i);
    db.close();
  });

  it('run_id FK CASCADEs — deleting a run deletes its artifacts', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    insertArtifact(db, 'art_c', {});
    db.prepare("DELETE FROM workflow_runs WHERE id = 'run-1'").run();
    expect((db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('entity_events now accepts entity_type=artifact (and still the originals)', () => {
    const db = buildDb();
    const ins = (type: string, id: string): void => {
      db.prepare(
        `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor) VALUES (?, ?, 1, 'created', 'user')`,
      ).run(type, id);
    };
    for (const t of ['idea', 'epic', 'task', 'review_item', 'artifact']) {
      expect(() => ins(t, `${t}_x`)).not.toThrow();
    }
    expect(() => ins('project', 'p_x')).toThrow(/CHECK/i);
    db.close();
  });

  it('the recreate-rename preserves pre-existing entity_events rows', () => {
    const db = new Database(':memory:');
    seedProject(db);
    apply(db, THROUGH_016); // up to but NOT including 029
    db.prepare(
      `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor) VALUES ('idea', 'ide_keep', 1, 'created', 'user')`,
    ).run();

    apply(db, ['029_artifacts.sql']);

    const row = db
      .prepare("SELECT entity_type, entity_id, kind FROM entity_events WHERE entity_id = 'ide_keep'")
      .get() as { entity_type: string; entity_id: string; kind: string } | undefined;
    expect(row).toMatchObject({ entity_type: 'idea', entity_id: 'ide_keep', kind: 'created' });
    db.close();
  });
});
