import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { withTempDir } from '../../__test_fixtures__/tmp';
import type { GitIndexStatus } from '../gitPlumbingCommands';

vi.mock('../gitPlumbingCommands', () => ({
  fastCheckWorkingDirectory: vi.fn(),
}));

import { fastCheckWorkingDirectory } from '../gitPlumbingCommands';
import { GitFileWatcher } from '../gitFileWatcher';

/**
 * These tests lock the watch-attachment POLICY (which paths get an fs.watch)
 * rather than FSEvents delivery, which is timing-flaky and platform-dependent.
 * The policy is the fix: never point a recursive watcher at node_modules / .git,
 * whose churn during a sibling lane's install/build otherwise floods the callback.
 */
describe('GitFileWatcher attachment policy', () => {
  let watcher: GitFileWatcher | undefined;

  afterEach(() => {
    watcher?.stopAll();
    watcher = undefined;
  });

  function scaffold(root: string): void {
    for (const dir of ['node_modules', '.git', 'src', 'frontend']) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    // A nested file under node_modules to prove we don't descend into it, and a
    // top-level file to prove non-directory entries never get a recursive watch.
    writeFileSync(join(root, 'node_modules', 'dep.js'), '// noise');
    writeFileSync(join(root, 'package.json'), '{}');
  }

  it('watches root + each non-excluded top-level dir, never node_modules/.git', async () => {
    await withTempDir('gitfilewatcher-policy-', (root) => {
      scaffold(root);
      watcher = new GitFileWatcher();
      watcher.startWatching('s1', root);

      const topDirs = watcher.getWatchedTopDirs('s1');
      expect(topDirs).toBeDefined();
      expect(new Set(topDirs)).toEqual(new Set(['src', 'frontend']));
      expect(topDirs).not.toContain('node_modules');
      expect(topDirs).not.toContain('.git');

      // Root (non-recursive) + src + frontend = 3 watchers total.
      expect(watcher.getStats().totalWatchers).toBe(3);
    });
  });

  it('attaches no recursive watchers when only excluded dirs exist (root only)', async () => {
    await withTempDir('gitfilewatcher-excluded-only-', (root) => {
      mkdirSync(join(root, 'node_modules'), { recursive: true });
      mkdirSync(join(root, '.git'), { recursive: true });
      watcher = new GitFileWatcher();
      watcher.startWatching('s1', root);

      expect(watcher.getWatchedTopDirs('s1')).toEqual([]);
      // Only the root non-recursive watcher.
      expect(watcher.getStats().totalWatchers).toBe(1);
    });
  });

  it('stopWatching closes every watcher and forgets the session (no fd leak)', async () => {
    await withTempDir('gitfilewatcher-stop-', (root) => {
      scaffold(root);
      watcher = new GitFileWatcher();
      watcher.startWatching('s1', root);
      expect(watcher.getStats().totalWatched).toBe(1);
      expect(watcher.getStats().totalWatchers).toBe(3);

      watcher.stopWatching('s1');
      expect(watcher.getStats().totalWatched).toBe(0);
      expect(watcher.getStats().totalWatchers).toBe(0);
      expect(watcher.getWatchedTopDirs('s1')).toBeUndefined();
    });
  });

  it('starting a second session replaces the first watcher set cleanly', async () => {
    await withTempDir('gitfilewatcher-restart-', (root) => {
      scaffold(root);
      watcher = new GitFileWatcher();
      watcher.startWatching('s1', root);
      // Re-starting the same session id must not double-watch.
      watcher.startWatching('s1', root);

      expect(watcher.getStats().totalWatched).toBe(1);
      expect(watcher.getStats().totalWatchers).toBe(3);
    });
  });
});

/**
 * Concurrency-contract tests for GitFileWatcher's refresh-check pipeline
 * (F3: sync execSync -> async fastCheckWorkingDirectory conversion).
 *
 * checkIfRefreshNeeded() now awaits gitPlumbingCommands.fastCheckWorkingDirectory
 * (runGitAsync) instead of running four sequential sync execSync spawns. Because
 * the check is now async, a debounce firing while a prior check for the same
 * session is still in flight could otherwise race a second concurrent git spawn
 * for the same worktree. These tests cover the reviewed contract:
 *
 * 1. Single-flight: only one checkIfRefreshNeeded() runs at a time per session.
 * 2. Dirty-bit rerun: a debounce collision during an in-flight check schedules
 *    exactly ONE follow-up check once the in-flight one completes (no dropped
 *    events).
 * 3. Stop-during-in-flight: stopWatching() while a check is in flight suppresses
 *    both the emit and the dirty-triggered rerun for the stopped session.
 *
 * fastCheckWorkingDirectory is mocked (controllable resolution timing); the
 * private per-session state is exercised via an `as unknown as` cast, following
 * the GitStatusManagerInternals convention in gitStatusManager.bounding.test.ts.
 */
const CLEAN_STATUS: GitIndexStatus = {
  hasModified: false,
  hasStaged: false,
  hasUntracked: false,
  hasConflicts: false,
};

/** Mirrors the private WatchedSession fields this test needs to read/seed. */
interface TestWatchedSession {
  sessionId: string;
  worktreePath: string;
  lastModified: number;
  pendingRefresh: boolean;
  checkInFlight: boolean;
  dirtyWhileInFlight: boolean;
}

/** Exposes the private session map + refresh-check method under test, without `any`. */
type GitFileWatcherInternals = {
  watchedSessions: Map<string, TestWatchedSession>;
  performRefreshCheck: (sessionId: string) => Promise<void>;
};

function internalsOf(watcher: GitFileWatcher): GitFileWatcherInternals {
  return watcher as unknown as GitFileWatcherInternals;
}

/** Seeds a session directly into the private map — bypasses startWatching's real fs.watch. */
function seedSession(watcher: GitFileWatcher, sessionId: string, worktreePath = '/fake/worktree'): TestWatchedSession {
  const session: TestWatchedSession = {
    sessionId,
    worktreePath,
    lastModified: Date.now(),
    pendingRefresh: true, // a change is already pending, as handleFileChange would set
    checkInFlight: false,
    dirtyWhileInFlight: false,
  };
  internalsOf(watcher).watchedSessions.set(sessionId, session);
  return session;
}

/** A fastCheckWorkingDirectory mock whose calls resolve only when the test says so. */
function makeControllableCheck() {
  let concurrent = 0;
  let maxConcurrent = 0;
  const resolvers: Array<(status: GitIndexStatus) => void> = [];
  const impl = vi.fn(() => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    return new Promise<GitIndexStatus>((resolve) => {
      resolvers.push((status) => {
        concurrent--;
        resolve(status);
      });
    });
  });
  return { impl, resolvers, getMaxConcurrent: () => maxConcurrent };
}

beforeEach(() => {
  vi.mocked(fastCheckWorkingDirectory).mockReset();
});

describe('GitFileWatcher — single-flight guarantee', () => {
  it('a second performRefreshCheck while one is in flight does not spawn a second concurrent git check', async () => {
    const { impl, resolvers, getMaxConcurrent } = makeControllableCheck();
    vi.mocked(fastCheckWorkingDirectory).mockImplementation(impl);

    const watcher = new GitFileWatcher();
    const internals = internalsOf(watcher);
    const session = seedSession(watcher, 's1');

    const firstCheck = internals.performRefreshCheck('s1');
    await vi.waitFor(() => expect(resolvers.length).toBe(1));
    expect(session.checkInFlight).toBe(true);

    // Simulate the debounce timer re-firing (e.g. a slow git repo) while the
    // first check is still awaiting fastCheckWorkingDirectory.
    session.pendingRefresh = true;
    await internals.performRefreshCheck('s1');

    // Guarded: no second git spawn, just the dirty bit set for a follow-up.
    expect(impl).toHaveBeenCalledTimes(1);
    expect(session.dirtyWhileInFlight).toBe(true);

    resolvers[0](CLEAN_STATUS);
    await vi.waitFor(() => expect(impl).toHaveBeenCalledTimes(2));
    resolvers[1](CLEAN_STATUS);
    await firstCheck;

    expect(getMaxConcurrent()).toBe(1);
  });
});

describe('GitFileWatcher — dirty-bit rerun', () => {
  it('a change that collides with an in-flight check triggers exactly one follow-up check', async () => {
    const { impl, resolvers } = makeControllableCheck();
    vi.mocked(fastCheckWorkingDirectory).mockImplementation(impl);

    const watcher = new GitFileWatcher();
    const internals = internalsOf(watcher);
    const session = seedSession(watcher, 's1');
    const emitted: string[] = [];
    watcher.on('needs-refresh', (id: string) => emitted.push(id));

    const firstCheck = internals.performRefreshCheck('s1');
    await vi.waitFor(() => expect(resolvers.length).toBe(1));

    // Collide once while in flight.
    session.pendingRefresh = true;
    await internals.performRefreshCheck('s1');

    resolvers[0](CLEAN_STATUS); // first check resolves clean -> no emit, but dirty bit reruns
    await vi.waitFor(() => expect(resolvers.length).toBe(2));

    resolvers[1]({ ...CLEAN_STATUS, hasModified: true }); // follow-up resolves dirty -> emits
    await firstCheck;

    expect(impl).toHaveBeenCalledTimes(2); // exactly one follow-up, not more
    expect(emitted).toEqual(['s1']);
    expect(session.checkInFlight).toBe(false);
    expect(session.dirtyWhileInFlight).toBe(false);
    expect(session.pendingRefresh).toBe(false);

    // No further collisions occurred, so a third check must not be spawned even
    // though the loop had a chance to re-check dirtyWhileInFlight after the 2nd run.
    expect(impl).toHaveBeenCalledTimes(2);
  });
});

describe('GitFileWatcher — stop-during-in-flight', () => {
  it('stopWatching mid-check suppresses both the emit and the dirty-triggered rerun', async () => {
    const { impl, resolvers } = makeControllableCheck();
    vi.mocked(fastCheckWorkingDirectory).mockImplementation(impl);

    const watcher = new GitFileWatcher();
    const internals = internalsOf(watcher);
    seedSession(watcher, 's1');
    const emitted: string[] = [];
    watcher.on('needs-refresh', (id: string) => emitted.push(id));

    const firstCheck = internals.performRefreshCheck('s1');
    await vi.waitFor(() => expect(resolvers.length).toBe(1));

    // A change collides while in flight (would normally trigger one rerun)...
    const session = internals.watchedSessions.get('s1')!;
    session.pendingRefresh = true;
    await internals.performRefreshCheck('s1');
    expect(session.dirtyWhileInFlight).toBe(true);

    // ...but the session is stopped before the in-flight check resolves.
    watcher.stopWatching('s1');
    expect(internals.watchedSessions.has('s1')).toBe(false);

    resolvers[0]({ ...CLEAN_STATUS, hasModified: true }); // would have emitted, had the session survived
    await firstCheck;

    expect(emitted).toEqual([]); // no emit for a stopped session
    expect(impl).toHaveBeenCalledTimes(1); // no dirty rerun spawned after stop
  });
});
