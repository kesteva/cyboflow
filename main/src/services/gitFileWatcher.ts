import { EventEmitter } from 'events';
import { watch, FSWatcher, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { execSync, ExtendedExecSyncOptions } from '../utils/commandExecutor';
import type { Logger } from '../utils/logger';

interface WatchedSession {
  sessionId: string;
  worktreePath: string;
  // One FSWatcher for the worktree root (non-recursive) plus one recursive
  // watcher per non-excluded top-level directory. See startWatching for why we
  // no longer point a single recursive watch at the whole worktree.
  watchers: FSWatcher[];
  // Top-level directory names already covered by a recursive watcher, so a
  // newly-created top-level dir can be attached without double-watching.
  watchedTopDirs: Set<string>;
  lastModified: number;
  pendingRefresh: boolean;
}

/**
 * Top-level directories never worth watching: they are massive, churn hard
 * during installs/builds (a sibling sprint lane running `pnpm build`/`pnpm test`
 * floods FSEvents), and are already gitignored / not working-tree paths. A
 * single recursive `fs.watch` over the whole worktree cannot prune them at the
 * source, so we exclude them by never attaching a watcher to them at all.
 */
const HARD_EXCLUDED_TOP_DIRS = new Set(['node_modules', '.git']);

/**
 * Smart file watcher that detects when git status actually needs refreshing
 * 
 * Key optimizations:
 * 1. Uses native fs.watch for efficient file monitoring
 * 2. Filters out events that don't affect git status
 * 3. Batches rapid file changes
 * 4. Uses git update-index to quickly check if index is dirty
 */
export class GitFileWatcher extends EventEmitter {
  private watchedSessions: Map<string, WatchedSession> = new Map();
  private refreshDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly DEBOUNCE_MS = 1500; // 1.5 second debounce for file changes
  private readonly IGNORE_PATTERNS = [
    '.git/',
    'node_modules/',
    '.DS_Store',
    'thumbs.db',
    '*.swp',
    '*.swo',
    '*~',
    '.#*',
    '#*#'
  ];

  constructor(private logger?: Logger) {
    super();
    this.setMaxListeners(100);
  }

  /**
   * Start watching a session's worktree for changes
   */
  startWatching(sessionId: string, worktreePath: string): void {
    // Stop existing watcher if any
    this.stopWatching(sessionId);

    this.logger?.info(`[GitFileWatcher] Starting watch for session ${sessionId} at ${worktreePath}`);

    // We deliberately do NOT do a single `watch(worktreePath, { recursive: true })`.
    // That points one FSEvents stream at the entire tree — including node_modules,
    // whose churn during a sibling lane's install/build floods the callback with
    // events we only discard afterwards. Instead: watch the root non-recursively
    // (top-level files + detecting new top-level dirs) and attach one recursive
    // watcher per top-level directory except the hard-excluded giants. Filenames
    // from a subdirectory watch are relative to that subdir, so we re-prefix them
    // to keep shouldIgnoreFile / handleFileChange operating on worktree-relative paths.
    const session: WatchedSession = {
      sessionId,
      worktreePath,
      watchers: [],
      watchedTopDirs: new Set(),
      lastModified: Date.now(),
      pendingRefresh: false
    };
    this.watchedSessions.set(sessionId, session);

    try {
      const rootWatcher = watch(worktreePath, { recursive: false }, (eventType, filename) => {
        if (!filename) return;
        const name = filename.toString();
        // A newly-appeared top-level directory won't be covered by an existing
        // recursive watcher — attach one lazily (excluded giants stay excluded).
        // Only 'rename' events create/remove entries; gating here avoids a
        // statSync on every content-change of a top-level file.
        if (eventType === 'rename') {
          this.attachTopDirWatcher(sessionId, name);
        }
        this.handleFileChange(sessionId, name, eventType);
      });
      session.watchers.push(rootWatcher);
    } catch (error) {
      this.logger?.error(`[GitFileWatcher] Failed to watch worktree root for session ${sessionId}:`, error as Error);
    }

    let topEntries: string[] = [];
    try {
      topEntries = readdirSync(worktreePath, { withFileTypes: true })
        .filter(e => e.isDirectory() && !HARD_EXCLUDED_TOP_DIRS.has(e.name))
        .map(e => e.name);
    } catch (error) {
      this.logger?.error(`[GitFileWatcher] Failed to enumerate top-level dirs for session ${sessionId}:`, error as Error);
    }

    for (const dirName of topEntries) {
      this.attachTopDirWatcher(sessionId, dirName);
    }
  }

  /**
   * Attach a recursive watcher for a single top-level directory of the session's
   * worktree, unless it is hard-excluded or already watched. Idempotent — safe to
   * call for every root event.
   */
  private attachTopDirWatcher(sessionId: string, dirName: string): void {
    const session = this.watchedSessions.get(sessionId);
    if (!session) return;
    if (HARD_EXCLUDED_TOP_DIRS.has(dirName) || session.watchedTopDirs.has(dirName)) return;

    const fullPath = join(session.worktreePath, dirName);
    try {
      if (!statSync(fullPath).isDirectory()) return;
    } catch {
      // Race: entry removed between the event and this stat — nothing to watch.
      return;
    }

    try {
      const watcher = watch(fullPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // Re-prefix so downstream sees a worktree-relative path (e.g. "src/foo.ts").
        this.handleFileChange(sessionId, join(dirName, filename.toString()), eventType);
      });
      session.watchedTopDirs.add(dirName);
      session.watchers.push(watcher);
    } catch (error) {
      this.logger?.error(`[GitFileWatcher] Failed to watch top-level dir ${dirName} for session ${sessionId}:`, error as Error);
    }
  }

  /**
   * Stop watching a session's worktree
   */
  stopWatching(sessionId: string): void {
    const session = this.watchedSessions.get(sessionId);
    if (session) {
      for (const watcher of session.watchers) {
        try {
          watcher.close();
        } catch (error) {
          this.logger?.error(`[GitFileWatcher] Error closing a watcher for session ${sessionId}:`, error as Error);
        }
      }
      session.watchers = [];
      session.watchedTopDirs.clear();
      this.watchedSessions.delete(sessionId);
      
      // Clear any pending refresh timer
      const timer = this.refreshDebounceTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        this.refreshDebounceTimers.delete(sessionId);
      }
      
      this.logger?.info(`[GitFileWatcher] Stopped watching session ${sessionId}`);
    }
  }

  /**
   * Stop all watchers
   */
  stopAll(): void {
    for (const sessionId of this.watchedSessions.keys()) {
      this.stopWatching(sessionId);
    }
  }

  /**
   * Handle a file change event
   */
  private handleFileChange(sessionId: string, filename: string, eventType: string): void {
    // Ignore changes to files that don't affect git status
    if (this.shouldIgnoreFile(filename)) {
      return;
    }

    const session = this.watchedSessions.get(sessionId);
    if (!session) return;

    // Update last modified time
    session.lastModified = Date.now();
    session.pendingRefresh = true;

    // Debounce the refresh to batch rapid changes
    this.scheduleRefreshCheck(sessionId);
  }

  /**
   * Check if a file should be ignored
   */
  private shouldIgnoreFile(filename: string): boolean {
    // Check against ignore patterns
    for (const pattern of this.IGNORE_PATTERNS) {
      if (pattern.endsWith('/')) {
        // Directory pattern
        if (filename.startsWith(pattern) || filename.includes('/' + pattern)) {
          return true;
        }
      } else if (pattern.startsWith('*.')) {
        // Extension pattern
        const ext = pattern.slice(1);
        if (filename.endsWith(ext)) {
          return true;
        }
      } else if (pattern.startsWith('.#') || pattern.startsWith('#')) {
        // Editor temp file patterns
        const basename = filename.split('/').pop() || '';
        if (basename.startsWith('.#') || (basename.startsWith('#') && basename.endsWith('#'))) {
          return true;
        }
      } else if (pattern.endsWith('~')) {
        // Backup file pattern
        if (filename.endsWith('~')) {
          return true;
        }
      } else {
        // Exact match
        if (filename === pattern || filename.endsWith('/' + pattern)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Schedule a refresh check for a session
   */
  private scheduleRefreshCheck(sessionId: string): void {
    // Clear existing timer
    const existingTimer = this.refreshDebounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new timer
    const timer = setTimeout(() => {
      this.refreshDebounceTimers.delete(sessionId);
      this.performRefreshCheck(sessionId);
    }, this.DEBOUNCE_MS);

    this.refreshDebounceTimers.set(sessionId, timer);
  }

  /**
   * Perform the actual refresh check using git plumbing commands
   */
  private performRefreshCheck(sessionId: string): void {
    const session = this.watchedSessions.get(sessionId);
    if (!session || !session.pendingRefresh) {
      return;
    }

    session.pendingRefresh = false;

    try {
      // Quick check if the index is dirty using git update-index
      // This is much faster than running full git status
      const needsRefresh = this.checkIfRefreshNeeded(session.worktreePath);
      
      if (needsRefresh) {
        this.logger?.info(`[GitFileWatcher] Session ${sessionId} needs refresh`);
        this.emit('needs-refresh', sessionId);
      } else {
        this.logger?.info(`[GitFileWatcher] Session ${sessionId} no refresh needed`);
      }
    } catch (error) {
      this.logger?.error(`[GitFileWatcher] Error checking session ${sessionId}:`, error as Error);
      // On error, emit refresh to be safe
      this.emit('needs-refresh', sessionId);
    }
  }

  /**
   * Quick check if git status needs refreshing
   * Returns true if there are changes, false if working tree is clean
   */
  private checkIfRefreshNeeded(worktreePath: string): boolean {
    try {
      // First, refresh the index to ensure it's up to date
      // This is very fast and updates git's internal cache
      execSync('git update-index --refresh --ignore-submodules', { cwd: worktreePath, encoding: 'utf8', silent: true });

      // Check for unstaged changes (modified files)
      try {
        execSync('git diff-files --quiet --ignore-submodules', { cwd: worktreePath, encoding: 'utf8', silent: true });
      } catch {
        // Non-zero exit means there are unstaged changes
        return true;
      }

      // Check for staged changes
      try {
        execSync('git diff-index --cached --quiet HEAD --ignore-submodules', { cwd: worktreePath, encoding: 'utf8', silent: true });
      } catch {
        // Non-zero exit means there are staged changes
        return true;
      }
      
      // Check for untracked files
      const untrackedOutput = execSync('git ls-files --others --exclude-standard', { cwd: worktreePath })
        .toString()
        .trim();
      
      if (untrackedOutput) {
        return true;
      }
      
      // Working tree is clean
      return false;
    } catch (error) {
      // If any command fails unexpectedly, assume refresh is needed
      this.logger?.error('[GitFileWatcher] Error in checkIfRefreshNeeded:', error as Error);
      return true;
    }
  }

  /**
   * Get statistics about watched sessions
   */
  getStats(): { totalWatched: number; sessionsNeedingRefresh: number; totalWatchers: number } {
    let sessionsNeedingRefresh = 0;
    let totalWatchers = 0;
    for (const session of this.watchedSessions.values()) {
      if (session.pendingRefresh) {
        sessionsNeedingRefresh++;
      }
      // Root (non-recursive) watcher + one recursive watcher per non-excluded
      // top-level directory. Exposed so callers/tests can confirm the giant,
      // always-ignored trees (node_modules, .git) are never watched.
      totalWatchers += session.watchers.length;
    }

    return {
      totalWatched: this.watchedSessions.size,
      sessionsNeedingRefresh,
      totalWatchers
    };
  }

  /**
   * Top-level directory names currently covered by a recursive watcher for a
   * session (excludes the root non-recursive watcher and the hard-excluded
   * giants). Returns undefined for an unwatched session. Primarily for tests /
   * diagnostics.
   */
  getWatchedTopDirs(sessionId: string): string[] | undefined {
    const session = this.watchedSessions.get(sessionId);
    return session ? [...session.watchedTopDirs] : undefined;
  }
}