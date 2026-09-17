/**
 * WorktreeChangeNotifier — "something in this session's worktree changed, go
 * refetch" for the right-rail Diff tab.
 *
 * The Diff tab fetches its grouped diff once per mount and only refetched on a
 * base change or its own Commit/Restore; every edit that landed on disk while
 * it was open (an agent writing files, the user in an editor, `git add` in a
 * terminal) stayed invisible until the tab was remounted. The automatic
 * git-status pipeline that could have told it (GitStatusManager's watcher +
 * auto-refresh) is switched off behind `GIT_STATUS_BADGE_ENABLED` because its
 * only consumer, the sidebar badge, is gone — and that pipeline watched EVERY
 * active session. This notifier is the narrow replacement: it watches ONE
 * worktree per live subscriber (the rail subscribes while its Diff tab is
 * mounted for the selected session, and unsubscribes when it isn't), so the
 * cost is one watcher set for the tree the user is actually looking at, and
 * zero when they aren't.
 *
 * Two sources feed one coalesced signal per session:
 *   1. `GitFileWatcher` in `'always'` mode — the worktree's files, with its
 *      existing pruned topology (root non-recursive + one recursive watcher
 *      per top-level dir, `node_modules`/`.git` never attached) and its
 *      1.5 s debounce. `'always'` because the rail's fetch is the check: a
 *      tree that just became clean must refresh too.
 *   2. A single NON-recursive `fs.watch` on the resolved git dir (`git
 *      rev-parse --absolute-git-dir` — for a linked worktree that is
 *      `<main>/.git/worktrees/<name>`, not the `.git` file). The file watcher
 *      deliberately never looks inside `.git`, but the index (`git add`),
 *      `HEAD` (commit / checkout), and `MERGE_HEAD` (a merge starting or
 *      ending) are exactly what moves paths between the Staged / Unstaged /
 *      Committed groups. Non-recursive keeps `objects/` churn out; the names
 *      are filtered to the handful that matter.
 *
 * Listeners get NO payload — the consumer refetches; the diff response is the
 * truth, not a second status computed here. Subscriptions are refcounted per
 * session so two rails (two windows) share one watcher set.
 */
import { watch, type FSWatcher } from 'fs';
import { GitFileWatcher } from './gitFileWatcher';
import { runGitAsync } from '../utils/runGit';
import type { Logger } from '../utils/logger';

type Listener = () => void;

interface WatchedWorktree {
  worktreePath: string;
  listeners: Set<Listener>;
  gitDirWatcher: FSWatcher | null;
  /** Coalesces both sources into one notification per burst. */
  notifyTimer: NodeJS.Timeout | null;
  /** Set once stop() ran, so a late gitdir resolution never attaches a watcher. */
  stopped: boolean;
}

/** Git-dir entries whose change moves paths between diff groups. */
const GIT_DIR_FILES_OF_INTEREST: ReadonlySet<string> = new Set([
  'index',
  'HEAD',
  'ORIG_HEAD',
  'MERGE_HEAD',
  'REBASE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'packed-refs',
]);

/** How long to hold a burst of events before notifying (both sources). */
const NOTIFY_COALESCE_MS = 300;

export class WorktreeChangeNotifier {
  private readonly watched = new Map<string, WatchedWorktree>();
  private readonly fileWatcher: GitFileWatcher;

  constructor(private readonly logger?: Logger) {
    this.fileWatcher = new GitFileWatcher(logger, 'always');
    this.fileWatcher.on('needs-refresh', (sessionId: string) => this.scheduleNotify(sessionId));
  }

  /**
   * Start delivering change notifications for `sessionId`'s worktree to
   * `listener`. Returns the unsubscribe; the watcher set is torn down when the
   * last listener leaves. Never throws — a worktree that cannot be watched
   * simply never notifies (the rail's mount fetch and focus refetch still run).
   */
  subscribe(sessionId: string, worktreePath: string, listener: Listener): () => void {
    let entry = this.watched.get(sessionId);
    if (!entry || entry.worktreePath !== worktreePath) {
      if (entry) this.stop(sessionId, entry);
      entry = { worktreePath, listeners: new Set(), gitDirWatcher: null, notifyTimer: null, stopped: false };
      this.watched.set(sessionId, entry);
      this.start(sessionId, entry);
    }
    entry.listeners.add(listener);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.watched.get(sessionId);
      if (!current || current !== entry) return;
      current.listeners.delete(listener);
      if (current.listeners.size === 0) {
        this.stop(sessionId, current);
        this.watched.delete(sessionId);
      }
    };
  }

  /** Number of worktrees currently being watched (test/diagnostic seam). */
  get watchedCount(): number {
    return this.watched.size;
  }

  /** Tear every watcher down (app shutdown). */
  stopAll(): void {
    for (const [sessionId, entry] of this.watched) this.stop(sessionId, entry);
    this.watched.clear();
  }

  private start(sessionId: string, entry: WatchedWorktree): void {
    this.fileWatcher.startWatching(sessionId, entry.worktreePath);

    // The git dir is resolved asynchronously (one git spawn, once per
    // subscribe); the file watcher above is already live meanwhile.
    runGitAsync(entry.worktreePath, ['rev-parse', '--absolute-git-dir'])
      .then((out) => {
        const gitDir = out.trim();
        if (!gitDir || entry.stopped) return;
        try {
          entry.gitDirWatcher = watch(gitDir, { recursive: false }, (_eventType, filename) => {
            if (!filename) return;
            if (GIT_DIR_FILES_OF_INTEREST.has(filename.toString())) this.scheduleNotify(sessionId);
          });
          // A stop() that raced the resolution: close what we just opened.
          if (entry.stopped) {
            entry.gitDirWatcher.close();
            entry.gitDirWatcher = null;
          }
        } catch (error) {
          this.logger?.warn(
            `[WorktreeChangeNotifier] Could not watch git dir ${gitDir} for session ${sessionId}: ${String(error)}`,
          );
        }
      })
      .catch((error: unknown) => {
        this.logger?.warn(
          `[WorktreeChangeNotifier] Could not resolve git dir for session ${sessionId}: ${String(error)}`,
        );
      });
  }

  private stop(sessionId: string, entry: WatchedWorktree): void {
    entry.stopped = true;
    this.fileWatcher.stopWatching(sessionId);
    if (entry.gitDirWatcher) {
      try {
        entry.gitDirWatcher.close();
      } catch {
        // Already closed / gone — nothing to release.
      }
      entry.gitDirWatcher = null;
    }
    if (entry.notifyTimer) {
      clearTimeout(entry.notifyTimer);
      entry.notifyTimer = null;
    }
    entry.listeners.clear();
  }

  private scheduleNotify(sessionId: string): void {
    const entry = this.watched.get(sessionId);
    if (!entry || entry.stopped) return;
    if (entry.notifyTimer) return; // a burst is already pending
    entry.notifyTimer = setTimeout(() => {
      entry.notifyTimer = null;
      if (entry.stopped) return;
      for (const listener of entry.listeners) {
        try {
          listener();
        } catch (error) {
          this.logger?.warn(`[WorktreeChangeNotifier] listener threw for session ${sessionId}: ${String(error)}`);
        }
      }
    }, NOTIFY_COALESCE_MS);
  }
}
