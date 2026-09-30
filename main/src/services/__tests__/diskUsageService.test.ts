import { describe, it, expect, vi } from 'vitest';
import { DiskUsageService, parseDuSkOutput, DISK_USAGE_TTL_MS, type DuRunner } from '../diskUsageService';

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Deferred {
  path: string;
  resolve: (bytes: number) => void;
  reject: (err: Error) => void;
}

/** A fake `du` that records call order and in-flight concurrency; each call parks until the test settles it. */
function makeFakeRunner() {
  const calls: string[] = [];
  const pending: Deferred[] = [];
  let active = 0;
  let maxActive = 0;
  const runDu: DuRunner = (path) => {
    calls.push(path);
    active += 1;
    maxActive = Math.max(maxActive, active);
    return new Promise<number>((resolve, reject) => {
      pending.push({
        path,
        resolve: (bytes) => {
          active -= 1;
          resolve(bytes);
        },
        reject: (err) => {
          active -= 1;
          reject(err);
        },
      });
    });
  };
  const settle = async (path: string, bytes: number): Promise<void> => {
    const at = pending.findIndex((p) => p.path === path);
    if (at === -1) throw new Error(`no pending du for ${path}`);
    pending.splice(at, 1)[0].resolve(bytes);
    await flush();
  };
  return { runDu, calls, pending, settle, maxActive: () => maxActive };
}

function makeService(overrides: { ttlMs?: number } = {}) {
  const fake = makeFakeRunner();
  let clock = 1_000_000;
  const svc = new DiskUsageService({
    runDu: fake.runDu,
    now: () => clock,
    sleep: () => Promise.resolve(),
    ...overrides,
  });
  return { svc, fake, advance: (ms: number) => (clock += ms) };
}

describe('DiskUsageService', () => {
  it('a never-queried path reads queued (never a value) and triggers a measurement', async () => {
    const { svc, fake } = makeService();
    const first = svc.getUsage('/wt/a');
    expect(first).toEqual({ status: 'queued' });
    expect('bytes' in first).toBe(false);
    await flush();
    expect(fake.calls).toEqual(['/wt/a']);
    expect(svc.getUsage('/wt/a')).toEqual({ status: 'measuring' });
    await fake.settle('/wt/a', 2048);
    expect(svc.getUsage('/wt/a')).toMatchObject({ status: 'measured', bytes: 2048 });
  });

  it('a measured 0-byte path is still status measured (value and status are distinct)', async () => {
    const { svc, fake } = makeService();
    svc.getUsage('/wt/empty');
    await flush();
    await fake.settle('/wt/empty', 0);
    expect(svc.getUsage('/wt/empty')).toMatchObject({ status: 'measured', bytes: 0 });
  });

  it('never runs two du at once, and measures in request order', async () => {
    const { svc, fake } = makeService();
    svc.getUsage('/wt/a');
    svc.getUsage('/wt/b');
    svc.getUsage('/wt/c');
    await flush();
    expect(fake.calls).toEqual(['/wt/a']);
    await fake.settle('/wt/a', 1);
    expect(fake.calls).toEqual(['/wt/a', '/wt/b']);
    await fake.settle('/wt/b', 1);
    await fake.settle('/wt/c', 1);
    expect(fake.calls).toEqual(['/wt/a', '/wt/b', '/wt/c']);
    expect(fake.maxActive()).toBe(1);
  });

  it('negative control: the concurrency tracker DOES see >1 when calls are not serialized', async () => {
    const fake = makeFakeRunner();
    void Promise.all(['/wt/a', '/wt/b', '/wt/c'].map((p) => fake.runDu(p)));
    expect(fake.maxActive()).toBe(3);
  });

  it('reads queued for waiting paths and measuring only for the in-flight one', async () => {
    const { svc, fake } = makeService();
    svc.getUsage('/wt/a');
    svc.getUsage('/wt/b');
    await flush();
    expect(svc.getUsage('/wt/a')).toEqual({ status: 'measuring' });
    expect(svc.getUsage('/wt/b')).toEqual({ status: 'queued' });
    await fake.settle('/wt/a', 1);
    await fake.settle('/wt/b', 1);
  });

  it('re-measures once the TTL has expired, with no stale fallback', async () => {
    const { svc, fake, advance } = makeService();
    svc.getUsage('/wt/a');
    await flush();
    await fake.settle('/wt/a', 1024);
    advance(DISK_USAGE_TTL_MS - 1);
    expect(svc.getUsage('/wt/a')).toMatchObject({ status: 'measured', bytes: 1024 });
    expect(fake.calls).toHaveLength(1);
    advance(1);
    expect(svc.getUsage('/wt/a')).toEqual({ status: 'queued' });
    await flush();
    expect(fake.calls).toEqual(['/wt/a', '/wt/a']);
    await fake.settle('/wt/a', 4096);
    expect(svc.getUsage('/wt/a')).toMatchObject({ status: 'measured', bytes: 4096 });
  });

  it('invalidate(path) forces a re-measure inside the TTL window', async () => {
    const { svc, fake } = makeService();
    svc.getUsage('/wt/a');
    await flush();
    await fake.settle('/wt/a', 1024);
    expect(svc.getUsage('/wt/a').status).toBe('measured');
    svc.invalidate('/wt/a');
    expect(svc.getUsage('/wt/a')).toEqual({ status: 'queued' });
    await flush();
    expect(fake.calls).toEqual(['/wt/a', '/wt/a']);
  });

  it('a result that lands after invalidate() is discarded', async () => {
    const { svc, fake } = makeService();
    svc.getUsage('/wt/a');
    await flush();
    svc.invalidate('/wt/a');
    await fake.settle('/wt/a', 999);
    // The pre-invalidation number must not resurface as "measured".
    expect(svc.getUsage('/wt/a')).toEqual({ status: 'queued' });
    await flush();
    expect(fake.calls).toEqual(['/wt/a', '/wt/a']);
  });

  it('requestFresh(path) measures ahead of the TTL-queued backlog', async () => {
    const { svc, fake } = makeService();
    svc.getUsage('/wt/a');
    svc.getUsage('/wt/b');
    svc.getUsage('/wt/c');
    svc.getUsage('/wt/d');
    await flush();
    expect(fake.calls).toEqual(['/wt/a']);
    expect(svc.requestFresh('/wt/d')).toEqual({ status: 'queued' });
    await fake.settle('/wt/a', 1);
    await fake.settle('/wt/d', 1);
    await fake.settle('/wt/b', 1);
    await fake.settle('/wt/c', 1);
    expect(fake.calls).toEqual(['/wt/a', '/wt/d', '/wt/b', '/wt/c']);
    expect(fake.maxActive()).toBe(1);
  });

  it('requestFresh on a fresh cached entry discards it and re-measures first', async () => {
    const { svc, fake } = makeService();
    svc.getUsage('/wt/a');
    await flush();
    await fake.settle('/wt/a', 1);
    svc.getUsage('/wt/b');
    svc.getUsage('/wt/c');
    await flush();
    svc.requestFresh('/wt/a');
    expect(svc.getUsage('/wt/a').status).toBe('queued');
    await fake.settle('/wt/b', 1);
    await fake.settle('/wt/a', 2);
    await fake.settle('/wt/c', 1);
    expect(fake.calls).toEqual(['/wt/a', '/wt/b', '/wt/a', '/wt/c']);
  });

  it('requestFresh while the path is in flight re-measures it next, keeping the newer number', async () => {
    const { svc, fake } = makeService();
    svc.getUsage('/wt/a');
    svc.getUsage('/wt/b');
    await flush();
    expect(svc.requestFresh('/wt/a')).toEqual({ status: 'measuring' });
    await fake.settle('/wt/a', 111); // predates the request — discarded, re-measured ahead of b
    expect(svc.getUsage('/wt/a')).toEqual({ status: 'measuring' });
    await fake.settle('/wt/a', 222);
    await fake.settle('/wt/b', 1);
    expect(fake.calls).toEqual(['/wt/a', '/wt/a', '/wt/b']);
    expect(svc.getUsage('/wt/a')).toMatchObject({ status: 'measured', bytes: 222 });
  });

  it('measures node_modules-containing paths like any other', async () => {
    const { svc, fake } = makeService();
    const path = '/repo/worktrees/wt-a/node_modules/.pnpm/foo';
    svc.getUsage(path);
    await flush();
    expect(fake.calls).toEqual([path]);
    await fake.settle(path, 1024 * 1024);
    expect(svc.getUsage(path)).toMatchObject({ status: 'measured', bytes: 1024 * 1024 });
  });

  it('a failing du never throws, is logged, and is retried only after the backoff', async () => {
    const warn = vi.fn();
    const fake = makeFakeRunner();
    let clock = 0;
    const svc = new DiskUsageService({
      runDu: fake.runDu,
      now: () => clock,
      sleep: () => Promise.resolve(),
      failureBackoffMs: 1000,
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    });
    svc.getUsage('/gone');
    await flush();
    fake.pending[0].reject(new Error('du: /gone: No such file or directory'));
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(svc.getUsage('/gone')).toEqual({ status: 'queued' });
    await flush();
    expect(fake.calls).toEqual(['/gone']); // still inside the backoff
    clock += 1000;
    svc.getUsage('/gone');
    await flush();
    expect(fake.calls).toEqual(['/gone', '/gone']);
    await fake.settle('/gone', 8);
  });
});

describe('parseDuSkOutput', () => {
  it('converts du -sk kilobytes to bytes', () => {
    expect(parseDuSkOutput('312\t/some/path\n')).toBe(312 * 1024);
    expect(parseDuSkOutput('0\t/empty\n')).toBe(0);
  });

  it('throws on unparseable output rather than yielding a bogus number', () => {
    expect(() => parseDuSkOutput('')).toThrow();
    expect(() => parseDuSkOutput('du: nope')).toThrow();
  });
});
