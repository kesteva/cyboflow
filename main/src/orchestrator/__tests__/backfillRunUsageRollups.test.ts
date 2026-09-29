/**
 * Unit tests for backfillRunUsageRollups — the boot sweep that materializes the
 * `run_usage` rollup (migration 026) for terminal runs whose usage lives only in
 * raw_events.
 *
 * WHY THE SWEEP EXISTS: rollupRunUsage is wired to runExecutor's terminal
 * lifecycle hook alone, but ~8 other writers can drive a run terminal (the
 * cancel handlers, questionRouter, the trpc close-outs, the merge path, the boot
 * orphan sweeps). Each leaves the run with raw_events and no durable row —
 * invisible today only because Insights falls back to a raw_events scan.
 *
 * Behaviors covered:
 *   a. A terminal run with usage events but no row gets one, with the summed
 *      token/cost values.
 *   b. NON-terminal runs are skipped — their raw_events log is still growing, so
 *      materializing would freeze a partial rollup the read path then prefers.
 *   c. An existing row is never overwritten (INSERT OR IGNORE, not REPLACE).
 *   d. Runs with no raw_events at all are not candidates.
 *   e. Idempotent: a second sweep finds nothing to do.
 *   f. Fail-soft on a missing run_usage table (un-migrated DB) — warn, no throw.
 *
 * Fixture mirrors runUsageRollup.test.ts: in-memory better-sqlite3 with
 * raw_events (shared DDL), run_usage (migration 026 shape), and a workflow_runs
 * stub carrying the `status` column this sweep filters on. FKs off so run_usage
 * can be written without a full parent row.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

import { backfillRunUsageRollups } from '../runRecovery';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import { RAW_EVENTS_DDL } from '../__test_fixtures__/rawEvents';

const WORKFLOW_RUNS_DDL = `
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id         TEXT PRIMARY KEY,
    status     TEXT NOT NULL,
    started_at DATETIME,
    ended_at   DATETIME
  )
`;

const RUN_USAGE_DDL = `
  CREATE TABLE IF NOT EXISTS run_usage (
    run_id                  TEXT PRIMARY KEY,
    input_tokens            INTEGER NOT NULL DEFAULT 0,
    output_tokens           INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens       INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens   INTEGER NOT NULL DEFAULT 0,
    total_tokens            INTEGER NOT NULL DEFAULT 0,
    cost_usd                REAL,
    num_turns               INTEGER,
    assistant_message_count INTEGER NOT NULL DEFAULT 0,
    computed_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
    accounting_version      INTEGER NOT NULL DEFAULT 0,
    coverage                TEXT NOT NULL DEFAULT 'legacy'
  )
`;

function makeDb(opts?: { omitRunUsage?: boolean }): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(RAW_EVENTS_DDL);
  db.exec(WORKFLOW_RUNS_DDL);
  if (opts?.omitRunUsage !== true) db.exec(RUN_USAGE_DDL);
  return db;
}

function seedRun(db: Database.Database, id: string, status: string): void {
  db.prepare('INSERT INTO workflow_runs (id, status) VALUES (?, ?)').run(id, status);
}

function seedEvent(
  db: Database.Database,
  runId: string,
  eventType: string,
  payload: Record<string, unknown>,
): void {
  db.prepare(
    'INSERT INTO raw_events (run_id, event_type, payload_json) VALUES (?, ?, ?)',
  ).run(runId, eventType, JSON.stringify(payload));
}

/** Seed one assistant turn plus a terminal result carrying cost/turns. */
function seedUsage(
  db: Database.Database,
  runId: string,
  opts: { input: number; output: number; cost: number; turns: number },
): void {
  seedEvent(db, runId, 'assistant', {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: opts.input,
        output_tokens: opts.output,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
  // The result's usage is the query's token source (accounting v1); the
  // assistant row only counts as the outer message.
  seedEvent(db, runId, 'result', {
    type: 'result',
    subtype: 'success',
    total_cost_usd: opts.cost,
    num_turns: opts.turns,
    usage: { input_tokens: opts.input, output_tokens: opts.output },
    modelUsage: { 'claude-sonnet-5': { inputTokens: opts.input, outputTokens: opts.output } },
    cyboflow_process_instance_id: `proc-${runId}`,
  });
}

interface RunUsageRow {
  run_id: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  num_turns: number | null;
  assistant_message_count: number;
  accounting_version: number;
  coverage: string;
}

function readRunUsage(db: Database.Database, runId: string): RunUsageRow | null {
  const row = db.prepare('SELECT * FROM run_usage WHERE run_id = ?').get(runId) as
    | RunUsageRow
    | undefined;
  return row ?? null;
}

describe('backfillRunUsageRollups', () => {
  it.each(['completed', 'failed', 'canceled'] as const)(
    'materializes a missing rollup for a %s run',
    (status) => {
      const db = makeDb();
      seedRun(db, 'run-1', status);
      seedUsage(db, 'run-1', { input: 100, output: 25, cost: 0.5, turns: 3 });

      const result = backfillRunUsageRollups(dbAdapter(db));

      expect(result).toEqual({ candidates: 1, materialized: 1 });
      const row = readRunUsage(db, 'run-1');
      expect(row).not.toBeNull();
      expect(row?.input_tokens).toBe(100);
      expect(row?.output_tokens).toBe(25);
      expect(row?.total_tokens).toBe(125);
      expect(row?.cost_usd).toBe(0.5);
      expect(row?.num_turns).toBe(3);
      expect(row?.assistant_message_count).toBe(1);
      // Written through the shared writer: the fold version and coverage land too.
      expect(row?.accounting_version).toBe(1);
      expect(row?.coverage).toBe('complete');
    },
  );

  it.each(['running', 'starting', 'awaiting_review', 'queued', 'stuck'] as const)(
    'skips a %s run whose raw_events log is still growing',
    (status) => {
      const db = makeDb();
      seedRun(db, 'run-live', status);
      seedUsage(db, 'run-live', { input: 10, output: 5, cost: 0.1, turns: 1 });

      const result = backfillRunUsageRollups(dbAdapter(db));

      expect(result).toEqual({ candidates: 0, materialized: 0 });
      expect(readRunUsage(db, 'run-live')).toBeNull();
    },
  );

  it('never overwrites an existing rollup row', () => {
    const db = makeDb();
    seedRun(db, 'run-1', 'completed');
    seedUsage(db, 'run-1', { input: 999, output: 999, cost: 9.99, turns: 99 });
    // A real materialized row already recorded different values.
    db.prepare(
      `INSERT INTO run_usage (run_id, input_tokens, output_tokens, total_tokens, cost_usd, num_turns, assistant_message_count)
       VALUES ('run-1', 1, 2, 3, 0.04, 5, 6)`,
    ).run();

    const result = backfillRunUsageRollups(dbAdapter(db));

    // Already materialized => not even a candidate.
    expect(result).toEqual({ candidates: 0, materialized: 0 });
    const row = readRunUsage(db, 'run-1');
    expect(row?.input_tokens).toBe(1);
    expect(row?.cost_usd).toBe(0.04);
  });

  it('ignores terminal runs that have no raw_events at all', () => {
    const db = makeDb();
    seedRun(db, 'run-empty', 'canceled');

    const result = backfillRunUsageRollups(dbAdapter(db));

    expect(result).toEqual({ candidates: 0, materialized: 0 });
    expect(readRunUsage(db, 'run-empty')).toBeNull();
  });

  it('materializes a zeroed row for a terminal run whose events carry no usage', () => {
    const db = makeDb();
    seedRun(db, 'run-noise', 'failed');
    // Events exist, but none of the usage-bearing kinds.
    seedEvent(db, 'run-noise', 'system', { type: 'system', subtype: 'init' });

    const result = backfillRunUsageRollups(dbAdapter(db));

    expect(result).toEqual({ candidates: 1, materialized: 1 });
    const row = readRunUsage(db, 'run-noise');
    expect(row?.total_tokens).toBe(0);
    expect(row?.assistant_message_count).toBe(0);
  });

  it('handles a mixed population in one sweep', () => {
    const db = makeDb();
    seedRun(db, 'run-done', 'completed');
    seedUsage(db, 'run-done', { input: 10, output: 1, cost: 0.1, turns: 1 });
    seedRun(db, 'run-cancel', 'canceled');
    seedUsage(db, 'run-cancel', { input: 20, output: 2, cost: 0.2, turns: 1 });
    seedRun(db, 'run-live', 'running');
    seedUsage(db, 'run-live', { input: 30, output: 3, cost: 0.3, turns: 1 });

    const result = backfillRunUsageRollups(dbAdapter(db));

    expect(result).toEqual({ candidates: 2, materialized: 2 });
    expect(readRunUsage(db, 'run-done')?.input_tokens).toBe(10);
    expect(readRunUsage(db, 'run-cancel')?.input_tokens).toBe(20);
    expect(readRunUsage(db, 'run-live')).toBeNull();
  });

  it('is idempotent — a second sweep finds no candidates', () => {
    const db = makeDb();
    seedRun(db, 'run-1', 'completed');
    seedUsage(db, 'run-1', { input: 100, output: 25, cost: 0.5, turns: 3 });

    expect(backfillRunUsageRollups(dbAdapter(db))).toEqual({ candidates: 1, materialized: 1 });
    expect(backfillRunUsageRollups(dbAdapter(db))).toEqual({ candidates: 0, materialized: 0 });
  });

  it('fail-softs (warn, no throw) when run_usage is missing', () => {
    const db = makeDb({ omitRunUsage: true });
    seedRun(db, 'run-1', 'completed');
    seedUsage(db, 'run-1', { input: 1, output: 1, cost: 0.1, turns: 1 });
    const logger = makeSpyLogger();

    let result: ReturnType<typeof backfillRunUsageRollups> | undefined;
    expect(() => {
      result = backfillRunUsageRollups(dbAdapter(db), logger);
    }).not.toThrow();

    expect(result).toEqual({ candidates: 0, materialized: 0 });
    expect(logger.warn).toHaveBeenCalled();
  });
});
