/**
 * Migration 097_verify_runbook_atype.sql — schema + constraint tests.
 *
 * Applies the artifacts chain 006 -> … -> 073 -> 088 -> 089 -> 091 -> 097
 * against an in-memory SQLite instance (mirroring migration091.test.ts). Proves:
 *   1. 'verify-runbook' is insertable alongside every pre-existing atype; a
 *      bogus atype is still rejected by the widened CHECK.
 *   2. 'verify-runbook' is NOT per-entity: it stays strictly one-per-(run,
 *      atype), which is what makes the prove step's write ENRICH the proposal
 *      the approve-runbook gate already reviewed rather than open a second tab.
 *   3. 073's per-entity split (idea-spec + arch-design) survives the recreate.
 *   4. Pre-existing artifacts rows survive the copy verbatim.
 *   5. The base + split indexes are recreated.
 *   6. The fresh-DB initialize() path also lands the widened CHECK.
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

/**
 * The artifacts-recreate chain, in order. Each recreate names its OWN atype
 * list, so applying them out of order would silently drop a later atype back
 * out of the CHECK — the ordering is load-bearing, not incidental.
 */
const THROUGH_091 = [
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
  '088_artifacts_revision_ensure.sql',
  '089_interactive_prototype.sql',
  '091_eval_report_atype.sql',
];

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  seedProject(db);
  apply(db, [...THROUGH_091, '097_verify_runbook_atype.sql']);
  return db;
}

function seedRun(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'verify-setup', '{}')`,
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

describe('Migration 097: verify-runbook artifact atype', () => {
  it('(a) accepts verify-runbook alongside every pre-existing atype, rejects a bogus one', () => {
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
      'approve-ideas',
      'approve-designs',
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

  it('(b) verify-runbook is one-per-(run, atype) — the prove step ENRICHES the reviewed doc', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    seedRun(db, 'run-2');
    insertArtifact(db, 'art_vr_1', { runId: 'run-1', atype: 'verify-runbook' });
    // A second on the SAME run collides (so the write is an upsert, and the
    // human's approve-runbook surface is the same document the outcomes land on).
    expect(() => insertArtifact(db, 'art_vr_2', { runId: 'run-1', atype: 'verify-runbook' })).toThrow(
      /UNIQUE/i,
    );
    // A different run gets its own.
    expect(() => insertArtifact(db, 'art_vr_3', { runId: 'run-2', atype: 'verify-runbook' })).not.toThrow();
    db.close();
  });

  it("(c) 073's per-entity split survives the recreate (idea-spec + arch-design keyed by source_ref)", () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    expect(() => insertArtifact(db, 'a1', { atype: 'idea-spec', sourceRef: 'ide_1' })).not.toThrow();
    expect(() => insertArtifact(db, 'a2', { atype: 'idea-spec', sourceRef: 'ide_2' })).not.toThrow();
    expect(() => insertArtifact(db, 'a3', { atype: 'idea-spec', sourceRef: 'ide_1' })).toThrow(/UNIQUE/i);
    expect(() => insertArtifact(db, 'a4', { atype: 'arch-design', sourceRef: 'ide_1' })).not.toThrow();
    expect(() => insertArtifact(db, 'a5', { atype: 'arch-design', sourceRef: 'ide_1' })).toThrow(/UNIQUE/i);
    db.close();
  });

  it('(d) pre-existing rows survive the copy, revision included', () => {
    const db = new Database(':memory:');
    seedProject(db);
    apply(db, THROUGH_091);
    seedRun(db, 'run-1');
    db.prepare(
      `INSERT INTO artifacts (id, run_id, atype, label, mode, source_ref, committed_at, revision)
       VALUES ('art_pre', 'run-1', 'idea-spec', 'Pre-existing', 'template', 'ide_1', '2026-07-01T00:00:00.000Z', 3)`,
    ).run();

    apply(db, ['097_verify_runbook_atype.sql']);

    expect(
      db
        .prepare('SELECT atype, label, mode, source_ref, committed_at, revision FROM artifacts WHERE id = ?')
        .get('art_pre'),
    ).toMatchObject({
      atype: 'idea-spec',
      label: 'Pre-existing',
      mode: 'template',
      source_ref: 'ide_1',
      committed_at: '2026-07-01T00:00:00.000Z',
      revision: 3,
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

  it('(f) the fresh-DB initialize() path includes verify-runbook in the atype CHECK', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-migration097-'));
    let svc: DatabaseService | undefined;
    try {
      svc = new DatabaseService(join(dir, 'test.db'));
      svc.setMigrationsDirForTesting(join(__dirname, '..', 'migrations'));
      svc.initialize();
      const db = svc.getDb();

      db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/proj-097')`).run();
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'verify-setup', '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
         VALUES ('run-1', 'wf-1', 1, 'running', 'default')`,
      ).run();

      expect(() =>
        db
          .prepare(
            `INSERT INTO artifacts (id, run_id, atype, label, mode) VALUES ('art_fresh', 'run-1', 'verify-runbook', 'Runbook proposal', 'template')`,
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
      try { svc?.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
