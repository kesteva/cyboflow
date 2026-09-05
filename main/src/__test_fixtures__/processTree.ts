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
 * Signal-0 liveness probe, matching the production semantics: ESRCH means
 * dead, and anything else — notably EPERM — means the process is still there.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
