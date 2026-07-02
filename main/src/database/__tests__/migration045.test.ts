/**
 * Migration 045_arch_design_atype.sql — schema + constraint integration tests.
 *
 * Applies 006 -> 011 -> 014 -> 015 -> 016 -> 035 -> 045 against an in-memory
 * SQLite instance. Proves:
 *   1. All SIX atypes (incl. the new 'arch-design') are insertable.
 *   2. A bogus atype is still rejected by the widened CHECK.
 *   3. UNIQUE(run_id, atype) is still enforced after the table recreate.
 *   4. Pre-existing artifacts rows survive the copy verbatim.
 *   5. The documented indexes + run_id FK CASCADE are preserved.
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

const THROUGH_035 = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  '035_artifacts.sql',
];

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  seedProject(db);
  apply(db, [...THROUGH_035, '045_arch_design_atype.sql']);
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

describe('Migration 045: arch-design artifact atype', () => {
  it('accepts all six atypes (incl. arch-design), rejects a bogus one', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    const valid = [
      'idea-spec',
      'decomposed-stories',
      'screenshots',
      'ui-prototype',
      'generic',
      'arch-design',
    ];
    valid.forEach((a, i) => {
      expect(() => insertArtifact(db, `art_ok_${i}`, { atype: a, mode: 'canvas' })).not.toThrow();
    });
    expect(() => insertArtifact(db, 'art_bad', { atype: 'nonsense' })).toThrow(/CHECK/i);
    db.close();
  });

  it('still enforces UNIQUE(run_id, atype) after the recreate', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    insertArtifact(db, 'art_a', { atype: 'arch-design' });
    expect(() => insertArtifact(db, 'art_b', { atype: 'arch-design' })).toThrow(/UNIQUE/i);
    db.close();
  });

  it('preserves pre-existing artifacts rows across the copy', () => {
    const db = new Database(':memory:');
    seedProject(db);
    apply(db, THROUGH_035); // up to but NOT including 045
    seedRun(db, 'run-keep');
    db.prepare(
      `INSERT INTO artifacts (id, run_id, atype, label, mode, payload_json, source_ref, committed)
       VALUES ('art_keep', 'run-keep', 'idea-spec', 'Keep me', 'template', NULL, 'ide_1', 1)`,
    ).run();

    apply(db, ['045_arch_design_atype.sql']);

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

  it('recreates the documented indexes', () => {
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

  it('preserves the run_id FK CASCADE — deleting a run deletes its artifacts', () => {
    const db = buildDb();
    seedRun(db, 'run-1');
    insertArtifact(db, 'art_c', { atype: 'arch-design' });
    db.prepare("DELETE FROM workflow_runs WHERE id = 'run-1'").run();
    expect((db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }).n).toBe(0);
    db.close();
  });
});
