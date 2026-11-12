import { describe, it, expect } from 'vitest';
import {
  reconcileWorktreeRegistry,
  loadWorktreeRegistry,
  worktreePathKey,
  type GitWorktreeEntry,
  type RegistryRunRow,
  type RegistrySessionRow,
} from '../worktreeRegistry';

const PROJECT = '/repo/proj';
const wt = (p: string, branch = 'b'): GitWorktreeEntry => ({ path: p, branch });
const sess = (id: string, path: string, o: Partial<RegistrySessionRow> = {}): RegistrySessionRow => ({
  id,
  worktreePath: path,
  inPlace: false,
  isMainRepo: false,
  ...o,
});
const run = (id: string, path: string): RegistryRunRow => ({ id, worktreePath: path });

// `git worktree list --porcelain`-shaped fixture, as WorktreeManager.listWorktrees returns it.
const git = [
  wt(PROJECT, 'main'),
  wt('/wt/session-only'),
  wt('/wt/run-only'),
  wt('/wt/nobody'),
  wt('/wt/both'),
];

function tagOf(entries: ReturnType<typeof reconcileWorktreeRegistry>, path: string) {
  const e = entries.find((x) => x.path === path);
  if (!e) throw new Error(`no entry for ${path}`);
  return e;
}

describe('reconcileWorktreeRegistry', () => {
  const entries = reconcileWorktreeRegistry({
    projectPath: PROJECT,
    gitWorktrees: git,
    sessions: [sess('s1', '/wt/session-only'), sess('s2', '/wt/both')],
    runs: [run('r1', '/wt/run-only'), run('r2', '/wt/both')],
  });

  it('tags session-only ownership as session-owned', () => {
    expect(tagOf(entries, '/wt/session-only')).toMatchObject({ tag: 'session-owned', sessionId: 's1', prunable: true });
  });

  it('tags run-only ownership as run-owned', () => {
    expect(tagOf(entries, '/wt/run-only')).toMatchObject({ tag: 'run-owned', runId: 'r1', prunable: true });
  });

  it('tags a path with no owner row as orphan', () => {
    const e = tagOf(entries, '/wt/nobody');
    expect(e.tag).toBe('orphan');
    expect(e.sessionId).toBeUndefined();
    expect(e.runId).toBeUndefined();
  });

  it('resolves a path owned by both a session and a run to ONE session-owned entry (session wins)', () => {
    const both = entries.filter((e) => e.path === '/wt/both');
    expect(both).toHaveLength(1);
    expect(both[0]).toMatchObject({ tag: 'session-owned', sessionId: 's2', runId: 'r2' });
  });

  it('returns exactly one entry per git-reported path', () => {
    expect(entries.map((e) => e.path)).toEqual(git.map((g) => g.path));
  });

  it('tags an in_place session row as in_place with prunable=false', () => {
    const out = reconcileWorktreeRegistry({
      projectPath: PROJECT,
      gitWorktrees: [wt(PROJECT, 'main')],
      sessions: [sess('ip', PROJECT, { inPlace: true })],
      runs: [],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tag: 'in_place', prunable: false, sessionId: 'ip' });
  });

  it('tags the is_main_repo row as is_main_repo with prunable=false, even when it is the git main worktree', () => {
    const out = reconcileWorktreeRegistry({
      projectPath: PROJECT,
      gitWorktrees: [wt(PROJECT, 'main')],
      sessions: [sess('dash', PROJECT, { isMainRepo: true })],
      runs: [],
    });
    expect(out[0]).toMatchObject({ tag: 'is_main_repo', prunable: false, sessionId: 'dash' });
  });

  it('is_main_repo outranks in_place and any run when they share a path', () => {
    const out = reconcileWorktreeRegistry({
      projectPath: PROJECT,
      gitWorktrees: [wt(PROJECT, 'main')],
      sessions: [sess('ip', PROJECT, { inPlace: true }), sess('dash', PROJECT, { isMainRepo: true })],
      runs: [run('r', PROJECT)],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tag: 'is_main_repo', prunable: false, sessionId: 'dash', runId: 'r' });
  });

  it('never marks the project checkout orphan/prunable, even with no owning row at all', () => {
    const out = reconcileWorktreeRegistry({
      projectPath: PROJECT,
      gitWorktrees: [wt(PROJECT, 'main')],
      sessions: [],
      runs: [],
    });
    expect(out[0]).toMatchObject({ tag: 'is_main_repo', prunable: false });
  });

  it('asserts prunable=false on every in_place/is_main_repo entry across a mixed fixture', () => {
    const mixed = reconcileWorktreeRegistry({
      projectPath: PROJECT,
      gitWorktrees: [...git, wt('/wt/inplace-other')],
      sessions: [sess('dash', PROJECT, { isMainRepo: true }), sess('ip', '/wt/inplace-other', { inPlace: true })],
      runs: [run('r1', '/wt/run-only')],
    });
    const guarded = mixed.filter((e) => e.tag === 'in_place' || e.tag === 'is_main_repo');
    expect(guarded.map((e) => e.tag).sort()).toEqual(['in_place', 'is_main_repo']);
    for (const e of guarded) expect(e.prunable).toBe(false);
  });

  it('does not tag from age/status: a run row at a path keeps it run-owned regardless of anything else', () => {
    const out = reconcileWorktreeRegistry({
      projectPath: PROJECT,
      gitWorktrees: [wt('/wt/x')],
      sessions: [],
      runs: [run('finished-long-ago', '/wt/x')],
    });
    expect(out[0].tag).toBe('run-owned');
  });

  it('ignores owner rows whose path git does not report', () => {
    const out = reconcileWorktreeRegistry({
      projectPath: PROJECT,
      gitWorktrees: [wt('/wt/a')],
      sessions: [sess('ghost', '/wt/ghost')],
      runs: [],
    });
    expect(out.map((e) => e.path)).toEqual(['/wt/a']);
  });

  it('matches paths despite a trailing slash', () => {
    const out = reconcileWorktreeRegistry({
      projectPath: PROJECT,
      gitWorktrees: [wt('/wt/a')],
      sessions: [sess('s', '/wt/a/')],
      runs: [],
    });
    expect(out[0].tag).toBe('session-owned');
  });

  it('matches Windows paths case- and separator-insensitively', () => {
    const out = reconcileWorktreeRegistry(
      {
        projectPath: 'C:/repo/proj',
        gitWorktrees: [wt('C:/repo/wt/a')],
        sessions: [sess('s', 'c:\\repo\\wt\\A')],
        runs: [],
      },
      'win32',
    );
    expect(out[0].tag).toBe('session-owned');
    expect(worktreePathKey('C:\\X\\', 'win32')).toBe('c:/x');
  });
});

describe('loadWorktreeRegistry', () => {
  it('pulls DB rows + git truth and maps snake_case/int flags into the reconciler shape', async () => {
    const out = await loadWorktreeRegistry({
      projectId: 7,
      projectPath: PROJECT,
      worktreeManager: { listWorktrees: async () => [wt(PROJECT, 'main'), wt('/wt/s'), wt('/wt/r'), wt('/wt/o')] },
      database: {
        getSessionWorktreeRefs: (id) => {
          expect(id).toBe(7);
          return [
            { id: 'dash', worktree_path: PROJECT, in_place: 0, is_main_repo: 1 },
            { id: 's', worktree_path: '/wt/s', in_place: null, is_main_repo: null },
          ];
        },
        getRunWorktreeRefs: () => [{ id: 'r', worktree_path: '/wt/r' }],
      },
    });
    expect(out.map((e) => e.tag)).toEqual(['is_main_repo', 'session-owned', 'run-owned', 'orphan']);
  });
});

describe('reconcileWorktreeRegistry — sibling instance claims', () => {
  const base = { projectPath: PROJECT, gitWorktrees: git, sessions: [sess('s1', '/wt/session-only')], runs: [] };

  it("tags a worktree only a sibling's DB references as other-instance, never prunable", () => {
    const entries = reconcileWorktreeRegistry({
      ...base,
      siblingClaims: { claimedPaths: new Map([['/wt/nobody/', '/home/.cyboflow_dev_dmg']]), unreadableDataDirs: [] },
    });
    expect(tagOf(entries, '/wt/nobody')).toMatchObject({
      tag: 'other-instance',
      prunable: false,
      claimedBy: '/home/.cyboflow_dev_dmg',
      claimVerified: true,
    });
    // Unclaimed paths with no row anywhere are still orphans.
    expect(tagOf(entries, '/wt/both').tag).toBe('orphan');
  });

  it('a sibling claim outranks a local owner row (a copied data dir carries the original rows), keeping the owner ids', () => {
    const entries = reconcileWorktreeRegistry({
      ...base,
      siblingClaims: { claimedPaths: new Map([['/wt/session-only', '/home/.cyboflow']]), unreadableDataDirs: [] },
    });
    expect(tagOf(entries, '/wt/session-only')).toMatchObject({
      tag: 'other-instance',
      prunable: false,
      claimVerified: true,
      sessionId: 's1',
    });
  });

  it('never outranks the real checkout guards', () => {
    const entries = reconcileWorktreeRegistry({
      ...base,
      sessions: [sess('s1', '/wt/session-only', { inPlace: true })],
      siblingClaims: { claimedPaths: new Map([['/wt/session-only', '/home/.cyboflow'], [PROJECT, '/home/.cyboflow']]), unreadableDataDirs: [] },
    });
    expect(tagOf(entries, '/wt/session-only').tag).toBe('in_place');
    expect(tagOf(entries, PROJECT).tag).toBe('is_main_repo');
  });

  it('matches by real path: an aliased git path still meets the claim and the local row', () => {
    const entries = reconcileWorktreeRegistry({
      projectPath: PROJECT,
      gitWorktrees: [wt(PROJECT, 'main'), wt('/var/x/theirs'), wt('/var/x/mine')],
      sessions: [sess('s1', '/private/var/x/mine')],
      runs: [],
      siblingClaims: { claimedPaths: new Map([['/private/var/x/theirs', '/home/.cyboflow']]), unreadableDataDirs: [] },
      realPaths: new Map([
        ['/var/x/theirs', '/private/var/x/theirs'],
        ['/var/x/mine', '/private/var/x/mine'],
      ]),
    });
    expect(tagOf(entries, '/var/x/theirs').tag).toBe('other-instance');
    expect(tagOf(entries, '/var/x/mine')).toMatchObject({ tag: 'session-owned', sessionId: 's1' });
  });

  it('fails closed: an unreadable sibling DB turns every would-be orphan into an unverified other-instance', () => {
    const entries = reconcileWorktreeRegistry({
      ...base,
      siblingClaims: { claimedPaths: new Map(), unreadableDataDirs: ['/home/.cyboflow'] },
    });
    const orphans = entries.filter((e) => e.tag === 'orphan');
    expect(orphans).toEqual([]);
    expect(tagOf(entries, '/wt/nobody')).toMatchObject({
      tag: 'other-instance',
      prunable: false,
      claimedBy: '/home/.cyboflow',
      claimVerified: false,
    });
    expect(tagOf(entries, '/wt/session-only')).toMatchObject({ tag: 'other-instance', claimVerified: false, sessionId: 's1' });
    expect(entries.filter((e) => e.prunable)).toEqual([]);
  });

  it('loadWorktreeRegistry resolves git paths and local rows to real paths', async () => {
    const real: Record<string, string> = { '/link/wt': '/real/wt' };
    const entries = await loadWorktreeRegistry({
      database: {
        getSessionWorktreeRefs: () => [{ id: 's1', worktree_path: '/real/wt', in_place: 0, is_main_repo: 0 }],
        getRunWorktreeRefs: () => [],
      },
      worktreeManager: { listWorktrees: async () => [wt(PROJECT, 'main'), wt('/link/wt')] },
      projectId: 1,
      projectPath: PROJECT,
      realPath: async (p) => real[p] ?? null,
    });
    expect(tagOf(entries, '/link/wt')).toMatchObject({ tag: 'session-owned', sessionId: 's1' });
  });

  it('loadWorktreeRegistry threads the sibling claims through', async () => {
    const entries = await loadWorktreeRegistry({
      database: { getSessionWorktreeRefs: () => [], getRunWorktreeRefs: () => [] },
      worktreeManager: { listWorktrees: async () => [wt(PROJECT, 'main'), wt('/wt/theirs')] },
      projectId: 1,
      projectPath: PROJECT,
      readSiblingClaims: async () => ({ claimedPaths: new Map([['/wt/theirs', '/home/.cyboflow']]), unreadableDataDirs: [] }),
    });
    expect(tagOf(entries, '/wt/theirs').tag).toBe('other-instance');
  });
});
