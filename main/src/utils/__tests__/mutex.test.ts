/**
 * Behavioral tests for the shared async mutex concurrency guard
 * (main/src/utils/mutex.ts) — the untested worktree-creation serialization
 * chokepoint.
 *
 * Uses REAL timers with short waits: the acquire() polling loop sleeps 10ms
 * between checks, so fake timers would have to be hand-advanced through every
 * poll. Real short timeouts keep the intent legible and the runs fast.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Mutex } from '../mutex';

/** A tiny real-time sleep so the polling loop gets a chance to run. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Mutex', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serializes two concurrent acquires on the same resource', async () => {
    const m = new Mutex();
    const release1 = await m.acquire('worktree');

    let secondAcquired = false;
    const p2 = m.acquire('worktree').then((rel) => {
      secondAcquired = true;
      return rel;
    });

    // While the first holder still holds the lock the second must block.
    await sleep(40);
    expect(secondAcquired).toBe(false);
    expect(m.isLocked('worktree')).toBe(true);

    release1();
    const release2 = await p2;
    expect(secondAcquired).toBe(true);

    release2();
    expect(m.isLocked('worktree')).toBe(false);
  });

  it('acquire() rejects with a timeout when the lock is never released', async () => {
    const m = new Mutex();
    // Hold the lock forever (never call the returned release fn).
    await m.acquire('held');

    await expect(m.acquire('held', 50)).rejects.toThrow(
      /Mutex timeout after 50ms waiting for lock: held/,
    );
    // The failed waiter must not have stolen or corrupted the lock.
    expect(m.isLocked('held')).toBe(true);
  });

  it('withLock() releases the lock even when fn() throws', async () => {
    const m = new Mutex();
    await expect(
      m.withLock('res', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Lock must be free afterwards — a fresh acquire resolves immediately.
    expect(m.isLocked('res')).toBe(false);
    const rel = await m.acquire('res', 100);
    expect(m.isLocked('res')).toBe(true);
    rel();
  });

  it('withLock() returns fn() result and holds the lock only for its duration', async () => {
    const m = new Mutex();
    const result = await m.withLock('res', async () => {
      expect(m.isLocked('res')).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(m.isLocked('res')).toBe(false);
  });

  it('releaseAll() unblocks a pending waiter', async () => {
    const m = new Mutex();
    await m.acquire('r'); // held, never released via its fn

    let acquired = false;
    const waiter = m.acquire('r').then((rel) => {
      acquired = true;
      return rel;
    });

    await sleep(30);
    expect(acquired).toBe(false);

    m.releaseAll();

    const rel = await waiter;
    expect(acquired).toBe(true);
    rel();
  });

  it('releaseAll() with no waiters clears all tracked locks', async () => {
    const m = new Mutex();
    await m.acquire('a');
    await m.acquire('b');
    expect(m.getActiveLockCount()).toBe(2);
    expect(m.getLockedResources().sort()).toEqual(['a', 'b']);

    m.releaseAll();
    expect(m.getActiveLockCount()).toBe(0);
    expect(m.getLockedResources()).toEqual([]);
  });

  it('different resource names never block each other', async () => {
    const m = new Mutex();
    const relA = await m.acquire('a');
    // Acquiring a DIFFERENT resource must resolve without releasing 'a'.
    const relB = await m.acquire('b', 50);
    expect(m.isLocked('a')).toBe(true);
    expect(m.isLocked('b')).toBe(true);
    relA();
    relB();
  });

  it('a stale release from a superseded holder does not clobber the current lock', async () => {
    const m = new Mutex();
    // First holder acquires then releases — freeing the lock.
    const release1 = await m.acquire('r');
    release1();
    expect(m.isLocked('r')).toBe(false);

    // A second holder acquires a NEW lock promise for the same name.
    const release2 = await m.acquire('r');
    expect(m.isLocked('r')).toBe(true);

    // Calling the FIRST (stale) release again must be a no-op — the identity
    // check `this.locks.get(name) === lockPromise` fails for the old promise,
    // so it must NOT delete the second holder's live lock.
    release1();
    expect(m.isLocked('r')).toBe(true);

    release2();
    expect(m.isLocked('r')).toBe(false);
  });
});
