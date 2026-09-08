/**
 * Shared fixtures for the process-tree suites.
 *
 * Eight suites drive a real process tree through a kill ladder, and each had
 * grown its own copy of the same probe, the same poll loop, and the same
 * fixture command line. One copy of each lives here instead, so a change to
 * what "a tree" means reaches every ladder at once.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

/**
 * Signal-0 liveness probe, matching the production semantics
 * (platformProcess.ts defaultIsPidAlive): ESRCH means dead, and EPERM
 * ("exists, no permission to signal") means the process is still there.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Poll `predicate` until it holds or `timeoutMs` elapses, then report its final
 * value. Async predicates are allowed, so a suite can await an enumeration.
 */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  pollIntervalMs = 50,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return predicate();
}

/**
 * A node parent that spawns a long-lived DETACHED grandchild and then stays
 * alive itself.
 *
 * Detached is the whole point. A tree walk that loses the parent link cannot
 * see the grandchild, which is the orphan case every ladder here exists to
 * prevent — and the one a test that checks only the parent will pass without
 * noticing.
 */
export const DETACHED_GRANDCHILD_SCRIPT =
  "require('child_process').spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' }).unref(); setInterval(()=>{},1000);";

/** Spawn {@link DETACHED_GRANDCHILD_SCRIPT}. The caller owns teardown. */
export function spawnDetachedGrandchildTree(options: SpawnOptions = {}): ChildProcess {
  return spawn(process.execPath, ['-e', DETACHED_GRANDCHILD_SCRIPT], {
    detached: true,
    stdio: 'ignore',
    ...options,
  });
}

/**
 * {@link DETACHED_GRANDCHILD_SCRIPT}, but the parent writes the grandchild's
 * pid to stdout before settling — for assertions that must name the tree they
 * OWN rather than trust the pid/ppid table for its membership.
 *
 * Why that matters: Windows keeps a dead parent's pid as a process's
 * ParentProcessId forever, and reissues pids quickly. On a busy host (a CI
 * runner mid-suite) an unrelated orphan can therefore hang under a fresh
 * fixture pid and be walked as its "descendant" — then exit, or refuse a
 * signal-0 open, at any moment. `found.every(isAlive)` over that set is a
 * race; `isAlive(grandchildPid)` is not.
 */
export const NAMED_DETACHED_GRANDCHILD_SCRIPT =
  "const c = require('child_process').spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' }); c.unref(); process.stdout.write(c.pid + '\\n'); setInterval(()=>{},1000);";

export interface NamedDetachedGrandchildTree {
  child: ChildProcess;
  grandchildPid: number;
}

/**
 * Spawn {@link NAMED_DETACHED_GRANDCHILD_SCRIPT} and resolve once the parent
 * has named its grandchild. The caller owns teardown of BOTH pids — killing
 * the parent alone orphans the grandchild (that is the fixture's point), and
 * on Windows an orphan keeps its stale ParentProcessId, which is exactly how
 * the phantoms above are born. {@link reapDetachedGrandchildTree} does it.
 */
export function spawnNamedDetachedGrandchildTree(
  options: SpawnOptions = {},
): Promise<NamedDetachedGrandchildTree> {
  const child = spawn(process.execPath, ['-e', NAMED_DETACHED_GRANDCHILD_SCRIPT], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    ...options,
  });
  return new Promise<NamedDetachedGrandchildTree>((resolve, reject) => {
    const stdout = child.stdout;
    if (!stdout) {
      reject(new Error('named grandchild fixture spawned without a stdout pipe'));
      return;
    }
    let buffered = '';
    const cleanup = () => {
      stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      // The parent never writes again; do not let the pipe pin the event loop.
      (stdout as unknown as { unref?: () => void }).unref?.();
    };
    const onData = (chunk: Buffer | string) => {
      buffered += String(chunk);
      const newline = buffered.indexOf('\n');
      if (newline === -1) return;
      cleanup();
      const grandchildPid = Number.parseInt(buffered.slice(0, newline), 10);
      if (Number.isInteger(grandchildPid) && grandchildPid > 0) resolve({ child, grandchildPid });
      else reject(new Error(`named grandchild fixture reported a non-pid: ${JSON.stringify(buffered)}`));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`named grandchild fixture parent exited before naming its grandchild (code ${code}, signal ${signal})`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    stdout.on('data', onData);
    child.on('exit', onExit);
    child.on('error', onError);
  });
}

/** Best-effort teardown of the grandchild AND the parent; never throws. */
export function reapDetachedGrandchildTree(tree: NamedDetachedGrandchildTree): void {
  for (const pid of [tree.grandchildPid, tree.child.pid]) {
    if (!pid) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
