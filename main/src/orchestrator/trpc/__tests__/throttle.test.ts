/**
 * Unit tests for throttleAsyncIterator.
 *
 * Uses vi.useFakeTimers() for deterministic rate measurement — no wall-clock
 * dependence. Test cases:
 *   1. Rate cap: source produces events continuously for 1 simulated second →
 *      throttle emits ≈ hz ± 10 times.
 *   2. Coalescing-latest: multiple source events within one tick window →
 *      only the latest event is emitted.
 *   3. Idle costs nothing: a subscription whose source is quiet holds NO timer,
 *      and returns to holding none after a burst settles.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { throttleAsyncIterator, batchAsyncIterator } from '../throttle';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drains the microtask queue by awaiting Promise.resolve() n times.
 */
async function drainMicrotasks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
  }
}

/**
 * A manually-controlled async iterable. Push values via push() and
 * terminate via done(). When the queue has items, yields them without
 * waiting; when empty and not done, waits for the next push or done call.
 */
function makeManualIterator<T>(): {
  push: (value: T) => void;
  done: () => void;
  iterable: AsyncIterable<T>;
} {
  const queue: T[] = [];
  let resolve: (() => void) | null = null;
  let finished = false;

  async function* generator(): AsyncGenerator<T> {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift() as T;
      } else if (finished) {
        return;
      } else {
        await new Promise<void>((r) => {
          resolve = r;
        });
        resolve = null;
      }
    }
  }

  return {
    push(value: T) {
      queue.push(value);
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    },
    done() {
      finished = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    },
    iterable: generator(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('throttleAsyncIterator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Test 1: Rate cap
  //
  // Drive a source that produces one event every fake-millisecond for 1000ms
  // (1000 events total), using two setIntervals: one for source events (1ms)
  // and one for the throttle (1000/60 ms). Count emissions and assert ≈ hz.
  // -------------------------------------------------------------------------
  it('caps emission rate to approximately hz per second (60Hz)', async () => {
    const hz = 60;
    const { push, done, iterable } = makeManualIterator<number>();
    const throttled = throttleAsyncIterator(iterable, hz);

    const results: number[] = [];
    let drainFinished = false;

    const drainPromise = (async () => {
      for await (const v of throttled) {
        results.push(v);
      }
      drainFinished = true;
    })();

    // Use a separate setInterval to push one event per fake-millisecond for
    // 1000ms, producing a stream that lasts the full simulated second.
    let eventCount = 0;
    const sourceInterval = setInterval(() => {
      push(++eventCount);
    }, 1);

    // Advance 1000ms using vi.advanceTimersByTimeAsync, which flushes pending
    // promises between each timer tick — allowing the consumer loop and the
    // outer generator to advance alongside the source and throttle intervals.
    await vi.advanceTimersByTimeAsync(1000);

    // Stop source, terminate the iterator.
    clearInterval(sourceInterval);
    done();

    // Drain remaining work.
    await drainMicrotasks(50);

    // Advance a little more to let the final dirty event (if any) be picked up.
    await vi.advanceTimersByTimeAsync(50);
    await drainMicrotasks(50);

    if (!drainFinished) {
      await throttled.return(undefined);
    }
    await drainPromise;

    // At 60Hz over 1 second: expect ~60 ticks. Allow ±10 for scheduling jitter.
    expect(results.length).toBeGreaterThanOrEqual(50);
    expect(results.length).toBeLessThanOrEqual(70);
  });

  // -------------------------------------------------------------------------
  // Test 2: Coalescing-latest
  //
  // Push 10 events synchronously (before any tick fires). Advance time past
  // exactly one tick boundary. Assert only the latest event (10) is emitted.
  // -------------------------------------------------------------------------
  it('yields the latest event when multiple events occur within one tick window', async () => {
    const hz = 60; // tick every ~16.67ms
    const { push, done, iterable } = makeManualIterator<number>();
    const throttled = throttleAsyncIterator(iterable, hz);

    const results: number[] = [];

    const drainPromise = (async () => {
      for await (const v of throttled) {
        results.push(v);
      }
    })();

    // Push all 10 events at fake time 0 (no ticks have fired yet).
    for (let i = 1; i <= 10; i++) {
      push(i);
    }
    done();

    // Drain many microtask rounds so the background consumer processes ALL 10
    // items and sets latest=10, dirty=true, sourceDone=true. Each generator
    // yield needs ~2–3 microtask rounds; 200 is more than enough for 10 items.
    await drainMicrotasks(200);

    // Still no tick has fired — results must be empty.
    expect(results).toHaveLength(0);

    // Advance time past exactly one tick boundary (17ms at 60Hz ≈ 16.67ms).
    // advanceTimersByTimeAsync flushes promises after the interval fires, so
    // the outer generator receives the enqueued item and yields it.
    await vi.advanceTimersByTimeAsync(17);

    // Drain additional microtasks so the outer generator can break out after
    // sourceDone=true, queue empty, dirty=false.
    await drainMicrotasks(50);

    await drainPromise;

    // Exactly one event should have been emitted — and it must be 10 (latest wins).
    expect(results).toHaveLength(1);
    expect(results[0]).toBe(10);
  });

  // -------------------------------------------------------------------------
  // Test 3: An idle subscription arms no timer.
  //
  // This is the property that matters for main-process CPU. The throttle used
  // to hold a setInterval for its whole life, so N live subscriptions cost
  // N * hz wakeups/second whether or not anything was streaming. Assert the
  // timer only exists while a value is actually pending.
  // -------------------------------------------------------------------------
  it('holds no timer while the source is idle', async () => {
    const { push, done, iterable } = makeManualIterator<number>();
    const throttled = throttleAsyncIterator(iterable, 60);

    const results: number[] = [];
    const drainPromise = (async () => {
      for await (const v of throttled) {
        results.push(v);
      }
    })();

    // A live subscription that has never seen a value must be timer-free.
    await drainMicrotasks(50);
    await vi.advanceTimersByTimeAsync(1000);
    await drainMicrotasks(50);
    expect(vi.getTimerCount()).toBe(0);
    expect(results).toHaveLength(0);

    // A burst arms exactly one timer, no matter how many values it carries.
    push(1);
    push(2);
    await drainMicrotasks(50);
    expect(vi.getTimerCount()).toBe(1);

    // A post-idle value must still be HELD for a full interval and coalesced —
    // not emitted on the leading edge. (Deriving the delay from a wall-clock
    // delta got this wrong: after an idle gap the computed delay collapsed to
    // zero, so value 1 escaped immediately and 2 followed separately.)
    await vi.advanceTimersByTimeAsync(5);
    await drainMicrotasks(20);
    expect(results).toEqual([]);

    // Once the burst has drained, the subscription goes back to costing nothing.
    await vi.advanceTimersByTimeAsync(100);
    await drainMicrotasks(50);
    expect(results).toEqual([2]);
    expect(vi.getTimerCount()).toBe(0);

    done();
    await drainMicrotasks(50);
    await drainPromise;
  });

  // -------------------------------------------------------------------------
  // Test 5: teardown completes even against an uncooperative source.
  //
  // The consumer loop is suspended in `iterator.next()` and only re-reads `done`
  // once a value arrives, so a source that never produces again cannot be woken
  // from inside. Teardown must therefore not block on it — otherwise .return()
  // (a client disconnect) stays pending forever and the subscription leaks.
  // -------------------------------------------------------------------------
  it('returns promptly when the source is parked in next() and ignores cancellation', async () => {
    let returnCalled = false;
    // Never yields, never completes, and its return() never settles either —
    // the worst-behaved source the throttle could be handed.
    const hostileSource: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<number>>(() => undefined),
        return: () => {
          returnCalled = true;
          return new Promise<IteratorResult<number>>(() => undefined);
        },
      }),
    };

    const controller = new AbortController();
    const throttled = throttleAsyncIterator(hostileSource, 60, controller.signal);

    // Start consuming so the generator is live and parked between emissions.
    const drained: number[] = [];
    const drainPromise = (async () => {
      for await (const v of throttled) drained.push(v);
    })();
    await drainMicrotasks(50);

    // The disconnect. Before the signal existed this could not be observed at
    // all: the generator was suspended at an internal await, so `.return()` was
    // merely QUEUED and its teardown never ran — here that is a test timeout.
    controller.abort();
    await drainMicrotasks(50);
    await drainPromise;

    expect(drained).toEqual([]);
    expect(returnCalled).toBe(true); // the source WAS asked to cancel
    expect(vi.getTimerCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 4: the cap holds across a system clock jump.
  //
  // An earlier version computed each delay from a `Date.now()` delta, which is
  // wrong in BOTH directions: a forward jump made the delay collapse to zero
  // (emitting faster than hz), and a backward jump inflated it by the size of
  // the jump (stalling a pending final value). The cadence must come from
  // relative timer delays only, so moving the wall clock must change nothing.
  // -------------------------------------------------------------------------
  it('is unaffected by system clock jumps in either direction', async () => {
    const { push, done, iterable } = makeManualIterator<number>();
    const throttled = throttleAsyncIterator(iterable, 60);

    const results: number[] = [];
    const drainPromise = (async () => {
      for await (const v of throttled) results.push(v);
    })();

    const realNow = Date.now;
    try {
      push(1);
      await drainMicrotasks(30);

      // Jump the wall clock forward an hour without advancing timers.
      Date.now = () => realNow() + 3_600_000;
      await drainMicrotasks(30);
      // The value is still held: only the timer decides, not the clock.
      expect(results).toEqual([]);

      // And it still lands on the normal cadence, not instantly.
      await vi.advanceTimersByTimeAsync(17);
      await drainMicrotasks(30);
      expect(results).toEqual([1]);

      // Now jump backward an hour and send a final value + completion. It must
      // not be stalled by the (negative) apparent elapsed time.
      Date.now = () => realNow() - 3_600_000;
      push(2);
      done();
      await drainMicrotasks(30);
      await vi.advanceTimersByTimeAsync(17);
      await drainMicrotasks(30);
      expect(results).toEqual([1, 2]);
    } finally {
      Date.now = realNow;
    }

    await drainPromise;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('batchAsyncIterator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // The property that distinguishes this from throttleAsyncIterator: nothing
  // is dropped. Push 10 events synchronously (before any tick fires), then
  // advance past one tick boundary — all 10 must arrive together, in order,
  // as a single batch (not just the latest, and not one emission per event).
  // -------------------------------------------------------------------------
  it('emits every event seen within a tick window as one ordered batch — nothing dropped', async () => {
    const hz = 60; // tick every ~16.67ms
    const { push, done, iterable } = makeManualIterator<number>();
    const batched = batchAsyncIterator(iterable, hz);

    const results: number[][] = [];
    const drainPromise = (async () => {
      for await (const v of batched) {
        results.push(v);
      }
    })();

    for (let i = 1; i <= 10; i++) {
      push(i);
    }
    done();

    await drainMicrotasks(200);

    // No tick has fired yet — nothing emitted.
    expect(results).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(17);
    await drainMicrotasks(50);
    await drainPromise;

    // Exactly one batch, carrying every value in arrival order.
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  // -------------------------------------------------------------------------
  // Rate cap: mirrors throttleAsyncIterator's own test — batches per second
  // stay bounded to ~hz regardless of source throughput, even though no
  // individual event is dropped (they land in fewer, larger batches instead).
  // -------------------------------------------------------------------------
  it('caps batch-emission rate to approximately hz per second while retaining every event', async () => {
    const hz = 60;
    const { push, done, iterable } = makeManualIterator<number>();
    const batched = batchAsyncIterator(iterable, hz);

    const batches: number[][] = [];
    let drainFinished = false;
    const drainPromise = (async () => {
      for await (const v of batched) {
        batches.push(v);
      }
      drainFinished = true;
    })();

    let eventCount = 0;
    const sourceInterval = setInterval(() => {
      push(++eventCount);
    }, 1);

    await vi.advanceTimersByTimeAsync(1000);
    clearInterval(sourceInterval);
    done();

    await drainMicrotasks(50);
    await vi.advanceTimersByTimeAsync(50);
    await drainMicrotasks(50);

    if (!drainFinished) {
      await batched.return(undefined);
    }
    await drainPromise;

    // Batch count stays hz-bounded (±10 jitter, same tolerance as the
    // throttle test), but every pushed event is accounted for across batches.
    expect(batches.length).toBeGreaterThanOrEqual(50);
    expect(batches.length).toBeLessThanOrEqual(70);
    const totalEvents = batches.reduce((sum, b) => sum + b.length, 0);
    expect(totalEvents).toBe(eventCount);
  });

  // -------------------------------------------------------------------------
  // Idle costs nothing — same property as throttleAsyncIterator, same reason
  // (N live subscriptions must not each hold a perpetual setInterval).
  // -------------------------------------------------------------------------
  it('holds no timer while the source is idle', async () => {
    const { push, done, iterable } = makeManualIterator<number>();
    const batched = batchAsyncIterator(iterable, 60);

    const results: number[][] = [];
    const drainPromise = (async () => {
      for await (const v of batched) {
        results.push(v);
      }
    })();

    await drainMicrotasks(50);
    await vi.advanceTimersByTimeAsync(1000);
    await drainMicrotasks(50);
    expect(vi.getTimerCount()).toBe(0);
    expect(results).toHaveLength(0);

    push(1);
    push(2);
    await drainMicrotasks(50);
    expect(vi.getTimerCount()).toBe(1);

    // The flush fires at one tick, then re-arms a trailing cooldown (same
    // chain shape as throttleAsyncIterator) that expires empty — advance past
    // BOTH before asserting the timer is gone, exactly like the throttle
    // test's own "holds no timer while idle" case does.
    await vi.advanceTimersByTimeAsync(100);
    await drainMicrotasks(50);
    expect(results).toEqual([[1, 2]]);
    expect(vi.getTimerCount()).toBe(0);

    done();
    await drainMicrotasks(50);
    await drainPromise;
  });
});
