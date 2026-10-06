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
  parseEtime,
  parsePsOutputWithCpuMem,
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

describe('parseEtime (shared)', () => {
  it('parses the three macOS shapes and rejects the rest', () => {
    expect(parseEtime('05:30')).toBe(330);
    expect(parseEtime('01:02:15')).toBe(3735);
    expect(parseEtime('2-03:04:05')).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5);
    expect(parseEtime('garbage')).toBeNull();
    expect(parseEtime('99:99')).toBeNull();
  });
});

describe('parsePsOutputWithCpuMem', () => {
  it('parses a normal six-column row', () => {
    const rows = parsePsOutputWithCpuMem('  123   1  12.5  0.3 01:02:15 /usr/bin/node server.js --port 1\n');
    expect(rows).toEqual([
      { pid: 123, ppid: 1, pcpu: 12.5, pmem: 0.3, etimeSeconds: 3735, command: '/usr/bin/node server.js --port 1' },
    ]);
  });

  it('yields etimeSeconds null (row kept) for a time-shaped but unparseable etime', () => {
    const rows = parsePsOutputWithCpuMem('10 1 0.0 0.1 99:99 /bin/foo\n');
    expect(rows).toHaveLength(1);
    expect(rows[0].etimeSeconds).toBeNull();
    expect(rows[0].command).toBe('/bin/foo');
  });

  it('yields null (never 0/NaN) for `-` pcpu/pmem', () => {
    const rows = parsePsOutputWithCpuMem('2 1 - - 05:30 kernel_task\n');
    expect(rows).toEqual([
      { pid: 2, ppid: 1, pcpu: null, pmem: null, etimeSeconds: 330, command: 'kernel_task' },
    ]);
  });

  it('keeps the row and yields null for a non-numeric (not shifted) pcpu/pmem token', () => {
    const rows = parsePsOutputWithCpuMem('4 1 12,5 abc 00:10 /bin/foo\n8 1 1.5 0,3 00:10 /bin/bar\n');
    expect(rows).toEqual([
      { pid: 4, ppid: 1, pcpu: null, pmem: null, etimeSeconds: 10, command: '/bin/foo' },
      { pid: 8, ppid: 1, pcpu: 1.5, pmem: null, etimeSeconds: 10, command: '/bin/bar' },
    ]);
  });

  it('skips a row shifted by a silently dropped column instead of mis-parsing it', () => {
    // pcpu column dropped: pmem lands in pcpu, etime in pmem.
    expect(parsePsOutputWithCpuMem('10 1 0.3 05:30 /bin/foo bar\n')).toEqual([]);
    // etime column dropped: the command's first word lands in the etime slot.
    expect(parsePsOutputWithCpuMem('10 1 0.0 0.3 /bin/foo bar baz\n')).toEqual([]);
  });

  it('skips blank and malformed lines without affecting good rows', () => {
    const rows = parsePsOutputWithCpuMem('\nnot a row\n0 1 0.0 0.0 00:01 zero-pid\n7 1 1.0 2.0 00:01 ok\n');
    expect(rows.map((r) => r.pid)).toEqual([7]);
  });
});
