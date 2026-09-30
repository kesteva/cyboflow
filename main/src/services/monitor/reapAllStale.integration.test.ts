/**
 * "Reap all stale" end-to-end through the REAL tRPC router, MonitorReapService and
 * ReapExecutorImpl, against a seeded aggregated snapshot holding orphan, suspected,
 * foreign and owned rows. Only the OS-touching primitives are fakes: a recording
 * `killTree` over a fake pid table, and a recording worktree pruner. So:
 *
 *  - only orphan worktrees/processes are ever targeted or touched (suspected, foreign
 *    and owned are asserted untouched directly, on the fake OS state itself);
 *  - a forged / hand-modified / drifted manifest id is rejected with ZERO side
 *    effects (AC-4);
 *  - a process that survives KILL comes back as an error entry, never bare success (AC-7).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { appRouter } from '../../orchestrator/trpc/router';
import { createContext } from '../../orchestrator/trpc/context';
import { MANIFEST_STALE, setMonitorReapProvider } from '../../orchestrator/trpc/routers/monitorReap';
import type { ReapWorktreeTarget } from '../../orchestrator/reapTypes';
import type {
  SystemForeignProcess,
  SystemManagedProcess,
  SystemOrphanProcess,
  SystemProcessEntry,
  SystemWorktreeEntry,
} from '../../orchestrator/systemTypes';
import { MonitorReapService } from './monitorReapService';
import { ReapExecutorImpl, type ReapKillTree } from './reapExecutor';
import type { ReapSnapshot } from './reapManifest';

const api = () => appRouter.createCaller(createContext()).cyboflow.monitorReap;

const wt = (
  path: string,
  tag: 'orphan' | 'session-owned' | 'run-owned' | 'in_place',
  extra: { sessionId?: string; runId?: string } = {},
): SystemWorktreeEntry =>
  tag === 'in_place'
    ? { path, branch: 'main', tag, prunable: false, usage: { status: 'queued' } }
    : { path, branch: `b-${path.split('/').pop()}`, tag, prunable: true, usage: { status: 'queued' }, ...extra };

const common = (pid: number, worktreePath: string | null) => ({
  pid,
  ppid: 1,
  pcpu: 0,
  pmem: 0,
  etimeSeconds: 30,
  owner: null,
  processType: 'claude-cli' as const,
  command: `cmd-${pid}`,
  worktreePath,
});
const orphan = (pid: number, worktreePath: string | null = null): SystemOrphanProcess => ({
  ...common(pid, worktreePath),
  bucket: 'orphan',
  sweepEligible: true,
  instanceId: 'dead-instance',
});
const managed = (pid: number, bucket: 'owned' | 'suspected', worktreePath: string | null = null): SystemManagedProcess => ({
  ...common(pid, worktreePath),
  bucket,
});
const foreign: SystemForeignProcess = {
  bucket: 'foreign',
  readOnly: true,
  pidLabel: '9001',
  display: { cpu: '0.0', mem: '0.0', elapsed: '00:30' },
  foreignInstanceId: 'other-instance',
  processType: 'claude-cli',
  command: 'cmd-9001',
  worktreePath: '/wt/foreign',
};

// Pids 9001 (foreign) is a real live process on the fake OS too: it must stay alive.
const ORPHAN_ALIVE = [21, 22, 23];
const UNTOUCHABLE_ALIVE = [31, 41, 9001];

const seeded = (): ReapSnapshot => ({
  generatedAt: 1_000_000,
  worktrees: [
    wt('/wt/orphan-a', 'orphan'),
    wt('/wt/orphan-b', 'orphan'),
    wt('/wt/owned', 'session-owned', { sessionId: 's-1' }),
    wt('/wt/run-owned', 'run-owned', { runId: 'r-1' }),
    wt('/wt/foreign', 'session-owned', { sessionId: 's-foreign' }),
    wt('/repo', 'in_place'),
  ],
  processes: [
    orphan(21, '/wt/orphan-a'),
    orphan(22, '/wt/orphan-b'), // will be unkillable in the survivor scenario
    orphan(23), // orphan process not inside any worktree
    managed(31, 'suspected', '/wt/owned'),
    managed(41, 'owned', '/wt/run-owned'),
    foreign as SystemProcessEntry,
  ],
});

function harness(opts: { immune?: number[] } = {}) {
  const alive = new Set<number>([...ORPHAN_ALIVE, ...UNTOUCHABLE_ALIVE]);
  const immune = new Set(opts.immune ?? []);
  const killed: number[] = [];
  const pruned: string[] = [];
  const killTree = vi.fn<ReapKillTree>(async (pid) => {
    killed.push(pid);
    if (!immune.has(pid)) alive.delete(pid);
    return true;
  });
  const pruneWorktree = vi.fn(async (t: ReapWorktreeTarget) => {
    pruned.push(t.path);
    return { targetId: `worktree:${t.path}`, kind: 'pruned' as const };
  });
  let snapshot = seeded();
  const service = new MonitorReapService({
    loadSnapshot: async () => snapshot,
    manifestDeps: {
      measureFresh: async () => 10,
      peekGitStatus: () => null,
      countDescendants: async () => 0,
      now: () => 2_000_000,
    },
    executor: new ReapExecutorImpl({
      killTree,
      listDescendants: async () => [],
      isPidAlive: (p) => alive.has(p),
      pruneWorktree,
      selfPid: 5,
    }),
  });
  setMonitorReapProvider(service);
  return {
    alive,
    killed,
    pruned,
    killTree,
    pruneWorktree,
    setSnapshot: (s: ReapSnapshot) => (snapshot = s),
    snapshot: () => snapshot,
  };
}

const noSideEffects = (h: ReturnType<typeof harness>): void => {
  expect(h.killTree).not.toHaveBeenCalled();
  expect(h.pruneWorktree).not.toHaveBeenCalled();
  expect([...h.alive].sort((a, b) => a - b)).toEqual([...ORPHAN_ALIVE, ...UNTOUCHABLE_ALIVE].sort((a, b) => a - b));
};

afterEach(() => setMonitorReapProvider(null));

describe('reap-all-stale end to end', () => {
  it('resolves only orphan worktrees and orphan processes from a snapshot holding all four kinds', async () => {
    harness();
    const { manifest } = await api().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    const ids = manifest.targets.map((t) => (t.kind === 'worktree' ? `wt:${t.path}` : `pid:${t.pid}`)).sort();
    expect(ids).toEqual(['pid:21', 'pid:22', 'pid:23', 'wt:/wt/orphan-a', 'wt:/wt/orphan-b']);
    expect(manifest.targets.every((t) => (t.kind === 'process' ? t.bucket === 'orphan' : t.tag === 'orphan'))).toBe(true);
  });

  it('executes: orphan worktrees pruned, orphan processes killed, everything else provably untouched', async () => {
    const h = harness();
    const { manifest } = await api().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    const out = await api().execute({ manifestId: manifest.id });

    // One aggregated result list: one entry per orphan target, all successful.
    expect(out.errors).toEqual([]);
    expect(Object.fromEntries(out.results.map((r) => [r.targetId, r.kind]))).toEqual({
      'process:21': 'killed',
      'process:22': 'killed',
      'process:23': 'killed',
      'worktree:/wt/orphan-a': 'pruned',
      'worktree:/wt/orphan-b': 'pruned',
    });

    expect(h.killed.sort()).toEqual([21, 22, 23]);
    expect(h.pruned.sort()).toEqual(['/wt/orphan-a', '/wt/orphan-b']);
    // Suspected (31), owned (41) and foreign (9001) processes are still alive, never signalled…
    for (const pid of UNTOUCHABLE_ALIVE) expect(h.alive.has(pid)).toBe(true);
    expect(h.killed).not.toContain(31);
    expect(h.killed).not.toContain(41);
    expect(h.killed).not.toContain(9001);
    // …and their worktrees, the owned ones and the in-place checkout were never pruned.
    for (const p of ['/wt/owned', '/wt/run-owned', '/wt/foreign', '/repo']) expect(h.pruned).not.toContain(p);
    // The orphan processes are dead.
    for (const pid of ORPHAN_ALIVE) expect(h.alive.has(pid)).toBe(false);
  });

  it('negative control: a non-orphan-restricted selection WOULD hit suspected/owned rows, so the assertions above can fail', async () => {
    const h = harness();
    // kill-all-of-type is not orphan-restricted: it targets every killable claude-cli.
    const { manifest } = await api().resolve({
      projectId: 1,
      selection: { kind: 'kill-all-of-type', processType: 'claude-cli' },
    });
    await api().execute({ manifestId: manifest.id });
    expect(h.killed).toContain(31);
    expect(h.killed).toContain(41);
    expect(h.alive.has(31)).toBe(false);
    // Even then the foreign row is structurally unreachable (it carries no pid).
    expect(h.killed).not.toContain(9001);
  });
});

describe('reap-all-stale rejects forged and stale manifest ids (AC-4)', () => {
  it('a fabricated id is rejected with a typed error and zero side effects', async () => {
    const h = harness();
    await expect(api().execute({ manifestId: 'reap_forged' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining(MANIFEST_STALE),
    });
    noSideEffects(h);
  });

  it('a hand-modified real id is rejected with zero side effects, and the genuine id still works once', async () => {
    const h = harness();
    const { manifest } = await api().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    const tampered = `${manifest.id.slice(0, -1)}${manifest.id.endsWith('0') ? '1' : '0'}`;
    await expect(api().execute({ manifestId: tampered })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    noSideEffects(h);
    // Rejecting a forgery did not consume the genuine manifest.
    const out = await api().execute({ manifestId: manifest.id });
    expect(out.results).toHaveLength(5);
  });

  it('a replayed id is rejected: nothing is torn down twice', async () => {
    const h = harness();
    const { manifest } = await api().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    await api().execute({ manifestId: manifest.id });
    const kills = h.killTree.mock.calls.length;
    const prunes = h.pruneWorktree.mock.calls.length;
    await expect(api().execute({ manifestId: manifest.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.killTree.mock.calls.length).toBe(kills);
    expect(h.pruneWorktree.mock.calls.length).toBe(prunes);
  });

  it('a manifest whose orphan set drifted since resolve (a new orphan appeared) is stale: zero side effects', async () => {
    const h = harness();
    const { manifest } = await api().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    const snap = h.snapshot();
    h.setSnapshot({ ...snap, processes: [...snap.processes, orphan(24)] });
    await expect(api().execute({ manifestId: manifest.id })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining(MANIFEST_STALE),
    });
    noSideEffects(h);
  });

  it('a process that became suspected since resolve drops out of the orphan set, so the manifest is stale', async () => {
    const h = harness();
    const { manifest } = await api().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    const snap = h.snapshot();
    h.setSnapshot({
      ...snap,
      processes: snap.processes.map((p) => (p.bucket === 'orphan' && p.pid === 23 ? managed(23, 'suspected') : p)),
    });
    await expect(api().execute({ manifestId: manifest.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    noSideEffects(h);
  });
});

describe('reap-all-stale surfaces a KILL survivor as an error (AC-7)', () => {
  it('an unkillable orphan comes back `survived` in results and in errors, never as bare success', async () => {
    const h = harness({ immune: [23] });
    const { manifest } = await api().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    const out = await api().execute({ manifestId: manifest.id });

    const byId = Object.fromEntries(out.results.map((r) => [r.targetId, r]));
    expect(byId['process:23']).toEqual({ targetId: 'process:23', kind: 'survived', survivorPids: [23] });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatchObject({ targetId: 'process:23', survivorPids: [23] });
    // The batch still completed for everything else.
    expect(byId['process:21'].kind).toBe('killed');
    expect(byId['worktree:/wt/orphan-a'].kind).toBe('pruned');
    // Non-orphans remain untouched even in the failure scenario.
    for (const pid of UNTOUCHABLE_ALIVE) expect(h.alive.has(pid)).toBe(true);
  });

  it('a survivor inside an orphan worktree keeps that worktree and reports both the survivor and the kept worktree', async () => {
    const h = harness({ immune: [22] });
    const { manifest } = await api().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    const out = await api().execute({ manifestId: manifest.id });

    expect(h.pruned).toEqual(['/wt/orphan-a']);
    expect(h.alive.has(22)).toBe(true);
    const errorIds = out.errors.map((e) => e.targetId).sort();
    expect(errorIds).toEqual(['process:22', 'worktree:/wt/orphan-b']);
    expect(out.errors.find((e) => e.targetId === 'process:22')?.survivorPids).toEqual([22]);
  });
});
