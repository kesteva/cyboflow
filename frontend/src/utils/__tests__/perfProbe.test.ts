/**
 * perfProbe tests — the renderer-side longtask + React-commit sampler.
 *
 * PERF_PROBE_ENABLED is read once at module load, so each scenario sets the
 * localStorage toggle, resets the module registry, and re-imports.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('perfProbe (disabled)', () => {
  it('perfProbeStart is a no-op returning a callable teardown', async () => {
    localStorage.removeItem('cyboflow.perfTrace');
    vi.resetModules();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const mod = await import('../perfProbe');
    expect(mod.PERF_PROBE_ENABLED).toBe(false);
    const stop = mod.perfProbeStart();
    expect(typeof stop).toBe('function');
    stop();
    expect(info).not.toHaveBeenCalled();
  });
});

describe('perfProbe (enabled)', () => {
  it('logs a periodic line with React-commit areas sorted by cost, then resets', async () => {
    localStorage.setItem('cyboflow.perfTrace', '1');
    vi.resetModules();
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const mod = await import('../perfProbe');
    expect(mod.PERF_PROBE_ENABLED).toBe(true);

    const stop = mod.perfProbeStart();
    expect(info.mock.calls.some(([m]) => String(m).includes('renderer probe started'))).toBe(true);

    // Two subtree commits — rail cheaper than center.
    mod.perfOnRender('center', 'update', 12.3, 0, 0, 0);
    mod.perfOnRender('rail', 'update', 4, 0, 0, 0);
    vi.advanceTimersByTime(5000);

    const line = info.mock.calls.map(([m]) => String(m)).find((m) => m.includes('[perf-r] longtask'));
    expect(line).toBeDefined();
    // Areas present, sorted by descending total ms (center before rail).
    expect(line).toContain('center=1/12ms');
    expect(line).toContain('rail=1/4ms');
    expect(line!.indexOf('center=')).toBeLessThan(line!.indexOf('rail='));

    // Commit aggregates drain each tick — a bump-free interval shows (none).
    vi.advanceTimersByTime(5000);
    const lines = info.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('[perf-r] longtask'));
    expect(lines[lines.length - 1]).toContain('(none)');

    stop();
  });
});
