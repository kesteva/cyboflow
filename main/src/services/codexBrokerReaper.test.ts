/**
 * CodexBrokerReaper unit tests.
 *
 * These drive the reaper through its injected `listProcesses`/`killPid`/`pathExists`
 * seams — no real `ps`/`process.kill`/`fs` — so the broker matching, tree collection,
 * and fail-soft loop are asserted deterministically. The critical regressions
 * covered: the empty-worktree match-all footgun, that the DETACHED `codex`/`node_repl`
 * descendants are collected and killed (not just the broker), that a live worktree's
 * broker is spared by the boot sweep, and that a `ps` failure or a per-PID kill
 * throw never aborts reaping.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CodexBrokerReaper,
  parseBrokerCwd,
  parsePsOutput,
  collectProcessTree,
  type CodexBrokerProcess,
} from './codexBrokerReaper';

/** Build a lister that returns a fixed process table. */
function fixedLister(rows: CodexBrokerProcess[]): () => Promise<CodexBrokerProcess[]> {
  return () => Promise.resolve(rows);
}

/** The command line a Codex broker for `cwd` would show in `ps`. */
function brokerCommand(cwd: string): string {
  return (
    `/Users/me/.nvm/versions/node/v22.15.1/bin/node ` +
    `/Users/me/.claude/plugins/cache/openai-codex/codex/1.0.5/scripts/app-server-broker.mjs ` +
    `serve --endpoint unix:/var/folders/T/cxc-abc/broker.sock --cwd ${cwd} --pid-file /var/folders/T/cxc-abc/broker.pid`
  );
}

const WT = '/Users/me/dev/cyboflow/worktrees/quick-A';

/**
 * A canonical leaked tree for worktree `cwd`: broker (root, ppid=1 detached) →
 * `codex` helper → two `node_repl` workers. `base` offsets the pids so multiple
 * trees don't collide.
 */
function leakedTree(cwd: string, base: number): CodexBrokerProcess[] {
  return [
    { pid: base, ppid: 1, command: brokerCommand(cwd) },
    { pid: base + 1, ppid: base, command: 'codex app-server' },
    { pid: base + 2, ppid: base + 1, command: '/Applications/Codex.app/.../node_repl' },
    { pid: base + 3, ppid: base + 1, command: 'node ./mcp/server.mjs' },
  ];
}

describe('parseBrokerCwd', () => {
  it('extracts the --cwd value from a broker command line', () => {
    expect(parseBrokerCwd(brokerCommand(WT))).toBe(WT);
  });

  it('returns null for a non-broker command (no marker)', () => {
    expect(parseBrokerCwd(`node --cwd ${WT} something-else.mjs`)).toBeNull();
  });

  it('returns null for a broker with no --cwd arg', () => {
    expect(parseBrokerCwd('node app-server-broker.mjs serve --endpoint unix:/x')).toBeNull();
  });
});

describe('parsePsOutput', () => {
  it('parses pid, ppid, and command; skips blanks and pid<=0', () => {
    const out = ['  1     0 /sbin/launchd', ' 320   1 node broker', '', 'garbage', '0 0 kernel'].join('\n');
    const rows = parsePsOutput(out);
    expect(rows).toEqual([
      { pid: 1, ppid: 0, command: '/sbin/launchd' },
      { pid: 320, ppid: 1, command: 'node broker' },
    ]);
  });
});

describe('collectProcessTree', () => {
  it('collects a root plus all descendants', () => {
    const procs = leakedTree(WT, 100);
    const tree = collectProcessTree([100], procs);
    expect([...tree].sort((a, b) => a - b)).toEqual([100, 101, 102, 103]);
  });

  it('never traverses or includes pid<=1 (no launchd/kernel sweep)', () => {
    const procs: CodexBrokerProcess[] = [
      { pid: 1, ppid: 0, command: 'launchd' },
      { pid: 320, ppid: 1, command: 'logd' }, // child of launchd — must NOT be swept
      { pid: 500, ppid: 320, command: 'grandchild' },
    ];
    // Root is launchd itself — guarded out entirely.
    expect(collectProcessTree([1], procs).size).toBe(0);
    // Root is a normal pid; its subtree is collected but the launchd branch is not.
    expect([...collectProcessTree([320], procs)].sort((a, b) => a - b)).toEqual([320, 500]);
  });

  it('returns a root even when it has no rows in the table', () => {
    expect([...collectProcessTree([999], [])]).toEqual([999]);
  });

  it('is cycle-safe (a malformed ppid loop terminates)', () => {
    const procs: CodexBrokerProcess[] = [
      { pid: 10, ppid: 11, command: 'a' },
      { pid: 11, ppid: 10, command: 'b' },
    ];
    expect([...collectProcessTree([10], procs)].sort((a, b) => a - b)).toEqual([10, 11]);
  });
});

describe('CodexBrokerReaper.reapForWorktree', () => {
  it('kills the broker AND its detached descendant tree, sparing other worktrees', async () => {
    const killPid = vi.fn<(pid: number) => void>();
    const rows: CodexBrokerProcess[] = [
      ...leakedTree(WT, 100), // match: 100..103
      ...leakedTree('/Users/me/dev/cyboflow/worktrees/quick-B', 200), // different worktree — spare
      { pid: 300, ppid: 1, command: `vim ${WT}/index.ts` }, // path present, not a broker — spare
    ];
    const reaper = new CodexBrokerReaper({ listProcesses: fixedLister(rows), killPid });

    await reaper.reapForWorktree(WT);

    expect(killPid.mock.calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual([100, 101, 102, 103]);
  });

  it('matches a broker whose cwd is UNDER the worktree (nested run dir)', async () => {
    const killPid = vi.fn<(pid: number) => void>();
    const nested = `${WT}/.cyboflow/worktrees/sprint/abcd1234`;
    const reaper = new CodexBrokerReaper({
      listProcesses: fixedLister(leakedTree(nested, 400)),
      killPid,
    });

    await reaper.reapForWorktree(WT);

    expect(killPid.mock.calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual([400, 401, 402, 403]);
  });

  it('does NOT match a sibling worktree that shares a path prefix', async () => {
    const killPid = vi.fn<(pid: number) => void>();
    // `${WT}-2` starts with `${WT}` textually but is a different worktree — the
    // separator check must reject it.
    const reaper = new CodexBrokerReaper({
      listProcesses: fixedLister(leakedTree(`${WT}-2`, 500)),
      killPid,
    });

    await reaper.reapForWorktree(WT);

    expect(killPid).not.toHaveBeenCalled();
  });

  it('tolerates a trailing slash on the worktree path', async () => {
    const killPid = vi.fn<(pid: number) => void>();
    const reaper = new CodexBrokerReaper({ listProcesses: fixedLister(leakedTree(WT, 100)), killPid });

    await reaper.reapForWorktree(`${WT}/`);

    expect(killPid.mock.calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual([100, 101, 102, 103]);
  });

  it('kills NOTHING when the worktree path is empty (match-all footgun guard)', async () => {
    const killPid = vi.fn<(pid: number) => void>();
    const reaper = new CodexBrokerReaper({
      listProcesses: fixedLister([...leakedTree(WT, 100), ...leakedTree('/other', 200)]),
      killPid,
    });

    await reaper.reapForWorktree('');
    await reaper.reapForWorktree('   ');
    // @ts-expect-error — exercising the undefined guard at runtime.
    await reaper.reapForWorktree(undefined);

    expect(killPid).not.toHaveBeenCalled();
  });
});

describe('CodexBrokerReaper.sweepOrphans', () => {
  it('kills brokers whose cwd is gone and spares brokers of a live worktree', async () => {
    const killPid = vi.fn<(pid: number) => void>();
    const liveWt = '/Users/me/dev/cyboflow/worktrees/live-one';
    const deadWt = '/Users/me/dev/cyboflow/worktrees/dead-one';
    const rows: CodexBrokerProcess[] = [...leakedTree(liveWt, 100), ...leakedTree(deadWt, 200)];
    const reaper = new CodexBrokerReaper({
      listProcesses: fixedLister(rows),
      killPid,
      pathExists: (p) => p === liveWt, // only the live worktree exists on disk
    });

    await reaper.sweepOrphans();

    expect(killPid.mock.calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual([200, 201, 202, 203]);
  });

  it('ignores non-broker processes entirely (only brokers gate the sweep)', async () => {
    const killPid = vi.fn<(pid: number) => void>();
    const rows: CodexBrokerProcess[] = [
      { pid: 700, ppid: 1, command: 'python3 -m http.server 8123 --directory /gone/dir' },
      { pid: 701, ppid: 1, command: 'node some-other-daemon.mjs --cwd /also/gone' },
    ];
    const reaper = new CodexBrokerReaper({
      listProcesses: fixedLister(rows),
      killPid,
      pathExists: () => false, // every path is "gone", yet none is a Codex broker
    });

    await reaper.sweepOrphans();

    expect(killPid).not.toHaveBeenCalled();
  });
});

describe('CodexBrokerReaper.sweepForWorktreeRoots', () => {
  const ROOT = '/Users/me/dev/cyboflow/worktrees';

  it('kills a broker under a root even though its worktree STILL EXISTS', async () => {
    // The regression this sweep exists for: sweepOrphans spares this broker
    // (cwd resolves) and reapForWorktree never fires (worktree never removed),
    // so before this seam it leaked forever.
    const killPid = vi.fn<(pid: number) => void>();
    const reaper = new CodexBrokerReaper({
      listProcesses: fixedLister(leakedTree(`${ROOT}/quick-A`, 100)),
      killPid,
      pathExists: () => true, // every worktree is alive on disk
    });

    await reaper.sweepForWorktreeRoots([ROOT]);

    expect(killPid.mock.calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual([100, 101, 102, 103]);
  });

  it('SPARES a broker outside the roots (another tool’s live session)', async () => {
    // The safety property: a Warp / plain-terminal Claude session's broker is
    // indistinguishable by age and may be mid-turn. It must never be matched.
    const killPid = vi.fn<(pid: number) => void>();
    const rows: CodexBrokerProcess[] = [
      ...leakedTree(`${ROOT}/quick-A`, 100),
      ...leakedTree('/Users/me/.warp/worktrees/cyboflow/ridge-ravine', 200),
    ];
    const reaper = new CodexBrokerReaper({
      listProcesses: fixedLister(rows),
      killPid,
      pathExists: () => true,
    });

    await reaper.sweepForWorktreeRoots([ROOT]);

    expect(killPid.mock.calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual([100, 101, 102, 103]);
  });

  it('does NOT match a root that merely shares a path prefix', async () => {
    const killPid = vi.fn<(pid: number) => void>();
    const reaper = new CodexBrokerReaper({
      listProcesses: fixedLister(leakedTree(`${ROOT}-archive/quick-A`, 100)),
      killPid,
      pathExists: () => true,
    });

    await reaper.sweepForWorktreeRoots([ROOT]);

    expect(killPid).not.toHaveBeenCalled();
  });

  it('matches across MULTIPLE roots (per-project worktree folder + .cyboflow layout)', async () => {
    const killPid = vi.fn<(pid: number) => void>();
    const nested = '/Users/me/dev/other/.cyboflow/worktrees';
    const rows: CodexBrokerProcess[] = [
      ...leakedTree(`${ROOT}/quick-A`, 100),
      ...leakedTree(`${nested}/sprint/ab12cd34`, 200),
      ...leakedTree('/Users/me/elsewhere/tree', 300),
    ];
    const reaper = new CodexBrokerReaper({
      listProcesses: fixedLister(rows),
      killPid,
      pathExists: () => true,
    });

    await reaper.sweepForWorktreeRoots([ROOT, nested]);

    expect(killPid.mock.calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual([
      100, 101, 102, 103, 200, 201, 202, 203,
    ]);
  });

  it('kills NOTHING when given no roots (match-all footgun guard)', async () => {
    const killPid = vi.fn<(pid: number) => void>();
    const reaper = new CodexBrokerReaper({
      listProcesses: fixedLister(leakedTree(`${ROOT}/quick-A`, 100)),
      killPid,
      pathExists: () => true,
    });

    await reaper.sweepForWorktreeRoots([]);

    expect(killPid).not.toHaveBeenCalled();
  });

  it('drops blank/whitespace roots rather than treating them as match-all', async () => {
    const killPid = vi.fn<(pid: number) => void>();
    const reaper = new CodexBrokerReaper({
      listProcesses: fixedLister(leakedTree('/Users/me/elsewhere/tree', 100)),
      killPid,
      pathExists: () => true,
    });

    await reaper.sweepForWorktreeRoots(['', '   ']);

    expect(killPid).not.toHaveBeenCalled();
  });

  it('tolerates a trailing slash on a root', async () => {
    const killPid = vi.fn<(pid: number) => void>();
    const reaper = new CodexBrokerReaper({
      listProcesses: fixedLister(leakedTree(`${ROOT}/quick-A`, 100)),
      killPid,
      pathExists: () => true,
    });

    await reaper.sweepForWorktreeRoots([`${ROOT}/`]);

    expect(killPid.mock.calls.map((c) => c[0]).sort((a, b) => a - b)).toEqual([100, 101, 102, 103]);
  });
});

describe('CodexBrokerReaper fail-soft', () => {
  it('does not throw when listing processes fails', async () => {
    const reaper = new CodexBrokerReaper({
      listProcesses: () => Promise.reject(new Error('ps blew up')),
      killPid: vi.fn(),
    });
    await expect(reaper.reapForWorktree(WT)).resolves.toBeUndefined();
    await expect(reaper.sweepOrphans()).resolves.toBeUndefined();
  });

  it('continues the kill loop when one PID throws (dead/reparented)', async () => {
    const killed: number[] = [];
    const killPid = vi.fn<(pid: number) => void>((pid) => {
      if (pid === 101) throw new Error('No such process');
      killed.push(pid);
    });
    const reaper = new CodexBrokerReaper({ listProcesses: fixedLister(leakedTree(WT, 100)), killPid });

    await reaper.reapForWorktree(WT);

    // 101 threw but 100/102/103 were still attempted.
    expect(killed.sort((a, b) => a - b)).toEqual([100, 102, 103]);
    expect(killPid).toHaveBeenCalledTimes(4);
  });
});
