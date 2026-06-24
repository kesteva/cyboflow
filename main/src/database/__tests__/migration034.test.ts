/**
 * Integration tests for migration 034_findings_triage.sql (findings-triage redesign).
 *
 * Migration 034 carries ALL the findings-triage schema in a single file:
 *   - review_items:  + priority   TEXT CHECK (priority IN ('P0','P1','P2')) NULL
 *                    + staged_at  DATETIME NULL
 *                    + selected   INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0,1))
 *   - workflow_runs: + seed_finding_ids TEXT NULL (JSON array of selected finding ids)
 *   - two indexes: idx_review_items_project_staged / idx_review_items_project_selected.
 *
 * It uses plain ALTER TABLE ADD COLUMN (no table recreation), so the four ALTERs
 * apply atomically inside the runner's transaction wrapper and pre-existing rows
 * backfill to the column defaults (selected=0, priority/staged_at NULL).
 *
 * We build the real pre-034 review_items shape from 016_review_items.sql (against a
 * minimal projects table it FK-references) and the real post-019 workflow_runs shape
 * (mirroring migration020.test.ts's chain), then read + apply the real 034 SQL file.
 * Applying the file proves it is correct (not a hand-copied inline string).
 *
 * Targets:
 *   (a) review_items gains priority/staged_at/selected with the right type/nullability/
 *       default/CHECK; pre-existing rows backfill (staged_at NULL, selected 0, priority NULL).
 *   (b) workflow_runs gains seed_finding_ids (nullable TEXT), round-trips a JSON array.
 *   (c) the CHECK rejects priority='P3'; round-trips P0/P1/P2/NULL and selected 0/1.
 *   (d) both new indexes exist after 034.
 *   (e) idempotency: re-applying via the production path throws "duplicate column name:
 *       priority" on the FIRST ALTER and the transaction wrapper rolls the whole file
 *       back (the post-034 state stays intact).
 *   (f) the fresh-DB initialize() path includes the new columns + indexes.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../database';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

/**
 * Apply a migration SQL the way the production runner does: wrap in a single
 * transaction so a multi-ALTER file rolls back as a unit (034 does not toggle
 * foreign_keys, but the helper keeps the FK-toggle handling for parity with
 * runFileBasedMigrations() / migration020.test.ts).
 */
function runMigrationViaProductionPath(db: Database.Database, sql: string): void {
  const needsFkOff = sql.includes('PRAGMA foreign_keys=OFF');
  if (needsFkOff) db.pragma('foreign_keys = OFF');
  try {
    const txn = db.transaction(() => {
      db.exec(sql);
    });
    txn();
  } finally {
    if (needsFkOff) db.pragma('foreign_keys = ON');
  }
}

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

/**
 * Build the pre-034 DB: a minimal projects table, the real review_items table
 * (migration 016, which FK-references projects + workflow_runs), and the real
 * post-019 workflow_runs shape (mirrors migration020.test.ts). Seeds one project,
 * one workflow_run, and one pre-existing review_items row so we can prove backfill.
 */
function applyChainPre034(): Database.Database {
  const db = new Database(':memory:');

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

  // Post-019 workflow_runs (006 base + 007 + 010 + the inline ALTERs through 019),
  // mirroring migration020.test.ts so 034's workflow_runs ALTER has a real target.
  db.exec(readMigration('006_cyboflow_schema.sql'));
  db.exec(readMigration('007_add_stuck_reason.sql'));
  db.exec(readMigration('010_questions.sql'));
  db.exec('ALTER TABLE workflow_runs ADD COLUMN current_step_id TEXT'); // 011
  db.exec(
    "ALTER TABLE workflow_runs ADD COLUMN substrate TEXT NOT NULL DEFAULT 'sdk' CHECK (substrate IN ('sdk','interactive'))",
  ); // 013
  db.exec('ALTER TABLE workflow_runs ADD COLUMN task_id TEXT'); // 014
  db.exec('ALTER TABLE workflow_runs ADD COLUMN outcome TEXT'); // 014
  db.exec('ALTER TABLE workflow_runs ADD COLUMN base_branch TEXT'); // 014
  db.exec('ALTER TABLE workflow_runs ADD COLUMN base_sha TEXT'); // 014
  db.exec('ALTER TABLE workflow_runs ADD COLUMN steps_snapshot_json TEXT'); // 014
  db.exec('ALTER TABLE workflow_runs ADD COLUMN seed_idea_id TEXT'); // 017
  db.exec('ALTER TABLE workflow_runs ADD COLUMN claude_session_id TEXT'); // 018
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT'); // 019

  // Real review_items (migration 016).
  db.exec(readMigration('016_review_items.sql'));

  // Seed a workflow + run (workflow_runs.workflow_id FK -> workflows).
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'compound', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES ('wr-1', 'wf-1', 1, 'running', 'default')`,
  ).run();

  // Seed a pre-existing review_items finding to prove the backfill.
  db.prepare(
    `INSERT INTO review_items (id, project_id, kind, status, title)
     VALUES ('rvw-legacy', 1, 'finding', 'pending', 'Legacy finding')`,
  ).run();

  return db;
}

function columnInfo(db: Database.Database, table: string, column: string): TableInfoRow | undefined {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[]).find(
    (c) => c.name === column,
  );
}

describe('Migration 034: findings-triage columns', () => {
  it('(a) adds priority/staged_at/selected to review_items with the right shape', () => {
    const db = applyChainPre034();
    runMigrationViaProductionPath(db, readMigration('034_findings_triage.sql'));

    const priority = columnInfo(db, 'review_items', 'priority');
    expect(priority).toBeDefined();
    expect(priority?.type).toBe('TEXT');
    expect(priority?.notnull).toBe(0); // nullable
    expect(priority?.dflt_value).toBeNull();

    const stagedAt = columnInfo(db, 'review_items', 'staged_at');
    expect(stagedAt).toBeDefined();
    expect(stagedAt?.type).toBe('DATETIME');
    expect(stagedAt?.notnull).toBe(0); // nullable
    expect(stagedAt?.dflt_value).toBeNull();

    const selected = columnInfo(db, 'review_items', 'selected');
    expect(selected).toBeDefined();
    expect(selected?.type).toBe('INTEGER');
    expect(selected?.notnull).toBe(1); // NOT NULL
    // The default literal surfaces as '0' in PRAGMA table_info.
    expect(String(selected?.dflt_value)).toBe('0');

    db.close();
  });

  it('(a) backfills the pre-existing row (staged_at NULL, selected 0, priority NULL)', () => {
    const db = applyChainPre034();
    runMigrationViaProductionPath(db, readMigration('034_findings_triage.sql'));

    const row = db
      .prepare('SELECT priority, staged_at, selected FROM review_items WHERE id = ?')
      .get('rvw-legacy') as { priority: string | null; staged_at: string | null; selected: number };
    expect(row.priority).toBeNull();
    expect(row.staged_at).toBeNull();
    expect(row.selected).toBe(0);

    db.close();
  });

  it('(b) adds seed_finding_ids to workflow_runs (nullable TEXT) and round-trips a JSON array', () => {
    const db = applyChainPre034();
    runMigrationViaProductionPath(db, readMigration('034_findings_triage.sql'));

    const seed = columnInfo(db, 'workflow_runs', 'seed_finding_ids');
    expect(seed).toBeDefined();
    expect(seed?.type).toBe('TEXT');
    expect(seed?.notnull).toBe(0); // nullable
    expect(seed?.dflt_value).toBeNull();

    // Pre-existing run backfilled to NULL.
    const before = db
      .prepare('SELECT seed_finding_ids FROM workflow_runs WHERE id = ?')
      .get('wr-1') as { seed_finding_ids: string | null };
    expect(before.seed_finding_ids).toBeNull();

    // Round-trip a JSON array string.
    const ids = JSON.stringify(['rvw-1', 'rvw-2', 'rvw-3']);
    db.prepare('UPDATE workflow_runs SET seed_finding_ids = ? WHERE id = ?').run(ids, 'wr-1');
    const after = db
      .prepare('SELECT seed_finding_ids FROM workflow_runs WHERE id = ?')
      .get('wr-1') as { seed_finding_ids: string };
    expect(after.seed_finding_ids).toBe(ids);
    expect(JSON.parse(after.seed_finding_ids)).toEqual(['rvw-1', 'rvw-2', 'rvw-3']);

    db.close();
  });

  it('(c) the priority CHECK accepts P0/P1/P2 + NULL and rejects P3', () => {
    const db = applyChainPre034();
    runMigrationViaProductionPath(db, readMigration('034_findings_triage.sql'));

    const insert = db.prepare(
      `INSERT INTO review_items (id, project_id, kind, status, title, priority)
       VALUES (?, 1, 'finding', 'pending', 'f', ?)`,
    );

    for (const p of ['P0', 'P1', 'P2', null]) {
      expect(() => insert.run(`rvw-${p ?? 'null'}`, p), `priority='${p}' should be accepted`).not.toThrow();
    }

    expect(() => insert.run('rvw-bad', 'P3')).toThrow(/CHECK constraint failed/);

    // Verify the accepted values round-trip.
    const row = db
      .prepare('SELECT priority FROM review_items WHERE id = ?')
      .get('rvw-P1') as { priority: string };
    expect(row.priority).toBe('P1');
    const nullRow = db
      .prepare('SELECT priority FROM review_items WHERE id = ?')
      .get('rvw-null') as { priority: string | null };
    expect(nullRow.priority).toBeNull();

    db.close();
  });

  it('(c) the selected CHECK accepts 0/1 and rejects 2', () => {
    const db = applyChainPre034();
    runMigrationViaProductionPath(db, readMigration('034_findings_triage.sql'));

    const insert = db.prepare(
      `INSERT INTO review_items (id, project_id, kind, status, title, selected)
       VALUES (?, 1, 'finding', 'pending', 'f', ?)`,
    );
    expect(() => insert.run('rvw-sel-0', 0)).not.toThrow();
    expect(() => insert.run('rvw-sel-1', 1)).not.toThrow();
    expect(() => insert.run('rvw-sel-2', 2)).toThrow(/CHECK constraint failed/);

    db.close();
  });

  it('(c) staged_at round-trips a timestamp string', () => {
    const db = applyChainPre034();
    runMigrationViaProductionPath(db, readMigration('034_findings_triage.sql'));

    db.prepare(
      `INSERT INTO review_items (id, project_id, kind, status, title, staged_at, selected)
       VALUES ('rvw-staged', 1, 'finding', 'pending', 'f', '2026-06-22 12:00:00', 1)`,
    ).run();
    const row = db
      .prepare('SELECT staged_at, selected FROM review_items WHERE id = ?')
      .get('rvw-staged') as { staged_at: string; selected: number };
    expect(row.staged_at).toBe('2026-06-22 12:00:00');
    expect(row.selected).toBe(1);

    db.close();
  });

  it('(d) creates both new review_items indexes', () => {
    const db = applyChainPre034();
    runMigrationViaProductionPath(db, readMigration('034_findings_triage.sql'));

    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='review_items'")
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    expect(names).toContain('idx_review_items_project_staged');
    expect(names).toContain('idx_review_items_project_selected');

    db.close();
  });

  it('(e) re-applying via the production path throws duplicate-column and rolls the file back', () => {
    const db = applyChainPre034();
    const sql = readMigration('034_findings_triage.sql');

    // First application succeeds.
    runMigrationViaProductionPath(db, sql);

    // Capture the post-034 shape so we can prove the rollback left it intact.
    const before = (db.prepare('PRAGMA table_info(review_items)').all() as TableInfoRow[]).map(
      (c) => c.name,
    );

    // A second application throws on the FIRST ALTER (duplicate column name: priority);
    // the transaction wrapper rolls the WHOLE file back (the later ALTERs never run).
    expect(() => runMigrationViaProductionPath(db, sql)).toThrow(/duplicate column name: priority/);

    // Shape is unchanged (no partial-apply, no duplicate columns).
    const after = (db.prepare('PRAGMA table_info(review_items)').all() as TableInfoRow[]).map(
      (c) => c.name,
    );
    expect(after).toEqual(before);
    expect(after.filter((n) => n === 'priority')).toHaveLength(1);
    expect(after.filter((n) => n === 'staged_at')).toHaveLength(1);
    expect(after.filter((n) => n === 'selected')).toHaveLength(1);

    db.close();
  });

  it('(f) the fresh-DB initialize() path includes the new columns + indexes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-migration034-'));
    try {
      const svc = new DatabaseService(join(dir, 'test.db'));
      svc.setMigrationsDirForTesting(join(__dirname, '..', 'migrations'));
      svc.initialize();
      const db = svc.getDb();

      const reviewCols = (db.prepare('PRAGMA table_info(review_items)').all() as TableInfoRow[]).map(
        (c) => c.name,
      );
      expect(reviewCols).toContain('priority');
      expect(reviewCols).toContain('staged_at');
      expect(reviewCols).toContain('selected');

      const runCols = (db.prepare('PRAGMA table_info(workflow_runs)').all() as TableInfoRow[]).map(
        (c) => c.name,
      );
      expect(runCols).toContain('seed_finding_ids');

      const idxNames = new Set(
        (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='review_items'")
            .all() as Array<{ name: string }>
        ).map((r) => r.name),
      );
      expect(idxNames).toContain('idx_review_items_project_staged');
      expect(idxNames).toContain('idx_review_items_project_selected');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
