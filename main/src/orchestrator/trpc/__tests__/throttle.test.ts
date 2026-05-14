/**
 * Unit tests for throttleAsyncIterator.
 *
 * Uses vi.useFakeTimers() for deterministic rate measurement — no wall-clock
 * dependence. Two test cases:
 *   1. Rate cap: source produces events continuously for 1 simulated second →
 *      throttle emits ≈ hz ± 10 times.
 *   2. Coalescing-latest: multiple source events within one tick window →
 *      only the latest event is emitted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { throttleAsyncIterator } from '../throttle';

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
});
