/**
 * Migration 063_per_idea_spec_artifacts.sql — schema + constraint integration tests.
 *
 * Applies 006 -> 011 -> 014 -> 015 -> 016 -> 035 -> 045 -> 061 -> 063 against an
 * in-memory SQLite instance. Proves the split identity rule (IDEA-009 multi-idea
 * planner batch):
 *   1. TWO 'idea-spec' rows in one run with DISTINCT source_ref insert cleanly.
 *   2. TWO 'idea-spec' rows in one run with the SAME source_ref conflict.
 *   3. TWO 'idea-spec' rows in one run BOTH with NULL source_ref conflict
 *      (COALESCE(source_ref,'') keeps NULLs from escaping the unique check).
 *   4. TWO 'ui-prototype' rows in one run still conflict (one-per-(run,atype)).
 *   5. Pre-existing artifacts rows survive the copy verbatim.
 *   6. Both partial unique indexes exist.
 *   7. The fresh-DB initialize() path lands the same split rule.
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

const THROUGH_061 = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  '035_artifacts.sql',
  '045_arch_design_atype.sql',
  '061_approve_ideas_atype.sql',
];

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  seedProject(db);
  apply(db, [...THROUGH_061, '063_per_idea_spec_artifacts.sql']);
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
  overrides: Partial<{ runId: string; atype: string; sourceRef: string | null }> = {},
): void {
  db.prepare(
    'INSERT INTO artifacts (id, run_id, atype, label, mode, source_ref) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    overrides.runId ?? 'run-1',
    overrides.atype ?? 'idea-spec',
    'A label',
    'template',
    overrides.sourceRef === undefined ? null : overrides.sourceRef,
  );
}

describe('Migration 063: one idea-spec per idea (split identity)', () => {
  it('(a) accepts two idea-spec rows in one run with DISTINCT source_ref', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    expect(() => insertArtifact(db, 'art_i1', { atype: 'idea-spec', sourceRef: 'ide_1' })).not.toThrow();
    expect(() => insertArtifact(db, 'art_i2', { atype: 'idea-spec', sourceRef: 'ide_2' })).not.toThrow();
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE run_id = 'run-1' AND atype = 'idea-spec'").get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(2);
    db.close();
  });

  it('(b) rejects two idea-spec rows in one run with the SAME source_ref', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    insertArtifact(db, 'art_i1', { atype: 'idea-spec', sourceRef: 'ide_dup' });
    expect(() => insertArtifact(db, 'art_i2', { atype: 'idea-spec', sourceRef: 'ide_dup' })).toThrow(
      /UNIQUE/i,
    );
    db.close();
  });

  it('(c) rejects two idea-spec rows in one run both with NULL source_ref', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    insertArtifact(db, 'art_i1', { atype: 'idea-spec', sourceRef: null });
    expect(() => insertArtifact(db, 'art_i2', { atype: 'idea-spec', sourceRef: null })).toThrow(/UNIQUE/i);
    db.close();
  });

  it('(d) still rejects two ui-prototype rows in one run (one-per-(run,atype))', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    insertArtifact(db, 'art_u1', { atype: 'ui-prototype', sourceRef: null });
    expect(() => insertArtifact(db, 'art_u2', { atype: 'ui-prototype', sourceRef: null })).toThrow(
      /UNIQUE/i,
    );
    db.close();
  });

  it('(e) preserves pre-existing artifacts rows across the copy', () => {
    const db = new Database(':memory:');
    seedProject(db);
    apply(db, THROUGH_061); // up to but NOT including 063
    seedRun(db, 'run-keep');
    db.prepare(
      `INSERT INTO artifacts (id, run_id, atype, label, mode, payload_json, source_ref, committed)
       VALUES ('art_keep', 'run-keep', 'idea-spec', 'Keep me', 'template', NULL, 'ide_1', 1)`,
    ).run();

    apply(db, ['063_per_idea_spec_artifacts.sql']);

    const row = db
      .prepare(
        `SELECT id, run_id, atype, label, mode, payload_json, source_ref, committed
           FROM artifacts WHERE id = 'art_keep'`,
      )
      .get() as Record<string, unknown> | undefined;
    expect(row).toMatchObject({
      id: 'art_keep',
      run_id: 'run-keep',
      atype: 'idea-spec',
      label: 'Keep me',
      mode: 'template',
      payload_json: null,
      source_ref: 'ide_1',
      committed: 1,
    });
    db.close();
  });

  it('(f) creates both partial unique indexes', () => {
    const db = buildDb();
    const idx = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'artifacts'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(idx).toContain('idx_artifacts_one_per_atype');
    expect(idx).toContain('idx_artifacts_idea_spec_per_source');
    expect(idx).toContain('idx_artifacts_run');
    expect(idx).toContain('idx_artifacts_run_committed');
    db.close();
  });

  it('(g) the fresh-DB initialize() path lands the split identity rule', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-migration063-'));
    try {
      const svc = new DatabaseService(join(dir, 'test.db'));
      svc.setMigrationsDirForTesting(join(__dirname, '..', 'migrations'));
      svc.initialize();
      const db = svc.getDb();

      db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/proj-063')`).run();
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'planner', '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
         VALUES ('run-1', 'wf-1', 1, 'running', 'default')`,
      ).run();

      // Two idea-specs, distinct source_ref → both insert.
      expect(() =>
        db
          .prepare(
            `INSERT INTO artifacts (id, run_id, atype, label, mode, source_ref) VALUES ('a1', 'run-1', 'idea-spec', 'A', 'template', 'ide_1')`,
          )
          .run(),
      ).not.toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO artifacts (id, run_id, atype, label, mode, source_ref) VALUES ('a2', 'run-1', 'idea-spec', 'B', 'template', 'ide_2')`,
          )
          .run(),
      ).not.toThrow();
      // Same source_ref → conflict.
      expect(() =>
        db
          .prepare(
            `INSERT INTO artifacts (id, run_id, atype, label, mode, source_ref) VALUES ('a3', 'run-1', 'idea-spec', 'C', 'template', 'ide_1')`,
          )
          .run(),
      ).toThrow(/UNIQUE/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
