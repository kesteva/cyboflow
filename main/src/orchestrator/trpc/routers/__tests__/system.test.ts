/**
 * cyboflow.system sub-router (routers/system.ts): the safe fallback, delegation to
 * the injected provider + orch-socket getters + port probe, the AC-5 "no caller ⇒
 * zero ps/du" guarantee against the real services with counting seams, and the
 * standalone-typecheck import invariant.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { setSystemProvider, type SystemSnapshotProvider } from '../system';
import { createSystemSnapshotProvider } from '../../../../services/systemSnapshotProvider';
import { ProcessSnapshotService } from '../../../../services/processSnapshot/processSnapshotService';
import { DiskUsageService } from '../../../../services/diskUsageService';
import type { ProcessSnapshotRow } from '../../../../services/processTable';
import type { WorktreeMonitorRegistryEntry } from '../worktreeMonitor';
import type { SystemProcessEntry } from '../../../systemTypes';

const caller = () => appRouter.createCaller(createContext()).cyboflow.system;

afterEach(() => setSystemProvider(null));

describe('cyboflow.system wiring', () => {
  it('is registered on the appRouter next to the unrelated monitor router', () => {
    const root = appRouter.createCaller(createContext()).cyboflow;
    expect(typeof root.system.snapshot).toBe('function');
    expect(root.monitor).toBeDefined();
  });

  it('resolves a starting fallback — never throws — when no provider was set', async () => {
    const snap = await caller().snapshot({ projectId: 1 });
    expect(snap.status).toBe('starting');
    expect(snap.processes).toEqual([]);
    expect(snap.worktrees).toEqual([]);
    expect(snap.ports.orchSocket).toEqual({ connectionCount: 0, runBindings: {} });
    expect(snap.ports.devRenderer).toMatchObject({ port: 4521, inUse: false });
    expect(snap.ports.cdp).toMatchObject({ port: 9223, inUse: false });
  });
});

const WORKTREE: WorktreeMonitorRegistryEntry = {
  path: '/wt/a',
  branch: 'a',
  tag: 'session-owned',
  prunable: true,
  sessionId: 's1',
};
const PROCESS: SystemProcessEntry = {
  bucket: 'owned',
  processType: 'claude-cli',
  command: 'claude',
  worktreePath: '/wt/a',
  pid: 10,
  ppid: 1,
  pcpu: 1,
  pmem: 2,
  etimeSeconds: 3,
  owner: { kind: 'cli', panelId: 'p', sessionId: 's1' },
};

describe('cyboflow.system.snapshot — delegation', () => {
  it('composes process + worktree/disk + ports/sockets data in one call', async () => {
    const probe = vi.fn(async (port: number, label: string) => ({ port, label, inUse: port === 9223 }));
    const provider: SystemSnapshotProvider = {
      loadWorktrees: vi.fn(async () => [WORKTREE]),
      getDiskUsage: vi.fn(() => ({ status: 'measuring' as const })),
      loadProcesses: vi.fn(async () => [PROCESS]),
      orchSocket: {
        getConnectionCount: vi.fn(() => 3),
        getRunBindingCounts: vi.fn(() => ({ 'run-1': 2 })),
      },
      probePort: probe,
    };
    setSystemProvider(provider);

    const snap = await caller().snapshot({ projectId: 7 });

    expect(provider.loadWorktrees).toHaveBeenCalledWith(7);
    expect(provider.loadProcesses).toHaveBeenCalledWith(new Set(['/wt/a']));
    expect(provider.getDiskUsage).toHaveBeenCalledWith('/wt/a');
    expect(snap.status).toBe('ready');
    expect(snap.processes).toEqual([PROCESS]);
    expect(snap.worktrees).toEqual([{ ...WORKTREE, usage: { status: 'measuring' } }]);
    expect(snap.ports).toEqual({
      devRenderer: { port: 4521, label: 'dev renderer', inUse: false },
      cdp: { port: 9223, label: 'CDP', inUse: true },
      orchSocket: { connectionCount: 3, runBindings: { 'run-1': 2 } },
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('cyboflow.system.snapshot — AC-5: no caller ⇒ zero ps/du', () => {
  function build() {
    const listProcesses = vi.fn(async (): Promise<ProcessSnapshotRow[]> => [
      { pid: 10, ppid: 1, pcpu: 1, pmem: 1, etimeSeconds: 5, command: 'claude' },
      { pid: 11, ppid: 1, pcpu: 0, pmem: 0, etimeSeconds: 9, command: '/usr/bin/other' },
    ]);
    const runDu = vi.fn(async () => 4096);
    const disk = new DiskUsageService({ runDu, sleep: async () => {} });
    const processSnapshot = new ProcessSnapshotService({
      listProcesses,
      cliManager: {
        listOwnedProcesses: () => [
          { pid: 10, provider: 'claude', panelId: 'p', sessionId: 's1', worktreePath: '/wt/a' },
        ],
      },
      runShellManager: { listOwnedShells: () => [] },
    });
    const provider = createSystemSnapshotProvider({
      processSnapshot,
      worktrees: {
        loadRegistry: async (): Promise<WorktreeMonitorRegistryEntry[]> => [
          { ...WORKTREE, path: '/wt/a' },
          { ...WORKTREE, path: '/wt/b', tag: 'orphan', prunable: true },
        ],
        getDiskUsage: (p) => disk.getUsage(p),
      },
      orchSocket: { getConnectionCount: () => 0, getRunBindingCounts: () => ({}) },
      readInstanceRecords: async () => [],
      getSelfInstanceId: () => 'self',
      probePort: async (port: number, label: string) => ({ port, label, inUse: false }),
    });
    return { provider, listProcesses, runDu };
  }

  it('mounted but never called: the ps and du seams stay at zero', async () => {
    const { provider, listProcesses, runDu } = build();
    setSystemProvider(provider);
    await new Promise((r) => setTimeout(r, 20));
    expect(listProcesses).not.toHaveBeenCalled();
    expect(runDu).not.toHaveBeenCalled();
  });

  it('one snapshot() runs ps once and du at most once per worktree path', async () => {
    const { provider, listProcesses, runDu } = build();
    setSystemProvider(provider);

    const snap = await caller().snapshot({ projectId: 1 });
    await vi.waitFor(() => expect(runDu).toHaveBeenCalledTimes(2));

    expect(listProcesses).toHaveBeenCalledTimes(1);
    const measured = runDu.mock.calls.map((c) => (c as unknown[])[0]).sort();
    expect(measured).toEqual(['/wt/a', '/wt/b']);
    // First read is queued/measuring — never a bare number.
    for (const w of snap.worktrees) expect(['queued', 'measuring']).toContain(w.usage.status);
    expect(snap.processes.map((p) => p.bucket).sort()).toEqual(['foreign', 'owned']);
  });
});

describe('system.ts standalone-typecheck invariant', () => {
  it('imports no electron, better-sqlite3, or main/src/services modules', () => {
    const src = readFileSync(join(__dirname, '..', 'system.ts'), 'utf8');
    const specs = [...src.matchAll(/^import[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) {
      expect(spec).not.toMatch(/^electron$|better-sqlite3|services\//);
    }
  });
});
