/**
 * PerfTracer — an opt-in, low-overhead main-process CPU/attribution sampler.
 *
 * Motivation: the Electron main process can burn CPU in bursts that a point-in-
 * time stack sample misses, and attributing it to a specific seam (codex raw-
 * event writes, codex app-server / probe spawns, git-status churn, …) is hard
 * without a time-series. This tracer logs one structured line every interval
 * with the two signals that actually attribute main-thread load —
 *
 *   - event-loop UTILIZATION (fraction of wall time the loop was on-CPU) and
 *     event-loop DELAY percentiles (how long callbacks were stalled), the gold-
 *     standard "is the main thread pegged, and is it starving?" pair, plus
 *   - process.cpuUsage() % (user+system across all threads — can exceed 100%),
 *     RSS / heapUsed, and
 *   - per-seam RATE COUNTERS that hot paths bump via `perfBump(name)`, printed
 *     as a per-interval delta then reset.
 *
 * Gating: fully OFF unless `CYBOFLOW_PERF_TRACE=1`. When off, `perfBump` is a
 * single boolean check (no Map write, no allocation) and `startPerfTracer` is a
 * no-op, so this costs nothing in normal runs. Interval defaults to 5000ms,
 * overridable via `CYBOFLOW_PERF_TRACE_MS`.
 *
 * Output goes through the injected logger, so it lands in cyboflow-backend-
 * debug.log under `pnpm dev` (the A/B harness) and the app log in a packaged
 * build — set the env var on a production launch to capture a real session.
 */
import {
  performance,
  monitorEventLoopDelay,
  type EventLoopUtilization,
  type IntervalHistogram,
} from 'node:perf_hooks';

/** Minimal logger surface — kept local so this module imports nothing heavy. */
interface PerfLogger {
  info(message: string): void;
}

const TRACE_ENABLED = process.env.CYBOFLOW_PERF_TRACE === '1';

function resolveIntervalMs(): number {
  const raw = Number(process.env.CYBOFLOW_PERF_TRACE_MS);
  return Number.isFinite(raw) && raw >= 250 ? raw : 5000;
}

// Module-level counter registry. Hot seams call `perfBump` unconditionally; the
// TRACE_ENABLED short-circuit keeps that free when tracing is off.
const counters = new Map<string, number>();

/**
 * Increment a named per-interval counter. A no-op (single boolean check) unless
 * `CYBOFLOW_PERF_TRACE=1`, so it is safe to call on the hottest paths.
 */
export function perfBump(name: string, n = 1): void {
  if (!TRACE_ENABLED) return;
  counters.set(name, (counters.get(name) ?? 0) + n);
}

/** Drain the counter registry into a sorted, reset snapshot. */
function drainCounters(): Array<[string, number]> {
  const snapshot = [...counters.entries()].filter(([, v]) => v > 0);
  counters.clear();
  snapshot.sort((a, b) => b[1] - a[1]);
  return snapshot;
}

const MS_PER_NS = 1e-6;

export class PerfTracer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private eluLast: EventLoopUtilization | null = null;
  private cpuLast: NodeJS.CpuUsage | null = null;
  private wallLastMs = 0;
  private eld: IntervalHistogram | null = null;

  constructor(private readonly logger: PerfLogger) {}

  start(): void {
    if (this.timer) return;
    this.eluLast = performance.eventLoopUtilization();
    this.cpuLast = process.cpuUsage();
    this.wallLastMs = performance.now();
    this.eld = monitorEventLoopDelay({ resolution: 20 });
    this.eld.enable();

    this.timer = setInterval(() => this.tick(), resolveIntervalMs());
    // Never keep the process alive on the tracer's account. Guarded because a
    // faked timer (tests) may return a bare handle without unref().
    (this.timer as { unref?: () => void }).unref?.();
    this.logger.info(
      `[perf] tracer started (interval=${resolveIntervalMs()}ms) — event-loop util + cpu% + seam counters`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.eld?.disable();
    this.eld = null;
  }

  private tick(): void {
    const nowMs = performance.now();
    const wallMs = Math.max(1, nowMs - this.wallLastMs);
    this.wallLastMs = nowMs;

    // Event-loop utilization delta since the last tick (fraction 0..1 on-CPU).
    const eluNow = performance.eventLoopUtilization();
    const eluDelta = this.eluLast
      ? performance.eventLoopUtilization(eluNow, this.eluLast)
      : eluNow;
    this.eluLast = eluNow;
    const eluPct = (eluDelta.utilization * 100).toFixed(1);

    // Whole-process CPU% over the interval (user+system, all threads).
    const cpu = process.cpuUsage(this.cpuLast ?? undefined);
    this.cpuLast = process.cpuUsage();
    const cpuPct = (((cpu.user + cpu.system) / 1000 / wallMs) * 100).toFixed(1);

    // Event-loop delay (callback scheduling lag) — mean / p99 / max in ms.
    const eldMean = this.eld ? (this.eld.mean * MS_PER_NS).toFixed(1) : 'n/a';
    const eldP99 = this.eld ? (this.eld.percentile(99) * MS_PER_NS).toFixed(1) : 'n/a';
    const eldMax = this.eld ? (this.eld.max * MS_PER_NS).toFixed(1) : 'n/a';
    this.eld?.reset();

    const mem = process.memoryUsage();
    const rssMb = Math.round(mem.rss / 1024 / 1024);
    const heapMb = Math.round(mem.heapUsed / 1024 / 1024);

    const seams = drainCounters();
    const seamStr = seams.length > 0
      ? seams.map(([k, v]) => `${k}=${v}`).join(' ')
      : '(none)';

    this.logger.info(
      `[perf] elu=${eluPct}% cpu=${cpuPct}% eld(mean/p99/max)=${eldMean}/${eldP99}/${eldMax}ms ` +
        `rss=${rssMb}mb heap=${heapMb}mb | ${seamStr}`,
    );
  }
}

/**
 * Construct + start the tracer when `CYBOFLOW_PERF_TRACE=1`, else return null.
 * The caller keeps the handle only to `stop()` it on shutdown (optional — the
 * interval is unref'd, so it never blocks quit).
 */
export function startPerfTracer(logger: PerfLogger): PerfTracer | null {
  if (!TRACE_ENABLED) return null;
  const tracer = new PerfTracer(logger);
  tracer.start();
  return tracer;
}
