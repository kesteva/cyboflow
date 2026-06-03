/**
 * Integration tests for migration 017_run_seed_idea.sql (Planner pre-launch idea selection).
 *
 * Applies 006_cyboflow_schema.sql → 011_workflow_step_tracking.sql →
 * 017_run_seed_idea.sql against an in-memory SQLite instance. This proves the SQL
 * file itself is correct — not a hard-coded inline string — and guards against
 * column-type typos.
 *
 * Targets:
 *  1. Applying 006→011→017 adds seed_idea_id TEXT (nullable, no default) to workflow_runs.
 *  2. A row inserted WITHOUT a seed_idea_id reads back NULL (existing rows unaffected).
 *  3. An explicit seed_idea_id round-trips.
 *  4. Re-executing 017 raises 'duplicate column name: seed_idea_id' SqliteError
 *     (the idempotency signal that runFileBasedMigrations uses to skip
 *     already-applied files).
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf-8');
}

function applyMigrations(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readMigration('006_cyboflow_schema.sql'));
  db.exec(readMigration('011_workflow_step_tracking.sql'));
  db.exec(readMigration('017_run_seed_idea.sql'));
  return db;
}

/** Seed a workflow row so the workflow_runs FK is satisfied. */
function seedWorkflow(db: Database.Database): void {
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json)
     VALUES ('wf-1', 1, 'test-wf', '{}')`,
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

describe('Migration 017: seed_idea_id column on workflow_runs', () => {
  it('adds seed_idea_id TEXT (nullable, no default) to workflow_runs', () => {
    const db = applyMigrations();

    const rows = db
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as TableInfoRow[];

    const col = rows.find((r) => r.name === 'seed_idea_id');

    expect(col).toBeDefined();
    expect(String(col!.type).toUpperCase()).toBe('TEXT');
    // notnull=0 means the column is nullable
    expect(col!.notnull).toBe(0);
    // No default literal
    expect(col!.dflt_value).toBeNull();

    db.close();
  });

  it('a row inserted WITHOUT a seed_idea_id reads back NULL', () => {
    const db = applyMigrations();
    seedWorkflow(db);

    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
       VALUES ('wr-none', 'wf-1', 1, 'queued', 'default')`,
    ).run();

    const row = db
      .prepare('SELECT seed_idea_id FROM workflow_runs WHERE id = ?')
      .get('wr-none') as { seed_idea_id: string | null };

    expect(row.seed_idea_id).toBeNull();

    db.close();
  });

  it('round-trips an explicit seed_idea_id value', () => {
    const db = applyMigrations();
    seedWorkflow(db);

    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, seed_idea_id)
       VALUES ('wr-seeded', 'wf-1', 1, 'queued', 'default', 'IDEA-042')`,
    ).run();

    const row = db
      .prepare('SELECT seed_idea_id FROM workflow_runs WHERE id = ?')
      .get('wr-seeded') as { seed_idea_id: string | null };

    expect(row.seed_idea_id).toBe('IDEA-042');

    db.close();
  });

  it('re-executing migration 017 raises duplicate column name: seed_idea_id', () => {
    const db = applyMigrations();

    expect(() => {
      db.exec(readMigration('017_run_seed_idea.sql'));
    }).toThrow(/duplicate column name: seed_idea_id/i);

    db.close();
  });
});
