/**
 * Integration tests for migration 020_workflow_run_paused_status.sql (Phase 4b).
 *
 * Migration 020 widens the workflow_runs.status CHECK enum to add the 10th value,
 * 'paused' (SDK-only Pause/Resume), via the SQLite table-recreation recipe (the
 * same recipe migration 010 used to add the 9th value, 'awaiting_input').
 *
 * Building the authoritative post-019 workflow_runs shape from the real .sql files
 * 006→019 is impractical here — migration 014/015/016 pull in the projects table,
 * the entity model, and board seeding, none of which are relevant to this CHECK
 * widening. Instead we reconstruct the exact 26-column post-019 workflow_runs shape
 * by applying:
 *   - 006_cyboflow_schema.sql      (base table)
 *   - 007_add_stuck_reason.sql     (stuck_detected_at)
 *   - 010_questions.sql            (awaiting_input + first table recreation)
 *   - the workflow_runs ALTER COLUMN statements from 011/013/014/017/018/019
 *     applied inline (mirrors orchestratorTestDb.ts's includeWorkflowRunTaskColumns)
 * and THEN read + apply the real 020 SQL file. This proves the 020 file itself is
 * correct (not a hand-copied inline string) and that every column survives the
 * recreation.
 *
 * Targets:
 *   (a) a 'paused' status row INSERTs successfully after 020.
 *   (b) every one of the 26 columns survives 020's recreation with values intact.
 *   (c) all 5 workflow_runs indexes exist after 020.
 *   (d) re-running 020's recipe is a one-shot (re-exec raises 'table … already exists');
 *       the production runner records a ledger marker so the recipe runs exactly once.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

/**
 * Apply a migration SQL the way the production runner does: PRAGMA foreign_keys
 * toggles are no-ops inside a transaction (SQLite docs), so the table-recreation
 * recipe needs the pragma toggled OUTSIDE the transaction wrapper. Mirrors
 * runFileBasedMigrations() in database.ts and migration010.test.ts.
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
 * Build the authoritative post-019 workflow_runs shape (26 columns), then return
 * the DB ready for migration 020.
 */
function applyChainThrough019(): Database.Database {
  const db = new Database(':memory:');
  // 006 base + 007 stuck_detected_at + 010 (awaiting_input + table recreation).
  db.exec(readMigration('006_cyboflow_schema.sql'));
  db.exec(readMigration('007_add_stuck_reason.sql'));
  db.exec(readMigration('010_questions.sql'));
  // workflow_runs ALTERs from 011/013/014/017/018/019, in order. The non-
  // workflow_runs content of 014/015/016 is irrelevant to this CHECK widening.
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
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_workflow_runs_session_id ON workflow_runs(session_id)',
  ); // 019
  return db;
}

/** The 26 workflow_runs columns in authoritative post-019 order. */
const EXPECTED_COLUMNS = [
  'id',
  'workflow_id',
  'project_id',
  'status',
  'permission_mode_snapshot',
  'worktree_path',
  'branch_name',
  'policy_json',
  'stuck_at',
  'stuck_reason',
  'stuck_detected_at',
  'error_message',
  'created_at',
  'updated_at',
  'started_at',
  'ended_at',
  'current_step_id',
  'substrate',
  'task_id',
  'outcome',
  'base_branch',
  'base_sha',
  'steps_snapshot_json',
  'seed_idea_id',
  'claude_session_id',
  'session_id',
] as const;

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

describe('Migration 020: workflow_runs paused status CHECK widening', () => {
  it('(a) accepts a paused status row after migration 020', () => {
    const db = applyChainThrough019();
    runMigrationViaProductionPath(db, readMigration('020_workflow_run_paused_status.sql'));

    db.prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json)
       VALUES ('wf-1', 1, 'test', '{}')`,
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
           VALUES ('wr-paused', 'wf-1', 1, 'paused', 'default')`,
        )
        .run(),
    ).not.toThrow();

    const row = db
      .prepare('SELECT status FROM workflow_runs WHERE id = ?')
      .get('wr-paused') as { status: string };
    expect(row.status).toBe('paused');

    db.close();
  });

  it('(a) still accepts all 9 pre-existing status values after migration 020', () => {
    for (const status of [
      'queued',
      'starting',
      'running',
      'awaiting_review',
      'stuck',
      'completed',
      'failed',
      'canceled',
      'awaiting_input',
    ]) {
      const db = applyChainThrough019();
      runMigrationViaProductionPath(db, readMigration('020_workflow_run_paused_status.sql'));

      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json)
         VALUES ('wf-1', 1, 'test', '{}')`,
      ).run();

      expect(() =>
        db
          .prepare(
            `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
             VALUES ('wr-1', 'wf-1', 1, ?, 'default')`,
          )
          .run(status),
        `expected status '${status}' to remain valid after migration 020`,
      ).not.toThrow();

      db.close();
    }
  });

  it('(a) rejects an unknown status value after migration 020 (CHECK still enforced)', () => {
    const db = applyChainThrough019();
    runMigrationViaProductionPath(db, readMigration('020_workflow_run_paused_status.sql'));

    db.prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json)
       VALUES ('wf-1', 1, 'test', '{}')`,
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
           VALUES ('wr-bad', 'wf-1', 1, 'not_a_status', 'default')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);

    db.close();
  });

  it('(b) preserves all 26 columns with values intact through the table recreation', () => {
    const db = applyChainThrough019();

    db.prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json)
       VALUES ('wf-seed', 1, 'seed-wf', '{}')`,
    ).run();

    // Seed a row that exercises MANY columns across the full 26-column set,
    // including the Pause-preservation columns (claude_session_id, current_step_id)
    // and the deferred-triage columns (base_sha, base_branch, session_id).
    db.prepare(
      `INSERT INTO workflow_runs (
         id, workflow_id, project_id, status, permission_mode_snapshot,
         worktree_path, branch_name, policy_json, stuck_at, stuck_reason,
         stuck_detected_at, error_message, started_at, ended_at,
         current_step_id, substrate, task_id, outcome, base_branch, base_sha,
         steps_snapshot_json, seed_idea_id, claude_session_id, session_id
       ) VALUES (
         'wr-seed', 'wf-seed', 1, 'running', 'acceptEdits',
         '/tmp/wt', 'feature/x', '{"k":1}', '2026-06-01 00:00:00', 'orphan pty',
         1717200000, 'boom', '2026-06-01 00:00:00', '2026-06-02 00:00:00',
         'implement', 'sdk', 'TASK-900', 'merged', 'main', 'abc123sha',
         '{"implement":"executor"}', 'IDEA-900', 'claude-sess-xyz', 'sess-parent-1'
       )`,
    ).run();

    runMigrationViaProductionPath(db, readMigration('020_workflow_run_paused_status.sql'));

    // The full 26-column set survives the recreation.
    const cols = db.prepare('PRAGMA table_info(workflow_runs)').all() as TableInfoRow[];
    const names = cols.map((c) => c.name);
    expect(names).toEqual([...EXPECTED_COLUMNS]);

    // Values round-trip unchanged across every column.
    const row = db
      .prepare('SELECT * FROM workflow_runs WHERE id = ?')
      .get('wr-seed') as Record<string, unknown>;

    expect(row.id).toBe('wr-seed');
    expect(row.workflow_id).toBe('wf-seed');
    expect(row.project_id).toBe(1);
    expect(row.status).toBe('running');
    expect(row.permission_mode_snapshot).toBe('acceptEdits');
    expect(row.worktree_path).toBe('/tmp/wt');
    expect(row.branch_name).toBe('feature/x');
    expect(row.policy_json).toBe('{"k":1}');
    expect(row.stuck_at).toBe('2026-06-01 00:00:00');
    expect(row.stuck_reason).toBe('orphan pty');
    expect(row.stuck_detected_at).toBe(1717200000);
    expect(row.error_message).toBe('boom');
    expect(row.started_at).toBe('2026-06-01 00:00:00');
    expect(row.ended_at).toBe('2026-06-02 00:00:00');
    expect(row.current_step_id).toBe('implement');
    expect(row.substrate).toBe('sdk');
    expect(row.task_id).toBe('TASK-900');
    expect(row.outcome).toBe('merged');
    expect(row.base_branch).toBe('main');
    expect(row.base_sha).toBe('abc123sha');
    expect(row.steps_snapshot_json).toBe('{"implement":"executor"}');
    expect(row.seed_idea_id).toBe('IDEA-900');
    expect(row.claude_session_id).toBe('claude-sess-xyz');
    expect(row.session_id).toBe('sess-parent-1');

    db.close();
  });

  it('(b) FK-bound child rows survive migration 020 via the production-path wrapper', () => {
    const db = applyChainThrough019();

    db.prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json)
       VALUES ('wf-seed', 1, 'seed-wf', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
       VALUES ('wr-seed', 'wf-seed', 1, 'running', 'default')`,
    ).run();
    db.prepare(
      `INSERT INTO approvals (id, run_id, tool_name, tool_input_json, tool_use_id, status)
       VALUES ('ap-1', 'wr-seed', 'Bash', '{}', 'tu-1', 'pending')`,
    ).run();
    db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json)
       VALUES ('wr-seed', 'sdk_message', '{}')`,
    ).run();

    runMigrationViaProductionPath(db, readMigration('020_workflow_run_paused_status.sql'));

    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }).n,
    ).toBe(1);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM raw_events').get() as { n: number }).n,
    ).toBe(1);

    db.close();
  });

  it('(c) recreates all 5 workflow_runs indexes after migration 020', () => {
    const db = applyChainThrough019();
    runMigrationViaProductionPath(db, readMigration('020_workflow_run_paused_status.sql'));

    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='workflow_runs'",
      )
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));

    expect(names).toContain('idx_workflow_runs_status_created');
    expect(names).toContain('idx_workflow_runs_workflow_id');
    expect(names).toContain('idx_workflow_runs_status_stuck_at');
    expect(names).toContain('idx_workflow_runs_task_id');
    expect(names).toContain('idx_workflow_runs_session_id');

    db.close();
  });

  it('(d) re-running the recipe is idempotent — same shape, data, and indexes survive', () => {
    // The recipe builds a fresh workflow_runs_new, copies, drops the old table, and
    // renames — so a second exec finds workflow_runs_new absent (renamed away last
    // time) and reproduces the identical post-020 shape. The production runner gates
    // it to a single application via the user_preferences ledger anyway, but proving
    // it is self-idempotent guards against accidental data loss on a double-apply.
    const db = applyChainThrough019();
    const sql = readMigration('020_workflow_run_paused_status.sql');

    db.prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json)
       VALUES ('wf-1', 1, 'test', '{}')`,
    ).run();
    // Seed with a pre-020-valid status — the table still carries the 9-value CHECK
    // until migration 020 widens it — then flip to 'paused' after the first apply so
    // we still prove a paused row survives the second application.
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, claude_session_id, current_step_id)
       VALUES ('wr-idem', 'wf-1', 1, 'running', 'default', 'sess-keep', 'implement')`,
    ).run();

    // Apply once (widens the CHECK), flip to 'paused', then apply a second time.
    runMigrationViaProductionPath(db, sql);
    db.prepare("UPDATE workflow_runs SET status = 'paused' WHERE id = 'wr-idem'").run();
    expect(() => runMigrationViaProductionPath(db, sql)).not.toThrow();

    // Shape unchanged.
    const cols = db.prepare('PRAGMA table_info(workflow_runs)').all() as TableInfoRow[];
    expect(cols.map((c) => c.name)).toEqual([...EXPECTED_COLUMNS]);

    // Row + resume-critical columns survived both applications.
    const row = db
      .prepare('SELECT status, claude_session_id, current_step_id FROM workflow_runs WHERE id = ?')
      .get('wr-idem') as {
      status: string;
      claude_session_id: string | null;
      current_step_id: string | null;
    };
    expect(row.status).toBe('paused');
    expect(row.claude_session_id).toBe('sess-keep');
    expect(row.current_step_id).toBe('implement');

    // No leftover scratch table.
    const scratch = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_runs_new'")
      .get();
    expect(scratch).toBeUndefined();

    // All 5 indexes still present after the second application.
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='workflow_runs'")
      .all() as Array<{ name: string }>;
    const idxNames = new Set(idx.map((r) => r.name));
    expect(idxNames).toContain('idx_workflow_runs_status_created');
    expect(idxNames).toContain('idx_workflow_runs_workflow_id');
    expect(idxNames).toContain('idx_workflow_runs_status_stuck_at');
    expect(idxNames).toContain('idx_workflow_runs_task_id');
    expect(idxNames).toContain('idx_workflow_runs_session_id');

    db.close();
  });
});
