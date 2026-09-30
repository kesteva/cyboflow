import { describe, it, expect, vi } from 'vitest';
import type { GitStatus } from '../../types/session';
import type {
  SystemProcessEntry,
  SystemProcessOwner,
  SystemProcessType,
  SystemWorktreeEntry,
} from '../../orchestrator/systemTypes';
import { DiskUsageService } from '../diskUsageService';
import {
  buildReapManifest,
  reapFingerprintsMatch,
  reapIdentityFingerprint,
  ReapManifestError,
  type ReapManifestDeps,
  type ReapSnapshot,
} from './reapManifest';

function wt(
  path: string,
  tag: 'session-owned' | 'run-owned' | 'orphan' | 'in_place' | 'is_main_repo',
  extra: { sessionId?: string; runId?: string } = {},
): SystemWorktreeEntry {
  const usage = { status: 'queued' as const };
  if (tag === 'in_place' || tag === 'is_main_repo') {
    return { path, branch: 'main', tag, prunable: false, usage, ...extra };
  }
  return { path, branch: `b-${path}`, tag, prunable: true, usage, ...extra };
}

function proc(
  pid: number,
  bucket: 'owned' | 'suspected' | 'orphan',
  worktreePath: string | null,
  processType: SystemProcessType = 'claude-cli',
): SystemProcessEntry {
  const common = {
    pid,
    ppid: 1,
    pcpu: 0,
    pmem: 0,
    etimeSeconds: 10,
    owner: null,
    processType,
    command: `cmd-${pid}`,
    worktreePath,
  };
  return bucket === 'orphan'
    ? { ...common, bucket, sweepEligible: true, instanceId: 'dead' }
    : { ...common, bucket };
}

const foreign = (worktreePath: string | null, processType: SystemProcessType = 'claude-cli'): SystemProcessEntry => ({
  bucket: 'foreign',
  readOnly: true,
  pidLabel: '999',
  display: { cpu: null, mem: null, elapsed: null },
  foreignInstanceId: null,
  processType,
  command: 'foreign',
  worktreePath,
});

const snapshot: ReapSnapshot = {
  generatedAt: 5000,
  worktrees: [
    wt('/wt/orphan-a', 'orphan'),
    wt('/wt/orphan-b', 'orphan'),
    wt('/wt/session', 'session-owned', { sessionId: 's1' }),
    wt('/wt/run', 'run-owned', { runId: 'r1' }),
    wt('/repo', 'is_main_repo'),
    wt('/wt/inplace', 'in_place'),
  ],
  processes: [
    proc(11, 'orphan', '/wt/orphan-a', 'codex-broker'),
    proc(12, 'orphan', null, 'claude-cli'),
    proc(13, 'suspected', '/wt/orphan-a', 'codex-broker'),
    proc(14, 'owned', '/wt/session', 'claude-cli'),
    foreign('/wt/orphan-a', 'codex-broker'),
  ],
};

function makeDeps(over: Partial<ReapManifestDeps> = {}): ReapManifestDeps {
  return {
    measureFresh: vi.fn(async (_path: string) => 1000),
    peekGitStatus: vi.fn(() => null),
    countDescendants: vi.fn(async (pid: number) => pid % 5),
    now: () => 9000,
    ...over,
  };
}

const paths = (m: { targets: Array<{ kind: string; path?: string; pid?: number }> }): string[] =>
  m.targets.map((t) => (t.kind === 'worktree' ? `w:${t.path}` : `p:${t.pid}`)).sort();

describe('buildReapManifest', () => {
  it('reap-all-stale targets only orphan worktrees and orphan processes', async () => {
    const m = await buildReapManifest('reap-all-stale', {}, snapshot, makeDeps());
    // suspected (13), owned (14), foreign, session/run-owned, in_place and main are all absent.
    expect(paths(m)).toEqual(['p:11', 'p:12', 'w:/wt/orphan-a', 'w:/wt/orphan-b']);
    expect(m.kind).toBe('reap-all-stale');
  });

  it('reap-all-stale never includes a suspected/foreign target even when they share a worktree', async () => {
    const m = await buildReapManifest('reap-all-stale', {}, snapshot, makeDeps());
    const pids = m.targets.filter((t) => t.kind === 'process').map((t) => (t.kind === 'process' ? t.bucket : ''));
    expect(pids.every((b) => b === 'orphan')).toBe(true);
  });

  it('row: selects the named worktrees and pids', async () => {
    const m = await buildReapManifest(
      'row',
      { worktreePaths: ['/wt/session'], pids: [13] },
      snapshot,
      makeDeps(),
    );
    expect(paths(m)).toEqual(['p:13', 'w:/wt/session']);
    const suspected = m.targets.find((t) => t.kind === 'process');
    expect(suspected && suspected.kind === 'process' && suspected.taggedAsCyboflow).toBe(false);
  });

  it('row: a foreign row cannot be selected (no pid exists) and unknown targets throw not_found', async () => {
    await expect(
      buildReapManifest('row', { pids: [999] }, snapshot, makeDeps()),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      buildReapManifest('row', { worktreePaths: ['/wt/nope'] }, snapshot, makeDeps()),
    ).rejects.toBeInstanceOf(ReapManifestError);
  });

  it('never yields a worktree target for in_place / is_main_repo', async () => {
    for (const path of ['/repo', '/wt/inplace']) {
      await expect(
        buildReapManifest('row', { worktreePaths: [path] }, snapshot, makeDeps()),
      ).rejects.toMatchObject({ code: 'not_prunable' });
      await expect(
        buildReapManifest('card', { worktreePath: path }, snapshot, makeDeps()),
      ).rejects.toMatchObject({ code: 'not_prunable' });
    }
  });

  it('card: the worktree plus every non-foreign process running in it', async () => {
    const m = await buildReapManifest('card', { worktreePath: '/wt/orphan-a' }, snapshot, makeDeps());
    // 11 (orphan) and 13 (suspected) live there; the foreign broker is excluded.
    expect(paths(m)).toEqual(['p:11', 'p:13', 'w:/wt/orphan-a']);
  });

  it('kill-all-of-type: every non-foreign process of the type, none of the worktrees', async () => {
    const m = await buildReapManifest(
      'kill-all-of-type',
      { processType: 'codex-broker' },
      snapshot,
      makeDeps(),
    );
    expect(paths(m)).toEqual(['p:11', 'p:13']);
    expect(m.reclaimableBytes).toBe(0);
  });

  it('reclaimableBytes comes from a fresh, target-scoped du — not the ambient cache', async () => {
    let size = 100;
    const runDu = vi.fn(async (_path: string) => size);
    const disk = new DiskUsageService({ runDu, sleep: () => Promise.resolve() });
    // Warm the ambient cache at the OLD size.
    disk.getUsage('/wt/orphan-a');
    await vi.waitFor(() => expect(disk.getUsage('/wt/orphan-a')).toMatchObject({ status: 'measured', bytes: 100 }));

    size = 250; // the directory just grew
    expect(disk.getUsage('/wt/orphan-a')).toMatchObject({ bytes: 100 }); // cache is stale

    const deps = makeDeps({ measureFresh: (p) => disk.measureFresh(p) });
    const m = await buildReapManifest('card', { worktreePath: '/wt/orphan-a' }, snapshot, deps);
    const target = m.targets.find((t) => t.kind === 'worktree');
    expect(target && target.kind === 'worktree' && target.reclaimableBytes).toBe(250);
    expect(m.reclaimableBytes).toBe(250);
    // Only the target's own path was ever measured (warm-up + fresh).
    expect(runDu.mock.calls.map((c) => c[0])).toEqual(['/wt/orphan-a', '/wt/orphan-a']);
  });

  it('measures exactly the target paths, once each', async () => {
    const measureFresh = vi.fn(async (_path: string) => 7);
    await buildReapManifest('reap-all-stale', {}, snapshot, makeDeps({ measureFresh }));
    expect(measureFresh.mock.calls.map((c) => c[0]).sort()).toEqual(['/wt/orphan-a', '/wt/orphan-b']);
  });

  it('a failed measurement is null (not 0) and counted as unmeasured', async () => {
    const m = await buildReapManifest(
      'reap-all-stale',
      {},
      snapshot,
      makeDeps({ measureFresh: async (p) => (p === '/wt/orphan-a' ? null : 40) }),
    );
    expect(m.reclaimableBytes).toBe(40);
    expect(m.unmeasuredTargetCount).toBe(1);
    const failed = m.targets.find((t) => t.kind === 'worktree' && t.path === '/wt/orphan-a');
    expect(failed && failed.kind === 'worktree' && failed.reclaimableBytes).toBeNull();
  });

  it('dirty / ahead-of-main come from the git cache and annotate without excluding', async () => {
    const status = (over: Partial<GitStatus>): { status: GitStatus } => ({
      status: { state: 'modified', ...over },
    });
    const peekGitStatus = vi.fn((id: string) =>
      id === 's1' ? status({ hasUncommittedChanges: true, filesChanged: 3, ahead: 2 }) : null,
    );
    const m = await buildReapManifest(
      'row',
      { worktreePaths: ['/wt/session', '/wt/run'] },
      snapshot,
      makeDeps({ peekGitStatus }),
    );
    expect(m.targets).toHaveLength(2); // dirty target is still present
    expect(m.dirtyFileCount).toBe(3);
    expect(m.aheadOfMainCount).toBe(2);
    const dirty = m.targets.find((t) => t.kind === 'worktree' && t.path === '/wt/session');
    expect(dirty).toMatchObject({ dirty: true, dirtyFileCount: 3, aheadOfMain: 2 });
    // Run-owned: no session id, so nothing in the cache to consult → unknown, not clean.
    const run = m.targets.find((t) => t.kind === 'worktree' && t.path === '/wt/run');
    expect(run).toMatchObject({ dirty: null, dirtyFileCount: null, aheadOfMain: null });
    expect(m.dirtyCountUnknownTargetCount).toBe(1);
    expect(peekGitStatus).toHaveBeenCalledTimes(1);
  });

  it('an orphan worktree with no session cache entry is annotated from a direct git probe', async () => {
    const probeWorktreeGit = vi.fn(async (p: string) =>
      p === '/wt/orphan-a' ? { dirty: true, dirtyFileCount: 4, aheadOfMain: 2 } : null,
    );
    const m = await buildReapManifest('reap-all-stale', {}, snapshot, makeDeps({ probeWorktreeGit }));
    const a = m.targets.find((t) => t.kind === 'worktree' && t.path === '/wt/orphan-a');
    expect(a).toMatchObject({ dirty: true, dirtyFileCount: 4, aheadOfMain: 2 });
    // An unreadable path stays unknown (null), never a confident clean.
    const b = m.targets.find((t) => t.kind === 'worktree' && t.path === '/wt/orphan-b');
    expect(b).toMatchObject({ dirty: null, dirtyFileCount: null, aheadOfMain: null });
    expect(m.dirtyFileCount).toBe(4);
    expect(m.aheadOfMainCount).toBe(2);
    expect(m.dirtyCountUnknownTargetCount).toBe(1);
  });

  it('a fresh probe beats a stale cached "clean"; an unreadable path falls back to the cache', async () => {
    const staleClean = () => ({ status: { state: 'clean', filesChanged: 0 } as GitStatus });
    const probed = await buildReapManifest(
      'row',
      { worktreePaths: ['/wt/session'] },
      snapshot,
      makeDeps({
        peekGitStatus: staleClean,
        probeWorktreeGit: async () => ({ dirty: true, dirtyFileCount: 2, aheadOfMain: 0 }),
      }),
    );
    expect(probed.targets[0]).toMatchObject({ dirty: true, dirtyFileCount: 2 });
    const fallback = await buildReapManifest(
      'row',
      { worktreePaths: ['/wt/session'] },
      snapshot,
      makeDeps({ peekGitStatus: staleClean, probeWorktreeGit: async () => null }),
    );
    expect(fallback.targets[0]).toMatchObject({ dirty: false, dirtyFileCount: 0 });
  });

  it('untracked-only work is dirty with an unavailable count, never a confident zero', async () => {
    // GitStatusManager sets hasUntrackedFiles but its filesChanged excludes untracked files.
    const peekGitStatus = () => ({
      status: { state: 'untracked', hasUntrackedFiles: true, filesChanged: 0 } as GitStatus,
    });
    const m = await buildReapManifest(
      'row',
      { worktreePaths: ['/wt/session'] },
      snapshot,
      makeDeps({ peekGitStatus }),
    );
    expect(m.targets[0]).toMatchObject({ dirty: true, dirtyFileCount: null });
    expect(m.dirtyCountUnknownTargetCount).toBe(1);
    expect(m.dirtyFileCount).toBe(0); // lower bound; the unknown count flags it
  });

  it('a clean cached worktree reports a real zero count', async () => {
    const peekGitStatus = () => ({ status: { state: 'clean', filesChanged: 0 } as GitStatus });
    const m = await buildReapManifest(
      'row',
      { worktreePaths: ['/wt/session'] },
      snapshot,
      makeDeps({ peekGitStatus }),
    );
    expect(m.targets[0]).toMatchObject({ dirty: false, dirtyFileCount: 0 });
    expect(m.dirtyCountUnknownTargetCount).toBe(0);
  });

  it('same snapshot generation but a changed measured size yields a different id', async () => {
    const at = (bytes: number) =>
      buildReapManifest('card', { worktreePath: '/wt/orphan-b' }, snapshot, makeDeps({ measureFresh: async () => bytes }));
    const [a, b, a2] = [await at(100), await at(200), await at(100)];
    expect(a.id).not.toBe(b.id);
    expect(a.id).toBe(a2.id);
  });

  it('changed git annotation or descendant count within one generation yields a different id', async () => {
    const base = await buildReapManifest('reap-all-stale', {}, snapshot, makeDeps());
    const moreKids = await buildReapManifest(
      'reap-all-stale',
      {},
      snapshot,
      makeDeps({ countDescendants: async () => 7 }),
    );
    expect(moreKids.id).not.toBe(base.id);
    const dirtyGit = { peekGitStatus: () => ({ status: { state: 'modified', filesChanged: 1 } as GitStatus }) };
    const w1 = await buildReapManifest('row', { worktreePaths: ['/wt/session'] }, snapshot, makeDeps());
    const w2 = await buildReapManifest('row', { worktreePaths: ['/wt/session'] }, snapshot, makeDeps(dirtyGit));
    expect(w2.id).not.toBe(w1.id);
  });

  it('descendantPidCount is populated per process target via the injected helper', async () => {
    const countDescendants = vi.fn(async (pid: number) => (pid === 11 ? 4 : 1));
    const m = await buildReapManifest('reap-all-stale', {}, snapshot, makeDeps({ countDescendants }));
    const p11 = m.targets.find((t) => t.kind === 'process' && t.pid === 11);
    expect(p11 && p11.kind === 'process' && p11.descendantPidCount).toBe(4);
    expect(m.descendantPidCount).toBe(5);
    expect(countDescendants.mock.calls.map((c) => c[0]).sort()).toEqual([11, 12]);
  });

  it('carries a stable id and the snapshot generation it was built from', async () => {
    const a = await buildReapManifest('reap-all-stale', {}, snapshot, makeDeps());
    const b = await buildReapManifest('reap-all-stale', {}, snapshot, makeDeps({ now: () => 12345 }));
    expect(a.id).toBe(b.id);
    expect(a.snapshotGeneratedAt).toBe(5000);
    expect(a.builtAt).toBe(9000);
    const other = await buildReapManifest('reap-all-stale', {}, { ...snapshot, generatedAt: 6000 }, makeDeps());
    expect(other.id).not.toBe(a.id);
    const different = await buildReapManifest('card', { worktreePath: '/wt/orphan-b' }, snapshot, makeDeps());
    expect(different.id).not.toBe(a.id);
  });

  it('alsoDeleteBranch defaults false and is true only when explicitly requested', async () => {
    const deflt = await buildReapManifest('reap-all-stale', {}, snapshot, makeDeps());
    expect(deflt.alsoDeleteBranch).toBe(false);
    const yes = await buildReapManifest('reap-all-stale', {}, snapshot, makeDeps(), { alsoDeleteBranch: true });
    expect(yes.alsoDeleteBranch).toBe(true);
    expect(yes.id).not.toBe(deflt.id);
    const truthy = await buildReapManifest('reap-all-stale', {}, snapshot, makeDeps(), {
      alsoDeleteBranch: 'yes' as unknown as boolean,
    });
    expect(truthy.alsoDeleteBranch).toBe(false);
  });

  it('is JSON-safe and round-trips unchanged', async () => {
    const m = await buildReapManifest('reap-all-stale', {}, snapshot, makeDeps());
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });

  it('an empty stale set yields a valid empty manifest', async () => {
    const m = await buildReapManifest(
      'reap-all-stale',
      {},
      { generatedAt: 1, worktrees: [wt('/repo', 'is_main_repo')], processes: [foreign(null)] },
      makeDeps(),
    );
    expect(m.targets).toEqual([]);
    expect(m.reclaimableBytes).toBe(0);
  });
});

describe('reapIdentityFingerprint owner identity', () => {
  const withOwner = (owner: SystemProcessOwner): ReapSnapshot => ({
    generatedAt: 5000,
    worktrees: [],
    processes: [{ ...proc(12, 'orphan', null), owner } as SystemProcessEntry],
  });
  const fp = (owner: SystemProcessOwner) =>
    reapIdentityFingerprint('reap-all-stale', {}, withOwner(owner));

  it('cli owners whose ids differ only in colon placement do not match', () => {
    const a = fp({ kind: 'cli', panelId: 'a:b', sessionId: 'c' });
    const b = fp({ kind: 'cli', panelId: 'a', sessionId: 'b:c' });
    expect(a[0].key).not.toBe(b[0].key);
    expect(reapFingerprintsMatch(a, b)).toBe(false);
  });

  it('run-shell owners whose ids differ only in colon placement do not match', () => {
    const a = fp({ kind: 'run-shell', runId: 'a:b', terminalId: 'c' });
    const b = fp({ kind: 'run-shell', runId: 'a', terminalId: 'b:c' });
    expect(a[0].key).not.toBe(b[0].key);
    expect(reapFingerprintsMatch(a, b)).toBe(false);
  });

  it('identical owners still match (negative control for the two cases above)', () => {
    const owner: SystemProcessOwner = { kind: 'cli', panelId: 'a:b', sessionId: 'c' };
    expect(reapFingerprintsMatch(fp(owner), fp({ ...owner }))).toBe(true);
  });
});
