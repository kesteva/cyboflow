/**
 * Unit tests for ReviewQueueSystemicPauseGate — the programmatic systemic-pause
 * checkpoint (the 2026-07-06 planner-incident fix). Exercised through fake item
 * ops + a fake parker + a real EventEmitter + injected setTimer/now (no real
 * timers) so the park / await-clear / auto-resume / cancel contract is pinned
 * without any DB, SDK, or wall-clock dependency.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  ReviewQueueSystemicPauseGate,
  AUTO_RESUME_BUFFER_MS,
  systemicPauseSourceForStep,
  type SystemicPauseItemOps,
  type SystemicPauseParker,
} from '../systemicPauseGate';
import type { WorkflowStep } from '../../../../../shared/types/workflows';

const channelFor = (projectId: number): string => `review-project-${projectId}`;
// Fixed wall clock (~2023-11-14T22:13:20Z) so parseable-epoch errors are stable.
const NOW_MS = 1_700_000_000_000;
const now = (): number => NOW_MS;

function step(p: Partial<WorkflowStep> & { id: string }): WorkflowStep {
  return { name: p.id, agent: 'executor', mcps: [], retries: 0, ...p };
}

/** Drain all pending microtasks (the async find/create/park chain) via one macrotask. */
const flush = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

interface FakeItems extends SystemicPauseItemOps {
  findPendingCalls: Array<{ runId: string; source: string }>;
  createCalls: Array<{ runId: string; projectId: number; title: string; body: string; source: string }>;
  resolveCalls: Array<{ projectId: number; reviewItemId: string; resolution: string }>;
  dismissCalls: Array<{ projectId: number; reviewItemId: string; resolution: string }>;
}

function makeItems(opts: { existing?: string | null; createId?: string; resolveThrows?: boolean } = {}): FakeItems {
  const createId = opts.createId ?? 'rvw_new';
  const state: FakeItems = {
    findPendingCalls: [],
    createCalls: [],
    resolveCalls: [],
    dismissCalls: [],
    async findPending(runId, source) {
      state.findPendingCalls.push({ runId, source });
      return opts.existing ?? null;
    },
    async create(args) {
      state.createCalls.push(args);
      return createId;
    },
    async resolve(args) {
      state.resolveCalls.push(args);
      if (opts.resolveThrows) throw new Error('invalid_status');
    },
    async dismiss(args) {
      state.dismissCalls.push(args);
    },
  };
  return state;
}

interface FakeParker extends SystemicPauseParker {
  parkCalls: number;
  resumeCalls: number;
  parkThrows: boolean;
}

function makeParker(): FakeParker {
  const state: FakeParker = {
    parkCalls: 0,
    resumeCalls: 0,
    parkThrows: false,
    async parkForBlockingReview() {
      state.parkCalls += 1;
      if (state.parkThrows) throw new Error('park boom');
      return true;
    },
    async maybeResumeRun() {
      state.resumeCalls += 1;
      return true;
    },
  };
  return state;
}

/** A controllable fake timer: captures armed callbacks so tests fire them by hand. */
function makeTimer(): {
  setTimer: (cb: () => void, ms: number) => () => void;
  timers: Array<{ cb: () => void; ms: number; canceled: boolean }>;
} {
  const timers: Array<{ cb: () => void; ms: number; canceled: boolean }> = [];
  return {
    timers,
    setTimer(cb, ms) {
      const t = { cb, ms, canceled: false };
      timers.push(t);
      return () => {
        t.canceled = true;
      };
    },
  };
}

describe('ReviewQueueSystemicPauseGate', () => {
  it('parks, creates the pause item, and settles retry (resuming the run) on a resolved event', async () => {
    const items = makeItems();
    const parker = makeParker();
    const events = new EventEmitter();
    const gate = new ReviewQueueSystemicPauseGate({ items, parker, events, channelFor, now });

    const p = gate.awaitClear({ runId: 'r', projectId: 1, step: step({ id: 'a' }), error: 'rate limit' });
    await flush();

    // It parked + minted the pause item under the per-step source.
    expect(parker.parkCalls).toBe(1);
    expect(items.createCalls).toHaveLength(1);
    expect(items.createCalls[0].source).toBe(systemicPauseSourceForStep('a'));

    events.emit('review-project-1', { reviewItemId: 'rvw_new', action: 'resolved' });

    await expect(p).resolves.toBe('retry');
    expect(parker.resumeCalls).toBe(1);
  });

  it('settles giveup (resuming the run) on a dismissed event', async () => {
    const items = makeItems();
    const parker = makeParker();
    const events = new EventEmitter();
    const gate = new ReviewQueueSystemicPauseGate({ items, parker, events, channelFor, now });

    const p = gate.awaitClear({ runId: 'r', projectId: 1, step: step({ id: 'a' }), error: 'rate limit' });
    await flush();

    events.emit('review-project-1', { reviewItemId: 'rvw_new', action: 'dismissed' });

    await expect(p).resolves.toBe('giveup');
    expect(parker.resumeCalls).toBe(1);
  });

  it('settles canceled immediately when already aborted on entry (nothing opened)', async () => {
    const items = makeItems();
    const parker = makeParker();
    const controller = new AbortController();
    controller.abort();
    const gate = new ReviewQueueSystemicPauseGate({ items, parker, events: new EventEmitter(), channelFor, now });

    const verdict = await gate.awaitClear({
      runId: 'r',
      projectId: 1,
      step: step({ id: 'a' }),
      error: 'rate limit',
      signal: controller.signal,
    });

    expect(verdict).toBe('canceled');
    expect(items.findPendingCalls).toHaveLength(0);
    expect(items.createCalls).toHaveLength(0);
    expect(parker.parkCalls).toBe(0);
  });

  it('dismisses the pause item and settles canceled (NO resume) when aborted while parked', async () => {
    const items = makeItems();
    const parker = makeParker();
    const controller = new AbortController();
    const gate = new ReviewQueueSystemicPauseGate({ items, parker, events: new EventEmitter(), channelFor, now });

    const p = gate.awaitClear({
      runId: 'r',
      projectId: 1,
      step: step({ id: 'a' }),
      error: 'rate limit',
      signal: controller.signal,
    });
    await flush();
    controller.abort();

    await expect(p).resolves.toBe('canceled');
    expect(items.dismissCalls).toEqual([{ projectId: 1, reviewItemId: 'rvw_new', resolution: 'canceled' }]);
    // Cancel owns the terminal transition — the gate must NOT resume the run.
    expect(parker.resumeCalls).toBe(0);
  });

  it('arms the auto-resume timer at delay + buffer for a parseable reset; firing resolves the item and settles retry', async () => {
    const items = makeItems();
    const parker = makeParker();
    const timer = makeTimer();
    // "...|1700003600" (10-digit epoch seconds) ⇒ reset at NOW + 3_600_000ms.
    const error = 'Claude AI usage limit reached|1700003600';
    const gate = new ReviewQueueSystemicPauseGate({
      items,
      parker,
      events: new EventEmitter(),
      channelFor,
      now,
      setTimer: timer.setTimer,
    });

    const p = gate.awaitClear({ runId: 'r', projectId: 1, step: step({ id: 'a' }), error });
    await flush();

    expect(timer.timers).toHaveLength(1);
    expect(timer.timers[0].ms).toBe(3_600_000 + AUTO_RESUME_BUFFER_MS);

    timer.timers[0].cb();

    await expect(p).resolves.toBe('retry');
    expect(items.resolveCalls).toEqual([
      { projectId: 1, reviewItemId: 'rvw_new', resolution: 'auto-retry: usage limit reset' },
    ]);
    expect(parker.resumeCalls).toBe(1);
  });

  it('does NOT arm a timer for an unparseable systemic error', async () => {
    const items = makeItems();
    const parker = makeParker();
    const timer = makeTimer();
    const events = new EventEmitter();
    const gate = new ReviewQueueSystemicPauseGate({
      items,
      parker,
      events,
      channelFor,
      now,
      setTimer: timer.setTimer,
    });

    const p = gate.awaitClear({ runId: 'r', projectId: 1, step: step({ id: 'a' }), error: 'overloaded_error' });
    await flush();

    expect(timer.timers).toHaveLength(0);

    // Settle so the promise does not dangle.
    events.emit('review-project-1', { reviewItemId: 'rvw_new', action: 'resolved' });
    await expect(p).resolves.toBe('retry');
  });

  it('reattaches to an already-pending pause item (findPending hit) instead of creating a duplicate', async () => {
    const items = makeItems({ existing: 'rvw_existing' });
    const parker = makeParker();
    const events = new EventEmitter();
    const gate = new ReviewQueueSystemicPauseGate({ items, parker, events, channelFor, now });

    const p = gate.awaitClear({ runId: 'r', projectId: 1, step: step({ id: 'a' }), error: 'rate limit' });
    await flush();

    expect(items.createCalls).toHaveLength(0);

    // Events for the reattached item drive the verdict.
    events.emit('review-project-1', { reviewItemId: 'rvw_existing', action: 'resolved' });
    await expect(p).resolves.toBe('retry');
  });

  it('keeps awaiting the clear event when the park fails (fail-soft)', async () => {
    const items = makeItems();
    const parker = makeParker();
    parker.parkThrows = true;
    const events = new EventEmitter();
    const gate = new ReviewQueueSystemicPauseGate({ items, parker, events, channelFor, now });

    const p = gate.awaitClear({ runId: 'r', projectId: 1, step: step({ id: 'a' }), error: 'rate limit' });
    await flush();

    // Park threw but the item still exists; a later resolve still settles.
    events.emit('review-project-1', { reviewItemId: 'rvw_new', action: 'resolved' });
    await expect(p).resolves.toBe('retry');
    expect(parker.resumeCalls).toBe(1);
  });

  it('is single-settle: a resolved event cancels the armed timer so a later fire is a no-op', async () => {
    const items = makeItems();
    const parker = makeParker();
    const timer = makeTimer();
    const events = new EventEmitter();
    const error = 'Claude AI usage limit reached|1700003600';
    const gate = new ReviewQueueSystemicPauseGate({
      items,
      parker,
      events,
      channelFor,
      now,
      setTimer: timer.setTimer,
    });

    const p = gate.awaitClear({ runId: 'r', projectId: 1, step: step({ id: 'a' }), error });
    await flush();

    // Human resolves first (event), settling 'retry' and cancelling the timer.
    events.emit('review-project-1', { reviewItemId: 'rvw_new', action: 'resolved' });
    await expect(p).resolves.toBe('retry');
    expect(timer.timers[0].canceled).toBe(true);

    // A stray timer fire after settle is a guarded no-op: it does NOT resolve the item again.
    timer.timers[0].cb();
    expect(items.resolveCalls).toHaveLength(0);
    expect(parker.resumeCalls).toBe(1);
  });
});
