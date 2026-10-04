/**
 * End-to-end orphan reap with REAL OS processes. A fake cyboflow "instance" process
 * (spawned with the real `stampSpawnMarker` env) itself spawns a child that inherits
 * the marker. The instance is SIGKILLed out from under the child (crash / force-quit),
 * a FRESH production snapshot (real `ps` scan → ProcessSnapshotService → marker reader
 * → classifier, via createSystemSnapshotProvider) re-scans it as `orphan`, and the reap
 * goes through the same tRPC resolve → execute contract the System view uses (not a
 * direct kill). Nothing is planted: the marker is read back off the real child's
 * environment, and every snapshot is a new scan.
 *
 * Marker reading: production reads `/proc/<pid>/environ` on linux only (darwin has no
 * environment reader). The test injects `readEnviron` — /proc on linux, `ps -Eww` on
 * darwin — into the real reader, scoped to just this test's two pids so unrelated
 * markers on the developer's machine can never become reap targets.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { appRouter } from '../../orchestrator/trpc/router';
import { createContext } from '../../orchestrator/trpc/context';
import { setMonitorReapProvider } from '../../orchestrator/trpc/routers/monitorReap';
import { getInstanceId, stampSpawnMarker } from '../../utils/spawnMarker';
import { ProcessSnapshotService } from '../processSnapshot/processSnapshotService';
import { createSpawnMarkerReader } from '../processSnapshot/spawnMarkerReader';
import { createSystemSnapshotProvider } from '../systemSnapshotProvider';
import { MonitorReapService } from './monitorReapService';
import { ReapExecutorImpl } from './reapExecutor';
import type { ReapSnapshot } from './reapManifest';

const api = () => appRouter.createCaller(createContext()).cyboflow.monitorReap;
/** The running "app" (this test process): distinct from the fake instance that owns the child. */
const SELF = 'self-instance';

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};
const ppidOf = (pid: number): number =>
  Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)]).toString().trim());
const waitFor = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
};

/** The instance process: spawns one child (inheriting its stamped env) and prints the child's pid. */
const INSTANCE_SCRIPT = `
const { spawn } = require('node:child_process');
const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
process.stdout.write(String(c.pid) + '\\n');
setInterval(() => {}, 1000);
`;

async function spawnInstanceWithChild(env: Record<string, string>): Promise<{ instance: ChildProcess; childPid: number }> {
  const instance = spawn(process.execPath, ['-e', INSTANCE_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'], env });
  const childPid = await new Promise<number>((resolve, reject) => {
    let buf = '';
    instance.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      if (buf.includes('\n')) resolve(Number(buf.trim()));
    });
    instance.once('exit', () => reject(new Error('instance exited before reporting its child')));
  });
  return { instance, childPid };
}

/** Environment blob (NUL-separated) for a pid, the way the production linux reader gets it. */
async function readEnviron(pid: number): Promise<string | null> {
  try {
    if (process.platform === 'linux') return await fsp.readFile(`/proc/${pid}/environ`, 'latin1');
    // darwin: `ps -Eww` appends the environment after argv; stamped values contain no spaces.
    const out = execFileSync('ps', ['-Eww', '-o', 'command=', '-p', String(pid)]).toString().trim();
    return out.split(/\s+/).join('\0');
  } catch {
    return null;
  }
}

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

/**
 * Wires the REAL snapshot pipeline: every `loadSnapshot()` is a fresh `ps` scan with the
 * marker read off the live process environments. Only the liveness record (which pid
 * embodies the fake instance) and the marker-read pid scope are supplied.
 */
function harness(instanceId: string, instancePid: number, scopedPids: number[]) {
  const provider = createSystemSnapshotProvider({
    processSnapshot: new ProcessSnapshotService({
      cliManager: { listOwnedProcesses: () => [] },
      runShellManager: { listOwnedShells: () => [] },
    }),
    worktrees: { loadRegistry: async () => { throw new Error('unused'); }, getDiskUsage: () => { throw new Error('unused'); } },
    orchSocket: { getConnectionCount: () => 0, getRunBindingCounts: () => ({}) },
    getSelfInstanceId: () => SELF,
    readInstanceRecords: async () => [{ instanceId, pid: instancePid, startedAt: new Date().toISOString() }],
    isPidAlive: isAlive,
    readMarkers: createSpawnMarkerReader({
      platform: 'linux', // force the environ path; the injected reader supplies darwin's environment
      readEnviron: async (pid) => (scopedPids.includes(pid) ? readEnviron(pid) : null),
    }),
  });
  const loadSnapshot = async (): Promise<ReapSnapshot> => ({
    generatedAt: Date.now(),
    worktrees: [],
    processes: await provider.loadProcesses(new Set()),
  });
  setMonitorReapProvider(
    new MonitorReapService({
      loadSnapshot,
      manifestDeps: { measureFresh: async () => 0, peekGitStatus: () => null, countDescendants: async () => 0, now: Date.now },
      executor: new ReapExecutorImpl({ graceMs: 1000 }),
    }),
  );
  return loadSnapshot;
}

describe.skipIf(process.platform === 'win32')('orphan reap end to end (real processes)', () => {
  it('reclassifies a child as orphan after its instance dies, then reaps it via resolve → execute', async () => {
    // Real marker stamp: the instance id comes from the production helper, not a literal.
    const instanceId = getInstanceId();
    const env = stampSpawnMarker(process.env, '/wt/fake');
    const { instance, childPid } = await spawnInstanceWithChild(env);
    cleanup.push(instance.pid!, childPid);
    const instancePid = instance.pid!;

    // The child really is the instance's child, so killing the instance orphans it.
    expect(ppidOf(childPid)).toBe(instancePid);

    const load = harness(instanceId, instancePid, [instancePid, childPid]);

    // While the instance lives, the child is another live instance's: foreign, never sweepable.
    const before = (await load()).processes.find((p) => p.bucket === 'foreign' && p.pidLabel === String(childPid));
    expect(before).toBeDefined();
    const pre = await api().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    expect(pre.manifest.targets).toEqual([]);
    expect(isAlive(childPid)).toBe(true);

    // Crash the instance out from under the child.
    process.kill(instancePid, 'SIGKILL');
    await new Promise((r) => (instance.exitCode !== null || instance.signalCode !== null ? r(null) : instance.once('exit', r)));
    expect(isAlive(instancePid)).toBe(false);
    expect(isAlive(childPid)).toBe(true);
    expect(ppidOf(childPid)).not.toBe(instancePid);

    // A brand-new production scan sees the marker on the real child and the dead instance.
    const orphan = (await load()).processes.find((p) => p.bucket === 'orphan' && p.pid === childPid);
    expect(orphan).toMatchObject({ bucket: 'orphan', pid: childPid, instanceId });

    const { manifest } = await api().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    expect(manifest.targets.map((t) => (t.kind === 'process' ? t.pid : null))).toEqual([childPid]);
    const out = await api().execute({ manifestId: manifest.id });

    expect(out.errors).toEqual([]);
    expect(out.results).toEqual([expect.objectContaining({ targetId: `process:${childPid}`, kind: 'killed' })]);
    // The reparented child is reaped by init; poll so a dead-but-unreaped entry can't read alive.
    expect(await waitFor(() => !isAlive(childPid), 5000)).toBe(true);
  }, 60_000);

  it('negative control: when the marker is not readable off the child, the dead instance never makes it an orphan', async () => {
    const instanceId = getInstanceId();
    const { instance, childPid } = await spawnInstanceWithChild(stampSpawnMarker(process.env, '/wt/fake'));
    cleanup.push(instance.pid!, childPid);
    const load = harness(instanceId, instance.pid!, []); // reader scoped to no pids: no marker observed
    process.kill(instance.pid!, 'SIGKILL');
    await new Promise((r) => (instance.exitCode !== null || instance.signalCode !== null ? r(null) : instance.once('exit', r)));
    const processes = (await load()).processes;
    expect(processes.some((p) => p.bucket === 'orphan' && p.pid === childPid)).toBe(false);
    const { manifest } = await api().resolve({ projectId: 1, selection: { kind: 'reap-all-stale' } });
    expect(manifest.targets).toEqual([]);
  }, 60_000);
});
