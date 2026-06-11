/**
 * Integration tests for migration 023_sprint_lane_step.sql (sprint-orchestrator
 * redesign — the lane substrate).
 *
 * Applies 006_cyboflow_schema.sql → 022_sprint_batches.sql →
 * 023_sprint_lane_step.sql against an in-memory SQLite instance. Proves the SQL
 * file is correct (not a hard-coded inline string) and guards against typos.
 *
 * Targets:
 *  1. sprint_batch_tasks gains a nullable current_step_id TEXT column (existing
 *     rows unaffected — they read back NULL).
 *  2. Re-executing 023 raises 'duplicate column name: current_step_id' (the
 *     idempotency signal runFileBasedMigrations uses to skip already-applied
 *     files, same mechanism as migration 022).
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
  db.exec(readMigration('022_sprint_batches.sql'));
  db.exec(readMigration('023_sprint_lane_step.sql'));
  return db;
}

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function columns(db: Database.Database, table: string): TableInfoRow[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
}

describe('Migration 023: sprint lane current step', () => {
  it('adds a nullable current_step_id TEXT column to sprint_batch_tasks', () => {
    const db = applyMigrations();
    const col = columns(db, 'sprint_batch_tasks').find((c) => c.name === 'current_step_id');
    expect(col).toBeDefined();
    expect(String(col!.type).toUpperCase()).toBe('TEXT');
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
    db.close();
  });

  it('pre-existing lane rows read back current_step_id = NULL and remain writable', () => {
    // Apply 022 + seed a row BEFORE 023 to mimic an upgrade install.
    const db = new Database(':memory:');
    db.exec(readMigration('006_cyboflow_schema.sql'));
    db.exec(readMigration('022_sprint_batches.sql'));
    db.prepare("INSERT INTO sprint_batches (id, project_id) VALUES ('b1', 1)").run();
    db.prepare("INSERT INTO sprint_batch_tasks (batch_id, task_id) VALUES ('b1', 't1')").run();

    db.exec(readMigration('023_sprint_lane_step.sql'));

    const row = db
      .prepare("SELECT current_step_id FROM sprint_batch_tasks WHERE batch_id = 'b1' AND task_id = 't1'")
      .get() as { current_step_id: string | null };
    expect(row.current_step_id).toBeNull();

    db.prepare("UPDATE sprint_batch_tasks SET current_step_id = 'implement' WHERE task_id = 't1'").run();
    const updated = db
      .prepare("SELECT current_step_id FROM sprint_batch_tasks WHERE task_id = 't1'")
      .get() as { current_step_id: string | null };
    expect(updated.current_step_id).toBe('implement');
    db.close();
  });

  it('re-executing migration 023 raises duplicate column name: current_step_id', () => {
    const db = applyMigrations();
    expect(() => {
      db.exec(readMigration('023_sprint_lane_step.sql'));
    }).toThrow(/duplicate column name: current_step_id/i);
    db.close();
  });
});
