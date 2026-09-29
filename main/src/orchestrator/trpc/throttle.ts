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
 *    `latest`, setting `dirty = true`, and arming the cooldown.
 * 2. `armCooldown` runs a SINGLE `setTimeout(intervalMs)`. When it fires it
 *    moves `latest` into the queue, clears `dirty`, and re-arms; an expiry
 *    with nothing pending stops the chain instead.
 * 3. The outer generator dequeues and yields, blocking between dequeues
 *    until the next flush signal or source completion.
 *
 * ## Why on-demand timers, not a steady interval
 *
 * This used to arm `setInterval(1000/hz)` for the whole life of the
 * subscription, which ticked whether or not the source had produced anything.
 * In the Electron MAIN process that is expensive in a way it is not in plain
 * Node: libuv is driven by Chromium's CFRunLoop, so each fire costs a
 * `__CFRunLoopDoSources0 → uv_run → uv__run_timers` round trip plus a
 * `uv__loop_interrupt`/`kevent` to re-arm. Measured on an IDLE app, two live
 * subscriptions at `hz=60` fired ~98 times/second between them and did 0.8ms of
 * real work per 5000ms — ~2% of a core spent almost entirely on wakeup
 * overhead. Arming the timer only while a value is actually pending drops that
 * to ZERO timers when nothing is streaming, with identical emission semantics.
 *
 * ## Emission-timing equivalence
 *
 * The cadence is driven by a COOLDOWN chain, never by comparing wall-clock
 * timestamps. A value arriving while idle arms a timer for `intervalMs` and is
 * held until it fires — so, exactly as under the old fixed grid, the first
 * value of a burst is coalesced with everything else that lands in that window
 * rather than escaping on the leading edge. Each emission re-arms the cooldown;
 * when it expires with nothing pending, the chain stops and the subscription
 * goes back to holding no timer.
 *
 * Deliberately NO `Date.now()` arithmetic. Deriving the delay from a wall-clock
 * delta makes the throttle wrong across a system clock adjustment in both
 * directions: a backward jump would stall a pending final value for the size of
 * the jump, and a forward jump would compute a zero delay and let emissions
 * exceed `hz`. Relative timer delays are immune to both.
 *
 * ## Lifecycle / cleanup
 *
 * When the outer generator is returned or thrown (client disconnect, error),
 * the `finally` block sets `done = true`, clears any pending cooldown timer,
 * and cancels the source via `iterator.return()`.
 *
 * It deliberately does NOT wait for the background consumer. Teardown here must
 * always complete promptly: a source parked in `next()` cannot see `done`, so
 * blocking on it would leave a client disconnect pending indefinitely. A source
 * is therefore expected to end on cancellation, but is not TRUSTED to — the
 * throttle stays correct either way.
 *
 * ## Why `signal` is needed for that to be true
 *
 * Cleanup code alone is not enough, because between emissions this generator is
 * suspended at an internal `await` (not at a `yield`). Calling `.return()` on an
 * async generator in that state does NOT run its `finally` — the request is
 * QUEUED until the generator next resumes. With an idle source there is nothing
 * to resume it, so a client disconnect would hang and the subscription would be
 * retained, with none of the teardown below ever executing.
 *
 * Passing the subscription's `AbortSignal` gives the generator an external wake:
 * on abort it resumes, breaks the loop, and runs teardown deterministically.
 * Callers that own a signal (every tRPC subscription does) SHOULD pass it.
 * Omitting it preserves the old behaviour exactly, including that hazard.
 */

/**
 * Wraps `source` in a throttled async generator that emits at most `hz`
 * values per second, always yielding the **latest** value seen within each
 * tick window (coalescing semantics).
 *
 * @param source - Any async iterable (EventEmitter-backed iterator, etc.).
 * @param hz     - Target emission rate in events per second (e.g. 60).
 * @param signal - The subscription's AbortSignal. Strongly recommended: without
 *                 it, teardown cannot interrupt an idle generator (see above).
 * @returns      An async generator suitable for use in a tRPC subscription.
 */
export async function* throttleAsyncIterator<T>(
  source: AsyncIterable<T>,
  hz: number,
  signal?: AbortSignal,
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

  // The single in-flight cooldown timer, or null when the chain is stopped. At
  // most one exists at a time, and none at all while the source is quiet.
  let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

  /** Wake up the outer generator loop (new value enqueued or source done). */
  function wake(): void {
    if (waitResolve) {
      const r = waitResolve;
      waitResolve = null;
      r();
    }
  }

  /** Move `latest` into the queue and wake the generator. */
  function flush(): void {
    if (!dirty) return;
    const toEmit = latest as T;
    dirty = false;
    latest = undefined;
    queue.push(toEmit);
    wake();
  }

  /**
   * Start one `intervalMs` cooldown. When it expires, anything that arrived
   * during the window is emitted (coalesced to the latest) and the cooldown
   * re-arms; if nothing arrived, the chain stops and we hold no timer until the
   * next value. A no-op when a cooldown is already running or after teardown.
   */
  function armCooldown(): void {
    if (cooldownTimer !== null || done) return;
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      if (!dirty) return; // quiet window — stop the chain, go back to zero timers
      flush();
      armCooldown();
    }, intervalMs);
  }

  // An EXPLICIT iterator rather than `for await`, so teardown can reach in and
  // cancel a source that is currently parked inside `next()`. `for await` only
  // calls `.return()` when its loop exits, which is exactly what cannot happen
  // in that state.
  const iterator = source[Symbol.asyncIterator]();

  // Background consumer: reads source, updates latest+dirty, and arms the
  // cooldown. Deliberately does NOT enqueue directly — only `flush` does, so the
  // rate cap and coalescing stay in one place.
  const consumerPromise = (async () => {
    try {
      while (!done) {
        const next = await iterator.next();
        if (next.done === true || done) break;
        latest = next.value;
        dirty = true;
        armCooldown();
      }
    } finally {
      sourceDone = true;
      wake();
    }
  })();

  // The external wake described in the header: an abort resolves whatever the
  // generator is parked on, so teardown can actually run.
  const onAbort = (): void => wake();
  signal?.addEventListener('abort', onAbort);

  try {
    while (!done) {
      // Drain the queue first.
      while (queue.length > 0) {
        yield queue.shift() as T;
      }

      // Cancelled — stop, even mid-burst. Checked after the drain so anything
      // already flushed still reaches the client.
      if (signal?.aborted === true) {
        break;
      }

      // If source is done and queue is empty and nothing dirty remains,
      // we are finished. (A still-dirty value keeps us here: its cooldown was
      // armed when it was set, so it will fire and wake us — that's what
      // ensures the very last event is not lost when the source exhausts
      // quickly.)
      if (sourceDone && queue.length === 0 && !dirty) {
        break;
      }

      // Wait for next wake() call (tick enqueue or source-done).
      await new Promise<void>((resolve) => {
        // Re-check inside the constructor to avoid a race between the
        // `while(queue.length)` check above and registering the callback —
        // including an abort that landed in that window, which would otherwise
        // park us with the listener already spent.
        if (queue.length > 0 || (sourceDone && !dirty) || signal?.aborted === true) {
          resolve();
        } else {
          waitResolve = resolve;
        }
      });
    }
  } finally {
    done = true;
    signal?.removeEventListener('abort', onAbort);
    if (cooldownTimer !== null) {
      clearTimeout(cooldownTimer);
      cooldownTimer = null;
    }
    wake(); // unblock consumer if waiting

    // Cancel the source, then let the consumer wind down on its own.
    //
    // Teardown must NOT block on the consumer. It used to `await consumerPromise`,
    // but `wake()` cannot reach that loop — it is suspended in `iterator.next()`,
    // and `done` is only re-read once a value arrives. A source that never
    // produces again (nor honours cancellation) therefore left `.return()` on
    // this generator pending FOREVER, so a client disconnect never completed and
    // the subscription's state stayed retained. Awaiting bought nothing in
    // return: all the consumer does on exit is set `sourceDone` and `wake()`,
    // neither of which is observable once the generator has returned.
    //
    // `.catch` on both: after teardown a source error has no consumer, and an
    // unhandled rejection must not escape into the process.
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
    void consumerPromise.catch(() => undefined);
  }
}

/**
 * Same rate-cap/cooldown/cleanup architecture as {@link throttleAsyncIterator},
 * but LOSSLESS: every source value seen within a tick window is retained and
 * emitted together as an array, instead of coalescing to the latest. Use this
 * instead of `throttleAsyncIterator` when a consumer accumulates DELTAS (e.g.
 * concatenating `content_block_delta.text` fragments) rather than replacing
 * its state wholesale on each signal — coalescing-to-latest silently drops
 * the in-between deltas a delta-accumulator needs, corrupting the
 * reconstructed text. Still caps the emission RATE to `hz` batches/second;
 * only the coalescing behavior differs.
 *
 * @param source - Any async iterable (EventEmitter-backed iterator, etc.).
 * @param hz     - Target batch-emission rate in batches per second (e.g. 60).
 * @param signal - The subscription's AbortSignal (see throttleAsyncIterator's
 *                 header for why this matters for teardown).
 * @returns      An async generator yielding non-empty arrays of `T`.
 */
export async function* batchAsyncIterator<T>(
  source: AsyncIterable<T>,
  hz: number,
  signal?: AbortSignal,
): AsyncGenerator<T[]> {
  const intervalMs = 1000 / hz;

  let pending: T[] = [];
  let dirty = false;
  let done = false;
  let sourceDone = false;

  const queue: T[][] = [];

  let waitResolve: (() => void) | null = null;

  let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

  function wake(): void {
    if (waitResolve) {
      const r = waitResolve;
      waitResolve = null;
      r();
    }
  }

  function flush(): void {
    if (!dirty) return;
    const toEmit = pending;
    dirty = false;
    pending = [];
    queue.push(toEmit);
    wake();
  }

  function armCooldown(): void {
    if (cooldownTimer !== null || done) return;
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      if (!dirty) return;
      flush();
      armCooldown();
    }, intervalMs);
  }

  const iterator = source[Symbol.asyncIterator]();

  const consumerPromise = (async () => {
    try {
      while (!done) {
        const next = await iterator.next();
        if (next.done === true || done) break;
        pending.push(next.value);
        dirty = true;
        armCooldown();
      }
    } finally {
      sourceDone = true;
      wake();
    }
  })();

  const onAbort = (): void => wake();
  signal?.addEventListener('abort', onAbort);

  try {
    while (!done) {
      while (queue.length > 0) {
        yield queue.shift() as T[];
      }

      if (signal?.aborted === true) {
        break;
      }

      if (sourceDone && queue.length === 0 && !dirty) {
        break;
      }

      await new Promise<void>((resolve) => {
        if (queue.length > 0 || (sourceDone && !dirty) || signal?.aborted === true) {
          resolve();
        } else {
          waitResolve = resolve;
        }
      });
    }
  } finally {
    done = true;
    signal?.removeEventListener('abort', onAbort);
    if (cooldownTimer !== null) {
      clearTimeout(cooldownTimer);
      cooldownTimer = null;
    }
    wake();

    void Promise.resolve(iterator.return?.()).catch(() => undefined);
    void consumerPromise.catch(() => undefined);
  }
}
