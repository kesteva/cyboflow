/**
 * TimerCensus — attributes main-process timer WAKEUPS to the code that scheduled
 * them.
 *
 * Why this exists (measured, not theoretical): in the Electron main process a
 * libuv timer is not cheap the way it is in plain Node. Electron drives libuv
 * from Chromium's CFRunLoop, so every timer fire costs a full
 * `__CFRunLoopDoSources0 → uv_run → uv__run_timers → RunTimers` round trip, and
 * re-arming a repeating timer adds a `uv__loop_interrupt` → `kevent` syscall. A
 * native `sample` of an IDLE cyboflow main process attributes ~all of its
 * on-CPU main-thread samples to exactly that path, while V8's own profiler
 * reports the JS inside those callbacks at ~0.1% — i.e. the cost is the WAKEUP
 * RATE, not the work per callback.
 *
 * That makes "how many times per second does each site fire, and does it do
 * anything when it does" the question that matters, and no stock tool answers
 * it. `process.getActiveResourcesInfo()` counts live handles but not their rate
 * or origin, and an unref'd timer does not even show up there.
 *
 * This module wraps `setTimeout` / `setInterval` / `setImmediate`, records the
 * app-code frame that created each one, and counts fires + callback time per
 * site. {@link drainTimerCensus} returns a per-interval snapshot that
 * {@link PerfTracer} prints alongside event-loop utilization.
 *
 * Gating: fully OFF unless `CYBOFLOW_PERF_TRACE=1`. When off, `installTimerCensus`
 * returns without touching the globals, so normal runs keep the untouched
 * built-ins and pay nothing. Capturing a creation stack per scheduled timer is
 * far too expensive to leave on in production — that cost is the reason this is
 * opt-in rather than always-on.
 *
 * Install as early as possible: sites that schedule a timer at module-import
 * time are only attributed if the census is installed before that import runs.
 */

import { normalizePathSeparators } from '../utils/posixPath';

/** Minimal logger surface — kept local so this module imports nothing heavy. */
interface CensusLogger {
  info(message: string): void;
}

const TRACE_ENABLED = process.env.CYBOFLOW_PERF_TRACE === '1';

/** Per-creation-site totals for the current interval. */
interface SiteStats {
  /** Timers created from this site during the interval. */
  created: number;
  /** Callback invocations from this site during the interval. */
  fires: number;
  /** Total wall time spent inside those callbacks, ms. */
  callbackMs: number;
  /** Shortest delay requested from this site, ms — the wakeup cadence. */
  minDelayMs: number;
  /** Kind of timer, for reading the report. */
  kind: 'interval' | 'timeout' | 'immediate';
}

const sites = new Map<string, SiteStats>();
let installed = false;

function statsFor(site: string, kind: SiteStats['kind']): SiteStats {
  let stats = sites.get(site);
  if (!stats) {
    stats = { created: 0, fires: 0, callbackMs: 0, minDelayMs: Number.POSITIVE_INFINITY, kind };
    sites.set(site, stats);
  }
  return stats;
}

/**
 * Resolve the first app-code frame that scheduled this timer.
 *
 * Skips this module and node internals so the reported site is the caller that
 * can actually be changed. Falls back to the raw first frame rather than
 * dropping the sample, so nothing goes unattributed.
 */
function callSite(): string {
  const stack = new Error().stack;
  if (!stack) return '(no stack)';
  const lines = stack.split('\n').slice(1);
  let firstFrame: string | null = null;
  for (const line of lines) {
    const match = line.match(/\(?((?:\/|[A-Za-z]:)[^():\s]+):(\d+):\d+\)?\s*$/);
    if (!match) continue;
    const [, file, lineNo] = match;
    // V8 frames carry platform-native paths (backslashes on Windows, where the
    // drive-letter form above already parses). Normalize to '/' once so the
    // '/node_modules/' include and the short-label splits below work on both
    // platforms.
    const normFile = normalizePathSeparators(file);
    if (firstFrame === null) firstFrame = `${normFile.split('/').slice(-2).join('/')}:${lineNo}`;
    if (normFile.includes('timerCensus')) continue;
    if (normFile.includes('node:')) continue;
    if (normFile.includes('/node_modules/')) {
      // Keep node_modules frames, but label them so app code is easy to spot.
      return `[dep] ${normFile.split('/node_modules/')[1]?.split('/').slice(0, 2).join('/') ?? normFile}:${lineNo}`;
    }
    return `${normFile.split('/').slice(-2).join('/')}:${lineNo}`;
  }
  return firstFrame ?? '(unresolved)';
}

/** A timer callback as node types it. */
type TimerCallback = (...args: unknown[]) => void;

/**
 * Copy the real timer's own SYMBOL properties onto the wrapper.
 *
 * `setTimeout` and `setImmediate` carry `Symbol(nodejs.util.promisify.custom)`,
 * which is what makes `util.promisify(setTimeout)(ms, value)` resolve after
 * `ms`. A bare wrapper function does not have it, so promisify silently falls
 * back to callback-style and calls `setTimeout(ms, value, cb)` — the delay
 * lands in the callback slot and the promise REJECTS with ERR_INVALID_ARG_TYPE.
 * An instrument that changes the behaviour of the code it measures is worse
 * than no instrument, so the hook is carried across.
 *
 * Deliberately symbols only: copying every own descriptor would drag in
 * `length` / `name` / `prototype`, where a non-configurable mismatch can throw.
 */
function carryOwnSymbols(target: object, source: unknown): void {
  // `source` is a global that a host may simply not provide (`setImmediate` is
  // absent under some test environments and in browsers). Installing the census
  // must never be what takes the process down, so a missing global is skipped.
  if (typeof source !== 'function') return;
  for (const symbol of Object.getOwnPropertySymbols(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, symbol);
    if (descriptor) Object.defineProperty(target, symbol, descriptor);
  }
}

/**
 * Wrap a callback so each invocation is counted against the `stats` bucket its
 * creation site owns.
 */
function countingWrapper(stats: SiteStats, callback: TimerCallback): TimerCallback {
  return function wrapped(this: unknown, ...args: unknown[]): void {
    const startedAt = performance.now();
    try {
      callback.apply(this, args);
    } finally {
      stats.fires += 1;
      stats.callbackMs += performance.now() - startedAt;
    }
  };
}

/**
 * Wrap `setTimeout` / `setInterval` / `setImmediate` on globalThis so every
 * scheduled timer is attributed to its creation site. Idempotent, and a no-op
 * unless `CYBOFLOW_PERF_TRACE=1`.
 */
export function installTimerCensus(): void {
  if (!TRACE_ENABLED || installed) return;
  installed = true;

  const globals = globalThis as unknown as {
    setTimeout: typeof setTimeout;
    setInterval: typeof setInterval;
    setImmediate: typeof setImmediate;
  };

  const realSetTimeout = globals.setTimeout;
  const realSetInterval = globals.setInterval;
  const realSetImmediate = globals.setImmediate;

  // The wrappers deliberately forward to the real builtin and return its handle
  // untouched, so `unref()` / `clearInterval()` / Timeout identity all keep
  // working exactly as before — the census only observes.
  const wrapScheduler = (
    real: typeof setTimeout | typeof setInterval,
    kind: 'timeout' | 'interval',
  ) =>
    function scheduled(callback: TimerCallback, ms?: number, ...args: unknown[]) {
      const site = callSite();
      const stats = statsFor(site, kind);
      stats.created += 1;
      stats.minDelayMs = Math.min(stats.minDelayMs, ms ?? 0);
      return (real as (cb: TimerCallback, ms?: number, ...rest: unknown[]) => NodeJS.Timeout)(
        countingWrapper(stats, callback),
        ms,
        ...args,
      );
    };

  const wrappedTimeout = wrapScheduler(realSetTimeout, 'timeout');
  const wrappedInterval = wrapScheduler(realSetInterval, 'interval');
  carryOwnSymbols(wrappedTimeout, realSetTimeout);
  carryOwnSymbols(wrappedInterval, realSetInterval);
  globals.setTimeout = wrappedTimeout as typeof setTimeout;
  globals.setInterval = wrappedInterval as typeof setInterval;

  // Same reason as carryOwnSymbols' guard: no setImmediate on this host, so
  // there is nothing to wrap and nothing to attribute.
  if (typeof realSetImmediate !== 'function') return;

  const wrappedImmediate = function scheduledImmediate(callback: TimerCallback, ...args: unknown[]) {
    const site = callSite();
    const stats = statsFor(site, 'immediate');
    stats.created += 1;
    stats.minDelayMs = 0;
    return realSetImmediate(
      countingWrapper(stats, callback) as unknown as (...a: unknown[]) => void,
      ...args,
    );
  };
  carryOwnSymbols(wrappedImmediate, realSetImmediate);
  globals.setImmediate = wrappedImmediate as unknown as typeof setImmediate;
}

/** One reported row, richest-first by fire count. */
export interface TimerCensusRow {
  site: string;
  kind: SiteStats['kind'];
  created: number;
  fires: number;
  callbackMs: number;
  minDelayMs: number;
}

/**
 * Drain the census into a sorted snapshot and reset the per-interval counters.
 * Sites are kept (not deleted) so a long-lived interval keeps its identity
 * across reports; only the counters reset.
 *
 * Returns EVERY site, deliberately. Truncating here would corrupt the headline
 * wakeup rate: the counters are reset for all sites but only the returned rows
 * are summable, so a slice would silently under-report exactly when the process
 * is busiest (many sites firing) — i.e. it would bias the measurement in the
 * flattering direction. {@link formatTimerCensus} truncates for DISPLAY only.
 */
export function drainTimerCensus(): TimerCensusRow[] {
  const rows: TimerCensusRow[] = [];
  for (const [site, stats] of sites) {
    if (stats.fires === 0 && stats.created === 0) continue;
    rows.push({
      site,
      kind: stats.kind,
      created: stats.created,
      fires: stats.fires,
      callbackMs: Number(stats.callbackMs.toFixed(1)),
      minDelayMs: Number.isFinite(stats.minDelayMs) ? stats.minDelayMs : 0,
    });
    stats.created = 0;
    stats.fires = 0;
    stats.callbackMs = 0;
  }
  rows.sort((a, b) => b.fires - a.fires);
  return rows;
}

/**
 * Format a census snapshot as a single log-friendly line, showing only the
 * busiest `limit` sites (the tail is noise) plus a count of what was elided —
 * silent truncation would read as "these are all the timers" when they are not.
 */
export function formatTimerCensus(rows: TimerCensusRow[], limit = 8): string {
  if (rows.length === 0) return '(no timers)';
  const shown = rows.slice(0, limit);
  const elided = rows.length - shown.length;
  return shown
    .map(
      (row) =>
        `${row.site}[${row.kind === 'interval' ? 'iv' : row.kind === 'timeout' ? 'to' : 'im'}@${row.minDelayMs}ms]=` +
        `${row.fires}x/${row.callbackMs}ms`,
    )
    .join(' ') + (elided > 0 ? ` (+${elided} more sites)` : '');
}

/** Test-only: drop all recorded sites so cases do not leak into each other. */
export function _resetTimerCensusForTesting(): void {
  sites.clear();
}

/** Whether the census is active this process. */
export function timerCensusEnabled(): boolean {
  return TRACE_ENABLED;
}

/** Expose the logger type for the tracer's use. */
export type { CensusLogger };
