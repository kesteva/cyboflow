/**
 * Integration tests for migration 025_sprint_lane_attempts.sql (swim-lanes
 * canvas — the per-task attempt counter).
 *
 * Applies 006_cyboflow_schema.sql → 022_sprint_batches.sql →
 * 023_sprint_lane_step.sql → 025_sprint_lane_attempts.sql against an in-memory
 * SQLite instance. Proves the SQL file is correct (not a hard-coded inline
 * string) and guards against typos.
 *
 * Targets:
 *  1. sprint_batch_tasks gains an attempts INTEGER NOT NULL DEFAULT 0 column
 *     (existing rows backfill to 0).
 *  2. Re-executing 025 raises 'duplicate column name: attempts' (the
 *     idempotency signal runFileBasedMigrations uses to skip already-applied
 *     files, same mechanism as migrations 022 / 023).
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
  db.exec(readMigration('025_sprint_lane_attempts.sql'));
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

describe('Migration 025: sprint lane attempts', () => {
  it('adds an attempts INTEGER NOT NULL DEFAULT 0 column to sprint_batch_tasks', () => {
    const db = applyMigrations();
    const col = columns(db, 'sprint_batch_tasks').find((c) => c.name === 'attempts');
    expect(col).toBeDefined();
    expect(String(col!.type).toUpperCase()).toBe('INTEGER');
    expect(col!.notnull).toBe(1);
    expect(String(col!.dflt_value)).toBe('0');
    db.close();
  });

  it('pre-existing lane rows read back attempts = 0 and remain writable', () => {
    // Apply 022 + 023 + seed a row BEFORE 025 to mimic an upgrade install.
    const db = new Database(':memory:');
    db.exec(readMigration('006_cyboflow_schema.sql'));
    db.exec(readMigration('022_sprint_batches.sql'));
    db.exec(readMigration('023_sprint_lane_step.sql'));
    db.prepare("INSERT INTO sprint_batches (id, project_id) VALUES ('b1', 1)").run();
    db.prepare("INSERT INTO sprint_batch_tasks (batch_id, task_id) VALUES ('b1', 't1')").run();

    db.exec(readMigration('025_sprint_lane_attempts.sql'));

    const row = db
      .prepare("SELECT attempts FROM sprint_batch_tasks WHERE batch_id = 'b1' AND task_id = 't1'")
      .get() as { attempts: number };
    expect(row.attempts).toBe(0);

    db.prepare("UPDATE sprint_batch_tasks SET attempts = 2 WHERE task_id = 't1'").run();
    const updated = db
      .prepare("SELECT attempts FROM sprint_batch_tasks WHERE task_id = 't1'")
      .get() as { attempts: number };
    expect(updated.attempts).toBe(2);
    db.close();
  });

  it('re-executing migration 025 raises duplicate column name: attempts', () => {
    const db = applyMigrations();
    expect(() => {
      db.exec(readMigration('025_sprint_lane_attempts.sql'));
    }).toThrow(/duplicate column name: attempts/i);
    db.close();
  });
});
