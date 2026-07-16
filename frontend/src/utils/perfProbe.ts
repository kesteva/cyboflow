/**
 * Renderer-side perf probe — the counterpart to the main-process PerfTracer.
 *
 * The renderer was the steady CPU consumer in the codex-load investigation, so
 * this attributes renderer cost with the two signals that matter:
 *
 *   - LONG TASKS — a PerformanceObserver('longtask') accumulates every main-
 *     thread task >50ms (count / total / max ms per interval). High long-task
 *     time is the direct measure of a janky, CPU-bound renderer.
 *   - REACT COMMITS by area — <PerfProfiler id> (see PerfProfiler.tsx) wraps a
 *     subtree in React's <Profiler>; its onRender fires per commit with the
 *     subtree's actualDuration. Aggregated per id, this is the "which part of
 *     the UI is re-rendering, and how expensively" breakdown.
 *
 * Gating: OFF unless `import.meta.env.VITE_CYBOFLOW_PERF_TRACE === '1'` (launch
 * with `VITE_CYBOFLOW_PERF_TRACE=1 pnpm dev`) OR `localStorage['cyboflow.perfTrace']
 * === '1'` (flip in devtools + reload, no restart). When off, perfProbeStart is
 * a no-op and PerfProfiler is a transparent passthrough. Output goes to
 * console.info, which `pnpm dev` forwards to cyboflow-frontend-debug.log.
 */
import type { ProfilerOnRenderCallback } from 'react';

function resolveEnabled(): boolean {
  try {
    // (1) Forwarded from the main process by preload — a single
    // `CYBOFLOW_PERF_TRACE=1` at launch enables both the main tracer and this.
    const mainFlag =
      typeof window !== 'undefined' &&
      (window as unknown as { __cyboflowPerf?: { traceEnabled?: boolean } })
        .__cyboflowPerf?.traceEnabled === true;
    // (2) Vite build/serve env — `VITE_CYBOFLOW_PERF_TRACE=1 pnpm dev`.
    const viteFlag =
      (import.meta as unknown as { env?: Record<string, string | undefined> }).env
        ?.VITE_CYBOFLOW_PERF_TRACE === '1';
    // (3) Runtime toggle — flip in devtools + reload, no restart.
    const lsFlag =
      typeof localStorage !== 'undefined' &&
      localStorage.getItem('cyboflow.perfTrace') === '1';
    return mainFlag || viteFlag || lsFlag;
  } catch {
    return false;
  }
}

/** Whether the renderer probe is active this session (read once at load). */
export const PERF_PROBE_ENABLED = resolveEnabled();

const INTERVAL_MS = 5000;

interface CommitAgg {
  count: number;
  totalMs: number;
  maxMs: number;
}

const commits = new Map<string, CommitAgg>();
let longtaskCount = 0;
let longtaskTotalMs = 0;
let longtaskMaxMs = 0;
let started = false;

/** Aggregate one React commit for a Profiler-wrapped subtree. */
function recordCommit(id: string, actualDuration: number): void {
  const agg = commits.get(id) ?? { count: 0, totalMs: 0, maxMs: 0 };
  agg.count += 1;
  agg.totalMs += actualDuration;
  agg.maxMs = Math.max(agg.maxMs, actualDuration);
  commits.set(id, agg);
}

/** <Profiler onRender> handler shared by every PerfProfiler instance. */
export const perfOnRender: ProfilerOnRenderCallback = (id, _phase, actualDuration) => {
  recordCommit(id, actualDuration);
};

/** Read Chrome's non-standard JS heap size, if exposed. */
function jsHeapMb(): number | null {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  return typeof mem?.usedJSHeapSize === 'number'
    ? Math.round(mem.usedJSHeapSize / 1024 / 1024)
    : null;
}

/** Emit one per-interval line and reset the accumulators. */
function drainAndLog(): void {
  const lt = `longtask(count/total/max)=${longtaskCount}/${Math.round(longtaskTotalMs)}/${Math.round(longtaskMaxMs)}ms`;
  longtaskCount = 0;
  longtaskTotalMs = 0;
  longtaskMaxMs = 0;

  const heap = jsHeapMb();
  const heapStr = heap !== null ? ` jsHeap=${heap}mb` : '';

  const areas = [...commits.entries()]
    .filter(([, v]) => v.count > 0)
    .sort((a, b) => b[1].totalMs - a[1].totalMs)
    .map(([id, v]) => `${id}=${v.count}/${Math.round(v.totalMs)}ms`);
  commits.clear();
  const areaStr = areas.length > 0 ? areas.join(' ') : '(none)';

  // Intentional: console.info is forwarded to cyboflow-frontend-debug.log under
  // `pnpm dev` — the whole point of the probe is to land these lines there.
  // eslint-disable-next-line no-console
  console.info(`[perf-r] ${lt}${heapStr} | ${areaStr}`);
}

/**
 * Start the renderer probe (idempotent). Call once at app mount. A no-op unless
 * the probe is enabled. Returns a disconnect fn for unmount/testing.
 */
export function perfProbeStart(): () => void {
  if (!PERF_PROBE_ENABLED || started) return () => undefined;
  started = true;

  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longtaskCount += 1;
        longtaskTotalMs += entry.duration;
        longtaskMaxMs = Math.max(longtaskMaxMs, entry.duration);
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    // longtask not supported in this engine — commit aggregation still works.
    observer = null;
  }

  const timer = setInterval(drainAndLog, INTERVAL_MS);
  // eslint-disable-next-line no-console
  console.info('[perf-r] renderer probe started (longtask + Profiler commits)');

  return () => {
    clearInterval(timer);
    observer?.disconnect();
    started = false;
  };
}
