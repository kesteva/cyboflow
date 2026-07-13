/**
 * Integration tests for migration 061_run_seed_idea_ids.sql (multi-idea planner
 * seed, IDEA-009 "Planner should accept multiple ideas").
 *
 * 061 is a single plain ALTER TABLE ADD COLUMN — workflow_runs gains
 * seed_idea_ids TEXT (nullable, JSON string array of seeded idea ids, no
 * default). Mirrors migration 034's seed_finding_ids column shape exactly;
 * NULL = single-idea run (the pre-existing seed_idea_id column keeps meaning
 * what it always did), a JSON array = a multi-idea planner batch.
 *
 * We build the real post-019 workflow_runs shape (mirroring migration034.test.ts's
 * chain) then read + apply the real 061 SQL file. Applying the file proves it is
 * correct (not a hand-copied inline string).
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
 * transaction so a multi-ALTER file rolls back as a unit (061 does not toggle
 * foreign_keys, but the helper keeps the FK-toggle handling for parity with
 * runFileBasedMigrations() / migration034.test.ts).
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
 * Build the pre-061 DB: the real post-019 workflow_runs shape (006 base + 007 +
 * 010 + the inline ALTERs through 019, mirroring migration034.test.ts's chain),
 * plus 034's seed_finding_ids column so we have a realistic pre-061 shape one
 * step ahead of what 034's own test builds. Seeds one workflow + one run.
 */
function applyChainPre061(): Database.Database {
  const db = new Database(':memory:');

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
  db.exec('ALTER TABLE workflow_runs ADD COLUMN seed_finding_ids TEXT'); // 034

  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'planner', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, seed_idea_id)
     VALUES ('wr-1', 'wf-1', 1, 'running', 'default', 'idea-1')`,
  ).run();

  return db;
}

function columnInfo(db: Database.Database, table: string, column: string): TableInfoRow | undefined {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[]).find(
    (c) => c.name === column,
  );
}

const MIGRATION = '061_run_seed_idea_ids.sql';

describe('Migration 061: workflow_runs.seed_idea_ids', () => {
  it('(a) adds seed_idea_ids to workflow_runs as nullable TEXT with no default', () => {
    const db = applyChainPre061();
    runMigrationViaProductionPath(db, readMigration(MIGRATION));

    const col = columnInfo(db, 'workflow_runs', 'seed_idea_ids');
    expect(col).toBeDefined();
    expect(col?.type).toBe('TEXT');
    expect(col?.notnull).toBe(0); // nullable
    expect(col?.dflt_value).toBeNull();

    db.close();
  });

  it('(a) backfills the pre-existing run to NULL', () => {
    const db = applyChainPre061();
    runMigrationViaProductionPath(db, readMigration(MIGRATION));

    const row = db
      .prepare('SELECT seed_idea_ids FROM workflow_runs WHERE id = ?')
      .get('wr-1') as { seed_idea_ids: string | null };
    expect(row.seed_idea_ids).toBeNull();

    db.close();
  });

  it('(b) round-trips a JSON array string and leaves seed_idea_id untouched (dual-write is caller responsibility)', () => {
    const db = applyChainPre061();
    runMigrationViaProductionPath(db, readMigration(MIGRATION));

    const ids = JSON.stringify(['idea-1', 'idea-2', 'idea-3']);
    db.prepare('UPDATE workflow_runs SET seed_idea_ids = ? WHERE id = ?').run(ids, 'wr-1');

    const after = db
      .prepare('SELECT seed_idea_id, seed_idea_ids FROM workflow_runs WHERE id = ?')
      .get('wr-1') as { seed_idea_id: string; seed_idea_ids: string };
    expect(after.seed_idea_id).toBe('idea-1'); // dual-write: first element, set independently by the caller
    expect(after.seed_idea_ids).toBe(ids);
    expect(JSON.parse(after.seed_idea_ids)).toEqual(['idea-1', 'idea-2', 'idea-3']);

    db.close();
  });

  it('(c) re-applying via the production path throws duplicate-column and rolls the file back', () => {
    const db = applyChainPre061();
    const sql = readMigration(MIGRATION);

    runMigrationViaProductionPath(db, sql);

    const before = (db.prepare('PRAGMA table_info(workflow_runs)').all() as TableInfoRow[]).map(
      (c) => c.name,
    );

    expect(() => runMigrationViaProductionPath(db, sql)).toThrow(/duplicate column name: seed_idea_ids/);

    const after = (db.prepare('PRAGMA table_info(workflow_runs)').all() as TableInfoRow[]).map(
      (c) => c.name,
    );
    expect(after).toEqual(before);
    expect(after.filter((n) => n === 'seed_idea_ids')).toHaveLength(1);

    db.close();
  });

  it('(d) the fresh-DB initialize() path includes seed_idea_ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-migration061-'));
    try {
      const svc = new DatabaseService(join(dir, 'test.db'));
      svc.setMigrationsDirForTesting(join(__dirname, '..', 'migrations'));
      svc.initialize();
      const db = svc.getDb();

      const runCols = (db.prepare('PRAGMA table_info(workflow_runs)').all() as TableInfoRow[]).map(
        (c) => c.name,
      );
      expect(runCols).toContain('seed_idea_ids');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
