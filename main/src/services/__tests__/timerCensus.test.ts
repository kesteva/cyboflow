/**
 * TimerCensus tests — the opt-in timer-wakeup attribution instrument.
 *
 * The census patches global timer functions, so its overriding constraint is
 * that it must not CHANGE the behaviour of the code it measures. These cases
 * pin the observer-effect properties that a naive wrapper silently breaks.
 *
 * TRACE_ENABLED is read from the env at module load, so each scenario resets
 * the module registry and re-imports with the env pre-set.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { promisify } from 'node:util';

const OLD_TRACE = process.env.CYBOFLOW_PERF_TRACE;

const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const realSetImmediate = globalThis.setImmediate;

afterEach(() => {
  process.env.CYBOFLOW_PERF_TRACE = OLD_TRACE;
  globalThis.setTimeout = realSetTimeout;
  globalThis.setInterval = realSetInterval;
  globalThis.setImmediate = realSetImmediate;
  vi.resetModules();
});

async function installEnabled() {
  process.env.CYBOFLOW_PERF_TRACE = '1';
  vi.resetModules();
  const mod = await import('../timerCensus');
  mod.installTimerCensus();
  return mod;
}

describe('timerCensus (disabled)', () => {
  it('leaves the global timer functions untouched', async () => {
    process.env.CYBOFLOW_PERF_TRACE = '0';
    vi.resetModules();
    const mod = await import('../timerCensus');
    mod.installTimerCensus();

    expect(globalThis.setTimeout).toBe(realSetTimeout);
    expect(globalThis.setInterval).toBe(realSetInterval);
    expect(globalThis.setImmediate).toBe(realSetImmediate);
    expect(mod.drainTimerCensus()).toEqual([]);
  });
});

describe('timerCensus (enabled)', () => {
  it('preserves util.promisify(setTimeout) semantics', async () => {
    // setTimeout carries Symbol(nodejs.util.promisify.custom); a bare wrapper
    // drops it, and promisify then falls back to callback-last — calling
    // setTimeout(ms, value, cb), so the delay lands in the callback slot and the
    // promise REJECTS with ERR_INVALID_ARG_TYPE instead of resolving with the
    // value. Anything doing `await promisify(setTimeout)(…)` would break, but
    // only while profiling: the exact observer effect this must not have.
    await installEnabled();

    const delay = promisify(globalThis.setTimeout);
    await expect(delay(1, 'sentinel')).resolves.toBe('sentinel');
  });

  it('preserves clearTimeout, handle identity and unref()', async () => {
    await installEnabled();

    const handle = globalThis.setTimeout(() => {
      throw new Error('cleared timer must never fire');
    }, 5);
    // The real Timeout handle is returned untouched, so its whole API works.
    expect(typeof handle.unref).toBe('function');
    expect(handle.unref()).toBe(handle);
    clearTimeout(handle);

    await new Promise((resolve) => realSetTimeout(resolve, 20));
  });

  it('forwards extra arguments and counts the fire against its site', async () => {
    const mod = await installEnabled();

    const seen: unknown[] = [];
    await new Promise<void>((resolve) => {
      globalThis.setTimeout(
        (...args: unknown[]) => {
          seen.push(...args);
          resolve();
        },
        1,
        'a',
        'b',
      );
    });

    expect(seen).toEqual(['a', 'b']);
    const rows = mod.drainTimerCensus();
    expect(rows.reduce((sum, row) => sum + row.fires, 0)).toBe(1);
    // Draining resets the counters.
    expect(mod.drainTimerCensus().reduce((sum, row) => sum + row.fires, 0)).toBe(0);
  });

  it('does not throw when a timer global is absent on this host', async () => {
    // setImmediate does not exist in every environment. Installing the census
    // must never be the thing that takes the process down.
    process.env.CYBOFLOW_PERF_TRACE = '1';
    vi.resetModules();
    (globalThis as { setImmediate?: unknown }).setImmediate = undefined;
    const mod = await import('../timerCensus');

    expect(() => mod.installTimerCensus()).not.toThrow();
    expect(globalThis.setTimeout).not.toBe(realSetTimeout); // still installed what it could
  });

  it('reports every site so the headline wakeup total cannot under-count', async () => {
    // drainTimerCensus resets ALL sites, so if it also truncated its return the
    // dropped fires would be unrecoverable and the reported rate would be
    // systematically low exactly when the process is busiest.
    const mod = await installEnabled();
    // Sites are keyed by file:line and frames from this file are skipped (its
    // name contains "timerCensus"), so schedule from a sourceURL'd script with
    // each call on its own line.
    let fired = 0;
    const tick = () => {
      fired += 1;
    };
    const calls = Array.from({ length: 9 }, () => 'setTimeout(tick, 1);').join('\n');
    new Function('setTimeout', 'tick', `${calls}\n//# sourceURL=/virtual/sites.js`)(globalThis.setTimeout, tick);
    await new Promise((resolve) => realSetTimeout(resolve, 50));
    expect(fired).toBe(9);
    const rows = mod.drainTimerCensus();
    expect(rows.length).toBeGreaterThanOrEqual(9);
    expect(rows.reduce((sum, row) => sum + row.fires, 0)).toBe(9);
    // Truncation belongs to the formatter, which says what it elided.
    const many = Array.from({ length: 10 }, (_, i) => ({
      site: `site${i}`,
      kind: 'interval' as const,
      created: 1,
      fires: 100,
      callbackMs: 1,
      minDelayMs: 16,
    }));
    const line = mod.formatTimerCensus(many);
    expect(line).toContain('+2 more sites');
  });
});
