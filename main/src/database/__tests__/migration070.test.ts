/**
 * Migration 070_approve_designs_and_per_idea_arch.sql — schema + constraint tests.
 *
 * Applies the artifacts chain 006 -> … -> 045 -> 060 -> 062 -> 063 -> 070 against
 * an in-memory SQLite instance. Proves:
 *   1. 'approve-designs' is insertable alongside every pre-existing atype; a bogus
 *      atype is still rejected by the widened CHECK.
 *   2. arch-design is now PER-ENTITY: two arch-design rows with DIFFERENT
 *      source_ref coexist in one run; a duplicate (run, atype, source_ref) is
 *      rejected — mirroring what 063 did for idea-spec.
 *   3. idea-spec stays per-entity (unchanged by 070).
 *   4. A non-per-entity atype (approve-ideas / generic) is still strictly
 *      one-per-(run, atype).
 *   5. Pre-existing artifacts rows survive the copy verbatim.
 *   6. The fresh-DB initialize() path also lands the widened CHECK + split indexes.
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

const THROUGH_063 = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  '035_artifacts.sql',
  '045_arch_design_atype.sql',
  '060_compound_recommendations_atype.sql',
  '062_approve_ideas_atype.sql',
  '063_per_idea_spec_artifacts.sql',
];

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  seedProject(db);
  apply(db, [...THROUGH_063, '070_approve_designs_and_per_idea_arch.sql']);
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
  overrides: Partial<{ runId: string; atype: string; mode: string; sourceRef: string | null }> = {},
): void {
  db.prepare(
    'INSERT INTO artifacts (id, run_id, atype, label, mode, source_ref) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    overrides.runId ?? 'run-1',
    overrides.atype ?? 'idea-spec',
    'A label',
    overrides.mode ?? 'template',
    overrides.sourceRef ?? null,
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

describe('Migration 070: approve-designs atype + per-idea arch-design', () => {
  it('(a) accepts approve-designs alongside every pre-existing atype, rejects a bogus one', () => {
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
      'approve-designs',
    ];
    valid.forEach((a, i) => {
      // Distinct source_ref so the per-entity atypes don't self-collide here.
      expect(() =>
        insertArtifact(db, `art_ok_${i}`, { atype: a, mode: 'canvas', sourceRef: `src_${i}` }),
      ).not.toThrow();
    });
    expect(() => insertArtifact(db, 'art_bad', { atype: 'nonsense' })).toThrow(/CHECK/i);
    db.close();
  });

  it('(b) arch-design is per-entity: distinct source_ref coexist, duplicate (run,atype,source_ref) rejected', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    expect(() =>
      insertArtifact(db, 'arch_a', { atype: 'arch-design', sourceRef: 'ide_1' }),
    ).not.toThrow();
    expect(() =>
      insertArtifact(db, 'arch_b', { atype: 'arch-design', sourceRef: 'ide_2' }),
    ).not.toThrow();
    // Same (run, atype, source_ref) → unique-index violation.
    expect(() =>
      insertArtifact(db, 'arch_dup', { atype: 'arch-design', sourceRef: 'ide_1' }),
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  it('(c) idea-spec stays per-entity (unchanged)', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    expect(() =>
      insertArtifact(db, 'spec_a', { atype: 'idea-spec', sourceRef: 'ide_1' }),
    ).not.toThrow();
    expect(() =>
      insertArtifact(db, 'spec_b', { atype: 'idea-spec', sourceRef: 'ide_2' }),
    ).not.toThrow();
    expect(() =>
      insertArtifact(db, 'spec_dup', { atype: 'idea-spec', sourceRef: 'ide_1' }),
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  it('(d) a non-per-entity atype (approve-ideas / generic) is still one-per-(run, atype)', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    expect(() =>
      insertArtifact(db, 'ai_1', { atype: 'approve-ideas', mode: 'canvas', sourceRef: 'x' }),
    ).not.toThrow();
    // A second approve-ideas in the SAME run — even with a different source_ref —
    // collides on idx_artifacts_one_per_atype (approve-ideas is NOT per-entity).
    expect(() =>
      insertArtifact(db, 'ai_2', { atype: 'approve-ideas', mode: 'canvas', sourceRef: 'y' }),
    ).toThrow(/UNIQUE/i);
    // approve-designs is likewise one-per-(run, atype).
    expect(() =>
      insertArtifact(db, 'ad_1', { atype: 'approve-designs', mode: 'canvas', sourceRef: 'x' }),
    ).not.toThrow();
    expect(() =>
      insertArtifact(db, 'ad_2', { atype: 'approve-designs', mode: 'canvas', sourceRef: 'y' }),
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  it('(e) preserves pre-existing artifacts rows across the copy', () => {
    const db = new Database(':memory:');
    seedProject(db);
    apply(db, THROUGH_063); // up to but NOT including 070
    seedRun(db, 'run-keep');
    db.prepare(
      `INSERT INTO artifacts (id, run_id, atype, label, mode, payload_json, source_ref, committed)
       VALUES ('art_keep', 'run-keep', 'arch-design', 'Keep me', 'template', NULL, 'ide_1', 1)`,
    ).run();

    apply(db, ['070_approve_designs_and_per_idea_arch.sql']);

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

  it('(f) recreates the base indexes', () => {
    const db = buildDb();
    const idx = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'artifacts'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(idx).toContain('idx_artifacts_run');
    expect(idx).toContain('idx_artifacts_run_committed');
    expect(idx).toContain('idx_artifacts_one_per_atype');
    expect(idx).toContain('idx_artifacts_per_source');
    db.close();
  });

  it('(g) the fresh-DB initialize() path includes approve-designs + the split indexes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-migration070-'));
    try {
      const svc = new DatabaseService(join(dir, 'test.db'));
      svc.setMigrationsDirForTesting(join(__dirname, '..', 'migrations'));
      svc.initialize();
      const db = svc.getDb();

      const cols = (db.prepare('PRAGMA table_info(artifacts)').all() as TableInfoRow[]).map((c) => c.name);
      expect(cols).toContain('atype');

      db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/proj-070')`).run();
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
            `INSERT INTO artifacts (id, run_id, atype, label, mode) VALUES ('art_fresh', 'run-1', 'approve-designs', 'Approve designs', 'canvas')`,
          )
          .run(),
      ).not.toThrow();

      // Per-entity arch-design survives the fresh-init split index too.
      expect(() =>
        db
          .prepare(
            `INSERT INTO artifacts (id, run_id, atype, label, mode, source_ref) VALUES ('arch_1', 'run-1', 'arch-design', 'Arch', 'template', 'ide_1')`,
          )
          .run(),
      ).not.toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO artifacts (id, run_id, atype, label, mode, source_ref) VALUES ('arch_2', 'run-1', 'arch-design', 'Arch', 'template', 'ide_2')`,
          )
          .run(),
      ).not.toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO artifacts (id, run_id, atype, label, mode, source_ref) VALUES ('arch_dup', 'run-1', 'arch-design', 'Arch', 'template', 'ide_1')`,
          )
          .run(),
      ).toThrow(/UNIQUE/i);

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
