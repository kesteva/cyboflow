/**
 * Migration 062_approve_ideas_atype.sql — schema + constraint integration tests.
 *
 * Applies 006 -> 011 -> 014 -> 015 -> 016 -> 035 -> 045 -> 062 against an
 * in-memory SQLite instance. Proves:
 *   1. 'approve-ideas' is insertable alongside the pre-existing atypes (incl. 060's compound-recommendations).
 *   2. A bogus atype is still rejected by the widened CHECK.
 *   3. Pre-existing artifacts rows survive the copy verbatim.
 *   4. The documented indexes are preserved.
 *   5. The fresh-DB initialize() path (which runs every numbered migration in
 *      order) also lands the widened CHECK.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../database';

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

const THROUGH_045 = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  '035_artifacts.sql',
  '045_arch_design_atype.sql',
];

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  seedProject(db);
  apply(db, [...THROUGH_045, '062_approve_ideas_atype.sql']);
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

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

describe('Migration 062: approve-ideas artifact atype', () => {
  it('(a) accepts approve-ideas alongside the seven pre-existing atypes, rejects a bogus one', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const valid = [
      'idea-spec',
      'decomposed-stories',
      'screenshots',
      'ui-prototype',
      'generic',
      'arch-design',
      'compound-recommendations',
      'approve-ideas',
    ];
    valid.forEach((a, i) => {
      expect(() => insertArtifact(db, `art_ok_${i}`, { atype: a, mode: 'canvas' })).not.toThrow();
    });
    expect(() => insertArtifact(db, 'art_bad', { atype: 'nonsense' })).toThrow(/CHECK/i);
    db.close();
  });

  it('(b) unknown atype is still rejected by the CHECK', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    expect(() => insertArtifact(db, 'art_bad_2', { atype: 'not-a-real-atype' })).toThrow(/CHECK/i);
    db.close();
  });

  it('(c) preserves pre-existing artifacts rows across the copy', () => {
    const db = new Database(':memory:');
    seedProject(db);
    apply(db, THROUGH_045); // up to but NOT including 062
    seedRun(db, 'run-keep');
    db.prepare(
      `INSERT INTO artifacts (id, run_id, atype, label, mode, payload_json, source_ref, committed)
       VALUES ('art_keep', 'run-keep', 'arch-design', 'Keep me', 'template', NULL, 'ide_1', 1)`,
    ).run();

    apply(db, ['062_approve_ideas_atype.sql']);

    const row = db
      .prepare(
        `SELECT id, run_id, atype, label, mode, payload_json, source_ref, committed
           FROM artifacts WHERE id = 'art_keep'`,
      )
      .get() as Record<string, unknown> | undefined;
    expect(row).toMatchObject({
      id: 'art_keep',
      run_id: 'run-keep',
      atype: 'arch-design',
      label: 'Keep me',
      mode: 'template',
      payload_json: null,
      source_ref: 'ide_1',
      committed: 1,
    });
    db.close();
  });

  it('(d) recreates both documented indexes', () => {
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

  it('(e) the fresh-DB initialize() path includes approve-ideas in the atype CHECK', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-migration062-'));
    try {
      const svc = new DatabaseService(join(dir, 'test.db'));
      svc.setMigrationsDirForTesting(join(__dirname, '..', 'migrations'));
      svc.initialize();
      const db = svc.getDb();

      const cols = (db.prepare('PRAGMA table_info(artifacts)').all() as TableInfoRow[]).map((c) => c.name);
      expect(cols).toContain('atype');

      db.prepare(
        `INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/proj-062')`,
      ).run();
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'planner', '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
         VALUES ('run-1', 'wf-1', 1, 'running', 'default')`,
      ).run();

      expect(() =>
        db
          .prepare(
            `INSERT INTO artifacts (id, run_id, atype, label, mode) VALUES ('art_fresh', 'run-1', 'approve-ideas', 'Approve ideas', 'canvas')`,
          )
          .run(),
      ).not.toThrow();

      expect(() =>
        db
          .prepare(
            `INSERT INTO artifacts (id, run_id, atype, label, mode) VALUES ('art_fresh_bad', 'run-1', 'nonsense', 'Bad', 'canvas')`,
          )
          .run(),
      ).toThrow(/CHECK/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
