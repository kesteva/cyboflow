import { describe, it, expect, vi, afterEach } from 'vitest';
import type { HostRow } from '../../../orchestrator/hosts/hostStore';
import type { LoggerLike } from '../../../orchestrator/types';
import {
  HOST_PREFLIGHT_MAX_AGE_MS,
  PreflightScheduler,
  selectDueHosts,
  type PreflightSchedulerDeps,
} from '../preflightScheduler';
import { HOST_PREFLIGHT_SCHEDULE_KILL_SWITCH_ENV, REMOTE_HOSTS_KILL_SWITCH_ENV } from '../flags';

const NOW = new Date(Date.UTC(2026, 9, 9, 12, 0, 0));
const iso = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString();

function row(over: Partial<HostRow>): HostRow {
  return {
    id: 'h', label: 'h', kind: 'ssh', sshTarget: 'h', remoteRoot: '~/cf-remote/h', arch: null, osVersion: null,
    toolchainHash: null, detectedTier: 'cli', userCapTier: null, preflight: null, preflightAt: iso(1000),
    preflightAppVersion: '1.0.0', lifecycleState: 'online', lastSeenAt: null, archivedAt: null,
    createdAt: iso(0), updatedAt: iso(0), ...over,
  };
}

const logger = (): LoggerLike => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

describe('selectDueHosts', () => {
  it('picks SSH hosts older than 24 h, never probed, unparseable, or from another app version', () => {
    const hosts = [
      row({ id: 'local', kind: 'local', sshTarget: null, preflightAt: null }),
      row({ id: 'fresh' }),
      row({ id: 'just-under', preflightAt: iso(HOST_PREFLIGHT_MAX_AGE_MS - 1) }),
      row({ id: 'exactly-24h', preflightAt: iso(HOST_PREFLIGHT_MAX_AGE_MS) }),
      row({ id: 'old', preflightAt: iso(HOST_PREFLIGHT_MAX_AGE_MS * 3) }),
      row({ id: 'never', preflightAt: null, preflightAppVersion: null }),
      row({ id: 'garbage', preflightAt: 'not a date' }),
      row({ id: 'other-version', preflightAppVersion: '0.9.0' }),
      row({ id: 'archived', preflightAt: null, archivedAt: iso(0) }),
    ];
    expect(selectDueHosts(hosts, '1.0.0', NOW).map((h) => h.id)).toEqual([
      'exactly-24h', 'old', 'never', 'garbage', 'other-version',
    ]);
  });
});

describe('PreflightScheduler', () => {
  let sched: PreflightScheduler | null = null;
  afterEach(() => {
    sched?.stop();
    sched = null;
    vi.useRealTimers();
  });

  function make(over: Partial<PreflightSchedulerDeps> = {}) {
    const runPreflight = vi.fn(async (_id: string) => undefined);
    const deps: PreflightSchedulerDeps = {
      listHosts: () => [row({ id: 'a', preflightAt: null }), row({ id: 'b' }), row({ id: 'c', preflightAppVersion: 'old' })],
      runPreflight,
      appVersion: '1.0.0',
      isRunning: () => true,
      env: {},
      now: () => NOW,
      logger: logger(),
      ...over,
    };
    sched = new PreflightScheduler(deps);
    return { sched, runPreflight: (over.runPreflight as typeof runPreflight | undefined) ?? runPreflight, deps };
  }

  it('runs due hosts sequentially', async () => {
    const order: string[] = [];
    let active = 0;
    const runPreflight = vi.fn(async (id: string) => {
      active++;
      expect(active).toBe(1);
      order.push(id);
      await new Promise((r) => setTimeout(r, 1));
      active--;
    });
    const { sched: s } = make({ runPreflight });
    await s.tick();
    expect(order).toEqual(['a', 'c']);
  });

  it.each([
    ['schedule kill switch', { env: { [HOST_PREFLIGHT_SCHEDULE_KILL_SWITCH_ENV]: '1' } }],
    ['remote hosts kill switch', { env: { [REMOTE_HOSTS_KILL_SWITCH_ENV]: '1' } }],
    ['feature not running', { isRunning: () => false }],
  ])('does nothing under the %s', async (_n, over) => {
    const { sched: s, runPreflight } = make(over);
    await s.tick();
    expect(runPreflight).not.toHaveBeenCalled();
  });

  it('inFlight guard: an overlapping tick is a no-op', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const runPreflight = vi.fn(async () => { await gate; });
    const { sched: s } = make({ runPreflight });
    const first = s.tick();
    await s.tick();
    expect(runPreflight).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(runPreflight).toHaveBeenCalledTimes(2);
  });

  it('a failing host does not stop the tick; a throwing list is logged', async () => {
    const runPreflight = vi.fn(async (id: string) => { if (id === 'a') throw new Error('x'); });
    const { sched: s, deps } = make({ runPreflight });
    await s.tick();
    expect(runPreflight).toHaveBeenCalledTimes(2);
    expect(deps.logger.warn).toHaveBeenCalled();
    const { sched: s2, deps: d2 } = make({ listHosts: () => { throw new Error('db'); } });
    await expect(s2.tick()).resolves.toBeUndefined();
    expect(d2.logger.warn).toHaveBeenCalled();
  });

  it('start ticks immediately then hourly (unref’d); stop is idempotent and ends a running tick', async () => {
    vi.useFakeTimers();
    const { sched: s, runPreflight } = make({ intervalMs: 1000 });
    s.start();
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runPreflight).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runPreflight).toHaveBeenCalledTimes(4);
    s.stop();
    s.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runPreflight).toHaveBeenCalledTimes(4);
  });

  it('stop() between hosts ends the tick after the current host', async () => {
    const holder: { s: PreflightScheduler | null } = { s: null };
    const runPreflight = vi.fn(async () => { holder.s?.stop(); });
    const s = make({ runPreflight }).sched;
    holder.s = s;
    await s.tick();
    expect(runPreflight).toHaveBeenCalledTimes(1);
  });
});
