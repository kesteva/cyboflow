/**
 * processTable unit tests — the shared (pid, ppid) table helpers and the
 * Windows tree-kill primitive the kill ladders consume.
 *
 * Covers the pure parseProcessTable / collectDescendantPids text helpers, the
 * synchronous table fetch against the REAL host process table, and — on win32
 * hosts — killWindowsTree reaping a real parent+grandchild tree.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import {
  parseProcessTable,
  collectDescendantPids,
  type ProcessTableRow,
} from './processTable';
import { listPidPpidTableSync, killWindowsTree } from '../utils/platformProcess';
import { windowsProcessTableCommand } from './winProcessTable';
import { ShellDetector } from '../utils/shellDetector';
import {
  isAlive,
  spawnNamedDetachedGrandchildTree,
  waitUntil,
} from '../__test_fixtures__/processTree';

describe('parseProcessTable', () => {
  it('parses "pid ppid" rows, skipping blanks and malformed lines', () => {
    const out = ['  1   0', ' 320   1', '', 'garbage', '0 5', '  99   1  '].join('\n');
    expect(parseProcessTable(out)).toEqual([
      { pid: 1, ppid: 0 },
      { pid: 320, ppid: 1 },
      { pid: 99, ppid: 1 },
    ]);
  });
});

describe('collectDescendantPids', () => {
  const procs: ProcessTableRow[] = [
    { pid: 500, ppid: 1 },   // the session's shell (root)
    { pid: 501, ppid: 500 }, // direct child (e.g. a dev-server wrapper)
    { pid: 502, ppid: 501 }, // grandchild (e.g. the actual node process)
    { pid: 503, ppid: 502 }, // great-grandchild
    { pid: 999, ppid: 1 },   // unrelated process — must not be swept
  ];

  it('walks the ppid tree and collects every descendant, excluding the root and unrelated pids', () => {
    expect(collectDescendantPids(500, procs).sort((a, b) => a - b)).toEqual([501, 502, 503]);
  });

  it('never traverses or includes pid<=1', () => {
    const withInit: ProcessTableRow[] = [
      { pid: 1, ppid: 0 },
      { pid: 10, ppid: 1 },
    ];
    expect(collectDescendantPids(1, withInit)).toEqual([]);
  });

  it('is cycle-safe (a malformed ppid loop terminates)', () => {
    const cyclic: ProcessTableRow[] = [
      { pid: 10, ppid: 11 },
      { pid: 11, ppid: 10 },
    ];
    expect(collectDescendantPids(10, cyclic).sort((a, b) => a - b)).toEqual([11]);
  });

  it('returns an empty list for a root with no rows in the table', () => {
    expect(collectDescendantPids(999, [])).toEqual([]);
  });
});

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
    const tree = await spawnNamedDetachedGrandchildTree();
    const pid = tree.child.pid;
    expect(pid).toBeTypeOf('number');

    // Positive control: the walk — this file's subject — really finds the
    // grandchild the parent NAMED. Asserting containment rather than a bare
    // count also pins that it found the right process, not a phantom.
    let grandkids: number[] = [];
    for (let i = 0; i < 15 && !grandkids.includes(tree.grandchildPid); i++) {
      await new Promise((r) => setTimeout(r, 200));
      grandkids = collectDescendantPids(pid as number, listPidPpidTableSync());
    }
    expect(grandkids).toContain(tree.grandchildPid);

    killWindowsTree(pid as number);

    // Teardown is asserted over the NAMED pid, never the walked set: a phantom
    // swept up by the walk may outlive the tree and never go dead. See
    // processTree.ts.
    const allDead = await waitUntil(
      () => !isAlive(pid as number) && !isAlive(tree.grandchildPid),
      8000,
    );
    expect(allDead).toBe(true);
  }, 30000);
});

describe('windowsProcessTableCommand', () => {
  it('pins the fixed System32 PowerShell path, never a bare "powershell"', () => {
    const { command, args } = windowsProcessTableCommand('pid-ppid-command');

    expect(command).toBe(ShellDetector.windowsPowerShellPath());
    expect(command).not.toBe('powershell');
    expect(args[0]).toBe('-NoProfile');
    expect(args).toContain('-Command');
  });
});
