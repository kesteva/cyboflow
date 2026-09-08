/**
 * RunCommandManager — win32 process-ops parity.
 *
 * `getAllDescendantPids` used to shell `ps -o pid= --ppid N` through cmd.exe —
 * dead on Windows, so it ALWAYS returned [] there: the win32 zombie check in
 * killProcessTree falsely reported success and the zombie event was
 * unreachable. It now fetches the shared (pid, ppid) table (PowerShell stand-in)
 * and walks it with the shared processTable helpers. `killEscapedProcesses`
 * likewise ran dead `ps -o pgid=` / `kill -9` sweeps on Windows; it now
 * taskkill-forces the enumerated escapees.
 *
 * Runs only on win32 hosts (where those branches execute); it drives a REAL
 * parent+grandchild node tree through the private primitives.
 */
import { describe, it, expect } from 'vitest';
import { RunCommandManager } from '../runCommandManager';
import type { DatabaseService } from '../../database/database';
import {
  isAlive,
  reapDetachedGrandchildTree,
  spawnNamedDetachedGrandchildTree,
  waitUntil,
} from '../../__test_fixtures__/processTree';

/** Expose the private process-ops primitives, as sibling tests in this repo do. */
interface RunCommandManagerPrivate {
  getAllDescendantPids(parentPid: number): Promise<number[]>;
  killEscapedProcesses(sessionId: string, knownPids: number[]): Promise<void>;
  on(event: string, cb: (payload: { pids: number[] }) => void): void;
}

function makeManager(): RunCommandManagerPrivate {
  return new RunCommandManager({} as unknown as DatabaseService) as unknown as RunCommandManagerPrivate;
}

describe('RunCommandManager — win32 process ops', () => {
  it.skipIf(process.platform !== 'win32')(
    'enumerates a real spawned grandchild tree (no longer always-empty on win32)',
    async () => {
      const mgr = makeManager();
      const tree = await spawnNamedDetachedGrandchildTree();
      const pid = tree.child.pid;
      expect(pid).toBeTypeOf('number');
      try {
        // The grandchild takes a beat to appear under the child. Assertions
        // name the grandchild the fixture reported rather than trusting every
        // pid the table attributes to the child — on a busy runner that set
        // can carry an unrelated orphan under a recycled pid (see the fixture).
        const ok = await waitUntil(async () => {
          const found = await mgr.getAllDescendantPids(pid as number);
          return found.includes(tree.grandchildPid);
        }, 10000);
        expect(ok).toBe(true);
        expect(isAlive(tree.grandchildPid)).toBe(true);

        // killEscapedProcesses force-kills the enumerated escapees (the
        // grandchild) and reports them via the zombie event — previously
        // unreachable on win32 because the enumeration was always empty. The
        // child itself is reaped by stopRunCommands' killProcessTree; here the
        // finally block takes it down.
        const zombied: number[] = [];
        mgr.on('zombie-processes-detected', (payload) => zombied.push(...payload.pids));
        await mgr.killEscapedProcesses('session-under-test', [pid as number]);

        expect(await waitUntil(() => !isAlive(tree.grandchildPid), 8000)).toBe(true);
        expect(zombied).toContain(tree.grandchildPid);
      } finally {
        reapDetachedGrandchildTree(tree);
      }
    },
    30000,
  );
});
