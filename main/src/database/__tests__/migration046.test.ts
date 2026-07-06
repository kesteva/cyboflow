/**
 * Integration tests for migration 046_notification_kind.sql.
 *
 * Migration 046 widens review_items.kind to add a fifth kind, 'notification',
 * via the table-rebuild recipe (SQLite cannot ALTER a CHECK). It recreates the
 * FULL post-034 schema (016 columns + priority/staged_at/selected) with the
 * widened CHECK, copies the rows across, recreates all five indexes, and
 * backfills the dynamic-workflow human_task items to notification.
 *
 * We build the real pre-046 review_items shape from 016 + 034 (against the
 * minimal projects table + the post-019 workflow_runs shape the FKs reference),
 * seed rows the backfill must and must-not touch, then read + apply the real
 * 046 SQL file the way the production runner does (FK-toggle honoured).
 *
 * Targets:
 *   (a) a kind='notification' row inserts successfully post-migration.
 *   (b) a pre-existing human_task row with source='dynamic_workflow' is
 *       backfilled to notification.
 *   (c) a human_task row with a DIFFERENT source is untouched.
 *   (d) all five indexes exist after the rebuild.
 *   (e) an invalid kind still fails the widened CHECK.
 *   (f) the fresh-DB initialize() path accepts notification + keeps the indexes.
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
 * Apply a migration SQL the way the production runner does: honour the
 * `PRAGMA foreign_keys=OFF` literal by toggling OUTSIDE the transaction, then
 * wrap the file body in a single transaction (mirrors runFileBasedMigrations()).
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
 * Build the pre-046 DB: a minimal projects table, the real review_items table
 * (016 + 034), and the real post-019 workflow_runs shape the FK references.
 * Seeds one project, one run, and three review_items rows the backfill probes.
 */
function applyChainPre046(): Database.Database {
  const db = new Database(':memory:');
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
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj One', '/tmp/p1');

  // Post-019 workflow_runs (mirrors migration034.test.ts's chain) so the
  // run_id FK on review_items has a real target after the rebuild.
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

  // Real review_items (016) + the finding-triage columns (034).
  db.exec(readMigration('016_review_items.sql'));
  db.exec(readMigration('034_findings_triage.sql'));

  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES ('wr-1', 'wf-1', 1, 'running', 'default')`,
  ).run();

  // A dynamic-workflow human_task item — the backfill target (NULL payload).
  db.prepare(
    `INSERT INTO review_items (id, project_id, run_id, kind, status, title, source)
     VALUES ('rvw-dynwf', 1, 'wr-1', 'human_task', 'pending', 'Dynamic workflow finished', 'dynamic_workflow')`,
  ).run();
  // A human_task from another source — must stay human_task.
  db.prepare(
    `INSERT INTO review_items (id, project_id, kind, status, title, source)
     VALUES ('rvw-user', 1, 'human_task', 'pending', 'Ping the release owner', 'user')`,
  ).run();
  // A finding — untouched control.
  db.prepare(
    `INSERT INTO review_items (id, project_id, kind, status, title)
     VALUES ('rvw-find', 1, 'finding', 'pending', 'N+1 query')`,
  ).run();

  return db;
}

describe('Migration 046: notification review-item kind', () => {
  it('(a) accepts a kind=notification row after the migration', () => {
    const db = applyChainPre046();
    runMigrationViaProductionPath(db, readMigration('046_notification_kind.sql'));

    expect(() =>
      db
        .prepare(
          `INSERT INTO review_items (id, project_id, kind, status, title)
           VALUES ('rvw-note', 1, 'notification', 'pending', 'FYI')`,
        )
        .run(),
    ).not.toThrow();

    const row = db.prepare('SELECT kind FROM review_items WHERE id = ?').get('rvw-note') as {
      kind: string;
    };
    expect(row.kind).toBe('notification');
    db.close();
  });

  it('(b) backfills a dynamic_workflow human_task to notification', () => {
    const db = applyChainPre046();
    runMigrationViaProductionPath(db, readMigration('046_notification_kind.sql'));

    const row = db.prepare('SELECT kind, source FROM review_items WHERE id = ?').get('rvw-dynwf') as {
      kind: string;
      source: string;
    };
    expect(row.kind).toBe('notification');
    expect(row.source).toBe('dynamic_workflow');
    db.close();
  });

  it('(c) leaves a human_task from a different source untouched', () => {
    const db = applyChainPre046();
    runMigrationViaProductionPath(db, readMigration('046_notification_kind.sql'));

    const user = db.prepare('SELECT kind FROM review_items WHERE id = ?').get('rvw-user') as {
      kind: string;
    };
    expect(user.kind).toBe('human_task');
    const find = db.prepare('SELECT kind FROM review_items WHERE id = ?').get('rvw-find') as {
      kind: string;
    };
    expect(find.kind).toBe('finding');
    db.close();
  });

  it('(d) recreates all five review_items indexes', () => {
    const db = applyChainPre046();
    runMigrationViaProductionPath(db, readMigration('046_notification_kind.sql'));

    const names = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='review_items'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name),
    );
    expect(names).toContain('idx_review_items_project_status');
    expect(names).toContain('idx_review_items_run_kind');
    expect(names).toContain('idx_review_items_blocking_status');
    expect(names).toContain('idx_review_items_project_staged');
    expect(names).toContain('idx_review_items_project_selected');
    db.close();
  });

  it('(e) still rejects an invalid kind after the widened CHECK', () => {
    const db = applyChainPre046();
    runMigrationViaProductionPath(db, readMigration('046_notification_kind.sql'));

    expect(() =>
      db
        .prepare(
          `INSERT INTO review_items (id, project_id, kind, status, title)
           VALUES ('rvw-bad', 1, 'nonsense', 'pending', 'x')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it('(f) the fresh-DB initialize() path accepts notification + keeps the indexes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-migration046-'));
    try {
      const svc = new DatabaseService(join(dir, 'test.db'));
      svc.setMigrationsDirForTesting(join(__dirname, '..', 'migrations'));
      svc.initialize();
      const db = svc.getDb();

      // Seed a project so the FK holds, then insert a notification row.
      db.prepare("INSERT INTO projects (id, name, path) VALUES (1, 'P', '/tmp/fresh046')").run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO review_items (id, project_id, kind, status, title)
             VALUES ('rvw-fresh', 1, 'notification', 'pending', 'FYI')`,
          )
          .run(),
      ).not.toThrow();

      const idxNames = new Set(
        (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='review_items'")
            .all() as Array<{ name: string }>
        ).map((r) => r.name),
      );
      expect(idxNames).toContain('idx_review_items_project_status');
      expect(idxNames).toContain('idx_review_items_project_selected');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
