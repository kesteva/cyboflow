/**
 * Unit tests for backfillUsageAccounting — the one-shot boot backfill that
 * rebuilds past Codex runs' descendant usage and recomputes every run's
 * `run_usage` row under the current fold (docs/proposals/
 * codex-workflow-efficiency.md §5.2 1d, tests §5.3 "Backfill").
 *
 * In-memory better-sqlite3 with raw_events (shared DDL), a workflow_runs stub,
 * run_usage at its migration-026 shape with migration 146 applied from the real
 * file, and an agent_invocations stub. The Codex replay is the real one
 * (codexUsageReplay.ts), wired as index.ts wires it. Sanitized synthetic ids.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { backfillUsageAccounting, type UsageBackfillDeps } from '../runUsageBackfill';
import { ACCOUNTING_VERSION } from '../usageFold';
import { selectDailyModelUsage } from '../insightsQueries';
import { replayCodexRunUsage } from '../../services/panels/codex/codexUsageReplay';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import { RAW_EVENTS_DDL } from '../__test_fixtures__/rawEvents';

const MIGRATION_146 = fs.readFileSync(
  path.join(__dirname, '../../database/migrations/146_usage_accounting_v1.sql'),
  'utf8',
);

const SCHEMA = `
  CREATE TABLE workflow_runs (
    id             TEXT PRIMARY KEY,
    status         TEXT NOT NULL,
    model          TEXT,
    agent_runtime  TEXT,
    agent_provider TEXT,
    started_at     DATETIME,
    ended_at       DATETIME,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE run_usage (
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
  );
  CREATE TABLE agent_invocations (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_invocation_id TEXT,
    run_id              TEXT NOT NULL,
    agent_runtime       TEXT,
    model               TEXT,
    external_session_id TEXT
  );
`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(RAW_EVENTS_DDL);
  db.exec(SCHEMA);
  db.exec(MIGRATION_146);
  return db;
}

/** A recent time `daysAgo` back, so daily-bucket windows include it. */
function at(daysAgo: number, minute = 0): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  d.setUTCHours(12, minute, 0, 0);
  return d.toISOString();
}

function realDeps(db: Database.Database): UsageBackfillDeps {
  return { replayCodexRun: (runId) => replayCodexRunUsage(db, runId, { notifiedBefore: '9999-01-01T00:00:00.000Z' }) };
}

function seedRun(db: Database.Database, id: string, status = 'completed', createdAt = at(3)): void {
  db.prepare("INSERT INTO workflow_runs (id, status, agent_runtime, created_at) VALUES (?, ?, 'codex-sdk', ?)").run(
    id,
    status,
    createdAt,
  );
}

function seedEvent(
  db: Database.Database,
  runId: string,
  eventType: string,
  payload: Record<string, unknown>,
  createdAt = at(2),
): void {
  db.prepare('INSERT INTO raw_events (run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)').run(
    runId,
    eventType,
    JSON.stringify(payload),
    createdAt,
  );
}

function seedNotification(
  db: Database.Database,
  runId: string,
  method: string,
  params: Record<string, unknown>,
  createdAt = at(2),
): void {
  seedEvent(db, runId, 'codex_app_server_notification', { method, params }, createdAt);
}

/** A legacy (pre-v1) materialized row with deliberately stale totals. */
function seedLegacyRow(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT INTO run_usage (run_id, input_tokens, output_tokens, total_tokens, assistant_message_count)
     VALUES (?, 7, 3, 10, 1)`,
  ).run(runId);
}

function spawnItem(sender: string, turnId: string, receiver: string, model: string | null): Record<string, unknown> {
  return {
    threadId: sender,
    turnId,
    item: {
      type: 'collabAgentToolCall',
      id: `call-${receiver}`,
      tool: 'spawnAgent',
      status: 'completed',
      senderThreadId: sender,
      receiverThreadIds: [receiver],
      model,
    },
  };
}

function responseParams(threadId: string, responseId: string, input: number, cached: number, output: number) {
  return {
    threadId,
    turnId: `turn-of-${threadId}`,
    responseId,
    usage: {
      totalTokens: input + output,
      inputTokens: input,
      cachedInputTokens: cached,
      cacheWriteInputTokens: 0,
      outputTokens: output,
      reasoningOutputTokens: 0,
    },
  };
}

/**
 * A post-boundary Codex run: root `root-<id>` (turn `rt-<id>`) whose one
 * agent_result reports the root thread's usage, and two children with
 * `rawResponse/completed` rows. Child uncached input: (400−300) + (250−200) =
 * 150, cache read 500, output 30 + 20.
 */
function seedPostBoundaryCodexRun(db: Database.Database, runId: string, status = 'completed'): void {
  seedRun(db, runId, status);
  const root = `root-${runId}`;
  db.prepare(
    "INSERT INTO agent_invocations (agent_invocation_id, run_id, agent_runtime, model, external_session_id) VALUES (?, ?, 'codex-sdk', 'root-model', ?)",
  ).run(`inv-${runId}`, runId, root);
  seedNotification(db, runId, 'turn/started', { threadId: root, turn: { id: `rt-${runId}` } }, at(2, 1));
  seedNotification(db, runId, 'rawResponse/completed', responseParams(root, `r-root-${runId}`, 1000, 900, 40), at(2, 2));
  seedNotification(db, runId, 'item/completed', spawnItem(root, `rt-${runId}`, `c1-${runId}`, 'child-model'), at(2, 3));
  seedNotification(db, runId, 'item/completed', spawnItem(root, `rt-${runId}`, `c2-${runId}`, 'child-model'), at(2, 4));
  seedNotification(db, runId, 'rawResponse/completed', responseParams(`c1-${runId}`, `r-c1-${runId}`, 400, 300, 30), at(2, 5));
  seedNotification(db, runId, 'rawResponse/completed', responseParams(`c2-${runId}`, `r-c2-${runId}`, 250, 200, 20), at(1, 6));
  seedEvent(
    db,
    runId,
    'agent_result',
    {
      type: 'agent_result',
      provider: 'codex',
      runtime: 'codex-sdk',
      num_turns: 1,
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
      external_session_id: root,
    },
    at(2, 7),
  );
}

/** A pre-boundary Codex run: a spawn and tokenUsage snapshots, but no rawResponse/completed. */
function seedPreBoundaryCodexRun(db: Database.Database, runId: string): void {
  seedRun(db, runId);
  const root = `root-${runId}`;
  db.prepare(
    "INSERT INTO agent_invocations (agent_invocation_id, run_id, agent_runtime, model, external_session_id) VALUES (?, ?, 'codex-sdk', 'root-model', ?)",
  ).run(`inv-${runId}`, runId, root);
  seedNotification(db, runId, 'item/completed', spawnItem(root, 'rt', `c-${runId}`, 'child-model'));
  seedNotification(db, runId, 'thread/tokenUsage/updated', { threadId: `c-${runId}`, turnId: 'tc', tokenUsage: {} });
  seedEvent(db, runId, 'agent_result', {
    type: 'agent_result',
    provider: 'codex',
    usage: { input_tokens: 60, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    external_session_id: root,
  });
}

/** A Claude run whose results carry process ids (an exact segment ⇒ 'complete'). */
function seedClaudeRun(db: Database.Database, runId: string): void {
  seedRun(db, runId);
  seedEvent(db, runId, 'result', {
    type: 'result',
    session_id: `s-${runId}`,
    total_cost_usd: 0.5,
    num_turns: 1,
    usage: { input_tokens: 11, output_tokens: 5 },
    modelUsage: { 'claude-sonnet-5': { inputTokens: 11, outputTokens: 5 } },
    cyboflow_process_instance_id: `p-${runId}`,
  });
}

interface UsageRow {
  run_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  cost_usd: number | null;
  num_turns: number | null;
  assistant_message_count: number;
  accounting_version: number;
  coverage: string;
}

function usageRow(db: Database.Database, runId: string): UsageRow | undefined {
  return db
    .prepare(
      `SELECT run_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_tokens,
              cost_usd, num_turns, assistant_message_count, accounting_version, coverage
         FROM run_usage WHERE run_id = ?`,
    )
    .get(runId) as UsageRow | undefined;
}

function codexRows(db: Database.Database, runId: string): Array<{ dedup_key: string; payload_json: string; created_at: string }> {
  return db
    .prepare(
      "SELECT dedup_key, payload_json, created_at FROM raw_events WHERE run_id = ? AND event_type = 'subagent_usage' ORDER BY dedup_key",
    )
    .all(runId) as Array<{ dedup_key: string; payload_json: string; created_at: string }>;
}

function markerCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM usage_backfill_marker').get() as { n: number }).n;
}

describe('backfillUsageAccounting', () => {
  it('rebuilds a post-boundary Codex run at the historical key, codex-run-level, summing child responses', async () => {
    const db = makeDb();
    seedPostBoundaryCodexRun(db, 'run-a');
    seedLegacyRow(db, 'run-a');

    const result = await backfillUsageAccounting(dbAdapter(db), realDeps(db));

    expect(result).toMatchObject({ candidates: 1, backfilled: 1, failed: 0, markerWritten: true });
    expect(codexRows(db, 'run-a').map((r) => r.dedup_key)).toEqual([
      'codex-subagent-run:run-a:root-run-a:rt-run-a:c1-run-a',
      'codex-subagent-run:run-a:root-run-a:rt-run-a:c2-run-a',
    ]);
    // Root agent_result (100 / 900 / 40) + children (150 / 500 / 50); the root's
    // own rawResponse is already the agent_result and is not added again.
    expect(usageRow(db, 'run-a')).toMatchObject({
      input_tokens: 100 + 150,
      cache_read_tokens: 900 + 500,
      output_tokens: 40 + 50,
      accounting_version: ACCOUNTING_VERSION,
      coverage: 'codex-run-level',
    });
    expect(db.prepare('SELECT run_id, accounting_version FROM usage_backfill_runs').all()).toEqual([
      { run_id: 'run-a', accounting_version: ACCOUNTING_VERSION },
    ]);
  });

  it('marks a pre-boundary Codex run codex-root-only and writes no descendant rows', async () => {
    const db = makeDb();
    seedPreBoundaryCodexRun(db, 'run-old');
    seedLegacyRow(db, 'run-old');

    await backfillUsageAccounting(dbAdapter(db), realDeps(db));

    expect(codexRows(db, 'run-old')).toEqual([]);
    expect(usageRow(db, 'run-old')).toMatchObject({
      input_tokens: 60,
      output_tokens: 6,
      accounting_version: ACCOUNTING_VERSION,
      coverage: 'codex-root-only',
    });
  });

  it('raises an unattributed-only Codex run to codex-run-level', async () => {
    const db = makeDb();
    seedRun(db, 'run-u');
    seedNotification(db, 'run-u', 'rawResponse/completed', responseParams('stray', 'r-stray', 50, 0, 5));

    await backfillUsageAccounting(dbAdapter(db), realDeps(db));

    expect(codexRows(db, 'run-u').map((r) => r.dedup_key)).toEqual(['codex-unattributed:run-u:stray']);
    // An unattributed row with no model to go by is model-inferred, which outranks run-level.
    expect(usageRow(db, 'run-u')).toMatchObject({ input_tokens: 50, coverage: 'codex-model-inferred' });
  });

  it('recomputes a Claude run and leaves runs with no raw_events untouched and legacy', async () => {
    const db = makeDb();
    seedClaudeRun(db, 'run-claude');
    seedLegacyRow(db, 'run-claude');
    seedRun(db, 'run-empty');
    seedLegacyRow(db, 'run-empty');
    const before = usageRow(db, 'run-empty');

    const result = await backfillUsageAccounting(dbAdapter(db), realDeps(db));

    expect(result.candidates).toBe(1);
    expect(usageRow(db, 'run-claude')).toMatchObject({
      input_tokens: 11,
      output_tokens: 5,
      accounting_version: ACCOUNTING_VERSION,
      coverage: 'complete',
    });
    expect(usageRow(db, 'run-empty')).toEqual(before);
    expect(before).toMatchObject({ accounting_version: 0, coverage: 'legacy' });
  });

  it('gives a non-terminal run no new row, but replaces an existing one', async () => {
    const db = makeDb();
    seedPostBoundaryCodexRun(db, 'run-live', 'awaiting_review');
    seedPostBoundaryCodexRun(db, 'run-live-row', 'paused');
    seedLegacyRow(db, 'run-live-row');

    const result = await backfillUsageAccounting(dbAdapter(db), realDeps(db));

    expect(result).toMatchObject({ candidates: 2, backfilled: 2, markerWritten: true });
    expect(usageRow(db, 'run-live')).toBeUndefined();
    expect(codexRows(db, 'run-live')).toHaveLength(2);
    expect(usageRow(db, 'run-live-row')).toMatchObject({ input_tokens: 250, coverage: 'codex-run-level' });
  });

  it('produces identical rows when run twice', async () => {
    const db = makeDb();
    seedPostBoundaryCodexRun(db, 'run-a');
    seedClaudeRun(db, 'run-c');
    seedLegacyRow(db, 'run-a');

    await backfillUsageAccounting(dbAdapter(db), realDeps(db));
    const firstRows = codexRows(db, 'run-a');
    const firstUsage = [usageRow(db, 'run-a'), usageRow(db, 'run-c')];
    const eventCount = (db.prepare('SELECT COUNT(*) AS n FROM raw_events').get() as { n: number }).n;

    // Forget the progress, as a version bump or a lost marker would.
    db.exec('DELETE FROM usage_backfill_runs; DELETE FROM usage_backfill_marker;');
    const second = await backfillUsageAccounting(dbAdapter(db), realDeps(db));

    expect(second).toMatchObject({ candidates: 2, backfilled: 2, markerWritten: true });
    expect(codexRows(db, 'run-a')).toEqual(firstRows);
    expect([usageRow(db, 'run-a'), usageRow(db, 'run-c')]).toEqual(firstUsage);
    expect((db.prepare('SELECT COUNT(*) AS n FROM raw_events').get() as { n: number }).n).toBe(eventCount);
  });

  it('keeps a failed run’s old row and withholds the marker; the next call finishes it', async () => {
    const db = makeDb();
    seedPostBoundaryCodexRun(db, 'run-ok');
    seedPostBoundaryCodexRun(db, 'run-bad');
    seedLegacyRow(db, 'run-bad');
    const legacy = usageRow(db, 'run-bad');
    const logger = makeSpyLogger();
    const real = realDeps(db);
    // Fails AFTER the real replay has written its rows, so the rollback is what is under test.
    const failing: UsageBackfillDeps = {
      replayCodexRun: (runId) => {
        const outcome = real.replayCodexRun(runId);
        if (runId === 'run-bad') throw new Error('synthetic failure');
        return outcome;
      },
    };

    const first = await backfillUsageAccounting(dbAdapter(db), failing, logger);

    expect(first).toMatchObject({ candidates: 2, backfilled: 1, failed: 1, markerWritten: false });
    expect(usageRow(db, 'run-bad')).toEqual(legacy);
    expect(codexRows(db, 'run-bad')).toEqual([]);
    expect(markerCount(db)).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('run backfill failed'),
      expect.objectContaining({ runId: 'run-bad', error: 'synthetic failure' }),
    );

    const replay = vi.fn(real.replayCodexRun);
    const second = await backfillUsageAccounting(dbAdapter(db), { replayCodexRun: replay });

    expect(second).toMatchObject({ candidates: 1, backfilled: 1, failed: 0, markerWritten: true });
    expect(replay).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledWith('run-bad');
    expect(usageRow(db, 'run-bad')).toMatchObject({ input_tokens: 250, coverage: 'codex-run-level' });
    expect(markerCount(db)).toBe(1);
  });

  it('is a no-op once the marker for the current version exists', async () => {
    const db = makeDb();
    seedPostBoundaryCodexRun(db, 'run-a');
    seedLegacyRow(db, 'run-a');
    db.prepare('INSERT INTO usage_backfill_marker (accounting_version) VALUES (?)').run(ACCOUNTING_VERSION);
    const replay = vi.fn(realDeps(db).replayCodexRun);

    const result = await backfillUsageAccounting(dbAdapter(db), { replayCodexRun: replay });

    expect(result).toMatchObject({ alreadyComplete: true, candidates: 0, backfilled: 0 });
    expect(replay).not.toHaveBeenCalled();
    expect(usageRow(db, 'run-a')).toMatchObject({ coverage: 'legacy', accounting_version: 0 });
  });

  it('matches the daily buckets of a backfilled run to its run_usage', async () => {
    const db = makeDb();
    seedPostBoundaryCodexRun(db, 'run-a');
    seedLegacyRow(db, 'run-a');

    await backfillUsageAccounting(dbAdapter(db), realDeps(db));

    const buckets = selectDailyModelUsage(dbAdapter(db), null, 30);
    const row = usageRow(db, 'run-a');
    expect(buckets.reduce((sum, b) => sum + b.inputTokens, 0)).toBe(row?.input_tokens);
    expect(buckets.reduce((sum, b) => sum + b.outputTokens, 0)).toBe(row?.output_tokens);
    // The child spent on a later day than the rest lands on that day.
    expect(new Set(buckets.map((b) => b.day)).size).toBe(2);
  });

  it('yields to the event loop before each run', async () => {
    const db = makeDb();
    seedPostBoundaryCodexRun(db, 'run-a');
    seedClaudeRun(db, 'run-c');
    const yieldBetweenRuns = vi.fn(async () => {});

    await backfillUsageAccounting(dbAdapter(db), { ...realDeps(db), yieldBetweenRuns });

    expect(yieldBetweenRuns).toHaveBeenCalledTimes(2);
  });

  it('replays only notifications stored before the cutoff (a run resumed on this boot)', async () => {
    const db = makeDb();
    seedPostBoundaryCodexRun(db, 'run-a');

    await backfillUsageAccounting(dbAdapter(db), {
      // c1 responded two days back, c2 one day back at 12:06 — after this cutoff.
      replayCodexRun: (runId) => replayCodexRunUsage(db, runId, { notifiedBefore: at(1, 0) }),
    });

    expect(codexRows(db, 'run-a').map((r) => r.dedup_key)).toEqual([
      'codex-subagent-run:run-a:root-run-a:rt-run-a:c1-run-a',
    ]);
  });

  it('is fail-soft on an un-migrated database', async () => {
    const db = new Database(':memory:');
    const logger = makeSpyLogger();

    const result = await backfillUsageAccounting(dbAdapter(db), realDeps(db), logger);

    expect(result).toMatchObject({ candidates: 0, markerWritten: false });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
