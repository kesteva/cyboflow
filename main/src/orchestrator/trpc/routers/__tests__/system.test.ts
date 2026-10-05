/**
 * cyboflow.system sub-router (routers/system.ts): the safe fallback, delegation to
 * the injected provider + orch-socket getters + port probe, the AC-5 "no caller ⇒
 * zero ps/du" guarantee against the real services with counting seams, and the
 * standalone-typecheck import invariant.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as childProcess from 'node:child_process';
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
import { createSpawnMarkerReader } from '../../../../services/processSnapshot/spawnMarkerReader';

// Passthrough wrappers so the AC-5 test can count every subprocess the provider starts.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile), spawn: vi.fn(actual.spawn) };
});

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
    expect(snap.ports.tcp).toEqual([]);
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

describe('cyboflow.system.snapshot — nested worktree disk usage', () => {
  const entry = (path: string, tag: WorktreeMonitorRegistryEntry['tag'] = 'orphan'): WorktreeMonitorRegistryEntry =>
    tag === 'is_main_repo'
      ? { path, branch: 'main', tag, prunable: false }
      : { path, branch: 'b', tag: 'orphan', prunable: true };
  const measured = (bytes: number) => ({ status: 'measured' as const, bytes, measuredAt: 1 });
  const providerFor = (sizes: Record<string, ReturnType<typeof measured> | { status: 'measuring' }>): SystemSnapshotProvider => ({
    loadWorktrees: async () => [
      entry('/repo', 'is_main_repo'),
      entry('/repo/worktrees/a'),
      entry('/repo/worktrees/b'),
      entry('/elsewhere/c'),
    ],
    getDiskUsage: (p) => sizes[p] ?? { status: 'queued' },
    loadProcesses: async () => [],
    orchSocket: { getConnectionCount: () => 0, getRunBindingCounts: () => ({}) },
    probePort: async (port, label) => ({ port, label, inUse: false }),
    // du sizing is POSIX-only; pin it so the win32 CI host measures too.
    platform: 'darwin',
  });

  it('subtracts the worktrees nested under a checkout so their bytes are counted once', async () => {
    setSystemProvider(
      providerFor({
        '/repo': measured(1000),
        '/repo/worktrees/a': measured(300),
        '/repo/worktrees/b': measured(200),
        '/elsewhere/c': measured(50),
      }),
    );
    const snap = await caller().snapshot({ projectId: 1 });
    const bytes = Object.fromEntries(
      snap.worktrees.map((w) => [w.path, w.usage.status === 'measured' ? w.usage.bytes : w.usage.status]),
    );
    expect(bytes).toEqual({ '/repo': 500, '/repo/worktrees/a': 300, '/repo/worktrees/b': 200, '/elsewhere/c': 50 });
  });

  it('keeps the parent measuring — never inflated — while a nested worktree is unmeasured', async () => {
    setSystemProvider(
      providerFor({ '/repo': measured(1000), '/repo/worktrees/a': measured(300), '/repo/worktrees/b': { status: 'measuring' } }),
    );
    const snap = await caller().snapshot({ projectId: 1 });
    expect(snap.worktrees.find((w) => w.path === '/repo')?.usage).toEqual({ status: 'measuring' });
  });
});

describe('cyboflow.system.snapshot — delegation', () => {
  it('composes process + worktree/disk + ports/sockets data in one call', async () => {
    const probe = vi.fn(async (port: number, label: string) => ({ port, label, inUse: port === 8080 }));
    const provider: SystemSnapshotProvider = {
      loadWorktrees: vi.fn(async () => [WORKTREE]),
      getDiskUsage: vi.fn(() => ({ status: 'measuring' as const })),
      loadProcesses: vi.fn(async () => [PROCESS]),
      orchSocket: {
        getConnectionCount: vi.fn(() => 3),
        getRunBindingCounts: vi.fn(() => ({ 'run-1': 2 })),
      },
      watchedPorts: () => [
        { port: 3000, label: 'watched' },
        { port: 8080, label: 'watched' },
      ],
      probePort: probe,
      platform: 'darwin',
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
      tcp: [
        { port: 3000, label: 'watched', inUse: false },
        { port: 8080, label: 'watched', inUse: true },
      ],
      orchSocket: { connectionCount: 3, runBindings: { 'run-1': 2 } },
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('probes nothing when the provider supplies no watched ports', async () => {
    const probe = vi.fn(async (port: number, label: string) => ({ port, label, inUse: true }));
    setSystemProvider({
      loadWorktrees: vi.fn(async () => []),
      getDiskUsage: vi.fn(() => ({ status: 'measuring' as const })),
      loadProcesses: vi.fn(async () => []),
      orchSocket: { getConnectionCount: () => 0, getRunBindingCounts: () => ({}) },
      probePort: probe,
      platform: 'darwin',
    });

    const snap = await caller().snapshot({ projectId: 7 });

    expect(snap.ports.tcp).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  it('re-reads the watched ports on every snapshot', async () => {
    let configured = [3000];
    setSystemProvider({
      loadWorktrees: vi.fn(async () => []),
      getDiskUsage: vi.fn(() => ({ status: 'measuring' as const })),
      loadProcesses: vi.fn(async () => []),
      orchSocket: { getConnectionCount: () => 0, getRunBindingCounts: () => ({}) },
      watchedPorts: () => configured.map((port) => ({ port, label: 'watched' })),
      probePort: async (port, label) => ({ port, label, inUse: false }),
      platform: 'darwin',
    });

    expect((await caller().snapshot({ projectId: 7 })).ports.tcp.map((p) => p.port)).toEqual([3000]);
    configured = [5000, 8080];
    expect((await caller().snapshot({ projectId: 7 })).ports.tcp.map((p) => p.port)).toEqual([5000, 8080]);
  });
});

describe('cyboflow.system.snapshot — platform gating', () => {
  function providerFor(platform: NodeJS.Platform) {
    const getDiskUsage = vi.fn(() => ({ status: 'queued' as const }));
    const provider: SystemSnapshotProvider = {
      loadWorktrees: vi.fn(async () => [WORKTREE]),
      getDiskUsage,
      loadProcesses: vi.fn(async () => [PROCESS]),
      orchSocket: { getConnectionCount: () => 0, getRunBindingCounts: () => ({}) },
      probePort: async (port: number, label: string) => ({ port, label, inUse: false }),
      platform,
    };
    return { provider, getDiskUsage };
  }

  it('win32: never throws, keeps real process data, marks only disk sizing unsupported', async () => {
    const { provider, getDiskUsage } = providerFor('win32');
    setSystemProvider(provider);

    const snap = await caller().snapshot({ projectId: 1 });

    expect(snap.status).toBe('ready');
    expect(snap.capabilities.diskSizing.supported).toBe(false);
    expect(snap.capabilities.diskSizing).toMatchObject({ reason: expect.stringContaining('Windows') });
    // Real process + worktree data still surfaces — not a blanket not-supported.
    expect(snap.processes).toEqual([PROCESS]);
    expect(snap.worktrees.map((w) => w.path)).toEqual(['/wt/a']);
    // Disk usage is an explicit "unsupported", never a number, and no du is requested.
    expect(snap.worktrees[0].usage).toMatchObject({ status: 'unsupported' });
    expect(snap.worktrees[0].usage).not.toHaveProperty('bytes');
    expect(getDiskUsage).not.toHaveBeenCalled();
  });

  it('darwin/linux: disk sizing is supported and getDiskUsage is consulted as before', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { provider, getDiskUsage } = providerFor(platform);
      setSystemProvider(provider);

      const snap = await caller().snapshot({ projectId: 1 });

      expect(snap.capabilities.diskSizing).toEqual({ supported: true });
      expect(snap.processes).toEqual([PROCESS]);
      expect(snap.worktrees[0].usage).toEqual({ status: 'queued' });
      expect(getDiskUsage).toHaveBeenCalledWith('/wt/a');
    }
  });

  it('the starting fallback still resolves, with a capabilities entry', async () => {
    const snap = await caller().snapshot({ projectId: 1 });
    expect(snap.status).toBe('starting');
    expect(typeof snap.capabilities.diskSizing.supported).toBe('boolean');
  });
});

describe('cyboflow.system.snapshot — AC-5: no caller ⇒ zero ps/du', () => {
  function build(registryPaths: string[] = ['/wt/a', '/wt/b']) {
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
    const realReadMarkers = createSpawnMarkerReader();
    const readMarkers = vi.fn((rows: readonly { pid: number }[]) => realReadMarkers(rows));
    const provider = createSystemSnapshotProvider({
      processSnapshot,
      readMarkers,
      worktrees: {
        loadRegistry: async (): Promise<WorktreeMonitorRegistryEntry[]> =>
          registryPaths.map((path) => ({ ...WORKTREE, path })),
        getDiskUsage: (p) => disk.getUsage(p),
      },
      orchSocket: { getConnectionCount: () => 0, getRunBindingCounts: () => ({}) },
      readInstanceRecords: async () => [],
      getSelfInstanceId: () => 'self',
      probePort: async (port: number, label: string) => ({ port, label, inUse: false }),
    });
    // du sizing is POSIX-only; pin it so the win32 CI host runs du too.
    return { provider: { ...provider, platform: 'darwin' as const }, listProcesses, runDu, readMarkers };
  }

  beforeEach(() => {
    vi.mocked(childProcess.execFile).mockClear();
    vi.mocked(childProcess.spawn).mockClear();
  });

  it('mounted but never called: the ps, du and marker seams stay at zero', async () => {
    const { provider, listProcesses, runDu, readMarkers } = build();
    setSystemProvider(provider);
    await new Promise((r) => setTimeout(r, 20));
    expect(listProcesses).not.toHaveBeenCalled();
    expect(runDu).not.toHaveBeenCalled();
    expect(readMarkers).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('one snapshot() runs ps once and du at most once per worktree path', async () => {
    const { provider, listProcesses, runDu, readMarkers } = build();
    setSystemProvider(provider);

    const snap = await caller().snapshot({ projectId: 1 });
    await vi.waitFor(() => expect(runDu).toHaveBeenCalledTimes(2));

    expect(listProcesses).toHaveBeenCalledTimes(1);
    expect(readMarkers.mock.calls.length).toBeLessThanOrEqual(1);
    // Marker reading starts no subprocess: exactly one ps scan in total (the injected list seam).
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
    const measured = runDu.mock.calls.map((c) => (c as unknown[])[0]).sort();
    expect(measured).toEqual(['/wt/a', '/wt/b']);
    // First read is queued/measuring — never a bare number.
    for (const w of snap.worktrees) expect(['queued', 'measuring']).toContain(w.usage.status);
    // The unrelated host process (11, /usr/bin/other) is classified foreign and never shipped.
    expect(snap.processes.map((p) => p.bucket).sort()).toEqual(['owned']);
  });

  it('a second snapshot() inside the TTL starts no further du runs (entries come back measured)', async () => {
    const { provider, listProcesses, runDu } = build();
    setSystemProvider(provider);

    await caller().snapshot({ projectId: 1 });
    await vi.waitFor(() => expect(runDu).toHaveBeenCalledTimes(2));
    // Let both queued measurements settle into the cache.
    let second = await caller().snapshot({ projectId: 1 });
    await vi.waitFor(async () => {
      second = await caller().snapshot({ projectId: 1 });
      expect(second.worktrees.map((w) => w.usage.status)).toEqual(['measured', 'measured']);
    });

    expect(runDu).toHaveBeenCalledTimes(2);
    expect(listProcesses.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a duplicate registry path is measured only once', async () => {
    const { provider, runDu } = build(['/wt/a', '/wt/a']);
    setSystemProvider(provider);

    await caller().snapshot({ projectId: 1 });
    await vi.waitFor(() => expect(runDu).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(runDu).toHaveBeenCalledTimes(1);
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
