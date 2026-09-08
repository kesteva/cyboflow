/**
 * Migration 099_project_brief_artifact.sql — schema + constraint tests.
 *
 * Applies the artifacts chain 006 -> … -> 073 -> 082 -> 089 -> 099 against an
 * in-memory SQLite instance. Proves:
 *   1. 'project-brief' is insertable alongside every pre-existing atype; a
 *      bogus atype is still rejected by the widened CHECK.
 *   2. The `revision` column (added by 082) survives the 099 recreate — the
 *      row keeps its value and the default is preserved.
 *   3. project-brief is one-per-(run, atype) (NOT per-entity).
 *   4. Pre-existing artifacts rows survive the copy verbatim (incl. revision).
 *   5. The fresh-DB initialize() path also lands the widened CHECK + split indexes.
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

// 082 does `ALTER TABLE sessions ADD COLUMN design_idea_id` — the sessions table
// is Crystal-legacy and not created by any migration in this subset, so create a
// minimal one before 082 runs.
const THROUGH_082 = [
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
  '073_approve_designs_and_per_idea_arch.sql',
];

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  seedProject(db);
  apply(db, THROUGH_082);
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
  apply(db, ['082_design_mode_v0.sql', '089_interactive_prototype.sql', '099_project_brief_artifact.sql']);
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
    overrides.atype ?? 'ui-prototype',
    'A label',
    overrides.mode ?? 'canvas',
    overrides.sourceRef ?? null,
  );
}

describe('Migration 099: project-brief atype', () => {
  it('(a) accepts project-brief alongside every pre-existing atype, rejects a bogus one', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const valid = [
      'idea-spec',
      'decomposed-stories',
      'screenshots',
      'ui-prototype',
      'generic',
      'interactive-prototype',
      'arch-design',
      'compound-recommendations',
      'project-brief',
      'approve-ideas',
      'approve-designs',
      // Carried forward from main's 091/097 recreates — 099's CHECK must not
      // strand rows of either atype outside the constraint.
      'eval-report',
      'verify-runbook',
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

  it('(b) the revision column (082) survives the 099 recreate with its default', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    insertArtifact(db, 'art_rev', { atype: 'project-brief' });
    const row = db.prepare('SELECT revision FROM artifacts WHERE id = ?').get('art_rev') as
      | { revision: number }
      | undefined;
    expect(row?.revision).toBe(1);
  });

  it('(c) project-brief is one-per-(run, atype) (NOT per-entity)', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    expect(() =>
      insertArtifact(db, 'pb_1', { atype: 'project-brief', sourceRef: 'x' }),
    ).not.toThrow();
    // A second project-brief in the SAME run — even with a different
    // source_ref — collides on idx_artifacts_one_per_atype.
    expect(() =>
      insertArtifact(db, 'pb_2', { atype: 'project-brief', sourceRef: 'y' }),
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  it('(d) preserves pre-existing artifacts rows (incl. revision) across the copy', () => {
    const db = new Database(':memory:');
    seedProject(db);
    apply(db, THROUGH_082);
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
    apply(db, ['082_design_mode_v0.sql', '089_interactive_prototype.sql']); // up to but NOT including 099
    seedRun(db, 'run-keep');
    db.prepare(
      `INSERT INTO artifacts (id, run_id, atype, label, mode, payload_json, source_ref, committed, revision)
       VALUES ('art_keep', 'run-keep', 'ui-prototype', 'Keep me', 'canvas', NULL, NULL, 1, 5)`,
    ).run();

    apply(db, ['099_project_brief_artifact.sql']);

    const row = db
      .prepare(
        `SELECT id, run_id, atype, label, mode, payload_json, source_ref, committed, revision
           FROM artifacts WHERE id = 'art_keep'`,
      )
      .get() as Record<string, unknown> | undefined;
    expect(row).toMatchObject({
      id: 'art_keep',
      run_id: 'run-keep',
      atype: 'ui-prototype',
      label: 'Keep me',
      committed: 1,
      revision: 5,
    });
    db.close();
  });

  it('(e) recreates the base + split indexes', () => {
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

  it('(f) the fresh-DB initialize() path includes project-brief + the split indexes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-migration099-'));
    let svc: DatabaseService | undefined;
    try {
      svc = new DatabaseService(join(dir, 'test.db'));
      svc.setMigrationsDirForTesting(join(__dirname, '..', 'migrations'));
      svc.initialize();
      const db = svc.getDb();

      db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/proj-090')`).run();
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
            `INSERT INTO artifacts (id, run_id, atype, label, mode) VALUES ('art_fresh', 'run-1', 'project-brief', 'Brief', 'canvas')`,
          )
          .run(),
      ).not.toThrow();
      // revision defaults to 1 on the fresh-init table.
      expect(
        (db.prepare('SELECT revision FROM artifacts WHERE id = ?').get('art_fresh') as { revision: number })
          .revision,
      ).toBe(1);

      expect(() =>
        db
          .prepare(
            `INSERT INTO artifacts (id, run_id, atype, label, mode) VALUES ('art_fresh_bad', 'run-1', 'nonsense', 'Bad', 'canvas')`,
          )
          .run(),
      ).toThrow(/CHECK/i);
    } finally {
      try { svc?.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
