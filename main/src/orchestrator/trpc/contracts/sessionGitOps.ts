/**
 * Narrow structural contract for the `sessionGit` tRPC router's business logic
 * — the THIRD and final slice of the IPC→tRPC migration
 * (docs/CODE-PATTERNS.md), following the same seam as `configOps.ts` (the PILOT
 * slice) and `workspaceFileOps.ts` (slice 2): the router
 * (routers/sessionGit.ts) does zod input validation and delegates to this
 * interface; the concrete implementation (main/src/ipc/gitOps.ts) wraps
 * SessionManager/GitDiffManager/WorktreeManager/GitStatusManager/
 * DatabaseService/ConfigManager plus the session close-out routers, and may
 * freely import from main/src/services/*. Declaring the interface here — rather
 * than importing the concrete factory — keeps the tRPC subtree's
 * standalone-typecheck invariant intact (no 'electron' or
 * 'main/src/services/**' imports; only main/src/types/* and shared/types/* are
 * allowed).
 *
 * Every method returns the EXACT envelope shape the legacy `sessions:*` /
 * `git:*` ipcMain.handle channels (main/src/ipc/git.ts, now deleted) returned,
 * so frontend call sites keep their existing shape — INCLUDING the irregular
 * ones, which are load-bearing for the merge/dismiss/create-PR dialogs:
 *   • `squashAndRebaseToMain` / `rebaseToMain` failures carry `needsRebase`
 *     (main advanced past the branch — rebase first) and `alreadyUpToDate`
 *     (the branch had nothing left to give main, so the dialog offers Mark
 *     complete instead of an error) alongside a `commands`-shaped `gitError`.
 *   • `rebaseMainIntoWorktree`'s failure `gitError` carries the conflict
 *     detail (`hasConflicts` / `conflictingFiles` / `conflictingCommits`).
 *   • `pull`'s failure can carry `isMergeConflict`.
 *   • `getGitStatus`'s SUCCESS envelope is `{ success: true, gitStatus }` —
 *     `gitStatus`, NOT `data` — optionally with `backgroundRefresh`.
 *
 * `sessions:check-rebase-conflicts` was NOT migrated (zero preload/frontend
 * callers). Its logic lives on via WorktreeManager.checkForRebaseConflicts,
 * which `rebaseMainIntoWorktree` calls directly.
 */
import type { GitStatus } from '../../../types/session';
import type { WorktreeStatusPayload, DiffGroupScope } from '../../../../../shared/types/runFiles';

/** The failure half every one of these envelopes shares. */
export type SessionGitError = { success: false; error: string };

/**
 * Structural mirror of GitDiffManager's `GitDiffStats`
 * (main/src/services/gitDiffManager.ts — source of truth), declared here so the
 * contract takes no services/* dependency.
 */
export interface SessionGitDiffStats {
  additions: number;
  deletions: number;
  filesChanged: number;
}

/**
 * Structural mirror of GitDiffManager's `GitDiffResult` (source of truth:
 * main/src/services/gitDiffManager.ts). The wire twin the renderer already
 * declares is frontend/src/types/diff.ts `GitDiffResult`.
 *
 * `resolvedBase` and `worktree` are Seam B (TASK-212) additions, both
 * REQUIRED — a loud exhaustive tripwire rather than an optional field an
 * `undefined` could silently satisfy, which would let the center pane derive
 * its own base and reintroduce a live bug. `resolvedBase` is the concrete SHA
 * (never a branch name) the response was actually computed against, `null`
 * only for the working-dir-vs-HEAD rung (no base to anchor on). `worktree` is
 * the same `getWorktreeStatus` + `getDiffGroups` (TASK-209/210) payload every
 * one of these three methods assembles, for the grouped Diff-tab view
 * alongside whichever single diff blob the method itself returns.
 */
export interface SessionGitDiffResult {
  diff: string;
  stats: SessionGitDiffStats;
  changedFiles: string[];
  beforeHash?: string;
  afterHash?: string;
  resolvedBase: string | null;
  worktree: WorktreeStatusPayload;
}

/**
 * One row of `getExecutions`. Synthesized from the session's commit history
 * (index-derived ids, 1-based; id 0 is the synthetic "Uncommitted changes"
 * row), NOT a database entity — the renderer's twin is
 * frontend/src/types/diff.ts `ExecutionDiff`.
 */
export interface SessionExecutionRow {
  id: number;
  session_id: string;
  execution_sequence: number;
  after_commit_hash: string;
  commit_message: string;
  timestamp: string;
  stats_additions: number;
  stats_deletions: number;
  stats_files_changed: number;
  author: string;
  comparison_branch: string;
  history_source: 'remote' | 'local' | 'branch';
  history_limit_reached: boolean;
}

/**
 * One row of `getLastCommits`. Shaped LIKE an execution row but not identical
 * to {@link SessionExecutionRow}: it carries `commit_hash` (not
 * `after_commit_hash`) and its `timestamp` is WorktreeManager's raw commit date
 * (`string | Date`), passed through unconverted exactly as the legacy handler
 * did.
 */
export interface SessionLastCommitRow {
  id: number;
  session_id: string;
  commit_message: string;
  execution_sequence: number;
  stats_additions: number;
  stats_deletions: number;
  stats_files_changed: number;
  commit_hash: string;
  timestamp: string | Date;
  author: string;
  history_limit_reached: boolean;
}

/**
 * The `gitError` detail on a rebase-from-main failure. Two producers share it:
 * the pre-flight conflict short-circuit (which fills `hasConflicts` /
 * `conflictingFiles` / `conflictingCommits` from
 * WorktreeManager.checkForRebaseConflicts — source of truth for those three)
 * and the catch arm (which fills `command` / `workingDirectory` /
 * `originalError` off the thrown GitError). Every field is optional because
 * neither producer fills all of them.
 */
export interface RebaseFromMainGitError {
  command?: string;
  output?: string;
  workingDirectory?: string;
  hasConflicts?: boolean;
  conflictingFiles?: string[];
  conflictingCommits?: { ours: string[]; theirs: string[] };
  originalError?: string;
}

/** The `gitError` detail on a merge-to-main failure (squash or rebase). */
export interface MergeToMainGitError {
  commands?: string[];
  output?: string;
  workingDirectory?: string;
  projectPath?: string;
  originalError?: string;
}

/** The `gitError` detail on a pull/push failure. */
export interface PullPushGitError {
  output?: string;
  workingDirectory: string;
}

/**
 * The merge envelope shared by `squashAndRebaseToMain` and `rebaseToMain`.
 * `needsRebase` marks the pre-merge guard's block (main advanced past this
 * branch); `alreadyUpToDate` marks the branch that had nothing left to give
 * main. Both are read by the merge dialog to choose what it offers next, so
 * neither may be dropped from the wire shape.
 */
export type MergeToMainResult =
  | { success: true; data: { message: string } }
  | {
      success: false;
      error: string;
      needsRebase?: boolean;
      alreadyUpToDate?: boolean;
      gitError?: MergeToMainGitError;
    };

export interface SessionGitOpsLike {
  /**
   * Mirrors legacy `sessions:get-executions`. The session's commit history as
   * renderer-facing execution rows, newest first, with a synthetic id-0 row
   * prepended when the worktree has uncommitted changes.
   */
  getExecutions(request: {
    sessionId: string;
  }): Promise<{ success: true; data: SessionExecutionRow[] } | SessionGitError>;

  /**
   * Mirrors legacy `sessions:get-execution-diff`. `executionId` is the 1-based
   * execution row id as a STRING (the legacy wire type — it is parseInt'd
   * inside).
   */
  getExecutionDiff(request: {
    sessionId: string;
    executionId: string;
  }): Promise<{ success: true; data: SessionGitDiffResult } | SessionGitError>;

  /** Mirrors legacy `sessions:git-commit`. Stages all changes and commits in the session worktree. */
  commit(request: {
    sessionId: string;
    message: string;
  }): Promise<{ success: true } | SessionGitError>;

  /** Mirrors legacy `sessions:git-diff`. The session worktree's working-directory diff. */
  diff(request: {
    sessionId: string;
  }): Promise<{ success: true; data: SessionGitDiffResult } | SessionGitError>;

  /**
   * Mirrors legacy `sessions:get-combined-diff`. `executionIds` selects what to
   * diff: omitted/empty = everything including uncommitted; `[0]` = uncommitted
   * only; a pair = the range; more than two = first..last.
   *
   * Seam B (TASK-212) additions, both wire fields (not merely hook arguments):
   * `comparisonRef` overrides the base the response is computed against
   * (resolved to a SHA before it reaches git argv; falls back to the session
   * default on an unresolvable ref, never throws). `scope`, when present,
   * takes precedence over `executionIds` and selects one `DiffGroupScope`'s
   * own git query for the returned diff blob (see gitOps.ts's
   * getCombinedDiff for the per-scope command mapping).
   */
  getCombinedDiff(request: {
    sessionId: string;
    executionIds?: number[];
    comparisonRef?: string;
    scope?: DiffGroupScope;
  }): Promise<{ success: true; data: SessionGitDiffResult } | SessionGitError>;

  /**
   * Mirrors legacy `sessions:rebase-main-into-worktree`. Short-circuits on a
   * pre-flight conflict WITHOUT mutating the worktree, reporting the conflict
   * detail in `gitError`.
   */
  rebaseMainIntoWorktree(request: {
    sessionId: string;
  }): Promise<
    | { success: true; data: { message: string } }
    | { success: false; error: string; gitError?: RebaseFromMainGitError }
  >;

  /**
   * Mirrors legacy `sessions:abort-rebase-and-use-claude`. Aborts an in-progress
   * rebase (a no-op when there is none) and spins up a Claude panel primed to
   * do the rebase and resolve conflicts.
   */
  abortRebaseAndUseClaude(request: {
    sessionId: string;
  }): Promise<{ success: true; data: { message: string; panelId: string } } | SessionGitError>;

  /** Mirrors legacy `sessions:squash-and-rebase-to-main`. See {@link MergeToMainResult}. */
  squashAndRebaseToMain(request: {
    sessionId: string;
    commitMessage: string;
  }): Promise<MergeToMainResult>;

  /** Mirrors legacy `sessions:rebase-to-main`. See {@link MergeToMainResult}. */
  rebaseToMain(request: { sessionId: string }): Promise<MergeToMainResult>;

  /**
   * Mirrors legacy `sessions:git-pull`. A merge conflict is reported as
   * `isMergeConflict: true` rather than as a plain failure.
   */
  pull(request: {
    sessionId: string;
  }): Promise<
    | { success: true; data: { output: string } }
    | { success: false; error: string; isMergeConflict?: boolean; gitError?: PullPushGitError }
  >;

  /**
   * Mirrors legacy `sessions:git-push`. On success this ALSO runs the Create-PR
   * close-out (sprint lanes finalized, runs stamped completed/pr_open,
   * uncommitted run artifacts reaped) — entirely fail-soft, never affecting the
   * push response.
   */
  push(request: {
    sessionId: string;
  }): Promise<
    | { success: true; data: { output: string } }
    | { success: false; error: string; gitError?: PullPushGitError }
  >;

  /**
   * Mirrors legacy `sessions:get-delivery-state`. `delivered` = a run this
   * session hosted carries a delivery stamp; `landed` = git says the branch has
   * nothing left to give main. Read by the dismiss dialog.
   */
  getDeliveryState(request: {
    sessionId: string;
  }): Promise<
    { success: true; data: { delivered: boolean; landed: boolean; ownCommits: number } } | SessionGitError
  >;

  /**
   * Mirrors legacy `sessions:mark-complete`. Bookkeeping stamp ONLY — archives
   * nothing and touches no git.
   */
  markComplete(request: {
    sessionId: string;
  }): Promise<{ success: true; data: { stamped: number } } | SessionGitError>;

  /**
   * Mirrors legacy `sessions:get-branch-commit-subjects`. Subjects of the
   * branch's OWN commits (`mainBranch..HEAD`), newest first — never main-branch
   * history, unlike {@link getLastCommits}.
   */
  getBranchCommitSubjects(request: {
    sessionId: string;
  }): Promise<{ success: true; data: { subjects: string[] } } | SessionGitError>;

  /** Mirrors legacy `sessions:get-last-commits`. `count` defaults to 50 in the ops impl. */
  getLastCommits(request: {
    sessionId: string;
    count?: number;
  }): Promise<{ success: true; data: SessionLastCommitRow[] } | SessionGitError>;

  /** Mirrors legacy `sessions:has-changes-to-rebase`. */
  hasChangesToRebase(request: {
    sessionId: string;
  }): Promise<{ success: true; data: boolean } | SessionGitError>;

  /**
   * Mirrors legacy `sessions:get-git-commands`. The copy-pasteable git command
   * sets the merge/rebase dialogs show. The renderer's twin is
   * frontend/src/types/session.ts `GitCommands`.
   */
  getGitCommands(request: {
    sessionId: string;
  }): Promise<
    | {
        success: true;
        data: {
          rebaseCommands: string[];
          squashCommands: string[];
          mergeCommands: string[];
          mainBranch: string;
          originBranch?: string;
          currentBranch: string;
        };
      }
    | SessionGitError
  >;

  /**
   * The session worktree's LIVE checked-out branch — the sidebar hover tooltip's
   * source. Deliberately narrower than getGitCommands (which also resolves the
   * project main branch and the origin branch): this is one `git branch
   * --show-current` per call, cheap enough to fire lazily on hover. A detached
   * HEAD resolves to the short SHA (gitPlumbingCommands.getCurrentBranch's own
   * fallback). `branch` is null when the session has no branch of its own to
   * report — archived, unreadable, or a husk directory inside the project
   * checkout whose worktree is gone (an unguarded read there would answer with
   * the PROJECT's branch); callers show nothing rather than that.
   */
  getCurrentBranch(request: {
    sessionId: string;
  }): Promise<{ success: true; data: { branch: string | null } } | SessionGitError>;

  /** Mirrors legacy `sessions:get-remote-url`. */
  getRemoteUrl(request: {
    sessionId: string;
  }): Promise<{ success: true; data: { remoteUrl: string; branchName: string } } | SessionGitError>;

  /**
   * Mirrors legacy `sessions:get-git-status`. NOTE the irregular success
   * envelope: the status rides on `gitStatus`, NOT `data`. `isInitialLoad`
   * takes the queued path and `nonBlocking` kicks a background refresh — both
   * return the CACHED status plus `backgroundRefresh: true`; neither makes this
   * a mutation (it is semantically a read).
   */
  getGitStatus(request: {
    sessionId: string;
    nonBlocking?: boolean;
    isInitialLoad?: boolean;
  }): Promise<
    { success: true; gitStatus: GitStatus | null; backgroundRefresh?: boolean } | SessionGitError
  >;

  /**
   * Mirrors legacy `git:cancel-status-for-project`. Cancels in-flight git-status
   * work for every non-archived session in the project.
   */
  cancelStatusForProject(request: { projectId: number }): Promise<{ success: true } | SessionGitError>;
}
