/**
 * Unit tests for `eventToAsyncIterable` — the shared EventEmitter→AsyncIterable
 * bridge that backs every push subscription (approvals / stuck / questions /
 * run-status / artifacts). The invariants under test are the ones a dropped or
 * duplicated push event would silently break:
 *   - an event emitted while the consumer awaits is delivered;
 *   - two events emitted synchronously before the consumer resumes are BOTH
 *     delivered, in order (the internal queue must not drop the second);
 *   - aborting mid-wait terminates the loop cleanly AND removes both the
 *     emitter listener and the abort listener (listenerCount back to zero — no
 *     leak across the life of a long-lived orchestrator process);
 *   - an already-aborted signal returns immediately without attaching a
 *     listener at all.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { eventToAsyncIterable } from '../events';

/** Yield to the microtask/immediate queue so a started iterator reaches its await. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Drain `iterable` until `count` values arrive, then abort + break. Returns the
 * collected values. `break` triggers the iterator's `finally`, so listener
 * cleanup is exercised on the happy path too.
 */
async function collect<T>(
  iterable: AsyncIterable<T>,
  count: number,
  ac: AbortController,
): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of iterable) {
    out.push(ev);
    if (out.length >= count) {
      ac.abort();
      break;
    }
  }
  return out;
}

describe('eventToAsyncIterable', () => {
  it('yields an event emitted while the consumer awaits, then cleans up', async () => {
    const emitter = new EventEmitter();
    const ac = new AbortController();
    const it = eventToAsyncIterable<number>(emitter, 'x', ac.signal);

    const collected = collect(it, 1, ac);
    await tick(); // let the iterator reach its `await new Promise`
    expect(emitter.listenerCount('x')).toBe(1);

    emitter.emit('x', 42);

    expect(await collected).toEqual([42]);
    expect(emitter.listenerCount('x')).toBe(0);
  });

  it('yields two synchronously-emitted events in order (no drop of the second)', async () => {
    const emitter = new EventEmitter();
    const ac = new AbortController();
    const it = eventToAsyncIterable<number>(emitter, 'x', ac.signal);

    const collected = collect(it, 2, ac);
    await tick();

    // Both emitted before the consumer resumes — they must queue, not clobber.
    emitter.emit('x', 1);
    emitter.emit('x', 2);

    expect(await collected).toEqual([1, 2]);
    expect(emitter.listenerCount('x')).toBe(0);
  });

  it('terminates cleanly on abort mid-wait and detaches every listener', async () => {
    const emitter = new EventEmitter();
    const ac = new AbortController();
    const it = eventToAsyncIterable<number>(emitter, 'x', ac.signal);

    let ended = false;
    const done = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ev of it) {
        /* never receives — we abort before any emit */
      }
      ended = true;
    })();

    await tick();
    expect(emitter.listenerCount('x')).toBe(1);

    ac.abort();
    await done;

    expect(ended).toBe(true);
    expect(emitter.listenerCount('x')).toBe(0);
  });

  it('returns immediately without attaching a listener when the signal is already aborted', async () => {
    const emitter = new EventEmitter();
    const ac = new AbortController();
    ac.abort();

    const it = eventToAsyncIterable<number>(emitter, 'x', ac.signal);
    const out: number[] = [];
    for await (const ev of it) out.push(ev);

    expect(out).toEqual([]);
    expect(emitter.listenerCount('x')).toBe(0);
  });
});
