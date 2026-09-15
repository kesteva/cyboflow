/**
 * Migration 135_adversarial_review_atype.sql — schema + constraint tests.
 *
 * Applies the artifacts chain 006 -> … -> 073 -> 088 -> 089 -> 091 -> 097 -> 099
 * -> 102 -> 135 against an in-memory SQLite instance (mirroring
 * migration102.test.ts, which mirrors migration091's).
 * Proves:
 *   1. 'adversarial-review' is insertable alongside every pre-existing atype; a
 *      bogus atype is still rejected by the widened CHECK.
 *   2. 'adversarial-review' is NOT per-entity: it stays strictly
 *      one-per-(run, atype), so a re-report ENRICHES the single row rather than
 *      minting a second — which is what a post-Revise re-review must do.
 *   3. 073/102's per-entity split (idea-spec + arch-design + idea-summary)
 *      survives the recreate unchanged.
 *   4. Pre-existing artifacts rows survive the copy verbatim (full column shape,
 *      INCLUDING `revision`).
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

/** Every artifacts recreate in order — each names only its own atype list. */
const THROUGH_102 = [
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
  '097_verify_runbook_atype.sql',
  '099_project_brief_artifact.sql',
  '102_idea_summary_atype.sql',
];

/** Every atype the CHECK must admit after 135. */
const ALL_ATYPES = [
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
  'eval-report',
  'verify-runbook',
  'idea-summary',
  'adversarial-review',
];

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  seedProject(db);
  apply(db, [...THROUGH_102, '135_adversarial_review_atype.sql']);
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

describe('Migration 135: adversarial-review artifact atype', () => {
  it('(a) accepts adversarial-review alongside every pre-existing atype, rejects a bogus one', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    ALL_ATYPES.forEach((a, i) => {
      // Distinct source_ref so the per-entity atypes don't self-collide here.
      expect(() =>
        insertArtifact(db, `art_ok_${i}`, { atype: a, mode: 'canvas', sourceRef: `src_${i}` }),
      ).not.toThrow();
    });
    expect(() => insertArtifact(db, 'art_bad', { atype: 'nonsense' })).toThrow(/CHECK/i);
    db.close();
  });

  it('(b) adversarial-review is NOT per-entity: one per (run, atype)', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    seedRun(db, 'run-2');
    insertArtifact(db, 'ar_1', { runId: 'run-1', atype: 'adversarial-review' });
    // A SECOND one in the same run collides even with a distinct source_ref —
    // the re-report path must ENRICH the existing row, never mint a sibling.
    expect(() =>
      insertArtifact(db, 'ar_dup', { runId: 'run-1', atype: 'adversarial-review', sourceRef: 'ide_1' }),
    ).toThrow(/UNIQUE/i);
    // A DIFFERENT run gets its own critique.
    expect(() =>
      insertArtifact(db, 'ar_2', { runId: 'run-2', atype: 'adversarial-review' }),
    ).not.toThrow();
    db.close();
  });

  it('(c) 073/102 per-entity split survives: idea-spec / arch-design / idea-summary stay per source_ref', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    for (const atype of ['idea-spec', 'arch-design', 'idea-summary']) {
      expect(() => insertArtifact(db, `${atype}_a`, { atype, sourceRef: 'ide_1' })).not.toThrow();
      expect(() => insertArtifact(db, `${atype}_b`, { atype, sourceRef: 'ide_2' })).not.toThrow();
      expect(() => insertArtifact(db, `${atype}_dup`, { atype, sourceRef: 'ide_1' })).toThrow(/UNIQUE/i);
    }
    db.close();
  });

  it('(d) preserves pre-existing artifacts rows across the copy (full column shape)', () => {
    const db = new Database(':memory:');
    seedProject(db);
    apply(db, THROUGH_102); // up to but NOT including 135
    seedRun(db, 'run-keep');
    db.prepare(
      `INSERT INTO artifacts (id, run_id, session_id, atype, label, step_origin, mode, committed,
                              session_only, is_new, payload_json, source_ref, committed_at, revision)
       VALUES ('art_keep', 'run-keep', 'sess-9', 'idea-summary', 'Keep me',
               'Planner · ideas', 'template', 1, 0, 0, '{"markdown":"x"}', 'ide_7', '2026-09-01T00:00:00.000Z', 3)`,
    ).run();

    apply(db, ['135_adversarial_review_atype.sql']);

    const row = db
      .prepare(
        `SELECT id, run_id, session_id, atype, label, step_origin, mode, committed,
                session_only, is_new, payload_json, source_ref, committed_at, revision
           FROM artifacts WHERE id = 'art_keep'`,
      )
      .get() as Record<string, unknown> | undefined;
    expect(row).toMatchObject({
      id: 'art_keep',
      run_id: 'run-keep',
      session_id: 'sess-9',
      atype: 'idea-summary',
      label: 'Keep me',
      step_origin: 'Planner · ideas',
      mode: 'template',
      committed: 1,
      session_only: 0,
      is_new: 0,
      payload_json: '{"markdown":"x"}',
      source_ref: 'ide_7',
      committed_at: '2026-09-01T00:00:00.000Z',
      // 088-era column carried through the 135 copy, not re-defaulted to 1.
      revision: 3,
    });
    db.close();
  });

  it('(e) recreates the base + split indexes', () => {
    const db = buildDb();
    const idx = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'artifacts'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(idx).toContain('idx_artifacts_run');
    expect(idx).toContain('idx_artifacts_run_committed');
    expect(idx).toContain('idx_artifacts_one_per_atype');
    expect(idx).toContain('idx_artifacts_per_source');
    db.close();
  });

  it('(f) the fresh-DB initialize() path includes adversarial-review in the atype CHECK', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-migration135-'));
    let svc: DatabaseService | undefined;
    try {
      svc = new DatabaseService(join(dir, 'test.db'));
      svc.setMigrationsDirForTesting(MIG_DIR);
      svc.initialize();
      const db = svc.getDb();

      db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/proj-135')`).run();
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
            `INSERT INTO artifacts (id, run_id, atype, label, mode)
             VALUES ('art_fresh', 'run-1', 'adversarial-review', 'Adversarial review', 'template')`,
          )
          .run(),
      ).not.toThrow();
    } finally {
      svc?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
