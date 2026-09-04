/**
 * processTable unit tests — the shared (pid, ppid) table helpers and the
 * Windows tree-kill primitive the kill ladders consume.
 *
 * parseProcessTable and collectDescendantPids are covered by
 * terminalSessionManager's suite, which reaches them through its re-exports
 * and pins more of their edges than a second copy here did. This file covers
 * what only it can: the synchronous table fetch against the REAL host process
 * table, and — on win32 hosts — killWindowsTree reaping a real
 * parent+grandchild tree.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import {
  parseProcessTable,
  collectDescendantPids,
  type ProcessTableRow,
} from './processTable';
import { listPidPpidTableSync, killWindowsTree } from '../utils/platformProcess';
import { isAlive, spawnDetachedGrandchildTree, waitUntil } from '../__test_fixtures__/processTree';

describe('listPidPpidTableSync', () => {
  it('round-trips a real spawned child into the (pid, ppid) table on this host', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      detached: true,
    });
    try {
      expect(child.pid).toBeTypeOf('number');
      const seen = await waitUntil(
        () => listPidPpidTableSync().some((row) => row.pid === child.pid && row.ppid === process.pid),
        5000,
      );
      expect(seen).toBe(true);
    } finally {
      try {
        child.kill();
      } catch {
        /* already dead */
      }
    }
  }, 10000);
});

describe('killWindowsTree', () => {
  // 99999999 is far beyond any real Windows pid; on POSIX hosts taskkill does
  // not exist at all. Either way the failure must be swallowed, not thrown.
  it('swallows a failed kill (already-dead pid / missing taskkill)', () => {
    expect(() => killWindowsTree(99999999)).not.toThrow();
  });

  it.skipIf(process.platform !== 'win32')('reaps a real spawned parent+grandchild tree on win32', async () => {
    // A node child that spawns its own long-lived detached grandchild — the
    // shape a CLI/app-server presents. taskkill /T /F must take BOTH.
    const child = spawnDetachedGrandchildTree();
    const pid = child.pid;
    expect(pid).toBeTypeOf('number');

    // Positive control: the grandchild really shows up in the shared table.
    let grandkids: number[] = [];
    for (let i = 0; i < 15 && grandkids.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 200));
      grandkids = collectDescendantPids(pid as number, listPidPpidTableSync());
    }
    expect(grandkids.length).toBeGreaterThanOrEqual(1);

    killWindowsTree(pid as number);

    const allDead = await waitUntil(
      () => !isAlive(pid as number) && grandkids.every((g) => !isAlive(g)),
      8000,
    );
    expect(allDead).toBe(true);
  }, 30000);
});
