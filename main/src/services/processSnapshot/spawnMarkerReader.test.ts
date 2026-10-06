import { describe, it, expect, vi, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import {
  createSpawnMarkerReader,
  parseMarkerFromEnviron,
  parseMarkerFromPsEnv,
  parsePsPidCommand,
} from './spawnMarkerReader';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile), spawn: vi.fn(actual.spawn) };
});

afterEach(() => {
  vi.mocked(childProcess.execFile).mockClear();
  vi.mocked(childProcess.spawn).mockClear();
});

describe('parseMarkerFromEnviron', () => {
  it('parses NUL-separated environ exactly', () => {
    const blob = ['A=1', 'CYBOFLOW_INSTANCE=i2', 'CYBOFLOW_WORKTREE=/a b/c', ''].join('\0');
    expect(parseMarkerFromEnviron(blob)).toEqual({ instanceId: 'i2', worktree: '/a b/c' });
    expect(parseMarkerFromEnviron('A=1\0')).toBeNull();
  });

  it('marker text inside a command-like string is not a marker', () => {
    // Spoofed argv: the marker sits inside one entry, not as its own entry.
    const blob = ['PATH=/usr/bin', 'node -e x CYBOFLOW_INSTANCE=dead-id CYBOFLOW_WORKTREE=/w', ''].join('\0');
    expect(parseMarkerFromEnviron(blob)).toBeNull();
    // Proof of failure: a real NUL-separated entry does yield a marker.
    const real = ['PATH=/usr/bin', 'CYBOFLOW_INSTANCE=dead-id', ''].join('\0');
    expect(parseMarkerFromEnviron(real)).toEqual({ instanceId: 'dead-id', worktree: null });
  });
});

describe('createSpawnMarkerReader', () => {
  const row = (pid: number) => ({ pid, ppid: 1, command: 'node x.js', etimeSeconds: 10 });
  const rows = [row(5), row(6)];

  it('win32: empty map and zero spawn calls', async () => {
    const readEnviron = vi.fn(async () => 'CYBOFLOW_INSTANCE=i\0');
    const read = createSpawnMarkerReader({ platform: 'win32', readEnviron });
    expect((await read(rows)).size).toBe(0);
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(readEnviron).not.toHaveBeenCalled();
  });

  it('linux: reads per-pid environ, unreadable pids omitted, no subprocess', async () => {
    const read = createSpawnMarkerReader({
      platform: 'linux',
      readEnviron: async (pid) => (pid === 5 ? 'CYBOFLOW_INSTANCE=i\0' : null),
    });
    const out = await read(rows);
    expect(out.get(5)).toEqual({ instanceId: 'i', worktree: null });
    expect(out.size).toBe(1);
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('linux: argument-like entry does not yield a marker; a real entry does', async () => {
    const read = createSpawnMarkerReader({
      platform: 'linux',
      readEnviron: async (pid) =>
        pid === 5 ? 'node x CYBOFLOW_INSTANCE=dead\0' : 'CYBOFLOW_INSTANCE=dead\0',
    });
    const out = await read(rows);
    expect(out.has(5)).toBe(false);
    expect(out.get(6)).toEqual({ instanceId: 'dead', worktree: null });
  });

  it('linux: fails soft when the reader throws', async () => {
    const read = createSpawnMarkerReader({
      platform: 'linux',
      readEnviron: async () => {
        throw new Error('boom');
      },
    });
    expect((await read(rows)).size).toBe(0);
  });
});

describe('parseMarkerFromPsEnv', () => {
  it('reads space-separated entries, keeping spaces inside a value', () => {
    expect(
      parseMarkerFromPsEnv(' PATH=/usr/bin CYBOFLOW_WORKTREE=/a b/wt CYBOFLOW_INSTANCE=i1 HOME=/h'),
    ).toEqual({ instanceId: 'i1', worktree: '/a b/wt' });
    expect(parseMarkerFromPsEnv(' PATH=/usr/bin HOME=/h')).toBeNull();
    expect(parseMarkerFromPsEnv('')).toBeNull();
  });

  it('does not read a marker glued inside another token', () => {
    expect(parseMarkerFromPsEnv(' X=aCYBOFLOW_INSTANCE=i1')).toBeNull();
  });
});

describe('parsePsPidCommand', () => {
  it('maps pid to text and folds continuation lines', () => {
    const out = parsePsPidCommand('  12 node a.js\n345 python -c x\nsecond line\n');
    expect(out.get(12)).toBe('node a.js');
    expect(out.get(345)).toBe('python -c x\nsecond line');
  });
});

describe('createSpawnMarkerReader — darwin', () => {
  const MARKED = ' CYBOFLOW_INSTANCE=dead-1 CYBOFLOW_WORKTREE=/wt/a PATH=/usr/bin';

  function fakePs(env: Record<number, { argv: string; env: string }>) {
    return vi.fn(async (pids: readonly number[], withEnv: boolean) =>
      pids
        .filter((pid) => env[pid] !== undefined)
        .map((pid) => `${pid} ${env[pid].argv}${withEnv ? env[pid].env : ''}`)
        .join('\n'),
    );
  }

  it('reads only launchd children, strips argv, and returns their markers', async () => {
    const runPs = fakePs({
      5: { argv: 'node idle.js', env: MARKED },
      6: { argv: 'node other.js', env: ' PATH=/usr/bin' },
    });
    const read = createSpawnMarkerReader({ platform: 'darwin', runPs, now: () => 100_000 });
    const out = await read([
      { pid: 5, ppid: 1, command: 'node idle.js', etimeSeconds: 10 },
      { pid: 6, ppid: 1, command: 'node other.js', etimeSeconds: 10 },
      { pid: 7, ppid: 5, command: 'node child.js', etimeSeconds: 10 },
    ]);
    expect(out.get(5)).toEqual({ instanceId: 'dead-1', worktree: '/wt/a' });
    expect(out.size).toBe(1);
    expect(runPs).toHaveBeenCalledTimes(2);
    for (const call of runPs.mock.calls) expect(call[0]).toEqual([5, 6]);
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it('never reads a marker spelled inside argv', async () => {
    const argv = 'node x.js CYBOFLOW_INSTANCE=dead-1 CYBOFLOW_WORKTREE=/wt/a';
    const read = createSpawnMarkerReader({
      platform: 'darwin',
      runPs: fakePs({ 5: { argv, env: ' PATH=/usr/bin' } }),
    });
    expect((await read([{ pid: 5, ppid: 1, command: argv, etimeSeconds: 1 }])).size).toBe(0);
    // Proof of failure: the same marker in the environment IS read.
    const real = createSpawnMarkerReader({ platform: 'darwin', runPs: fakePs({ 5: { argv: 'node x.js', env: MARKED } }) });
    expect((await real([{ pid: 5, ppid: 1, command: 'node x.js', etimeSeconds: 1 }])).size).toBe(1);
  });

  it('caches per pid + command + start time, and re-reads a reused pid', async () => {
    let clock = 100_000;
    const runPs = fakePs({ 5: { argv: 'node idle.js', env: MARKED } });
    const read = createSpawnMarkerReader({ platform: 'darwin', runPs, now: () => clock });
    const r = { pid: 5, ppid: 1, command: 'node idle.js', etimeSeconds: 10 };

    expect((await read([r])).get(5)?.instanceId).toBe('dead-1');
    clock += 30_000;
    // Same process 30s later: served from cache, no ps.
    expect((await read([{ ...r, etimeSeconds: 40 }])).get(5)?.instanceId).toBe('dead-1');
    expect(runPs).toHaveBeenCalledTimes(2);

    // Same pid, new start time (pid reuse): read again.
    await read([{ ...r, etimeSeconds: 1 }]);
    expect(runPs).toHaveBeenCalledTimes(4);
  });

  it('does not cache a pid missing from the ps output, and fails soft on a ps error', async () => {
    const runPs = vi.fn(async () => '');
    const read = createSpawnMarkerReader({ platform: 'darwin', runPs });
    const r = { pid: 5, ppid: 1, command: 'node idle.js', etimeSeconds: 10 };
    await read([r]);
    await read([r]);
    expect(runPs).toHaveBeenCalledTimes(4);

    const failing = createSpawnMarkerReader({
      platform: 'darwin',
      runPs: async () => {
        throw new Error('boom');
      },
    });
    expect((await failing([r])).size).toBe(0);
  });

  it('starts no ps when no row is a launchd child', async () => {
    const runPs = vi.fn(async () => '');
    const read = createSpawnMarkerReader({ platform: 'darwin', runPs });
    await read([{ pid: 5, ppid: 77, command: 'node x', etimeSeconds: 1 }]);
    expect(runPs).not.toHaveBeenCalled();
  });
});
