/**
 * Integration tests for migration 039_backfill_run_session_id.sql
 * (session-invariant history cleanup — re-run 019's recovery for runs that became
 * NULL after 019, e.g. SDK quick sentinels created post-019).
 *
 * Applies 006_cyboflow_schema.sql → 011_workflow_step_tracking.sql → a minimal
 * inline `sessions` table (006 does not create one, but the backfill UPDATE reads
 * sessions.id / sessions.run_id) → 019_workflow_run_session_id.sql (which adds the
 * session_id column) → 039_backfill_run_session_id.sql against an in-memory SQLite
 * instance. This proves the SQL file itself is correct — not a hard-coded inline
 * string — and that, unlike 019's ALTER, 039 is a pure UPDATE that is STRICTLY
 * idempotent (re-running it never throws and is data-stable).
 *
 * Targets:
 *  1. BACKFILL — a run left session_id = NULL after 019 (e.g. an SDK quick sentinel
 *     created post-019) but with an existing sessions.run_id back-reference gets that
 *     session's id copied forward into workflow_runs.session_id when 039 runs.
 *  2. IDEMPOTENT — re-executing 039 does NOT throw (pure UPDATE, no ALTER) and leaves
 *     the backfilled value unchanged.
 *  3. NO-CLOBBER — a run that already has a session_id is left untouched even if a
 *     DIFFERENT session.run_id happens to point at it (the session_id IS NULL guard).
 *  4. ORPHAN — a run with NULL session_id that NO session points back at stays NULL
 *     (residual orphaned sentinels are terminal/historical, not recovered).
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

/**
 * Minimal stand-in for the inherited `sessions` table — 006_cyboflow_schema.sql
 * declares only the orchestrator tables, but migrations 019/039's backfill UPDATE
 * reads sessions.id and sessions.run_id (added in migration 009 against the legacy
 * schema).
 */
function createSessionsTable(db: Database.Database): void {
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, run_id TEXT)');
}

/** Seed a workflow row so the workflow_runs FK is satisfied. */
function seedWorkflow(db: Database.Database): void {
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json)
     VALUES ('wf-1', 1, 'test-wf', '{}')`,
  ).run();
}

/**
 * Apply the schema up to and including 019 (which adds the session_id column 039
 * backfills), plus a minimal sessions table. Callers seed rows and run 039 themselves.
 */
function applyBase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readMigration('006_cyboflow_schema.sql'));
  db.exec(readMigration('011_workflow_step_tracking.sql'));
  createSessionsTable(db);
  db.exec(readMigration('019_workflow_run_session_id.sql'));
  return db;
}

describe('Migration 039: backfill workflow_runs.session_id (idempotent)', () => {
  it('backfills a post-019 NULL session_id from an existing sessions.run_id back-reference', () => {
    const db = applyBase();
    seedWorkflow(db);

    // A run created AFTER 019 ran: session_id is NULL by design, but a session
    // points back at it (the SDK-quick-sentinel scenario 039 cleans up).
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
       VALUES ('wr-x', 'wf-1', 1, 'queued', 'default')`,
    ).run();
    db.prepare(`INSERT INTO sessions (id, run_id) VALUES ('sess-1', 'wr-x')`).run();

    db.exec(readMigration('039_backfill_run_session_id.sql'));

    const row = db
      .prepare('SELECT session_id FROM workflow_runs WHERE id = ?')
      .get('wr-x') as { session_id: string | null };

    expect(row.session_id).toBe('sess-1');

    db.close();
  });

  it('is strictly idempotent: re-executing 039 does not throw and is data-stable', () => {
    const db = applyBase();
    seedWorkflow(db);

    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
       VALUES ('wr-x', 'wf-1', 1, 'queued', 'default')`,
    ).run();
    db.prepare(`INSERT INTO sessions (id, run_id) VALUES ('sess-1', 'wr-x')`).run();

    // First run backfills.
    db.exec(readMigration('039_backfill_run_session_id.sql'));

    // Re-running the pure UPDATE must NOT throw (contrast 019's ALTER) and must
    // leave the value unchanged.
    expect(() => {
      db.exec(readMigration('039_backfill_run_session_id.sql'));
      db.exec(readMigration('039_backfill_run_session_id.sql'));
    }).not.toThrow();

    const row = db
      .prepare('SELECT session_id FROM workflow_runs WHERE id = ?')
      .get('wr-x') as { session_id: string | null };

    expect(row.session_id).toBe('sess-1');

    db.close();
  });

  it('does not clobber an already-populated session_id (NULL guard)', () => {
    const db = applyBase();
    seedWorkflow(db);

    // The run already carries its correct owner; a DIFFERENT session also points
    // back at it. The `session_id IS NULL` guard must leave the existing value.
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id)
       VALUES ('wr-y', 'wf-1', 1, 'queued', 'default', 'sess-owner')`,
    ).run();
    db.prepare(`INSERT INTO sessions (id, run_id) VALUES ('sess-other', 'wr-y')`).run();

    db.exec(readMigration('039_backfill_run_session_id.sql'));

    const row = db
      .prepare('SELECT session_id FROM workflow_runs WHERE id = ?')
      .get('wr-y') as { session_id: string | null };

    expect(row.session_id).toBe('sess-owner');

    db.close();
  });

  it('leaves an orphaned run (no session points back) with NULL session_id', () => {
    const db = applyBase();
    seedWorkflow(db);

    // Residual orphaned sentinel: session_id NULL and nothing points back.
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
       VALUES ('wr-orphan', 'wf-1', 1, 'queued', 'default')`,
    ).run();

    db.exec(readMigration('039_backfill_run_session_id.sql'));

    const row = db
      .prepare('SELECT session_id FROM workflow_runs WHERE id = ?')
      .get('wr-orphan') as { session_id: string | null };

    expect(row.session_id).toBeNull();

    db.close();
  });
});
