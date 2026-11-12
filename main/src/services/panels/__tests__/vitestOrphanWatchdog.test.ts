/**
 * Orphan-watchdog unit tests.
 *
 * Driven through the injected title/thread/spawn seams — no thread is started and
 * nothing is killed. The regressions that matter here are the ones where arming is
 * WRONG: a vitest root must never self-terminate, a `threads`-pool worker must
 * never be judged by its process ppid, and a detached (`nohup`) run must survive —
 * each of those would turn a healthy gate into a self-inflicted kill.
 *
 * The behaviour that cannot be unit-tested is the one that motivated the design:
 * that the watchdog still fires when the main thread is wedged in libuv's check
 * phase and no main-thread callback can run. That was verified against a live
 * orphan — see the module header.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  isForkPoolWorker,
  startOrphanWatchdog,
  titleVitestForkWorker,
  ORPHAN_POLL_INTERVAL_MS,
  WATCHDOG_THREAD_SOURCE,
  type OrphanWatchdogDeps,
} from '../../../../../vitestOrphanWatchdog';

/** A watchdog harness that records what would have been spawned. */
function harness(overrides: Partial<OrphanWatchdogDeps> = {}) {
  const terminate = vi.fn();
  const unref = vi.fn();
  const spawn = vi.fn((_source: string) => ({ unref, terminate }));
  const deps: OrphanWatchdogDeps = {
    title: 'node (vitest 7)',
    mainThread: true,
    spawn,
    ...overrides,
  };
  const disarm = startOrphanWatchdog(deps);
  return { disarm, spawn, terminate, armed: spawn.mock.calls.length > 0 };
}

describe('isForkPoolWorker', () => {
  it('accepts a fork-pool worker on its own main thread', () => {
    expect(isForkPoolWorker('node (vitest 7)', true)).toBe(true);
    expect(isForkPoolWorker('node (vitest 12)', true)).toBe(true);
  });

  it('rejects the vitest root — it is titled without an index', () => {
    expect(isForkPoolWorker('node (vitest)', true)).toBe(false);
  });

  it('rejects a threads-pool worker, which shares the root process ppid', () => {
    expect(isForkPoolWorker('node (vitest 7)', false)).toBe(false);
  });

  it('rejects unrelated processes', () => {
    expect(isForkPoolWorker('node', true)).toBe(false);
    expect(isForkPoolWorker('/usr/bin/node ./server.js', true)).toBe(false);
    expect(isForkPoolWorker('', true)).toBe(false);
  });
});

describe('startOrphanWatchdog', () => {
  it('spawns a watchdog for a fork-pool worker', () => {
    const h = harness();
    expect(h.armed).toBe(true);
    expect(h.disarm).toBeInstanceOf(Function);
  });

  it('does not arm for a vitest root, even one detached to ppid 1', () => {
    // The nohup case: `nohup pnpm test:unit &` reparents the ROOT. Arming here
    // would kill a perfectly healthy run on its first poll.
    const h = harness({ title: 'node (vitest)' });
    expect(h.armed).toBe(false);
    expect(h.disarm).toBeUndefined();
  });

  it('does not arm for a threads-pool worker', () => {
    // Also what stops the watchdog thread from spawning one of its own.
    const h = harness({ mainThread: false });
    expect(h.armed).toBe(false);
  });

  it('bakes the poll interval into the thread source', () => {
    const h = harness({ intervalMs: 1234 });
    const source = h.spawn.mock.calls[0][0];
    expect(source).toContain('1234');
    expect(source).not.toContain('INTERVAL_MS');
  });

  it('defaults to a seconds-scale poll interval', () => {
    const h = harness();
    expect(h.spawn.mock.calls[0][0]).toContain(String(ORPHAN_POLL_INTERVAL_MS));
    expect(ORPHAN_POLL_INTERVAL_MS).toBeLessThanOrEqual(10_000);
  });

  it('disarms by terminating the thread', () => {
    const h = harness();
    h.disarm?.();
    expect(h.terminate).toHaveBeenCalled();
  });

  it('fails soft when threads are unavailable rather than failing the run', () => {
    const spawn = vi.fn(() => {
      throw new Error('worker_threads unavailable');
    });
    expect(() => startOrphanWatchdog({ title: 'node (vitest 1)', mainThread: true, spawn })).not.toThrow();
    expect(startOrphanWatchdog({ title: 'node (vitest 1)', mainThread: true, spawn })).toBeUndefined();
  });
});

describe('WATCHDOG_THREAD_SOURCE', () => {
  it('SIGKILLs the whole process rather than exiting the thread', () => {
    // process.exit() inside a worker thread ends only that thread, leaving a
    // wedged main thread running — the exact failure this design exists to fix.
    expect(WATCHDOG_THREAD_SOURCE).toContain("process.kill(process.pid, 'SIGKILL')");
    expect(WATCHDOG_THREAD_SOURCE).not.toContain('process.exit');
  });

  it('triggers only on ppid 1', () => {
    expect(WATCHDOG_THREAD_SOURCE).toContain('process.ppid === ORPHAN_PPID');
    expect(WATCHDOG_THREAD_SOURCE).toContain('const ORPHAN_PPID = 1;');
  });
});

// vitest 4 stopped titling its fork workers; the watchdog and both reapers key on
// `node (vitest N)`, so the setup path applies it from VITEST_POOL_ID.
describe('titleVitestForkWorker', () => {
  const originalTitle = process.title;
  afterEach(() => {
    process.title = originalTitle;
  });

  it('titles a main-thread pool worker from its pool id', () => {
    titleVitestForkWorker(true, { VITEST_POOL_ID: '7' });
    expect(isForkPoolWorker(process.title, true)).toBe(true);
    expect(process.title.trim()).toBe('node (vitest 7)');
  });

  it('leaves the title alone off the main thread or without a numeric pool id', () => {
    process.title = 'unchanged';
    titleVitestForkWorker(false, { VITEST_POOL_ID: '7' });
    titleVitestForkWorker(true, {});
    titleVitestForkWorker(true, { VITEST_POOL_ID: 'x' });
    expect(process.title).toBe('unchanged');
  });
});
