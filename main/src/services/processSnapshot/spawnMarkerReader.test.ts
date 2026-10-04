import { describe, it, expect, vi, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import { createSpawnMarkerReader, parseMarkerFromEnviron } from './spawnMarkerReader';

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
  const rows = [{ pid: 5 }, { pid: 6 }];

  it.each(['darwin', 'win32'] as const)('%s: empty map and zero spawn calls', async (platform) => {
    const readEnviron = vi.fn(async () => 'CYBOFLOW_INSTANCE=i\0');
    const read = createSpawnMarkerReader({ platform, readEnviron });
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
