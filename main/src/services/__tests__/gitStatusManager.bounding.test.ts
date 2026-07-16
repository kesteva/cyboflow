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

// Override the three spawn helpers but KEEP the real module's other exports —
// crucially GitOperationalError, which gitStatusManager does `instanceof` against.
// A bare factory that omits it would make that check `instanceof undefined` and
// crash the operational-failure path at runtime.
vi.mock('../gitPlumbingCommands', async () => {
  const actual = await vi.importActual<typeof import('../gitPlumbingCommands')>('../gitPlumbingCommands');
  return {
    ...actual,
    fastCheckWorkingDirectory: vi.fn(),
    fastGetAheadBehind: vi.fn(async () => ({ ahead: 0, behind: 0 })),
    fastGetDiffStats: vi.fn(async () => ({ additions: 0, deletions: 0, filesChanged: 0 })),
  };
});

import { fastCheckWorkingDirectory, fastGetAheadBehind, GitOperationalError } from '../gitPlumbingCommands';
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
  MAX_CONCURRENT_OPERATIONS: number;
  cache: Record<string, { status: GitStatus; lastChecked: number }>;
};

beforeEach(() => {
  vi.mocked(fastCheckWorkingDirectory).mockReset();
  vi.mocked(fastGetAheadBehind).mockReset();
  vi.mocked(fastGetAheadBehind).mockResolvedValue({ ahead: 0, behind: 0 });
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

describe('GitStatusManager — quick-check burst bounding (Codex finding 1)', () => {
  it('refreshAllSessions with populated caches keeps concurrent quick-check git children within the cap', async () => {
    vi.useFakeTimers();
    try {
      const SESSION_COUNT = 12; // > MAX_CONCURRENT_OPERATIONS (3), so the cap is exercised
      const sessions: Session[] = Array.from({ length: SESSION_COUNT }, (_, i) => ({
        ...FAKE_SESSION,
        id: `s${i}`,
        worktreePath: `/fake/worktree/${i}`,
      }));

      // Track concurrent in-flight fastCheckWorkingDirectory calls — the git spawns the
      // quick check (hasGitStatusChanged) issues. Each call is held open until we release
      // it, so overlapping acquisitions are directly observable; `peak` records the max.
      let active = 0;
      let peak = 0;
      let resolvers: Array<() => void> = [];
      vi.mocked(fastCheckWorkingDirectory).mockImplementation(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => resolvers.push(resolve));
        active--;
        return { hasModified: false, hasStaged: false, hasUntracked: false, hasConflicts: false };
      });

      const sessionManager = {
        getSession: vi.fn(async (id: string) => sessions.find((s) => s.id === id) ?? null),
        getProjectForSession: vi.fn(() => ({ id: 1, path: '/fake/project' })),
        getAllSessions: vi.fn(async () => sessions),
      } as unknown as SessionManager;
      const worktreeManager = {
        getProjectMainBranch: vi.fn(async () => 'main'),
      } as unknown as WorktreeManager;
      const gitDiffManager = {} as unknown as GitDiffManager;

      const manager = new GitStatusManager(sessionManager, worktreeManager, gitDiffManager);
      const internals = manager as unknown as GitStatusManagerInternals;
      const cap = internals.MAX_CONCURRENT_OPERATIONS;

      // Populate a cache for every session so hasGitStatusChanged runs its quick check —
      // an EMPTY cache short-circuits to `return true` and spawns nothing, which would
      // hide the very burst under test.
      for (const s of sessions) {
        internals.cache[s.id] = {
          status: {
            state: 'clean',
            lastChecked: new Date().toISOString(),
            hasUncommittedChanges: false,
            hasUntrackedFiles: false,
          },
          lastChecked: Date.now(),
        };
      }

      const done = manager.refreshAllSessions();

      // Fire every session's debounce timer — all quick checks are now scheduled at once.
      await vi.advanceTimersByTimeAsync(internals.DEBOUNCE_MS);

      // Drain: release the in-flight batch, then advance the executeWithLimit spin-poll
      // (50ms) so queued quick checks acquire the freed slots. Repeat until none remain.
      // Without the cap, ALL 12 fastCheck calls would be in flight after the debounce
      // advance above and `peak` would reach 12; the cap holds it at `cap`.
      let guard = 0;
      while (resolvers.length > 0 && guard++ < 100) {
        const batch = resolvers;
        resolvers = [];
        batch.forEach((r) => r());
        await vi.advanceTimersByTimeAsync(50);
      }
      await done;

      expect(peak).toBeGreaterThan(0); // sanity: quick checks actually ran
      expect(peak).toBeLessThanOrEqual(cap);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GitStatusManager — preserve last-known status on operational git failure (Codex finding 2)', () => {
  /** Exposes the private fetchGitStatus + cache for the preservation assertion, without `any`. */
  type FetchInternals = {
    fetchGitStatus: (sessionId: string) => Promise<GitStatus | null>;
    cache: Record<string, { status: GitStatus; lastChecked: number }>;
  };

  it('an ahead/behind timeout returns null from fetchGitStatus so the caller preserves the cached ahead status', async () => {
    const { sessionManager, worktreeManager, gitDiffManager } = makeFakeCollaborators();
    const manager = new GitStatusManager(sessionManager, worktreeManager, gitDiffManager);
    const internals = manager as unknown as FetchInternals;

    // Seed a known-good cached status: 2 commits ahead of main, ready to merge.
    const cachedAhead: GitStatus = {
      state: 'ahead',
      ahead: 2,
      lastChecked: new Date().toISOString(),
      isReadyToMerge: true,
      hasUncommittedChanges: false,
      hasUntrackedFiles: false,
    };
    internals.cache['s1'] = { status: cachedAhead, lastChecked: Date.now() };

    // Working dir is clean, so the fetch reaches the state-critical ahead/behind
    // call — which times out (operational failure), NOT a semantic zero result.
    vi.mocked(fastCheckWorkingDirectory).mockResolvedValue({
      hasModified: false,
      hasStaged: false,
      hasUntracked: false,
      hasConflicts: false,
    });
    vi.mocked(fastGetAheadBehind).mockRejectedValue(
      new GitOperationalError('git rev-list timed out', new Error('killed'))
    );

    const fetched = await internals.fetchGitStatus('s1');

    // Contract: operational failure => null (caller's `if (status)` skips updateCache).
    expect(fetched).toBeNull();
    // The cache still holds the known-good ahead status — NOT flipped to clean/unknown.
    expect(internals.cache['s1'].status.state).toBe('ahead');
    expect(internals.cache['s1'].status.ahead).toBe(2);
    expect(internals.cache['s1'].status.isReadyToMerge).toBe(true);
  });

  it('a non-operational (semantic) ahead/behind zero result is still cached normally', async () => {
    const { sessionManager, worktreeManager, gitDiffManager } = makeFakeCollaborators();
    const manager = new GitStatusManager(sessionManager, worktreeManager, gitDiffManager);
    const internals = manager as unknown as FetchInternals;

    vi.mocked(fastCheckWorkingDirectory).mockResolvedValue({
      hasModified: false,
      hasStaged: false,
      hasUntracked: false,
      hasConflicts: false,
    });
    // A genuine {0,0} (branch equals base) resolves normally — must produce a real
    // 'clean' status, proving the preserve path is scoped to operational failures only.
    vi.mocked(fastGetAheadBehind).mockResolvedValue({ ahead: 0, behind: 0 });

    const fetched = await internals.fetchGitStatus('s2');
    expect(fetched).not.toBeNull();
    expect(fetched?.state).toBe('clean');
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
