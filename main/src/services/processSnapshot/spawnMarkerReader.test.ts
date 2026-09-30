import { describe, it, expect } from 'vitest';
import {
  createSpawnMarkerReader,
  parseMarkerFromCommandLine,
  parseMarkerFromEnviron,
  parseMarkersFromPsEnv,
} from './spawnMarkerReader';

describe('parseMarkerFromCommandLine', () => {
  it('reads instance and a worktree path containing spaces', () => {
    const tail = 'node -e x FOO=bar CYBOFLOW_INSTANCE=abc-123 CYBOFLOW_WORKTREE=/tmp/my wt/x PATH=/usr/bin';
    expect(parseMarkerFromCommandLine(tail)).toEqual({ instanceId: 'abc-123', worktree: '/tmp/my wt/x' });
  });
  it('worktree at end of line', () => {
    expect(parseMarkerFromCommandLine('a CYBOFLOW_INSTANCE=i CYBOFLOW_WORKTREE=/wt')).toEqual({
      instanceId: 'i',
      worktree: '/wt',
    });
  });
  it('null without an instance key (worktree alone is not a marker)', () => {
    expect(parseMarkerFromCommandLine('a CYBOFLOW_WORKTREE=/wt')).toBeNull();
    expect(parseMarkerFromCommandLine('a NOT_CYBOFLOW_INSTANCE=x')).toBeNull();
  });
});

describe('parseMarkersFromPsEnv', () => {
  it('maps only marked pids, skipping junk lines', () => {
    const out = parseMarkersFromPsEnv(
      ['  11 a CYBOFLOW_INSTANCE=i1 CYBOFLOW_WORKTREE=/w1', '12 plain FOO=1', 'garbage'].join('\n'),
    );
    expect([...out.keys()]).toEqual([11]);
    expect(out.get(11)).toEqual({ instanceId: 'i1', worktree: '/w1' });
  });
});

describe('parseMarkerFromEnviron', () => {
  it('parses NUL-separated environ exactly', () => {
    const blob = ['A=1', 'CYBOFLOW_INSTANCE=i2', 'CYBOFLOW_WORKTREE=/a b/c', ''].join('\0');
    expect(parseMarkerFromEnviron(blob)).toEqual({ instanceId: 'i2', worktree: '/a b/c' });
    expect(parseMarkerFromEnviron('A=1\0')).toBeNull();
  });
});

describe('createSpawnMarkerReader', () => {
  const rows = [{ pid: 5 }, { pid: 6 }];

  it('darwin: one ps spawn for all pids', async () => {
    const calls: number[][] = [];
    const read = createSpawnMarkerReader({
      platform: 'darwin',
      runPs: async (pids) => {
        calls.push([...pids]);
        return '5 x CYBOFLOW_INSTANCE=i CYBOFLOW_WORKTREE=/w\n6 y\n';
      },
    });
    const out = await read(rows);
    expect(calls).toEqual([[5, 6]]);
    expect(out.get(5)).toEqual({ instanceId: 'i', worktree: '/w' });
    expect(out.has(6)).toBe(false);
  });

  it('linux: reads per-pid environ, unreadable pids omitted', async () => {
    const read = createSpawnMarkerReader({
      platform: 'linux',
      readEnviron: async (pid) => (pid === 5 ? 'CYBOFLOW_INSTANCE=i\0' : null),
    });
    const out = await read(rows);
    expect(out.get(5)).toEqual({ instanceId: 'i', worktree: null });
    expect(out.size).toBe(1);
  });

  it('win32: never spawns, never marks', async () => {
    const read = createSpawnMarkerReader({
      platform: 'win32',
      runPs: async () => {
        throw new Error('must not spawn');
      },
    });
    expect((await read(rows)).size).toBe(0);
  });

  it('fails soft when ps throws', async () => {
    const read = createSpawnMarkerReader({
      platform: 'darwin',
      runPs: async () => {
        throw new Error('boom');
      },
    });
    expect((await read(rows)).size).toBe(0);
  });
});
