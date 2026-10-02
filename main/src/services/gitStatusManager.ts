import { existsSync } from 'fs';
import { join } from 'path';
import type { Logger } from '../utils/logger';
import type { GitStatus } from '../types/session';
import type { SessionManager } from './sessionManager';
import type { WorktreeManager } from './worktreeManager';
import type { GitDiffManager } from './gitDiffManager';
import { GitStatusLogger } from './gitStatusLogger';
import { perfBump } from './perfTracer';
import { fastCheckWorkingDirectory, fastGetAheadBehind, fastGetDiffStats, GitOperationalError } from './gitPlumbingCommands';
import { runGitAsync } from '../utils/runGit';

interface GitStatusCache {
  [sessionId: string]: {
    status: GitStatus;
    lastChecked: number;
  };
}

export class GitStatusManager {
  private cache: GitStatusCache = {};
  private readonly CACHE_TTL_MS = 5000; // 5 seconds cache
  private refreshDebounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly DEBOUNCE_MS = 2000; // 2 seconds debounce to batch rapid changes
  private gitLogger: GitStatusLogger;

  // Concurrent operation limiting
  private activeOperations = 0;
  private readonly MAX_CONCURRENT_OPERATIONS = 3; // Reduced to limit CPU usage
  private operationQueue: Array<() => Promise<void>> = [];
  
  // Cancellation support
  private abortControllers: Map<string, AbortController> = new Map();

  // Per-session async git spawn bounding (mandatory alongside the execSync -> async
  // conversion below — see class doc comment above fetchGitStatus for the full rationale).
  // (a) In-flight fetch coalescing: a session with a fetch already running reuses it
  // instead of launching a second concurrent fetch of the same worktree.
  private inFlightFetches: Map<string, Promise<{ status: GitStatus | null; generation: number }>> = new Map();
  // (d) Per-session monotonic generation counter: stamped at the START of every
  // cache-bound fetch/update; updateCache() drops a completion whose generation
  // is older than the latest one that has since started, preventing an
  // out-of-order last-write-wins stale cache.
  private sessionGenerations: Map<string, number> = new Map();
  // (c) Bound how long any single git child process may run before it's killed.
  private readonly GIT_COMMAND_TIMEOUT_MS = 10000;

  // Initial load management
  private isInitialLoadInProgress = false;
  private initialLoadQueue: string[] = [];
  private readonly INITIAL_LOAD_DELAY_MS = 200; // Increased to 200ms for better staggering

  constructor(
    private sessionManager: SessionManager,
    private worktreeManager: WorktreeManager,
    private gitDiffManager: GitDiffManager,
    private logger?: Logger
  ) {
    this.gitLogger = new GitStatusLogger(logger);
  }

  /**
   * Stop git status manager
   */
  stopPolling(): void {
    this.gitLogger.logSummary();

    // Clear any pending debounce timers
    this.refreshDebounceTimers.forEach(timer => clearTimeout(timer));
    this.refreshDebounceTimers.clear();

    // Cancel all active operations
    this.abortControllers.forEach(controller => controller.abort());
    this.abortControllers.clear();
  }

  /**
   * Get cached status without fetching
   */
  private getCachedStatus(sessionId: string): { status: GitStatus; lastChecked: number } | null {
    return this.cache[sessionId] || null;
  }

  /**
   * Read the cache without ever fetching, and without applying the TTL — for
   * the quick-session board's 3s poll, which must never spawn a git
   * subprocess. `lastChecked` (epoch ms) lets the caller label staleness
   * itself; warming the cache is a separate explicit action (the
   * `sessions:warm-quick-git` IPC handler → getGitStatus, which IS TTL-aware).
   */
  peekCachedStatus(sessionId: string): { status: GitStatus; lastChecked: number } | null {
    return this.cache[sessionId] || null;
  }

  /**
   * Get git status for a specific session (with caching)
   */
  async getGitStatus(sessionId: string): Promise<GitStatus | null> {
    // Check cache first
    const cached = this.cache[sessionId];
    if (cached && Date.now() - cached.lastChecked < this.CACHE_TTL_MS) {
      this.gitLogger.logSessionFetch(sessionId, true);
      return cached.status;
    }

    // Fetch fresh status (coalesced with any in-flight fetch for this session)
    const { status, generation } = await this.fetchGitStatusCoalesced(sessionId);
    if (status) {
      this.updateCache(sessionId, status, generation);
    }
    return status;
  }

  /**
   * Refresh git status for all sessions in a project
   * @param projectId - The project ID to refresh sessions for
   */
  private async refreshGitStatusForProject(projectId: number): Promise<void> {
    try {
      const sessions = await this.sessionManager.getAllSessions();
      const projectSessions = sessions.filter(s => s.projectId === projectId && !s.archived && s.status !== 'error');
      
      // Refresh all sessions in parallel — bounded by fetchGitStatusCoalesced's internal
      // executeWithLimit, NOT wrapped here (see its comment for why).
      await Promise.all(projectSessions.map(session =>
        this.refreshSessionGitStatus(session.id, false).catch(() => {
          // Individual failures are logged by GitStatusManager
        })
      ));
    } catch (error) {
      this.logger?.error(`[GitStatus] Failed to refresh git status for project ${projectId}:`, error as Error);
    }
  }

  /**
   * Update git status for all sessions in a project after main branch was updated
   * @param projectId - The project ID to update sessions for
   * @param updatedBySessionId - The session ID that caused the update (e.g. rebased to main)
   */
  async updateProjectGitStatusAfterMainUpdate(projectId: number, updatedBySessionId?: string): Promise<void> {
    try {
      const sessions = await this.sessionManager.getAllSessions();
      const projectSessions = sessions.filter(s => s.projectId === projectId && !s.archived && s.status !== 'error');
      
      // Update all sessions in parallel
      await Promise.all(projectSessions.map(async (session) => {
        if (session.id === updatedBySessionId) {
          // The session that rebased to main is now in sync with main
          await this.updateGitStatusAfterRebase(session.id, 'to_main');
        } else {
          // Other sessions may now be behind main
          const cached = this.cache[session.id];
          if (cached && session.worktreePath) {
            try {
              // Quick check for new ahead/behind status
              const project = this.sessionManager.getProjectForSession(session.id);
              if (project?.path) {
                const generation = this.beginFetch(session.id);
                const mainBranch = await this.worktreeManager.getProjectMainBranch(project.path);
                const { ahead, behind } = await fastGetAheadBehind(session.worktreePath, mainBranch, {
                  timeout: this.GIT_COMMAND_TIMEOUT_MS
                });

                const updatedStatus = { ...cached.status };
                updatedStatus.ahead = ahead;
                updatedStatus.behind = behind;

                this.updateCache(session.id, updatedStatus, generation);
              }
            } catch {
              // Fall back to full refresh on error
              await this.refreshSessionGitStatus(session.id, false);
            }
          } else {
            // No cache, do a full refresh
            await this.refreshSessionGitStatus(session.id, false);
          }
        }
      }));
      
      this.logger?.info(`[GitStatus] Updated all sessions in project ${projectId} after main branch update`);
    } catch (error) {
      this.logger?.error(`[GitStatus] Error updating project statuses after main update:`, error as Error);
      // Fall back to refreshing all
      await this.refreshGitStatusForProject(projectId);
    }
  }

  /**
   * Update git status after a rebase operation without running git commands
   * @param sessionId - The session ID to update
   * @param rebaseType - 'from_main' or 'to_main' 
   */
  async updateGitStatusAfterRebase(sessionId: string, rebaseType: 'from_main' | 'to_main'): Promise<void> {
    try {
      const cached = this.cache[sessionId];
      if (!cached) {
        // No cached status, fall back to refresh
        await this.refreshSessionGitStatus(sessionId, false);
        return;
      }

      const session = await this.sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        return;
      }

      const project = this.sessionManager.getProjectForSession(sessionId);
      if (!project?.path) {
        return;
      }

      const generation = this.beginFetch(sessionId);
      const mainBranch = await this.worktreeManager.getProjectMainBranch(project.path);
      const gitOpts = { timeout: this.GIT_COMMAND_TIMEOUT_MS };

      // Create updated status based on rebase type
      const updatedStatus = { ...cached.status };

      if (rebaseType === 'from_main') {
        // After rebasing from main, we're no longer behind
        updatedStatus.behind = 0;
        // ahead count stays the same or might change if there were conflicts resolved
        // hasUncommittedChanges might be true if there were conflicts
        // We'll do a quick check for uncommitted changes
        try {
          const quickStatus = await fastCheckWorkingDirectory(session.worktreePath, gitOpts);
          updatedStatus.hasUncommittedChanges = quickStatus.hasModified || quickStatus.hasStaged;
          updatedStatus.hasUntrackedFiles = quickStatus.hasUntracked;
          // Update state based on conflicts
          if (quickStatus.hasConflicts) {
            updatedStatus.state = 'conflict';
          }

          if (updatedStatus.hasUncommittedChanges) {
            // Get updated diff stats
            const quickStats = await fastGetDiffStats(session.worktreePath, gitOpts);
            updatedStatus.additions = quickStats.additions;
            updatedStatus.deletions = quickStats.deletions;
            updatedStatus.filesChanged = quickStats.filesChanged;
          } else {
            updatedStatus.additions = 0;
            updatedStatus.deletions = 0;
            updatedStatus.filesChanged = 0;
          }
        } catch {
          // If quick check fails, fall back to full refresh
          await this.refreshSessionGitStatus(sessionId, false);
          return;
        }
      } else if (rebaseType === 'to_main') {
        // After rebasing to main, we're ahead of main with our changes
        // and no longer behind (since we just rebased onto it)
        updatedStatus.behind = 0;
        // ahead count would be the number of commits we have
        // hasUncommittedChanges should be false (we just rebased cleanly)
        updatedStatus.hasUncommittedChanges = false;
        updatedStatus.hasUntrackedFiles = false;
        updatedStatus.state = 'ahead'; // We're ahead after rebasing to main
        updatedStatus.additions = 0;
        updatedStatus.deletions = 0;
        updatedStatus.filesChanged = 0;
      }

      this.updateCache(sessionId, updatedStatus, generation);

      this.logger?.info(`[GitStatus] Updated status after ${rebaseType} rebase for session ${sessionId}`);
    } catch (error) {
      this.logger?.error(`[GitStatus] Error updating status after rebase for session ${sessionId}:`, error as Error);
      // Fall back to full refresh on error
      await this.refreshSessionGitStatus(sessionId, false);
    }
  }

  /**
   * Force refresh git status for a specific session (with debouncing)
   * @param sessionId - The session ID to refresh
   * @param isUserInitiated - Whether this refresh was triggered by user action (shows loading spinner)
   */
  async refreshSessionGitStatus(sessionId: string, isUserInitiated = false): Promise<GitStatus | null> {
    perfBump('git.status.refresh');

    // Clear any existing debounce timer for this session
    const existingTimer = this.refreshDebounceTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.refreshDebounceTimers.delete(sessionId);
      this.gitLogger.logDebounce(sessionId, 'cancelled');
    }

    // Create a promise that will be resolved after debounce
    this.gitLogger.logDebounce(sessionId, 'start');
    return new Promise((resolve) => {
      const timer = setTimeout(async () => {
        this.refreshDebounceTimers.delete(sessionId);
        this.gitLogger.logDebounce(sessionId, 'complete');
        
        // Fast path: check if git status actually changed before doing expensive operations
        const session = await this.sessionManager.getSession(sessionId);
        if (session?.worktreePath) {
          const hasChanged = await this.hasGitStatusChanged(sessionId, session.worktreePath);
          if (!hasChanged) {
            this.logger?.info(`[GitStatus] Quick check: no changes for session ${sessionId}, skipping refresh`);
            resolve(this.cache[sessionId]?.status || null);
            return;
          }
        }
        
        const { status, generation } = await this.fetchGitStatusCoalesced(sessionId);
        if (status) {
          this.updateCache(sessionId, status, generation);
        }
        resolve(status);
      }, this.DEBOUNCE_MS);

      this.refreshDebounceTimers.set(sessionId, timer);
    });
  }

  /**
   * Queue a session for initial git status loading with staggered execution
   * This prevents UI lock when many sessions load at once
   */
  async queueInitialLoad(sessionId: string): Promise<GitStatus | null> {
    // Check cache first
    const cached = this.getCachedStatus(sessionId);
    if (cached && Date.now() - cached.lastChecked < this.CACHE_TTL_MS) {
      return cached.status;
    }

    // Add to initial load queue if not already there
    if (!this.initialLoadQueue.includes(sessionId)) {
      this.initialLoadQueue.push(sessionId);
    }

    // Start processing queue if not already running
    if (!this.isInitialLoadInProgress) {
      this.processInitialLoadQueue();
    }

    // Return cached status immediately; the queued fetch refreshes the cache
    return cached?.status || null;
  }

  /**
   * Process the initial load queue with staggering to prevent UI lock
   */
  private async processInitialLoadQueue(): Promise<void> {
    if (this.isInitialLoadInProgress || this.initialLoadQueue.length === 0) {
      return;
    }

    this.isInitialLoadInProgress = true;
    
    while (this.initialLoadQueue.length > 0) {
      // Take a batch of sessions to process
      const batchSize = Math.min(this.MAX_CONCURRENT_OPERATIONS, this.initialLoadQueue.length);
      const batch = this.initialLoadQueue.splice(0, batchSize);
      
      // Process batch concurrently. The batch is already capped at MAX_CONCURRENT_OPERATIONS
      // by the splice above, and fetchGitStatusCoalesced bounds the underlying git spawn
      // itself — NOT double-wrapped in executeWithLimit here, since nesting two
      // executeWithLimit levels against the same shared cap would deadlock (all outer
      // slots held while each waits on an inner slot the outer holders are blocking).
      const promises = batch.map(sessionId =>
        (async () => {
          try {
            const { status, generation } = await this.fetchGitStatusCoalesced(sessionId);
            if (status) {
              this.updateCache(sessionId, status, generation);
            }
          } catch (error) {
            this.logger?.error(`[GitStatus] Error fetching status for session ${sessionId}:`, error as Error);
          }
        })()
      );
      
      await Promise.allSettled(promises);
      
      // Small delay between batches to keep UI responsive
      if (this.initialLoadQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, this.INITIAL_LOAD_DELAY_MS));
      }
    }
    
    this.isInitialLoadInProgress = false;
  }

  /**
   * Refresh git status for all active sessions (called manually, not on a timer)
   */
  async refreshAllSessions(): Promise<void> {
    try {
      const sessions = await this.sessionManager.getAllSessions();
      const activeSessions = sessions.filter(s => 
        !s.archived && s.status !== 'error' && s.worktreePath
      );

      this.gitLogger.logPollStart(activeSessions.length);

      // Process sessions with concurrent limiting — bounded by fetchGitStatusCoalesced's
      // internal executeWithLimit, NOT wrapped here (see its comment for why: this was a
      // pre-existing instance of the same caller-side-wrap deadlock the fix 2 review caught).
      let successCount = 0;
      let errorCount = 0;

      const results = await Promise.allSettled(
        activeSessions.map(session =>
          this.refreshSessionGitStatus(session.id, false) // false = not user initiated
        )
      );
      
      results.forEach((result) => {
        if (result.status === 'fulfilled' && result.value) {
          successCount++;
        } else {
          errorCount++;
        }
      });
      
      this.gitLogger.logPollComplete(successCount, errorCount);
    } catch (error) {
      this.logger?.error('[GitStatus] Critical error during refresh:', error as Error);
    }
  }

  /**
   * Cancel git status operations for a session
   */
  cancelSessionGitStatus(sessionId: string): void {
    // Cancel any active fetch for this session
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }

    // Clear any pending debounce timer
    const timer = this.refreshDebounceTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.refreshDebounceTimers.delete(sessionId);
    }
  }
  
  /**
   * Cancel git status operations for multiple sessions
   */
  cancelMultipleGitStatus(sessionIds: string[]): void {
    sessionIds.forEach(id => this.cancelSessionGitStatus(id));
  }

  /**
   * Quick check if git status actually changed using fast plumbing commands
   * Returns true if status is different from cached, false if unchanged
   */
  private async hasGitStatusChanged(sessionId: string, worktreePath: string): Promise<boolean> {
    const cached = this.cache[sessionId];
    if (!cached) return true;

    try {
      // Bound the quick-check git spawns under the SAME shared cap (executeWithLimit) as the
      // full fetch in fetchGitStatusCoalesced. Without this, refreshAllSessions fans out every
      // session's quick check concurrently and each spawns its own update-index/diff-files/
      // diff-index/ls-files/diff (+ rev-list) children OUTSIDE the cap — an N-wide git burst
      // (the exact CPU/index.lock storm the cap exists to prevent, made truly concurrent by
      // fix 2's execSync→async conversion). This acquisition runs to completion and releases
      // its slot BEFORE the caller proceeds to fetchGitStatusCoalesced, so the quick check and
      // the full fetch never hold the cap at the same time (sequential, not nested → no
      // deadlock; hasGitStatusChanged never calls back into the coalesced/debounced path).
      return await this.executeWithLimit(async () => {
        const gitOpts = { timeout: this.GIT_COMMAND_TIMEOUT_MS };
        const quickStatus = await fastCheckWorkingDirectory(worktreePath, gitOpts);

        // Compare with cached status
        const cachedHasChanges = cached.status.hasUncommittedChanges || cached.status.hasUntrackedFiles;
        const currentHasChanges = quickStatus.hasModified || quickStatus.hasStaged || quickStatus.hasUntracked;

        // If the basic state differs, we need to refresh
        if (cachedHasChanges !== currentHasChanges) {
          return true;
        }

        // If both have no changes, check if ahead/behind changed
        if (!currentHasChanges) {
          const project = this.sessionManager.getProjectForSession(sessionId);
          if (project?.path) {
            const mainBranch = await this.worktreeManager.getProjectMainBranch(project.path);
            const { ahead, behind } = await fastGetAheadBehind(worktreePath, mainBranch, gitOpts);

            if ((cached.status.ahead || 0) !== ahead || (cached.status.behind || 0) !== behind) {
              return true;
            }
          }
        }

        return false;
      });
    } catch {
      // On any error, assume we need to refresh
      return true;
    }
  }

  /**
   * (d) Stamp a new monotonically increasing generation for a session's fetch/update,
   * and record it as the latest one that has started. updateCache() compares an
   * incoming write's generation against this to drop stale (superseded) completions.
   */
  private beginFetch(sessionId: string): number {
    const generation = (this.sessionGenerations.get(sessionId) ?? 0) + 1;
    this.sessionGenerations.set(sessionId, generation);
    return generation;
  }

  /**
   * (a) Coalesce concurrent fetchGitStatus calls for the same session: a session with
   * a fetch already in flight reuses that promise instead of spawning a second
   * concurrent set of git children against the same worktree (which — now that the
   * spawns are async instead of blocking the whole process — could otherwise race
   * on index.lock and produce spurious "modified" status / out-of-order cache writes).
   *
   * (b) This is also the ONE place the MAX_CONCURRENT_OPERATIONS cap (executeWithLimit)
   * is applied — bounding the actual git spawn, not the caller. Do NOT wrap callers of
   * this method (or refreshSessionGitStatus) in executeWithLimit themselves: doing so
   * deadlocks the shared cap. refreshSessionGitStatus's debounce logic clearTimeout()s
   * a same-session call's prior in-flight timer (L393-398), so THAT prior call's Promise
   * — whose `resolve` lives inside the now-cleared setTimeout callback — never settles.
   * A caller-side executeWithLimit(() => refreshSessionGitStatus(...)) would then hold
   * its concurrency slot forever, and after MAX_CONCURRENT_OPERATIONS such orphans every
   * future fetch across every session spins forever. Bounding only the fetch here avoids
   * this: the debounce timers themselves stay unbounded (cheap, no git spawn) and only
   * the actual git work — which always eventually settles — occupies a slot.
   */
  private fetchGitStatusCoalesced(sessionId: string): Promise<{ status: GitStatus | null; generation: number }> {
    const existing = this.inFlightFetches.get(sessionId);
    if (existing) {
      return existing;
    }

    const generation = this.beginFetch(sessionId);
    const promise = this.executeWithLimit(() => this.fetchGitStatus(sessionId))
      .then(status => ({ status, generation }))
      .finally(() => {
        // Only clear our own entry — a newer coalesced fetch may have already
        // replaced it in the map by the time this one settles.
        if (this.inFlightFetches.get(sessionId) === promise) {
          this.inFlightFetches.delete(sessionId);
        }
      });
    this.inFlightFetches.set(sessionId, promise);
    return promise;
  }

  /**
   * Fetch git status for a session
   */
  private async fetchGitStatus(sessionId: string): Promise<GitStatus | null> {
    // Create abort controller for this operation
    const abortController = new AbortController();
    this.abortControllers.set(sessionId, abortController);
    
    try {
      const session = await this.sessionManager.getSession(sessionId);
      if (!session || !session.worktreePath) {
        this.abortControllers.delete(sessionId);
        return null;
      }
      
      // Check if operation was cancelled
      if (abortController.signal.aborted) {
        this.abortControllers.delete(sessionId);
        return null;
      }
      
      this.gitLogger.logSessionFetch(sessionId, false);

      const project = this.sessionManager.getProjectForSession(sessionId);
      if (!project?.path) {
        return null;
      }

      // (c) Bound every git child spawned for this fetch: abortable via cancelSessionGitStatus
      // (which aborts abortController above) and hard-killed after GIT_COMMAND_TIMEOUT_MS.
      const gitOpts = { signal: abortController.signal, timeout: this.GIT_COMMAND_TIMEOUT_MS };

      // Use fast plumbing commands for initial checks
      const quickStatus = await fastCheckWorkingDirectory(session.worktreePath, gitOpts);
      const hasUncommittedChanges = quickStatus.hasModified || quickStatus.hasStaged;
      const hasUntrackedFiles = quickStatus.hasUntracked;
      const hasMergeConflicts = quickStatus.hasConflicts;

      // Get uncommitted changes details only if needed
      let uncommittedDiff = { stats: { filesChanged: 0, additions: 0, deletions: 0 } };
      if (hasUncommittedChanges) {
        // Use fast diff stats instead of full diff capture when possible.
        // An operational failure here (timeout/kill) is tolerated: we already KNOW
        // the tree is modified (from fastCheckWorkingDirectory), so we keep the
        // 'modified' state with zero counts rather than discarding the whole status.
        // Only ahead/behind (below) is state-critical enough to preserve last-known.
        try {
          const quickStats = await fastGetDiffStats(session.worktreePath, gitOpts);
          uncommittedDiff = {
            stats: {
              filesChanged: quickStats.filesChanged,
              additions: quickStats.additions,
              deletions: quickStats.deletions
            }
          };
        } catch (statsError) {
          if (statsError instanceof Error && statsError.name === 'AbortError') throw statsError;
          if (!(statsError instanceof GitOperationalError)) throw statsError;
          this.logger?.info(`[GitStatus] Diff-stats timed out for session ${sessionId}; keeping modified state with zero counts`);
        }
      }

      // Get ahead/behind status using fast plumbing command
      const mainBranch = await this.worktreeManager.getProjectMainBranch(project.path);
      const { ahead, behind } = await fastGetAheadBehind(session.worktreePath, mainBranch, gitOpts);

      // Get total additions/deletions for all commits in the branch (compared to main)
      let totalCommitAdditions = 0;
      let totalCommitDeletions = 0;
      let totalCommitFilesChanged = 0;
      if (ahead > 0) {
        // Use git diff --shortstat for commit statistics
        try {
          const statLine = (await runGitAsync(session.worktreePath, ['diff', '--shortstat', `${mainBranch}...HEAD`], gitOpts)).trim();
          if (statLine) {
            const filesMatch = statLine.match(/(\d+) files? changed/);
            const additionsMatch = statLine.match(/(\d+) insertions?\(\+\)/);
            const deletionsMatch = statLine.match(/(\d+) deletions?\(-\)/);
            
            totalCommitFilesChanged = filesMatch ? parseInt(filesMatch[1], 10) : 0;
            totalCommitAdditions = additionsMatch ? parseInt(additionsMatch[1], 10) : 0;
            totalCommitDeletions = deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0;
          }
        } catch {
          // Keep defaults of 0 if command fails
        }
      }

      // Check for rebase in progress
      let isRebasing = false;
      
      // Check for rebase in progress using filesystem APIs
      const rebaseMergeExists = existsSync(join(session.worktreePath, '.git', 'rebase-merge'));
      const rebaseApplyExists = existsSync(join(session.worktreePath, '.git', 'rebase-apply'));
      isRebasing = rebaseMergeExists || rebaseApplyExists;

      // Determine the overall state and secondary states
      let state: GitStatus['state'] = 'clean';
      const secondaryStates: GitStatus['secondaryStates'] = [];
      
      // Priority order for primary state: conflict > diverged > modified > ahead > behind > untracked > clean
      if (hasMergeConflicts) {
        state = 'conflict';
      } else if (ahead > 0 && behind > 0) {
        state = 'diverged';
      } else if (hasUncommittedChanges) {
        state = 'modified';
        if (ahead > 0) secondaryStates.push('ahead');
        if (behind > 0) secondaryStates.push('behind');
      } else if (ahead > 0) {
        state = 'ahead';
        if (hasUntrackedFiles) secondaryStates.push('untracked');
      } else if (behind > 0) {
        state = 'behind';
        if (hasUncommittedChanges) secondaryStates.push('modified');
        if (hasUntrackedFiles) secondaryStates.push('untracked');
      } else if (hasUntrackedFiles) {
        state = 'untracked';
      }
      
      // IMPORTANT: Even if state is 'clean', we still want to show commit count
      // A 'clean' branch can still have commits not in main!

      // Determine if ready to merge (ahead with no uncommitted changes or untracked files)
      const isReadyToMerge = ahead > 0 && !hasUncommittedChanges && !hasUntrackedFiles && behind === 0;

      // Get total number of commits in the branch
      let totalCommits = ahead;
      try {
        const countStr = (await runGitAsync(session.worktreePath, ['rev-list', '--count', `${mainBranch}..HEAD`], gitOpts)).trim();
        totalCommits = parseInt(countStr, 10) || ahead;
      } catch {
        // Keep default of ahead if command fails
      }

      const result = {
        state,
        ahead: ahead > 0 ? ahead : undefined,
        behind: behind > 0 ? behind : undefined,
        additions: uncommittedDiff.stats.additions > 0 ? uncommittedDiff.stats.additions : undefined,
        deletions: uncommittedDiff.stats.deletions > 0 ? uncommittedDiff.stats.deletions : undefined,
        filesChanged: uncommittedDiff.stats.filesChanged > 0 ? uncommittedDiff.stats.filesChanged : undefined,
        lastChecked: new Date().toISOString(),
        isReadyToMerge,
        hasUncommittedChanges,
        hasUntrackedFiles,
        secondaryStates: secondaryStates.length > 0 ? secondaryStates : undefined,
        // Include commit statistics if ahead of main
        commitAdditions: totalCommitAdditions > 0 ? totalCommitAdditions : undefined,
        commitDeletions: totalCommitDeletions > 0 ? totalCommitDeletions : undefined,
        commitFilesChanged: totalCommitFilesChanged > 0 ? totalCommitFilesChanged : undefined,
        // Total commits in branch
        totalCommits: totalCommits > 0 ? totalCommits : undefined
      };
      
      this.gitLogger.logSessionSuccess(sessionId);
      this.abortControllers.delete(sessionId);
      return result;
    } catch (error) {
      this.abortControllers.delete(sessionId);

      // Check if this was a cancellation
      if (error instanceof Error && error.name === 'AbortError') {
        this.gitLogger.logSessionFetch(sessionId, true); // cancelled
        return null;
      }

      // An operational git failure (timeout / killed / spawn failure) reached us
      // from the state-critical ahead/behind computation. Do NOT flatten it into an
      // authoritative status — returning a fake-clean or a lossy 'unknown' would
      // overwrite a good cached 'ahead'/'diverged'. Return null so the caller skips
      // updateCache and PRESERVES the last-known status; the next refresh retries.
      if (error instanceof GitOperationalError) {
        this.gitLogger.logSessionError(sessionId, error);
        this.logger?.info(`[GitStatus] Preserving last-known status for session ${sessionId} after operational git failure`);
        return null;
      }

      this.gitLogger.logSessionError(sessionId, error as Error);
      return {
        state: 'unknown',
        lastChecked: new Date().toISOString()
      };
    }
  }

  /**
   * Update cache with new status
   * @param generation (d) If provided, the generation the write's fetch/update began at —
   *   dropped as stale if a newer fetch has since started for this session, preventing an
   *   out-of-order last-write-wins cache write when async fetches interleave.
   */
  private updateCache(sessionId: string, status: GitStatus, generation?: number): void {
    if (generation !== undefined) {
      const latestGeneration = this.sessionGenerations.get(sessionId);
      if (latestGeneration !== undefined && generation < latestGeneration) {
        this.logger?.info(
          `[GitStatus] Dropping stale generation ${generation} for session ${sessionId} (latest started: ${latestGeneration})`
        );
        return;
      }
    }

    this.cache[sessionId] = {
      status,
      lastChecked: Date.now()
    };
  }

  /**
   * Clear cache for a session
   */
  clearSessionCache(sessionId: string): void {
    delete this.cache[sessionId];
    this.sessionGenerations.delete(sessionId);
    this.inFlightFetches.delete(sessionId);
  }

  /**
   * Clear all cached status
   */
  clearAllCache(): void {
    this.cache = {};
    this.sessionGenerations.clear();
    this.inFlightFetches.clear();
  }

  /**
   * Execute an operation with concurrency limiting
   * @param operation The operation to execute
   */
  private async executeWithLimit<T>(operation: () => Promise<T>): Promise<T> {
    // Wait if we're at the limit
    while (this.activeOperations >= this.MAX_CONCURRENT_OPERATIONS) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    this.activeOperations++;
    try {
      return await operation();
    } finally {
      this.activeOperations--;
      
      // Process queued operations
      if (this.operationQueue.length > 0) {
        const nextOp = this.operationQueue.shift();
        if (nextOp) {
          nextOp().catch(error => {
            this.logger?.error('[GitStatus] Queued operation failed:', error as Error);
          });
        }
      }
    }
  }
}