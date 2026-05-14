/**
 * Async-iterator throttle utility for tRPC v11 subscriptions.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 *
 * ## Coalescing semantics
 *
 * When the source produces multiple events within a single tick window
 * (1000/hz milliseconds), only the **latest** event is emitted — earlier
 * events in the same window are silently discarded. This is intentional:
 * the renderer cares about "current state of this run", not a replay of
 * every intermediate state. The raw EventEmitter source (consumed by the
 * raw_events DB writer) remains unthrottled and retains full fidelity.
 *
 * ## Memory-leak mitigation
 *
 * tRPC v11 subscriptions backed by high-frequency sources (e.g., long Bash
 * output) can saturate the IPC queue if every source event crosses the
 * boundary. This throttle caps the per-subscription emission rate at `hz`
 * events per second regardless of source throughput.
 *
 * ## Algorithm
 *
 * 1. A background consumer loop reads from `source`, always overwriting
 *    `latest` and setting `dirty = true`.
 * 2. A `setInterval(1000/hz)` tick checks: if `dirty`, push `latest` into
 *    an internal queue and clear `dirty`.
 * 3. The outer generator dequeues and yields, blocking between dequeues
 *    until the next tick signal or source completion.
 *
 * ## Lifecycle / cleanup
 *
 * When the outer generator is returned or thrown (client disconnect, error),
 * the `finally` block sets `done = true`, clears the interval, and awaits
 * the consumer promise so the background loop exits cleanly.
 */

/**
 * Wraps `source` in a throttled async generator that emits at most `hz`
 * values per second, always yielding the **latest** value seen within each
 * tick window (coalescing semantics).
 *
 * @param source - Any async iterable (EventEmitter-backed iterator, etc.).
 * @param hz     - Target emission rate in events per second (e.g. 60).
 * @returns      An async generator suitable for use in a tRPC subscription.
 */
export async function* throttleAsyncIterator<T>(
  source: AsyncIterable<T>,
  hz: number,
): AsyncGenerator<T> {
  const intervalMs = 1000 / hz;

  let latest: T | undefined = undefined;
  let dirty = false;
  let done = false;
  let sourceDone = false;

  // Queue of values ready to yield.
  const queue: T[] = [];

  // Pending resolve callback: the outer generator awaits this between yields.
  let waitResolve: (() => void) | null = null;

  /** Wake up the outer generator loop (new value enqueued or source done). */
  function wake(): void {
    if (waitResolve) {
      const r = waitResolve;
      waitResolve = null;
      r();
    }
  }

  // Tick interval: if dirty, snapshot latest and enqueue for yield.
  const interval = setInterval(() => {
    if (dirty) {
      const toEmit = latest as T;
      dirty = false;
      latest = undefined;
      queue.push(toEmit);
      wake();
    }
  }, intervalMs);

  // Background consumer: reads source, updates latest+dirty only.
  // Deliberately does NOT enqueue directly — only the interval tick does.
  const consumerPromise = (async () => {
    try {
      for await (const event of source) {
        if (done) break;
        latest = event;
        dirty = true;
      }
    } finally {
      sourceDone = true;
      wake();
    }
  })();

  try {
    while (!done) {
      // Drain the queue first.
      while (queue.length > 0) {
        yield queue.shift() as T;
      }

      // If source is done and queue is empty and nothing dirty remains,
      // we are finished. (Dirty will be caught by the next interval tick if
      // the interval fires before this check — that's intentional to ensure
      // the very last event is not lost when the source exhausts quickly.)
      if (sourceDone && queue.length === 0 && !dirty) {
        break;
      }

      // Wait for next wake() call (tick enqueue or source-done).
      await new Promise<void>((resolve) => {
        // Re-check inside the constructor to avoid a race between the
        // `while(queue.length)` check above and registering the callback.
        if (queue.length > 0 || (sourceDone && !dirty)) {
          resolve();
        } else {
          waitResolve = resolve;
        }
      });
    }
  } finally {
    done = true;
    clearInterval(interval);
    wake(); // unblock consumer if waiting
    await consumerPromise;
  }
}
