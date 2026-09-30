/**
 * End-to-end orphan reap with REAL OS processes: a fake cyboflow "instance" process
 * and a child tagged as its own. The instance is killed out from under the child
 * (crash / force-quit), the real classifier re-scans it as `orphan`, and the reap goes
 * through the same tRPC resolve → execute contract the System view uses (not a direct
 * kill). Only the snapshot loader is assembled here; kill is the real ladder.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { appRouter } from '../../orchestrator/trpc/router';
import { createContext } from '../../orchestrator/trpc/context';
import { setMonitorReapProvider } from '../../orchestrator/trpc/routers/monitorReap';
import { classify, buildLiveInstanceSet, type MarkedProcess } from '../processSnapshot/classify';
import { buildWorktreeTruthFixture } from '../processSnapshot/worktreeTruth';
import { toSystemProcessEntry } from '../systemSnapshotProvider';
import { MonitorReapService } from './monitorReapService';
import { ReapExecutorImpl } from './reapExecutor';
import type { ReapSnapshot } from './reapManifest';

const api = () => appRouter.createCaller(createContext()).cyboflow.monitorReap;
const SELF = 'self-instance';
const DEAD = 'fake-instance-1';

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};
const spawnSleeper = (): ChildProcess =>
  spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true });

const cleanup: number[] = [];
afterEach(() => {
  setMonitorReapProvider(null);
  for (const pid of cleanup.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

/** Real `ps` row for one pid, tagged with the instance that spawned it. */
function taggedRow(pid: number, instanceId: string): MarkedProcess {
  const out = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)]).toString().trim();
  const [ppid, ...cmd] = out.split(/\s+/);
  return {
    pid,
    ppid: Number(ppid),
    pcpu: 0,
    pmem: 0,
    etimeSeconds: 1,
    command: cmd.join(' '),
    processType: 'unknown',
    worktreePath: null,
    owner: null,
    marker: { instanceId, worktree: '/wt/fake' },
  };
}

function harness(rows: () => MarkedProcess[], instancePid: number) {
  const loadSnapshot = async (): Promise<ReapSnapshot> => {
    const live = buildLiveInstanceSet(SELF, [{ instanceId: DEAD, pid: instancePid }], isAlive);
    const processes = classify(rows(), live, buildWorktreeTruthFixture()).map(toSystemProcessEntry);
    return { generatedAt: Date.now(), worktrees: [], processes };
  };
  setMonitorReapProvider(
    new MonitorReapService({
      loadSnapshot,
      manifestDeps: { measureFresh: async () => 0, peekGitStatus: () => null, countDescendants: async () => 0, now: Date.now },
      executor: new ReapExecutorImpl({ graceMs: 1000 }),
    }),
  );
  return loadSnapshot;
}

describe('orphan reap end to end (real processes)', () => {
  it('reclassifies a child as orphan after its instance dies, then reaps it via resolve → execute', async () => {
    const instance = spawnSleeper();
    const child = spawnSleeper();
    cleanup.push(instance.pid!, child.pid!);
    const childRow = taggedRow(child.pid!, DEAD);
    const load = harness(() => [childRow], instance.pid!);

    // While the instance lives, the child is another live instance's: foreign, never sweepable.
    const before = (await load()).processes.find((p) => p.bucket === 'foreign');
    expect(before).toBeDefined();
    const pre = await api().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    expect(pre.manifest.targets).toEqual([]);
    expect(isAlive(child.pid!)).toBe(true);

    // Crash the instance out from under the child.
    process.kill(instance.pid!, 'SIGKILL');
    await new Promise((r) => instance.once('exit', r));
    expect(isAlive(instance.pid!)).toBe(false);

    const orphan = (await load()).processes.find((p) => p.bucket === 'orphan');
    expect(orphan).toMatchObject({ bucket: 'orphan', pid: child.pid, instanceId: DEAD });

    const { manifest } = await api().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    expect(manifest.targets.map((t) => (t.kind === 'process' ? t.pid : null))).toEqual([child.pid]);
    const out = await api().execute({ manifestId: manifest.id });

    expect(out.errors).toEqual([]);
    expect(out.results).toEqual([expect.objectContaining({ targetId: `process:${child.pid}`, kind: 'killed' })]);
    // Reap the zombie so a dead-but-unreaped child doesn't read alive to signal 0.
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(child.pid!)).toBe(false);
  }, 60_000);
});
