/**
 * Migration 132_run_usage_recompute.sql — invalidate stale `run_usage`
 * rollups so the next boot backfill (backfillRunUsageRollups) re-materializes
 * them with the corrected cost-ladder semantics (insightsQueries.ts's
 * scanRawEventRollups now ladders `result.total_cost_usd` per SDK process
 * instead of plain-summing it).
 *
 * Same minimal-chain technique as migration112.test.ts: 006 defines
 * `raw_events` + `workflow_runs`, 026 adds the `run_usage` table this
 * migration targets. FKs are left OFF so seeding a bare `run_usage` /
 * `raw_events` row needs no real `workflow_runs` parent — this migration
 * cares only about the `run_id` relationship BETWEEN those two tables, not
 * about `workflow_runs`.
 *
 * Targets:
 *   (a) a run_usage row for a run that still has raw_events is deleted.
 *   (b) a run_usage row for a run with no raw_events survives (nothing to
 *       recompute it from).
 *   (c) applying the file twice is a no-op the second time (idempotent DML).
 *   (d) only matching runs are touched — an unrelated run's row is untouched.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');
}

/** 006 defines raw_events + workflow_runs; 026 adds the run_usage table. */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(readMigration('006_cyboflow_schema.sql'));
  db.exec(readMigration('026_run_usage_spec_hash_revisions.sql'));
  return db;
}

function seedRunUsage(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT INTO run_usage (run_id, input_tokens, output_tokens, total_tokens, cost_usd, num_turns)
     VALUES (?, 10, 5, 15, 1.23, 2)`,
  ).run(runId);
}

function seedRawEvent(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT INTO raw_events (run_id, event_type, payload_json) VALUES (?, 'result', '{}')`,
  ).run(runId);
}

function runUsageRunIds(db: Database.Database): string[] {
  return (
    db.prepare('SELECT run_id FROM run_usage ORDER BY run_id').all() as Array<{ run_id: string }>
  ).map((r) => r.run_id);
}

describe('migration 132 run_usage recompute', () => {
  it('deletes the run_usage row for a run that still has raw_events', () => {
    const db = makeDb();
    seedRunUsage(db, 'run-with-events');
    seedRawEvent(db, 'run-with-events');

    db.exec(readMigration('132_run_usage_recompute.sql'));

    expect(runUsageRunIds(db)).toEqual([]);
  });

  it('keeps the run_usage row for a run whose raw_events are gone', () => {
    const db = makeDb();
    seedRunUsage(db, 'run-no-events');
    // No raw_events row for this run at all — nothing to recompute it from.

    db.exec(readMigration('132_run_usage_recompute.sql'));

    expect(runUsageRunIds(db)).toEqual(['run-no-events']);
  });

  it('touches only runs present in raw_events, leaving unrelated runs alone', () => {
    const db = makeDb();
    seedRunUsage(db, 'run-a-events');
    seedRawEvent(db, 'run-a-events');
    seedRunUsage(db, 'run-b-no-events');

    db.exec(readMigration('132_run_usage_recompute.sql'));

    expect(runUsageRunIds(db)).toEqual(['run-b-no-events']);
  });

  it('is idempotent — a second application deletes nothing further', () => {
    const db = makeDb();
    seedRunUsage(db, 'run-with-events');
    seedRawEvent(db, 'run-with-events');
    seedRunUsage(db, 'run-no-events');

    db.exec(readMigration('132_run_usage_recompute.sql'));
    expect(runUsageRunIds(db)).toEqual(['run-no-events']);

    expect(() => db.exec(readMigration('132_run_usage_recompute.sql'))).not.toThrow();
    expect(runUsageRunIds(db)).toEqual(['run-no-events']);
  });
});
