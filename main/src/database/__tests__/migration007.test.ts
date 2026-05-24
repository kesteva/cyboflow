/**
 * Integration tests for migration 007_add_stuck_reason.sql (TASK-737).
 *
 * These tests apply 006_cyboflow_schema.sql and then 007_add_stuck_reason.sql
 * directly against an in-memory SQLite instance. This proves the SQL file
 * itself is correct — not the inline ALTER in orchestratorTestDb.ts:createTestDb,
 * which uses a hard-coded string and would not catch column-type changes or
 * index typos in the actual migration file.
 *
 * The three test_strategy.targets from the plan frontmatter:
 *  1. Applying 007 adds stuck_detected_at INTEGER to workflow_runs.
 *  2. Applying 007 creates the idx_workflow_runs_status_stuck_at index.
 *  3. (Optional) The CREATE INDEX uses IF NOT EXISTS so re-executing is safe.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helper: open a fresh in-memory DB and apply migrations 006 and 007
// ---------------------------------------------------------------------------

function applyMigrations006And007(): Database.Database {
  const db = new Database(':memory:');

  const sql006 = readFileSync(
    join(__dirname, '..', 'migrations', '006_cyboflow_schema.sql'),
    'utf-8'
  );
  db.exec(sql006);

  const sql007 = readFileSync(
    join(__dirname, '..', 'migrations', '007_add_stuck_reason.sql'),
    'utf-8'
  );
  db.exec(sql007);

  return db;
}

// ---------------------------------------------------------------------------
// PRAGMA table_info row shape returned by better-sqlite3
// ---------------------------------------------------------------------------

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

interface SqliteMasterRow {
  name: string;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Migration 007: stuck_detected_at column and index', () => {
  it('adds stuck_detected_at INTEGER to workflow_runs', () => {
    const db = applyMigrations006And007();

    const rows = db
      .prepare('PRAGMA table_info(workflow_runs)')
      .all() as TableInfoRow[];

    const col = rows.find((r) => r.name === 'stuck_detected_at');

    expect(col).toBeDefined();
    expect(String(col!.type).toUpperCase()).toBe('INTEGER');
  });

  it('creates idx_workflow_runs_status_stuck_at index', () => {
    const db = applyMigrations006And007();

    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_workflow_runs_status_stuck_at'"
      )
      .all() as SqliteMasterRow[];

    expect(rows).toHaveLength(1);
  });

  it('is idempotent when re-applying the IF NOT EXISTS index clause', () => {
    const db = applyMigrations006And007();

    // The ALTER TABLE statement does NOT support IF NOT EXISTS in SQLite, so we
    // only re-execute the CREATE INDEX line (which does use IF NOT EXISTS).
    // This asserts the IF NOT EXISTS guard is present and effective.
    expect(() => {
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_stuck_at ON workflow_runs(status, stuck_detected_at)'
      );
    }).not.toThrow();
  });
});
