import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../../utils/logger';
import {
  CodexProcessUsageTracker,
  CodexUsageRowWriter,
  createCodexUsageOwner,
} from '../codexUsageTracker';
import { CodexUsageTotals } from '../appServer/usageAccumulator';
import type { TokenUsageBreakdown } from '../appServer/protocol';
import { codexNotification as n, codexUsage } from '../../../../test/fakes/fakeCodexAppServer';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE raw_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dedup_key TEXT
    );
    CREATE UNIQUE INDEX idx_raw_events_dedup ON raw_events(dedup_key) WHERE dedup_key IS NOT NULL;
  `);
  return db;
}

function fakeLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const error = vi.fn();
  return { logger: { warn, error, info: vi.fn(), debug: vi.fn() } as unknown as Logger, warn, error };
}

function rowUsage(db: Database.Database, dedupKey: string): unknown {
  const row = db.prepare('SELECT payload_json AS payloadJson FROM raw_events WHERE dedup_key = ?').get(dedupKey) as
    | { payloadJson: string }
    | undefined;
  return row ? (JSON.parse(row.payloadJson) as { message: { usage: unknown } }).message.usage : undefined;
}

function expected(...usages: TokenUsageBreakdown[]): unknown {
  const totals = new CodexUsageTotals();
  for (const usage of usages) totals.add(usage);
  return totals.snapshot();
}

function makeTracker(db: Database.Database, logger?: Logger, drainTimeoutMs?: number): CodexProcessUsageTracker {
  const tracker = new CodexProcessUsageTracker({
    runId: 'run-1',
    writer: new CodexUsageRowWriter(db, logger),
    logger,
    drainTimeoutMs,
  });
  tracker.setRootThread('root');
  return tracker;
}

const A = codexUsage(10, 1, 4);
const B = codexUsage(20, 2, 5, 3);
const C = codexUsage(30, 3);

describe('CodexProcessUsageTracker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tops up exactly the unmatched update into the codex-usage-topup row, at settlement only', () => {
    const db = createDb();
    try {
      const { logger, warn } = fakeLogger();
      const tracker = makeTracker(db, logger);
      const owner = createCodexUsageOwner({ invocationId: 'inv-1', runId: 'run-1', model: 'gpt-root', rootThreadId: 'root' });
      tracker.bindOwner(owner);
      tracker.observe(n.tokenUsage('root', 'turn-1', A, A));
      tracker.observe(n.tokenUsage('root', 'turn-1', codexUsage(30, 3, 9, 3), B));
      tracker.observe(n.tokenUsage('root', 'turn-1', codexUsage(60, 6, 9, 3), C));
      tracker.observe(n.rawResponse('root', 'turn-1', 'r1', A));
      tracker.observe(n.rawResponse('root', 'turn-1', 'r3', C));
      expect(owner.accumulator.rootSnapshot()).toEqual(expected(A, C));
      expect(rowUsage(db, 'codex-usage-topup:run-1:root')).toBeUndefined();

      tracker.settle();
      expect(rowUsage(db, 'codex-usage-topup:run-1:root')).toEqual(expected(B));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('response_usage_missing'));
    } finally {
      db.close();
    }
  });

  it('never lets one process overwrite another\'s run-scoped row', () => {
    const db = createDb();
    try {
      const first = makeTracker(db);
      first.observe(n.rawResponse('stranger', 't', 's1', A));
      first.settle();
      // A later process of the same run (a resumed thread) writes the same key.
      const second = makeTracker(db);
      second.observe(n.rawResponse('stranger', 't', 's2', B));
      second.settle();
      expect(rowUsage(db, 'codex-unattributed:run-1:stranger')).toEqual(expected(A, B));
    } finally {
      db.close();
    }
  });

  it('ends a drain at its timeout, then sends late descendant usage to the unattributed row', async () => {
    vi.useFakeTimers();
    const db = createDb();
    try {
      const { logger, warn } = fakeLogger();
      const tracker = makeTracker(db, logger, 1_000);
      const owner = createCodexUsageOwner({ invocationId: 'inv-1', runId: 'run-1', model: 'gpt-root', rootThreadId: 'root' });
      tracker.bindOwner(owner);
      tracker.observe(n.spawnAgent('root', 'turn-1', ['child'], 'gpt-child'));
      tracker.observe(n.rawResponse('child', 'c', 'c1', A));

      let drained = false;
      const drain = tracker.drain(owner).then(() => { drained = true; });
      expect(tracker.isDraining(owner)).toBe(true);
      tracker.observe(n.rawResponse('child', 'c', 'c2', B)); // inside the drain: still the owner's
      await vi.advanceTimersByTimeAsync(1_000);
      await drain;
      expect(drained).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('drain timed out'));

      tracker.observe(n.rawResponse('child', 'c', 'c3', C)); // after it: unattributed
      expect(rowUsage(db, 'codex-subagent:inv-1:child')).toEqual(expected(A, B));
      expect(rowUsage(db, 'codex-unattributed:run-1:child')).toEqual(expected(C));
      // Once there, a thread's usage never moves back.
      tracker.observe(n.rawResponse('child', 'c', 'c4', A));
      expect(rowUsage(db, 'codex-unattributed:run-1:child')).toEqual(expected(C, A));
    } finally {
      db.close();
    }
  });

  it('holds a drain while a descendant update still waits for its response', () => {
    const db = createDb();
    try {
      const tracker = makeTracker(db);
      const owner = createCodexUsageOwner({ invocationId: 'inv-1', runId: 'run-1', model: 'gpt-root', rootThreadId: 'root' });
      tracker.bindOwner(owner);
      tracker.observe(n.spawnAgent('root', 'turn-1', ['child'], 'gpt-child'));
      tracker.observe(n.tokenUsage('child', 'c', A, A));
      tracker.observe(n.turnCompleted('child', 'c'));
      void tracker.drain(owner);
      expect(tracker.isDraining(owner)).toBe(true);
      tracker.observe(n.rawResponse('child', 'c', 'c1', A));
      expect(tracker.isDraining(owner)).toBe(false);
      expect(rowUsage(db, 'codex-subagent:inv-1:child')).toEqual(expected(A));
      tracker.settle();
    } finally {
      db.close();
    }
  });

  it('logs protocol drift and an unexplained oracle mismatch at settlement', () => {
    const db = createDb();
    try {
      const { logger, warn, error } = fakeLogger();
      const tracker = makeTracker(db, logger);
      tracker.observe(n.tokenUsage('root', 'turn-1', A, A)); // a turn with snapshots, no responses
      tracker.observe(n.tokenUsage('other', 'turn-o', A, A));
      tracker.observe(n.rawResponse('other', 'turn-o', 'o1', A));
      tracker.observe(n.rawResponse('other', 'turn-o', 'o2', B)); // total never included it
      tracker.settle();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('PROTOCOL DRIFT: turn turn-1'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('oracle_mismatch on thread other'));
    } finally {
      db.close();
    }
  });

  it('writes nothing for a hermetic spawn but still counts the root', () => {
    const tracker = new CodexProcessUsageTracker({ runId: 'agent:t', writer: null });
    tracker.setRootThread('root');
    const owner = createCodexUsageOwner({ invocationId: 'inv-1', runId: 'agent:t', model: 'm', rootThreadId: null });
    tracker.bindOwner(owner);
    tracker.observe(n.rawResponse('root', 'turn-1', 'r1', A));
    tracker.observe(n.rawResponse('stranger', 't', 's1', B));
    tracker.settle();
    expect(owner.accumulator.rootSnapshot()).toEqual(expected(A));
  });
});

describe('CodexProcessUsageTracker raw-events source switch (update-sourced thread gets responses)', () => {
  function resumedTracker(db: Database.Database): { tracker: CodexProcessUsageTracker; owner: ReturnType<typeof createCodexUsageOwner> } {
    const tracker = new CodexProcessUsageTracker({ runId: 'run-1', writer: new CodexUsageRowWriter(db) });
    tracker.markThreadOrigin('root', 'resumed');
    tracker.setRootThread('root');
    const owner = createCodexUsageOwner({ invocationId: 'inv-1', runId: 'run-1', model: 'm', rootThreadId: 'root' });
    tracker.bindOwner(owner);
    return { tracker, owner };
  }

  it('counts the in-flight request once when its update arrives before its response', () => {
    const db = createDb();
    try {
      const { tracker, owner } = resumedTracker(db);
      tracker.observe(n.tokenUsage('root', 't', A, A));
      tracker.observe(n.tokenUsage('root', 't', codexUsage(30, 3, 9, 3), B));
      tracker.observe(n.rawResponse('root', 't', 'rb', B)); // answers B, already counted
      tracker.observe(n.rawResponse('root', 't', 'rc', C)); // response-first from here on
      tracker.observe(n.tokenUsage('root', 't', codexUsage(60, 6, 9, 3), C));
      tracker.settle();
      expect(owner.accumulator.rootSnapshot()).toEqual(expected(A, B, C));
      expect(rowUsage(db, 'codex-usage-topup:run-1:root')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('counts the in-flight request once when its response arrives before its update', () => {
    const db = createDb();
    try {
      const { tracker, owner } = resumedTracker(db);
      tracker.observe(n.tokenUsage('root', 't', A, A));
      tracker.observe(n.rawResponse('root', 't', 'rb', B)); // switch; B's update is still to come
      tracker.observe(n.tokenUsage('root', 't', codexUsage(30, 3, 9, 3), B));
      tracker.settle();
      expect(owner.accumulator.rootSnapshot()).toEqual(expected(A, B));
      expect(rowUsage(db, 'codex-usage-topup:run-1:root')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('stays exact when the first response is mis-skipped as an identical earlier request', () => {
    const db = createDb();
    try {
      const { tracker, owner } = resumedTracker(db);
      tracker.observe(n.tokenUsage('root', 't', A, A));
      // A second request identical to A: its response lands first and is skipped...
      tracker.observe(n.rawResponse('root', 't', 'ra2', A));
      // ...so its update, now paired, finds no response and is topped up once.
      tracker.observe(n.tokenUsage('root', 't', codexUsage(20, 2, 8, 0), A));
      tracker.settle();
      expect(owner.accumulator.rootSnapshot()).toEqual(expected(A));
      expect(rowUsage(db, 'codex-usage-topup:run-1:root')).toEqual(expected(A));
    } finally {
      db.close();
    }
  });
});
