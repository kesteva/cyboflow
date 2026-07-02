/**
 * Unit tests for rollupRunUsage — the Insights Phase-2 (migration 026) writer
 * that materializes a durable `run_usage` row from a run's persisted
 * `assistant` + `result` raw_events at a terminal seam.
 *
 * Behaviors covered:
 *   a. Seeded assistant + result events → run_usage row carries the summed
 *      token/cost/turn values (the values selectRunUsageRollups computes).
 *   b. INSERT OR REPLACE semantics: a second call after MORE events land
 *      overwrites the prior row (no PK collision, no stale partial).
 *   c. Fail-soft on a missing run_usage table (un-migrated DB): logger.warn is
 *      called with runId context and NO throw escapes.
 *   d. Zeroed row when the run produced no usage events at all.
 *
 * Fixture: a single in-memory better-sqlite3 DB carrying the tables the writer
 * touches — raw_events (the scan source, via the shared RAW_EVENTS_DDL),
 * run_usage (the write target, mirroring migration 026), and an empty
 * workflow_runs stub (the rollup read folds in runtime timestamps from it; no
 * rows are seeded, so timestamps stay null). FK enforcement is off so we can
 * write run_usage without seeding a parent workflow_runs row (the FK is
 * exercised in the migration's own schema-parity tests, not here).
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { rollupRunUsage } from '../runUsageRollup';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import { RAW_EVENTS_DDL } from '../__test_fixtures__/rawEvents';

// ---------------------------------------------------------------------------
// run_usage DDL — mirrors migration 026 (FK clause omitted; FKs are off in the
// fixture so run_usage can be written without a parent workflow_runs row).
// ---------------------------------------------------------------------------
// Minimal workflow_runs stub: selectRunUsageRollups folds in runtime timestamps
// via one IN() lookup over workflow_runs(id, started_at, ended_at); without the
// table that read throws and the writer fail-softs to a no-op. Rows stay
// unseeded — absent runs simply leave the rollup timestamps null.
const WORKFLOW_RUNS_DDL = `
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id         TEXT PRIMARY KEY,
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
    computed_at             DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** In-memory DB with raw_events + run_usage; FKs off (no parent run needed). */
function makeRollupDb(opts?: { withRunUsage?: boolean }): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(RAW_EVENTS_DDL);
  db.exec(WORKFLOW_RUNS_DDL);
  if (opts?.withRunUsage !== false) {
    db.exec(RUN_USAGE_DDL);
  }
  return db;
}

/** Insert one raw_events row (payload JSON-stringified). */
function seedEvent(db: Database.Database, runId: string, eventType: string, payload: unknown): void {
  db.prepare(
    `INSERT INTO raw_events (run_id, event_type, payload_json) VALUES (?, ?, ?)`,
  ).run(runId, eventType, JSON.stringify(payload));
}

/** Assistant payload carrying a usage block (matches the SDK assistant shape). */
function assistantPayload(usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
}): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      usage: {
        input_tokens: usage.input ?? 0,
        output_tokens: usage.output ?? 0,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        cache_creation_input_tokens: usage.cacheCreation ?? 0,
      },
    },
  };
}

/** Result payload carrying cost + turns. */
function resultPayload(cost: number | null, turns: number | null): Record<string, unknown> {
  const payload: Record<string, unknown> = { type: 'result', subtype: 'success' };
  if (cost !== null) payload.total_cost_usd = cost;
  if (turns !== null) payload.num_turns = turns;
  return payload;
}

interface RunUsageRow {
  run_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  num_turns: number | null;
  assistant_message_count: number;
}

/** Read back the single run_usage row for a run (or null when absent). */
function readRunUsage(db: Database.Database, runId: string): RunUsageRow | null {
  const row = db
    .prepare(`SELECT * FROM run_usage WHERE run_id = ?`)
    .get(runId) as RunUsageRow | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rollupRunUsage', () => {
  it('materializes a run_usage row from seeded assistant + result events', () => {
    const db = makeRollupDb();
    const runId = 'run-1';

    // Two assistant turns with usage + one terminal result carrying cost/turns.
    seedEvent(db, runId, 'assistant', assistantPayload({ input: 100, output: 40, cacheRead: 10, cacheCreation: 5 }));
    seedEvent(db, runId, 'assistant', assistantPayload({ input: 200, output: 60, cacheRead: 20, cacheCreation: 0 }));
    seedEvent(db, runId, 'result', resultPayload(0.42, 3));

    const logger = makeSpyLogger();
    rollupRunUsage(dbAdapter(db), runId, logger);

    const row = readRunUsage(db, runId);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      run_id: runId,
      input_tokens: 300,
      output_tokens: 100,
      cache_read_tokens: 30,
      cache_creation_tokens: 5,
      total_tokens: 400, // input + output
      cost_usd: 0.42,
      num_turns: 3,
      assistant_message_count: 2,
    });
    // Success path logs nothing at warn.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('writes a zeroed row when the run has no events', () => {
    const db = makeRollupDb();
    const runId = 'run-empty';

    const logger = makeSpyLogger();
    rollupRunUsage(dbAdapter(db), runId, logger);

    const row = readRunUsage(db, runId);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      run_id: runId,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_tokens: 0,
      cost_usd: null, // no result carried a cost
      num_turns: null, // no result carried turns
      assistant_message_count: 0,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('REPLACEs the prior row on a second call after more events land', () => {
    const db = makeRollupDb();
    const runId = 'run-2';

    // First terminal seam: one assistant turn + a result.
    seedEvent(db, runId, 'assistant', assistantPayload({ input: 100, output: 50 }));
    seedEvent(db, runId, 'result', resultPayload(0.1, 1));
    rollupRunUsage(dbAdapter(db), runId);

    const first = readRunUsage(db, runId);
    expect(first).toMatchObject({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      cost_usd: 0.1,
      num_turns: 1,
      assistant_message_count: 1,
    });

    // A later turn lands MORE events; the run re-terminates and re-rolls up.
    seedEvent(db, runId, 'assistant', assistantPayload({ input: 300, output: 150 }));
    seedEvent(db, runId, 'result', resultPayload(0.4, 2));
    rollupRunUsage(dbAdapter(db), runId);

    // Exactly one row (PK upsert, no duplicate), carrying the FULL re-scan.
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM run_usage WHERE run_id = ?`)
      .get(runId) as { n: number };
    expect(count.n).toBe(1);

    const second = readRunUsage(db, runId);
    expect(second).toMatchObject({
      input_tokens: 400, // 100 + 300
      output_tokens: 200, // 50 + 150
      total_tokens: 600,
      cost_usd: 0.5, // 0.1 + 0.4 (SUM across both results)
      num_turns: 3, // 1 + 2
      assistant_message_count: 2,
    });
  });

  it('is fail-soft when the run_usage table is missing (logs warn, no throw)', () => {
    // DB without the run_usage table — mirrors an un-migrated install.
    const db = makeRollupDb({ withRunUsage: false });
    const runId = 'run-3';
    seedEvent(db, runId, 'assistant', assistantPayload({ input: 10, output: 5 }));

    const logger = makeSpyLogger();
    // Must NOT throw — the run transition that calls this must never break.
    expect(() => rollupRunUsage(dbAdapter(db), runId, logger)).not.toThrow();

    // The failure is surfaced at warn level with runId context.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const call = logger.calls.find((c) => c.level === 'warn');
    expect(call?.ctx).toMatchObject({ runId });
  });

  it('does not throw when no logger is provided and the table is missing', () => {
    const db = makeRollupDb({ withRunUsage: false });
    expect(() => rollupRunUsage(dbAdapter(db), 'run-4')).not.toThrow();
  });
});
