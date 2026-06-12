/**
 * Integration tests for migration 026_run_usage_spec_hash_revisions.sql
 * (Insights Phase-2 persistence).
 *
 * Migration 026 adds:
 *   1. workflow_runs.spec_hash TEXT (ALTER ADD COLUMN; NULL for historic runs)
 *   2. run_usage — per-run token/cost rollup, FK run_id -> workflow_runs CASCADE
 *   3. workflow_revisions — append-only spec snapshot, UNIQUE(workflow_id,
 *      spec_hash), FK workflow_id -> workflows CASCADE
 *   4. idx_workflow_runs_project_workflow on workflow_runs(project_id, workflow_id)
 *
 * Building the authoritative post-024 workflow_runs shape from the full
 * 001..024 chain is impractical here — migrations 014/015/016/024 pull in the
 * projects table, the entity model, and board seeding, none of which this
 * migration touches. Mirroring migration020.test.ts, we reconstruct the exact
 * post-020 workflow_runs shape (the `paused` CHECK + all 26 columns) by applying
 * 006 + 007 + 010 + the workflow_runs ALTERs from 011/013/014/017/018/019, then
 * the real 020 SQL file, and THEN read + apply the real 025 file. This proves the
 * 026 file itself is correct (not a hand-copied inline string).
 *
 * Targets:
 *   (a) spec_hash column exists after 026 and defaults NULL on existing rows.
 *   (b) run_usage CRUD round-trips, and a row CASCADE-deletes with its run.
 *   (c) workflow_revisions enforces UNIQUE(workflow_id, spec_hash) and rows
 *       CASCADE-delete with their workflow.
 *   (d) idx_workflow_runs_project_workflow exists (sqlite_master).
 *   (e) re-running 026's CREATEs is harmless (the IF NOT EXISTS CREATEs + index
 *       re-apply cleanly; the production runner gates the non-idempotent ALTER
 *       via its ledger / duplicate-column signal).
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

/**
 * Apply a migration the way the production runner does — PRAGMA foreign_keys
 * toggles are no-ops inside a transaction, so the table-recreation recipe (020)
 * needs the pragma toggled OUTSIDE the transaction wrapper. Mirrors
 * runFileBasedMigrations() in database.ts and migration020.test.ts.
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

/**
 * Build the authoritative post-020 workflow_runs shape (26 columns + the
 * `paused` CHECK), then return the DB ready for migration 026. FK enforcement is
 * left ON so the run_usage / workflow_revisions CASCADE assertions exercise the
 * real constraint.
 */
function applyChainThrough020(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // 006 base + 007 stuck_detected_at + 010 (awaiting_input + table recreation).
  db.exec(readMigration('006_cyboflow_schema.sql'));
  db.exec(readMigration('007_add_stuck_reason.sql'));
  db.exec(readMigration('010_questions.sql'));
  // workflow_runs ALTERs from 011/013/014/017/018/019, in order. The non-
  // workflow_runs content of 014/015/016 is irrelevant to migration 026.
  db.exec('ALTER TABLE workflow_runs ADD COLUMN current_step_id TEXT'); // 011
  db.exec(
    "ALTER TABLE workflow_runs ADD COLUMN substrate TEXT NOT NULL DEFAULT 'sdk' CHECK (substrate IN ('sdk','interactive'))",
  ); // 013
  db.exec('ALTER TABLE workflow_runs ADD COLUMN task_id TEXT'); // 014
  db.exec('ALTER TABLE workflow_runs ADD COLUMN outcome TEXT'); // 014
  db.exec('ALTER TABLE workflow_runs ADD COLUMN base_branch TEXT'); // 014
  db.exec('ALTER TABLE workflow_runs ADD COLUMN base_sha TEXT'); // 014
  db.exec('ALTER TABLE workflow_runs ADD COLUMN steps_snapshot_json TEXT'); // 014
  db.exec('CREATE INDEX IF NOT EXISTS idx_workflow_runs_task_id ON workflow_runs(task_id)'); // 014
  db.exec('ALTER TABLE workflow_runs ADD COLUMN seed_idea_id TEXT'); // 017
  db.exec('ALTER TABLE workflow_runs ADD COLUMN claude_session_id TEXT'); // 018
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT'); // 019
  db.exec('CREATE INDEX IF NOT EXISTS idx_workflow_runs_session_id ON workflow_runs(session_id)'); // 019
  // 020 widens the status CHECK to add 'paused' via the table-recreation recipe.
  runMigrationViaProductionPath(db, readMigration('020_workflow_run_paused_status.sql'));
  return db;
}

/** Seed a workflow + run so the FK-bound 026 tables have parents to reference. */
function seedWorkflowAndRun(db: Database.Database): void {
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json)
     VALUES ('wf-1', 7, 'planner', '{"steps":[]}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES ('wr-1', 'wf-1', 7, 'running', 'default')`,
  ).run();
}

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

describe('Migration 026: run_usage + spec_hash + workflow_revisions', () => {
  it('(a) adds spec_hash to workflow_runs, defaulting NULL on existing rows', () => {
    const db = applyChainThrough020();
    // Seed a run BEFORE 026 so we prove the new column defaults NULL on backfill.
    seedWorkflowAndRun(db);

    runMigrationViaProductionPath(db, readMigration('026_run_usage_spec_hash_revisions.sql'));

    const cols = db.prepare('PRAGMA table_info(workflow_runs)').all() as TableInfoRow[];
    expect(cols.map((c) => c.name)).toContain('spec_hash');

    const row = db
      .prepare('SELECT spec_hash FROM workflow_runs WHERE id = ?')
      .get('wr-1') as { spec_hash: string | null };
    expect(row.spec_hash).toBeNull();

    // And a fresh row may carry a hash.
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, spec_hash)
       VALUES ('wr-2', 'wf-1', 7, 'queued', 'default', 'deadbeef')`,
    ).run();
    const hashed = db
      .prepare('SELECT spec_hash FROM workflow_runs WHERE id = ?')
      .get('wr-2') as { spec_hash: string | null };
    expect(hashed.spec_hash).toBe('deadbeef');

    db.close();
  });

  it('(b) run_usage CRUD round-trips with defaults and nullable cost/turns', () => {
    const db = applyChainThrough020();
    seedWorkflowAndRun(db);
    runMigrationViaProductionPath(db, readMigration('026_run_usage_spec_hash_revisions.sql'));

    // Insert with only the required key — every counter column has a default.
    db.prepare('INSERT INTO run_usage (run_id) VALUES (?)').run('wr-1');
    const defaulted = db.prepare('SELECT * FROM run_usage WHERE run_id = ?').get('wr-1') as Record<
      string,
      unknown
    >;
    expect(defaulted.input_tokens).toBe(0);
    expect(defaulted.output_tokens).toBe(0);
    expect(defaulted.cache_read_tokens).toBe(0);
    expect(defaulted.cache_creation_tokens).toBe(0);
    expect(defaulted.total_tokens).toBe(0);
    expect(defaulted.assistant_message_count).toBe(0);
    expect(defaulted.cost_usd).toBeNull(); // nullable, no default
    expect(defaulted.num_turns).toBeNull(); // nullable, no default
    expect(defaulted.computed_at).not.toBeNull(); // CURRENT_TIMESTAMP default

    // Update with a full rollup.
    db.prepare(
      `UPDATE run_usage SET input_tokens = 100, output_tokens = 40, cache_read_tokens = 10,
       cache_creation_tokens = 5, total_tokens = 140, cost_usd = 0.0123, num_turns = 3,
       assistant_message_count = 7 WHERE run_id = ?`,
    ).run('wr-1');
    const updated = db.prepare('SELECT * FROM run_usage WHERE run_id = ?').get('wr-1') as Record<
      string,
      unknown
    >;
    expect(updated.input_tokens).toBe(100);
    expect(updated.output_tokens).toBe(40);
    expect(updated.total_tokens).toBe(140);
    expect(updated.cost_usd).toBeCloseTo(0.0123);
    expect(updated.num_turns).toBe(3);
    expect(updated.assistant_message_count).toBe(7);

    // run_id is the PRIMARY KEY — a duplicate insert conflicts.
    expect(() => db.prepare('INSERT INTO run_usage (run_id) VALUES (?)').run('wr-1')).toThrow(
      /UNIQUE constraint failed|PRIMARY KEY/,
    );

    db.close();
  });

  it('(b) run_usage row CASCADE-deletes when its workflow_run is deleted', () => {
    const db = applyChainThrough020();
    seedWorkflowAndRun(db);
    runMigrationViaProductionPath(db, readMigration('026_run_usage_spec_hash_revisions.sql'));

    db.prepare('INSERT INTO run_usage (run_id, total_tokens) VALUES (?, ?)').run('wr-1', 99);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM run_usage').get() as { n: number }).n,
    ).toBe(1);

    db.prepare('DELETE FROM workflow_runs WHERE id = ?').run('wr-1');
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM run_usage').get() as { n: number }).n,
    ).toBe(0);

    db.close();
  });

  it('(c) workflow_revisions enforces UNIQUE(workflow_id, spec_hash)', () => {
    const db = applyChainThrough020();
    seedWorkflowAndRun(db);
    runMigrationViaProductionPath(db, readMigration('026_run_usage_spec_hash_revisions.sql'));

    const insert = db.prepare(
      'INSERT INTO workflow_revisions (workflow_id, spec_hash, spec_json) VALUES (?, ?, ?)',
    );
    insert.run('wf-1', 'hashA', '{"v":1}');

    // Same (workflow_id, spec_hash) conflicts.
    expect(() => insert.run('wf-1', 'hashA', '{"v":1}')).toThrow(/UNIQUE constraint failed/);

    // INSERT OR IGNORE makes the writer's "record if new" idempotent — no throw,
    // no duplicate row.
    expect(() =>
      db
        .prepare(
          'INSERT OR IGNORE INTO workflow_revisions (workflow_id, spec_hash, spec_json) VALUES (?, ?, ?)',
        )
        .run('wf-1', 'hashA', '{"v":1}'),
    ).not.toThrow();
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM workflow_revisions').get() as { n: number }).n,
    ).toBe(1);

    // A different hash for the SAME workflow is allowed (a new revision).
    insert.run('wf-1', 'hashB', '{"v":2}');
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM workflow_revisions').get() as { n: number }).n,
    ).toBe(2);

    db.close();
  });

  it('(c) workflow_revisions rows CASCADE-delete when their workflow is deleted', () => {
    const db = applyChainThrough020();
    seedWorkflowAndRun(db);
    runMigrationViaProductionPath(db, readMigration('026_run_usage_spec_hash_revisions.sql'));

    db.prepare(
      'INSERT INTO workflow_revisions (workflow_id, spec_hash, spec_json) VALUES (?, ?, ?)',
    ).run('wf-1', 'hashA', '{"v":1}');

    // workflow_runs.workflow_id also CASCADEs from workflows — delete the run
    // first so the workflow delete is not RESTRICTed by an unrelated FK.
    db.prepare('DELETE FROM workflow_runs WHERE workflow_id = ?').run('wf-1');
    db.prepare('DELETE FROM workflows WHERE id = ?').run('wf-1');

    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM workflow_revisions').get() as { n: number }).n,
    ).toBe(0);

    db.close();
  });

  it('(d) creates the idx_workflow_runs_project_workflow index', () => {
    const db = applyChainThrough020();
    runMigrationViaProductionPath(db, readMigration('026_run_usage_spec_hash_revisions.sql'));

    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='workflow_runs'",
      )
      .all() as Array<{ name: string }>;
    const names = new Set(idx.map((r) => r.name));
    expect(names).toContain('idx_workflow_runs_project_workflow');

    db.close();
  });

  it('(e) re-running the CREATEs is harmless (IF NOT EXISTS tables + index)', () => {
    const db = applyChainThrough020();
    seedWorkflowAndRun(db);
    const sql = readMigration('026_run_usage_spec_hash_revisions.sql');
    runMigrationViaProductionPath(db, sql);

    // Seed data through the first application.
    db.prepare('INSERT INTO run_usage (run_id, total_tokens) VALUES (?, ?)').run('wr-1', 42);
    db.prepare(
      'INSERT INTO workflow_revisions (workflow_id, spec_hash, spec_json) VALUES (?, ?, ?)',
    ).run('wf-1', 'hashA', '{"v":1}');

    // Re-running the whole file would throw on the non-idempotent ALTER
    // ('duplicate column name: spec_hash') — that is the production runner's
    // idempotency signal. Re-apply ONLY the idempotent CREATE statements (the
    // tables + index, all IF NOT EXISTS) to prove they are harmless on a second
    // pass and do not clobber existing rows.
    // Strip full-line `--` comments FIRST: the header comment block and the
    // per-section banners contain semicolons inside prose, so splitting the raw
    // file on ';' mangles those comment lines into chunks that begin with `--`,
    // defeating the ^CREATE anchor below. With full-line comments removed, the
    // only remaining semicolons terminate real statements (the inline trailing
    // comments inside the CREATE bodies carry no semicolons), so the split is safe.
    const noComments = sql.replace(/^\s*--.*$/gm, '');
    const createOnly = noComments
      .split(';')
      .map((s) => s.trim())
      .filter((s) => /^CREATE (TABLE|INDEX) IF NOT EXISTS/i.test(s))
      .map((s) => `${s};`)
      .join('\n');
    expect(createOnly).toContain('CREATE TABLE IF NOT EXISTS run_usage');
    expect(createOnly).toContain('CREATE TABLE IF NOT EXISTS workflow_revisions');
    expect(createOnly).toContain('CREATE INDEX IF NOT EXISTS idx_workflow_runs_project_workflow');
    expect(() => db.exec(createOnly)).not.toThrow();

    // Seed data survived the harmless re-apply.
    expect(
      (db.prepare('SELECT total_tokens FROM run_usage WHERE run_id = ?').get('wr-1') as {
        total_tokens: number;
      }).total_tokens,
    ).toBe(42);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM workflow_revisions').get() as { n: number }).n,
    ).toBe(1);

    db.close();
  });
});
