import { describe, it, expect } from 'vitest';
import { createSystemSnapshotProvider, toSystemProcessEntry } from '../systemSnapshotProvider';
import type { SnapshottedProcess } from '../processSnapshot/processSnapshotService';

const proc = (pid: number, command: string, owner: SnapshottedProcess['owner'] = null): SnapshottedProcess => ({
  pid,
  ppid: 1,
  pcpu: 1,
  pmem: 2,
  etimeSeconds: 3,
  command,
  processType: 'unknown',
  worktreePath: null,
  owner,
});

function build(rows: SnapshottedProcess[], over: Partial<Parameters<typeof createSystemSnapshotProvider>[0]> = {}) {
  return createSystemSnapshotProvider({
    processSnapshot: { snapshot: async () => rows },
    worktrees: { loadRegistry: async () => [], getDiskUsage: () => ({ status: 'queued' }) },
    orchSocket: { getConnectionCount: () => 0, getRunBindingCounts: () => ({}) },
    readInstanceRecords: async () => [],
    getSelfInstanceId: () => 'self',
    ...over,
  });
}

describe('createSystemSnapshotProvider.loadProcesses', () => {
  it('classifies via the registry path set and the instance liveness records', async () => {
    const rows = [
      proc(10, 'claude', { kind: 'cli', panelId: 'p', sessionId: 's' }),
      proc(20, 'node server --cwd /wt/known'),
      proc(30, '/usr/bin/unrelated'),
      proc(40, 'orphaned-child'),
    ];
    const provider = build(rows, {
      readInstanceRecords: async () => [{ instanceId: 'dead', pid: 999_999, startedAt: '' }],
      isPidAlive: () => false,
      readMarkers: async () => new Map([[40, { instanceId: 'dead', worktree: '/wt/known' }]]),
    });

    const out = await provider.loadProcesses(new Set(['/wt/known']));
    const bucket = (pid: number) => out.find((p) => 'pid' in p && p.pid === pid)?.bucket;
    expect(bucket(10)).toBe('owned');
    expect(bucket(20)).toBe('suspected');
    expect(bucket(40)).toBe('orphan');
    expect(out.filter((p) => p.bucket === 'foreign')).toHaveLength(1);
  });

  it('without any marker reader nothing can be an orphan', async () => {
    const out = await build([proc(40, 'orphaned-child')]).loadProcesses(new Set());
    expect(out.map((p) => p.bucket)).not.toContain('orphan');
  });

  it('foreign wire entries carry no number-typed field (no pid to kill)', async () => {
    const [foreign] = await build([proc(30, '/usr/bin/unrelated')]).loadProcesses(new Set());
    expect(foreign.bucket).toBe('foreign');
    for (const value of Object.values(foreign)) expect(typeof value).not.toBe('number');
    expect(foreign).not.toHaveProperty('pid');
  });

  it('only orphans are marked sweepEligible', () => {
    const base = proc(1, 'x');
    const entry = toSystemProcessEntry({
      bucket: 'orphan',
      sweepEligible: true,
      process: base,
      instanceId: 'dead',
      processType: 'unknown',
      command: 'x',
      worktreePath: null,
      pcpu: 1,
      pmem: 2,
      etimeSeconds: 3,
    });
    expect(entry).toMatchObject({ bucket: 'orphan', sweepEligible: true, pid: 1 });
  });
});
