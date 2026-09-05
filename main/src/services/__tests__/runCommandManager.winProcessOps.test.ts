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
import { spawn } from 'node:child_process';
import { RunCommandManager } from '../runCommandManager';
import type { DatabaseService } from '../../database/database';
import { isAlive, spawnDetachedGrandchildTree, waitUntil } from '../../__test_fixtures__/processTree';

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
      const child = spawnDetachedGrandchildTree();
      const pid = child.pid;
      expect(pid).toBeTypeOf('number');

      // The grandchild takes a beat to appear under the child.
      let found: number[] = [];
      const ok = await waitUntil(async () => {
        found = await mgr.getAllDescendantPids(pid as number);
        return found.length >= 1;
      }, 10000);
      expect(ok).toBe(true);
      expect(found.every((k) => isAlive(k))).toBe(true);

      // killEscapedProcesses force-kills the enumerated escapees (the
      // grandchild) and reports them via the zombie event — previously
      // unreachable on win32 because the enumeration was always empty. The
      // child itself is reaped by stopRunCommands' killProcessTree, so the
      // test terminates it directly afterwards.
      const zombied: number[] = [];
      mgr.on('zombie-processes-detected', (payload) => zombied.push(...payload.pids));
      await mgr.killEscapedProcesses('session-under-test', [pid as number]);

      const escapeesDead = await waitUntil(
        () => found.every((g) => !isAlive(g)),
        8000,
      );
      expect(escapeesDead).toBe(true);
      for (const g of found) {
        expect(zombied).toContain(g);
      }

      try {
        process.kill(pid as number);
      } catch {
        /* already dead */
      }
    },
    30000,
  );
});
