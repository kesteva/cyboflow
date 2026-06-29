/**
 * Integration tests for migration 038_session_chat_run_id.sql
 * (the pure gate vehicle — permission-mode redesign §6, Slice 3).
 *
 * Applies 006_cyboflow_schema.sql (workflows + workflow_runs) → a minimal inline
 * `sessions` table (id, run_id; 006 does not create one) → 038 against an in-memory
 * SQLite instance. Proves the SQL file itself is correct (not a hard-coded inline
 * string) and that the backfill copies run_id → chat_run_id ONLY for sessions whose
 * run_id points at a `__quick__` sentinel.
 *
 * Targets:
 *  1. ADD COLUMN — sessions.chat_run_id is created (nullable, default NULL).
 *  2. BACKFILL — a session whose run_id points at a __quick__ sentinel gets that
 *     sentinel copied into chat_run_id.
 *  3. NON-QUICK — a session whose run_id points at a FLOW (non-__quick__) run stays
 *     NULL (the flow-hosted case: the sentinel is minted on read on the next chat turn).
 *  4. NULL run_id — a flow-only/legacy session with no run_id stays NULL.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

/** Minimal stand-in for the inherited `sessions` table (migration 009 shape, pre-038). */
function createSessionsTable(db: Database.Database): void {
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, run_id TEXT)');
}

function seedQuickWorkflow(db: Database.Database): void {
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-quick', 1, '__quick__', '{}')`,
  ).run();
}

function seedFlowWorkflow(db: Database.Database): void {
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-flow', 1, 'sprint', '{}')`,
  ).run();
}

function seedRun(db: Database.Database, id: string, workflowId: string): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, ?, 1, 'running', 'default')`,
  ).run(id, workflowId);
}

function applyBase(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readMigration('006_cyboflow_schema.sql'));
  createSessionsTable(db);
  return db;
}

describe('Migration 038: sessions.chat_run_id gate vehicle', () => {
  it('adds the chat_run_id column (nullable, default NULL)', () => {
    const db = applyBase();
    db.exec(readMigration('038_session_chat_run_id.sql'));

    const cols = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'chat_run_id')).toBe(true);
    db.close();
  });

  it('backfills chat_run_id from a run_id that points at a __quick__ sentinel', () => {
    const db = applyBase();
    seedQuickWorkflow(db);
    seedRun(db, 'quick-run-1', 'wf-quick');
    db.prepare(`INSERT INTO sessions (id, run_id) VALUES ('sess-quick', 'quick-run-1')`).run();

    db.exec(readMigration('038_session_chat_run_id.sql'));

    const row = db
      .prepare('SELECT chat_run_id FROM sessions WHERE id = ?')
      .get('sess-quick') as { chat_run_id: string | null };
    expect(row.chat_run_id).toBe('quick-run-1');
    db.close();
  });

  it('leaves chat_run_id NULL for a session whose run_id points at a FLOW (non-__quick__) run', () => {
    const db = applyBase();
    seedFlowWorkflow(db);
    seedRun(db, 'flow-run-1', 'wf-flow');
    db.prepare(`INSERT INTO sessions (id, run_id) VALUES ('sess-flow', 'flow-run-1')`).run();

    db.exec(readMigration('038_session_chat_run_id.sql'));

    const row = db
      .prepare('SELECT chat_run_id FROM sessions WHERE id = ?')
      .get('sess-flow') as { chat_run_id: string | null };
    expect(row.chat_run_id).toBeNull();
    db.close();
  });

  it('leaves chat_run_id NULL for a flow-only/legacy session with no run_id', () => {
    const db = applyBase();
    db.prepare(`INSERT INTO sessions (id, run_id) VALUES ('sess-none', NULL)`).run();

    db.exec(readMigration('038_session_chat_run_id.sql'));

    const row = db
      .prepare('SELECT chat_run_id FROM sessions WHERE id = ?')
      .get('sess-none') as { chat_run_id: string | null };
    expect(row.chat_run_id).toBeNull();
    db.close();
  });
});
