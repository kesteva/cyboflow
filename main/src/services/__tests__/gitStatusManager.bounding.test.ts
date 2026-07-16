/**
 * Bounding tests for GitStatusManager (TASK: git-status async + bounding, fix 2).
 *
 * Converting the git-status refresh spawns from sync `execSync` to async
 * `runGitAsync` removes the accidental global mutex execSync gave us — without
 * bounding, N sessions x ~9 concurrent git spawns can race on index.lock and
 * produce a spurious "modified" status, or write stale results out of order.
 * These tests exercise the two bounding mechanisms added alongside the async
 * conversion:
 *
 * 1. In-flight fetch coalescing (fetchGitStatusCoalesced): two concurrent
 *    refreshes of the SAME session/worktree share one underlying git fetch
 *    instead of racing two independent ones.
 * 2. Generation-stamped cache writes (beginFetch/updateCache): a fetch that
 *    was superseded by a newer one must not clobber the newer result when it
 *    eventually completes (out-of-order last-write-wins prevention).
 *
 * The git layer (fastCheckWorkingDirectory et al.) is mocked so timing is
 * fully controllable and deterministic — SessionManager/WorktreeManager are
 * faked to the minimal shape GitStatusManager actually calls, following the
 * `as unknown as X` fake-collaborator convention used elsewhere in this suite
 * (see claudeCodeManager.autoModeClassifier.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitStatus, Session } from '../../types/session';
import type { SessionManager } from '../sessionManager';
import type { WorktreeManager } from '../worktreeManager';
import type { GitDiffManager } from '../gitDiffManager';
import type { GitIndexStatus } from '../gitPlumbingCommands';

vi.mock('../gitPlumbingCommands', () => ({
  fastCheckWorkingDirectory: vi.fn(),
  fastGetAheadBehind: vi.fn(async () => ({ ahead: 0, behind: 0 })),
  fastGetDiffStats: vi.fn(async () => ({ additions: 0, deletions: 0, filesChanged: 0 })),
}));

import { fastCheckWorkingDirectory } from '../gitPlumbingCommands';
import { GitStatusManager } from '../gitStatusManager';

const FAKE_SESSION: Session = {
  id: 's1',
  name: 'fake',
  worktreePath: '/fake/worktree',
  prompt: '',
  status: 'ready',
  output: [],
  jsonMessages: [],
  createdAt: new Date(),
};

function makeFakeCollaborators() {
  const sessionManager = {
    getSession: vi.fn(async () => FAKE_SESSION),
    getProjectForSession: vi.fn(() => ({ id: 1, path: '/fake/project' })),
    getAllSessions: vi.fn(async () => [FAKE_SESSION]),
  } as unknown as SessionManager;

  const worktreeManager = {
    getProjectMainBranch: vi.fn(async () => 'main'),
  } as unknown as WorktreeManager;

  const gitDiffManager = {} as unknown as GitDiffManager;

  return { sessionManager, worktreeManager, gitDiffManager };
}

/** Exposes the private generation/cache/debounce internals under test without `any`. */
type GitStatusManagerInternals = {
  beginFetch: (sessionId: string) => number;
  updateCache: (sessionId: string, status: GitStatus, generation?: number) => void;
  DEBOUNCE_MS: number;
};

beforeEach(() => {
  vi.mocked(fastCheckWorkingDirectory).mockReset();
});

describe('GitStatusManager — in-flight fetch coalescing', () => {
  it('two concurrent getGitStatus calls for the same session share ONE underlying fetch, never a spurious "modified"', async () => {
    let callCount = 0;
    let resolveFirstCall!: (v: GitIndexStatus) => void;
    const firstCall = new Promise<GitIndexStatus>((resolve) => {
      resolveFirstCall = resolve;
    });

    vi.mocked(fastCheckWorkingDirectory).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return firstCall;
      }
      // A second, UNCOALESCED concurrent spawn would race on index.lock and
      // could observe a spurious dirty state — simulate that here so the
      // assertion below fails loudly if coalescing regresses.
      return { hasModified: true, hasStaged: false, hasUntracked: false, hasConflicts: false };
    });

    const { sessionManager, worktreeManager, gitDiffManager } = makeFakeCollaborators();
    const manager = new GitStatusManager(sessionManager, worktreeManager, gitDiffManager);

    // Both calls fire in the same synchronous tick, before either awaits past
    // the coalescing check — this is the race the mandatory bounding covers.
    const p1 = manager.getGitStatus('s1');
    const p2 = manager.getGitStatus('s1');

    resolveFirstCall({ hasModified: false, hasStaged: false, hasUntracked: false, hasConflicts: false });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(callCount).toBe(1);
    expect(r1?.hasUncommittedChanges).toBe(false);
    expect(r2?.hasUncommittedChanges).toBe(false);
    expect(r1).toEqual(r2);
  });
});

describe('GitStatusManager — stale-generation cache write suppression', () => {
  it('drops an older-generation fetch completion that arrives after a newer generation has already written the cache', async () => {
    const { sessionManager, worktreeManager, gitDiffManager } = makeFakeCollaborators();
    const manager = new GitStatusManager(sessionManager, worktreeManager, gitDiffManager);
    const internals = manager as unknown as GitStatusManagerInternals;

    let resolveSlowFetch!: (v: GitIndexStatus) => void;
    const slowFetch = new Promise<GitIndexStatus>((resolve) => {
      resolveSlowFetch = resolve;
    });
    vi.mocked(fastCheckWorkingDirectory).mockImplementation(async () => slowFetch);

    // Start a fetch — this stamps generation 1 and suspends awaiting the
    // (still-pending) mocked fastCheckWorkingDirectory call.
    const slowFetchPromise = manager.getGitStatus('s1');

    // While generation 1 is still in flight, a separate cache-bound update
    // (e.g. updateGitStatusAfterRebase's lightweight path) starts and
    // completes first, stamping + writing generation 2.
    const newerGeneration = internals.beginFetch('s1');
    const newerStatus: GitStatus = { state: 'ahead', lastChecked: new Date().toISOString() };
    internals.updateCache('s1', newerStatus, newerGeneration);

    // Now let the stale generation-1 fetch complete.
    resolveSlowFetch({ hasModified: false, hasStaged: false, hasUntracked: false, hasConflicts: false });
    await slowFetchPromise;

    // The stale completion must NOT have overwritten the newer cache write —
    // a fresh getGitStatus call within the cache TTL reads straight from cache.
    const finalStatus = await manager.getGitStatus('s1');
    expect(finalStatus?.state).toBe('ahead');
  });

  it('a same-or-newer generation write is NOT dropped', () => {
    const { sessionManager, worktreeManager, gitDiffManager } = makeFakeCollaborators();
    const manager = new GitStatusManager(sessionManager, worktreeManager, gitDiffManager);
    const internals = manager as unknown as GitStatusManagerInternals;

    const gen1 = internals.beginFetch('s2');
    const status: GitStatus = { state: 'clean', lastChecked: new Date().toISOString() };
    internals.updateCache('s2', status, gen1);

    // No newer generation has started since — this write must land.
    return manager.getGitStatus('s2').then((result) => {
      expect(result?.state).toBe('clean');
    });
  });
});

describe('GitStatusManager — concurrency-cap deadlock regression', () => {
  it('rapid repeated refreshSessionGitStatus calls for the same session do not leak the shared MAX_CONCURRENT_OPERATIONS cap', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(fastCheckWorkingDirectory).mockResolvedValue({
        hasModified: false,
        hasStaged: false,
        hasUntracked: false,
        hasConflicts: false,
      });

      const { sessionManager, worktreeManager, gitDiffManager } = makeFakeCollaborators();
      const manager = new GitStatusManager(sessionManager, worktreeManager, gitDiffManager);
      const internals = manager as unknown as GitStatusManagerInternals;

      // Drive this through the REAL production entry points that fire rapid same-session
      // refreshes — setActiveSession + handleVisibilityChange — rather than calling
      // refreshSessionGitStatus directly, so this test exercises the actual call sites
      // the reviewed diff touched.
      manager.setActiveSession('burst-session');

      // Fire 5 rapid "window became visible" events for the SAME active session —
      // simulating repeated file-watcher/focus fires within one debounce window. Each
      // call to refreshSessionGitStatus underneath clearTimeout()s the prior call's
      // still-pending debounce timer, so the prior call's Promise — whose `resolve`
      // lives inside that now-cleared setTimeout callback — never settles. That
      // orphaning is pre-existing debounce behavior, independent of this fix; only the
      // LAST call's timer survives to fire.
      //
      // The regression this covers: the reviewed diff briefly wrapped
      // `executeWithLimit(() => refreshSessionGitStatus(...))` at call sites like this
      // one. Because an orphaned call's Promise never settles, executeWithLimit's
      // `activeOperations` slot for it was held FOREVER — after
      // MAX_CONCURRENT_OPERATIONS such orphans, the shared spin-gate wedges and every
      // future fetch, for every session, hangs. The fix moves the ONE executeWithLimit
      // call inside fetchGitStatusCoalesced, bounding the git spawn itself (which
      // always settles) instead of the debounced-refresh wrapper (which sometimes
      // doesn't) — so refreshSessionGitStatus is never itself wrapped anymore.
      for (let i = 0; i < 5; i++) {
        manager.handleVisibilityChange(false); // isHidden=false => window visible => refresh
      }

      await vi.advanceTimersByTimeAsync(internals.DEBOUNCE_MS);

      // Prove the cap was NOT leaked: MAX_CONCURRENT_OPERATIONS-many fresh fetches for
      // OTHER sessions must all still complete promptly (activeOperations recovered to
      // 0). Before the fix, these would hang forever once the cap was exhausted.
      const otherResults = await Promise.all(
        ['s-a', 's-b', 's-c'].map((id) => manager.getGitStatus(id))
      );
      expect(otherResults.every((r) => r?.state === 'clean')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
