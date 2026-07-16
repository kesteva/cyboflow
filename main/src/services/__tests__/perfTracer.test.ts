/**
 * PerfTracer tests — the opt-in main-process CPU/attribution sampler.
 *
 * TRACE_ENABLED is read from the env at module load, so each scenario resets the
 * module registry and re-imports with the env pre-set.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const OLD_TRACE = process.env.CYBOFLOW_PERF_TRACE;
const OLD_MS = process.env.CYBOFLOW_PERF_TRACE_MS;

afterEach(() => {
  process.env.CYBOFLOW_PERF_TRACE = OLD_TRACE;
  process.env.CYBOFLOW_PERF_TRACE_MS = OLD_MS;
  vi.useRealTimers();
  vi.resetModules();
});

describe('perfTracer (disabled)', () => {
  it('startPerfTracer returns null and perfBump is a no-op', async () => {
    process.env.CYBOFLOW_PERF_TRACE = '0';
    vi.resetModules();
    const mod = await import('../perfTracer');
    const logs: string[] = [];
    expect(mod.startPerfTracer({ info: (m) => logs.push(m) })).toBeNull();
    // Must not throw and must emit nothing when tracing is off.
    mod.perfBump('raw.codex', 5);
    expect(logs).toHaveLength(0);
  });
});

describe('perfTracer (enabled)', () => {
  it('emits a periodic line carrying per-interval seam counters, then resets them', async () => {
    process.env.CYBOFLOW_PERF_TRACE = '1';
    process.env.CYBOFLOW_PERF_TRACE_MS = '1000';
    vi.resetModules();
    vi.useFakeTimers();
    const mod = await import('../perfTracer');

    const logs: string[] = [];
    const tracer = mod.startPerfTracer({ info: (m) => logs.push(m) });
    expect(tracer).not.toBeNull();
    expect(logs.some((l) => l.includes('tracer started'))).toBe(true);

    mod.perfBump('raw.codex', 3);
    mod.perfBump('git.status.refresh');
    vi.advanceTimersByTime(1000);

    const firstTick = logs.find((l) => l.includes('elu='));
    expect(firstTick).toBeDefined();
    expect(firstTick).toContain('raw.codex=3');
    expect(firstTick).toContain('git.status.refresh=1');

    // Counters are drained each tick: a subsequent bump-free interval shows (none).
    vi.advanceTimersByTime(1000);
    const tickLines = logs.filter((l) => l.includes('elu='));
    expect(tickLines[tickLines.length - 1]).toContain('(none)');

    tracer?.stop();
  });

  it('orders seam counters by descending count', async () => {
    process.env.CYBOFLOW_PERF_TRACE = '1';
    process.env.CYBOFLOW_PERF_TRACE_MS = '1000';
    vi.resetModules();
    vi.useFakeTimers();
    const mod = await import('../perfTracer');

    const logs: string[] = [];
    const tracer = mod.startPerfTracer({ info: (m) => logs.push(m) });
    mod.perfBump('raw.claude', 2);
    mod.perfBump('raw.codex', 9);
    vi.advanceTimersByTime(1000);

    const tick = logs.find((l) => l.includes('elu='))!;
    expect(tick.indexOf('raw.codex=9')).toBeLessThan(tick.indexOf('raw.claude=2'));
    tracer?.stop();
  });
});
