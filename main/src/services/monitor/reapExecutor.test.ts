/**
 * ReapExecutorImpl: process kills go through the shared killTree ladder (5s grace),
 * any post-KILL survivor is reported as `survived` (never success), and worktree
 * teardown reaps brokers before pruning. All primitives are fakes — no real pid is
 * ever signalled.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { appRouter } from '../../orchestrator/trpc/router';
import { createContext } from '../../orchestrator/trpc/context';
import { setMonitorReapProvider } from '../../orchestrator/trpc/routers/monitorReap';
import type {
  ReapManifest,
  ReapProcessTarget,
  ReapWorktreeTarget,
} from '../../orchestrator/reapTypes';
import type { SystemOrphanProcess } from '../../orchestrator/systemTypes';
import { CodexBrokerReaper, type CodexBrokerProcess } from '../codexBrokerReaper';
import { MonitorReapService } from './monitorReapService';
import { ReapExecutorImpl, REAP_KILL_GRACE_MS, type ReapKillTree } from './reapExecutor';

const proc = (pid: number, extra: Partial<ReapProcessTarget> = {}): ReapProcessTarget => ({
  kind: 'process',
  pid,
  processType: 'claude-cli',
  bucket: 'orphan',
  command: `cmd-${pid}`,
  worktreePath: null,
  sessionId: null,
  runId: null,
  taggedAsCyboflow: true,
  descendantPidCount: 0,
  ...extra,
});

const wt = (path: string): ReapWorktreeTarget => ({
  kind: 'worktree',
  path,
  branch: 'b',
  tag: 'orphan',
  sessionId: null,
  runId: null,
  reclaimableBytes: 1,
  dirty: false,
  dirtyFileCount: 0,
  aheadOfMain: 0,
});

const manifestOf = (targets: ReapManifest['targets']): ReapManifest => ({
  id: 'reap_x',
  kind: 'row',
  snapshotGeneratedAt: 1,
  builtAt: 1,
  targets,
  reclaimableBytes: 0,
  unmeasuredTargetCount: 0,
  dirtyFileCount: 0,
  dirtyCountUnknownTargetCount: 0,
  aheadOfMainCount: 0,
  descendantPidCount: 0,
  alsoDeleteBranch: false,
});

const OPTS = { alsoDeleteBranch: false };

describe('ReapExecutorImpl process targets', () => {
  it('kills a tree via killTree with the 5s grace, pre-enumerated descendants and no real-pgid lookup', async () => {
    const alive = new Set([100, 101]);
    const killTreeFn = vi.fn<ReapKillTree>(async () => {
      alive.clear();
      return true;
    });
    const ex = new ReapExecutorImpl({
      killTree: killTreeFn,
      listDescendants: async () => [101],
      isPidAlive: (p) => alive.has(p),
      selfPid: 5,
    });
    const [res] = await ex.execute(manifestOf([proc(100)]), OPTS);
    expect(res).toEqual({ targetId: 'process:100', kind: 'killed' });
    expect(killTreeFn).toHaveBeenCalledTimes(1);
    const [pid, opts] = killTreeFn.mock.calls[0];
    expect(pid).toBe(100);
    expect(opts?.graceMs).toBe(REAP_KILL_GRACE_MS);
    expect(REAP_KILL_GRACE_MS).toBe(5000);
    expect(opts?.descendantPids).toEqual([101]);
    expect(opts?.posixGroupMode).toBe('root');
  });

  it('reports descendants that survive the ladder as `survived` with survivorPids', async () => {
    let rootDead = false;
    const killTreeFn: ReapKillTree = async (_pid, opts) => {
      rootDead = true; // the root dies; only its descendants survive
      await opts?.onSurvivors?.([201, 202]);
      return false;
    };
    const ex = new ReapExecutorImpl({
      killTree: killTreeFn,
      listDescendants: async () => [201, 202],
      isPidAlive: () => !rootDead,
      selfPid: 5,
    });
    const [res] = await ex.execute(manifestOf([proc(200)]), OPTS);
    expect(res).toEqual({ targetId: 'process:200', kind: 'survived', survivorPids: [201, 202] });
  });

  it('an unkillable root (still alive after the ladder) is a survivor, never `killed`', async () => {
    const killTreeFn: ReapKillTree = async () => true; // ladder claims success…
    const ex = new ReapExecutorImpl({
      killTree: killTreeFn,
      listDescendants: async () => [],
      isPidAlive: () => true, // …but the pid is still there
      selfPid: 5,
    });
    const [res] = await ex.execute(manifestOf([proc(300)]), OPTS);
    expect(res.kind).toBe('survived');
    expect(res.survivorPids).toEqual([300]);
  });

  it('skips a pid that is already gone without invoking the ladder', async () => {
    const killTreeFn = vi.fn<ReapKillTree>(async () => true);
    const ex = new ReapExecutorImpl({ killTree: killTreeFn, isPidAlive: () => false, selfPid: 5 });
    const [res] = await ex.execute(manifestOf([proc(400)]), OPTS);
    expect(res).toEqual({ targetId: 'process:400', kind: 'skipped' });
    expect(killTreeFn).not.toHaveBeenCalled();
  });

  it('refuses protected pids (init, self) and surfaces a thrown ladder as `failed`', async () => {
    const killTreeFn = vi.fn<ReapKillTree>(async () => {
      throw new Error('boom');
    });
    const ex = new ReapExecutorImpl({
      killTree: killTreeFn,
      listDescendants: async () => [],
      isPidAlive: () => true,
      selfPid: 77,
    });
    const results = await ex.execute(manifestOf([proc(1), proc(77), proc(500)]), OPTS);
    expect(results.map((r) => r.kind)).toEqual(['failed', 'failed', 'failed']);
    expect(results[0].error).toContain('protected');
    expect(results[1].error).toContain('protected');
    expect(results[2].error).toBe('boom');
    expect(killTreeFn).toHaveBeenCalledTimes(1);
  });
});

describe('ReapExecutorImpl worktree targets', () => {
  it('kills processes first, then reaps brokers, then prunes — in that order', async () => {
    const order: string[] = [];
    const killTreeFn: ReapKillTree = async (pid) => {
      order.push(`kill:${pid}`);
      return true;
    };
    let dead = false;
    const ex = new ReapExecutorImpl({
      killTree: async (pid, opts) => {
        const r = await killTreeFn(pid, opts);
        dead = true;
        return r;
      },
      listDescendants: async () => [],
      isPidAlive: () => !dead,
      reapBrokersForWorktree: async (p) => {
        order.push(`brokers:${p}`);
      },
      pruneWorktree: async (t, o) => {
        order.push(`prune:${t.path}:${o.alsoDeleteBranch}`);
        return { targetId: `worktree:${t.path}`, kind: 'pruned' };
      },
      selfPid: 5,
    });
    // Worktree listed BEFORE the process: execution order must still be kill → brokers → prune.
    const results = await ex.execute(manifestOf([wt('/wt/a'), proc(600)]), { alsoDeleteBranch: true });
    expect(order).toEqual(['kill:600', 'brokers:/wt/a', 'prune:/wt/a:true']);
    expect(results.map((r) => r.kind)).toEqual(['killed', 'pruned']);
  });

  it('fails a worktree target visibly (and reaps nothing) when pruning is not wired', async () => {
    const reap = vi.fn(async () => {});
    const ex = new ReapExecutorImpl({ reapBrokersForWorktree: reap, selfPid: 5 });
    const [res] = await ex.execute(manifestOf([wt('/wt/a')]), OPTS);
    expect(res.kind).toBe('failed');
    expect(reap).not.toHaveBeenCalled();
  });

  it('a throwing prune becomes a `failed` result, not a rejected execute', async () => {
    const ex = new ReapExecutorImpl({
      pruneWorktree: async () => {
        throw new Error('EBUSY');
      },
      selfPid: 5,
    });
    const [res] = await ex.execute(manifestOf([wt('/wt/a')]), OPTS);
    expect(res).toEqual({ targetId: 'worktree:/wt/a', kind: 'failed', error: 'EBUSY' });
  });

  it('reaps Codex brokers rooted in the worktree through the real CodexBrokerReaper.reapForWorktree', async () => {
    const rows: CodexBrokerProcess[] = [
      { pid: 700, ppid: 1, command: 'node codex app-server-broker.mjs serve --cwd /wt/a --pid-file x' },
      { pid: 701, ppid: 1, command: 'node codex app-server-broker.mjs serve --cwd /wt/other --pid-file y' },
    ];
    const killed: number[] = [];
    const reaper = new CodexBrokerReaper({
      listProcesses: async () => rows,
      killPid: (pid) => {
        killed.push(pid);
      },
    });
    const ex = new ReapExecutorImpl({
      reapBrokersForWorktree: (p) => reaper.reapForWorktree(p),
      pruneWorktree: async (t) => ({ targetId: `worktree:${t.path}`, kind: 'pruned' }),
      selfPid: 5,
    });
    const [res] = await ex.execute(manifestOf([wt('/wt/a')]), OPTS);
    expect(res.kind).toBe('pruned');
    expect(killed).toEqual([700]);
  });
});

describe('monitorReap.execute with the real executor', () => {
  afterEach(() => setMonitorReapProvider(null));

  it('a forced-survivor manifest returns a non-empty errors list, not a bare success', async () => {
    const orphan: SystemOrphanProcess = {
      pid: 800,
      ppid: 1,
      pcpu: 0,
      pmem: 0,
      etimeSeconds: 5,
      owner: null,
      processType: 'claude-cli',
      command: 'cmd-800',
      worktreePath: null,
      bucket: 'orphan',
      sweepEligible: true,
      instanceId: 'dead',
    };
    const service = new MonitorReapService({
      loadSnapshot: async () => ({ generatedAt: 1, worktrees: [], processes: [orphan] }),
      manifestDeps: {
        measureFresh: async () => 0,
        peekGitStatus: () => null,
        countDescendants: async () => 0,
        now: () => 1000,
      },
      executor: new ReapExecutorImpl({
        killTree: async () => false,
        listDescendants: async () => [],
        isPidAlive: () => true, // unkillable test double
        selfPid: 5,
      }),
    });
    setMonitorReapProvider(service);
    const api = appRouter.createCaller(createContext()).cyboflow.monitorReap;
    const { manifest } = await api.resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    const out = await api.execute({ manifestId: manifest.id });
    expect(out.results).toEqual([{ targetId: 'process:800', kind: 'survived', survivorPids: [800] }]);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatchObject({ targetId: 'process:800', survivorPids: [800] });
  });
});
