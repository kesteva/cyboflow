/**
 * Unit tests for ReviewQueueBlockingItemsGate — the programmatic blocking-review-
 * items checkpoint. Exercised through a fake BlockingItemsOpener + a real
 * EventEmitter so the park / await-clear / resume / cancel contract is pinned
 * without any DB or SDK dependency.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ReviewQueueBlockingItemsGate, type BlockingItemsOpener } from '../blockingItemsGate';

const channelFor = (projectId: number): string => `review-project-${projectId}`;

/** A controllable fake opener whose pending state is a mutable flag. */
function makeOpener(initialPending: boolean): BlockingItemsOpener & {
  pending: boolean;
  parkCalls: number;
  resumeCalls: number;
} {
  const state = {
    pending: initialPending,
    parkCalls: 0,
    resumeCalls: 0,
    hasPendingBlockingItems(): boolean {
      return state.pending;
    },
    async parkForBlockingReview(): Promise<boolean> {
      state.parkCalls += 1;
      return state.pending;
    },
    async maybeResumeRun(): Promise<boolean> {
      state.resumeCalls += 1;
      return true;
    },
  };
  return state;
}

describe('ReviewQueueBlockingItemsGate', () => {
  it('fast path: proceeds immediately without parking when nothing is blocking', async () => {
    const opener = makeOpener(false);
    const gate = new ReviewQueueBlockingItemsGate(opener, new EventEmitter(), channelFor);

    const verdict = await gate.awaitClear({ runId: 'r', projectId: 1 });

    expect(verdict).toBe('proceed');
    expect(opener.parkCalls).toBe(0);
    expect(opener.resumeCalls).toBe(0);
  });

  it('parks, awaits the clear event, then resumes and proceeds', async () => {
    const opener = makeOpener(true);
    const events = new EventEmitter();
    const gate = new ReviewQueueBlockingItemsGate(opener, events, channelFor);

    const p = gate.awaitClear({ runId: 'r', projectId: 7 });
    // Let the park() microtask settle so the subscription + re-check ran.
    await Promise.resolve();
    expect(opener.parkCalls).toBe(1);

    // A resolved event while STILL blocking must NOT proceed.
    events.emit('review-project-7', { reviewItemId: 'rvw_x', action: 'resolved' });
    await Promise.resolve();

    // Clear the blocking state, then emit a triage event → proceed.
    opener.pending = false;
    events.emit('review-project-7', { reviewItemId: 'rvw_x', action: 'resolved' });

    await expect(p).resolves.toBe('proceed');
    expect(opener.resumeCalls).toBe(1);
  });

  it('proceeds without waiting for an event when items clear during the park', async () => {
    const opener = makeOpener(true);
    // Flip to not-pending as soon as park is invoked (race: cleared during park).
    const origPark = opener.parkForBlockingReview.bind(opener);
    opener.parkForBlockingReview = async (runId: string) => {
      const r = await origPark(runId);
      opener.pending = false;
      return r;
    };
    const gate = new ReviewQueueBlockingItemsGate(opener, new EventEmitter(), channelFor);

    await expect(gate.awaitClear({ runId: 'r', projectId: 1 })).resolves.toBe('proceed');
    expect(opener.resumeCalls).toBe(1);
  });

  it('settles canceled when the abort signal fires while parked', async () => {
    const opener = makeOpener(true);
    const controller = new AbortController();
    const gate = new ReviewQueueBlockingItemsGate(opener, new EventEmitter(), channelFor);

    const p = gate.awaitClear({ runId: 'r', projectId: 1, signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    await expect(p).resolves.toBe('canceled');
    expect(opener.resumeCalls).toBe(0);
  });

  it('settles canceled immediately when already aborted on entry (no park)', async () => {
    const opener = makeOpener(true);
    const controller = new AbortController();
    controller.abort();
    const gate = new ReviewQueueBlockingItemsGate(opener, new EventEmitter(), channelFor);

    await expect(
      gate.awaitClear({ runId: 'r', projectId: 1, signal: controller.signal }),
    ).resolves.toBe('canceled');
    expect(opener.parkCalls).toBe(0);
  });

  it('ignores created/non-triage events and mismatched payloads', async () => {
    const opener = makeOpener(true);
    const events = new EventEmitter();
    const gate = new ReviewQueueBlockingItemsGate(opener, events, channelFor);
    const settled = vi.fn();

    const p = gate.awaitClear({ runId: 'r', projectId: 2 }).then((v) => {
      settled(v);
      return v;
    });
    await Promise.resolve();

    opener.pending = false;
    events.emit('review-project-2', { reviewItemId: 'rvw', action: 'created' }); // not a clear
    events.emit('review-project-2', { notAnEvent: true }); // malformed
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    events.emit('review-project-2', { reviewItemId: 'rvw', action: 'dismissed' }); // clears
    await expect(p).resolves.toBe('proceed');
  });
});
