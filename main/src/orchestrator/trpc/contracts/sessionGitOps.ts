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
 * one the merge dialog depends on: `squashAndRebaseToMain` / `rebaseToMain`
 * failures carry `needsRebase` (main advanced past the branch — rebase first)
 * and `alreadyUpToDate` (the branch had nothing left to give main, so the
 * dialog offers Mark complete instead of an error) alongside a
 * `commands`-shaped `gitError`.
 */
import type { ComparisonBases, WorktreeStatusPayload, DiffGroupScope } from '../../../../../shared/types/runFiles';

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
 * main/src/services/gitDiffManager.ts). The renderer's Diff-tab panels take
 * this shape via tRPC inference.
 *
 * `resolvedBase` and `worktree` are Seam B (TASK-212) additions, both
 * REQUIRED — a loud exhaustive tripwire rather than an optional field an
 * `undefined` could silently satisfy, which would let the center pane derive
 * its own base and reintroduce a live bug. `resolvedBase` is the concrete SHA
 * (never a branch name) the response was actually computed against, `null`
 * only for the working-dir-vs-HEAD rung (no base to anchor on). `worktree` is
 * the `getWorktreeStatus` + `getDiffGroups` (TASK-209/210) payload
 * getCombinedDiff assembles, for the grouped Diff-tab view alongside the
 * single diff blob it returns.
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

/** The `gitError` detail on a merge-to-main failure (squash or rebase). */
export interface MergeToMainGitError {
  commands?: string[];
  output?: string;
  workingDirectory?: string;
  projectPath?: string;
  originalError?: string;
}

/** The `gitError` detail on a push failure. */
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
  /** Mirrors legacy `sessions:git-commit`. Stages all changes and commits in the session worktree. */
  commit(request: {
    sessionId: string;
    message: string;
  }): Promise<{ success: true } | SessionGitError>;

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

  /** Mirrors legacy `sessions:squash-and-rebase-to-main`. See {@link MergeToMainResult}. */
  squashAndRebaseToMain(request: {
    sessionId: string;
    commitMessage: string;
  }): Promise<MergeToMainResult>;

  /** Mirrors legacy `sessions:rebase-to-main`. See {@link MergeToMainResult}. */
  rebaseToMain(request: { sessionId: string }): Promise<MergeToMainResult>;

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
   * nothing left to give main; `completedNoCode` = the session hosted a
   * COMPLETED run of a workflow that never touches the repo (Planner / Launch)
   * and the worktree has zero own commits — the DB-only sibling of
   * `delivered`/`landed` for a run whose "delivery" is backlog rows, not code.
   * Read by the dismiss dialog, which offers Mark complete when ANY of the
   * three is true. `integratedLaneCount` (TASK-296) is how many integrated
   * sprint-lane tasks have not yet reached Done — 0 unless `landed`, since only
   * a landed branch's Mark-complete actually moves them; the dialog uses it for
   * the button copy ("Mark complete (moves N tasks to Done)").
   */
  getDeliveryState(request: {
    sessionId: string;
  }): Promise<
    | {
        success: true;
        data: {
          delivered: boolean;
          landed: boolean;
          ownCommits: number;
          completedNoCode: boolean;
          integratedLaneCount?: number;
        };
      }
    | SessionGitError
  >;

  /**
   * Mirrors legacy `sessions:mark-complete`. NOT a bookkeeping-only stamp
   * (TASK-296): re-probes delivery state server-side (the same landing probe
   * `getDeliveryState` uses) and, when the branch has ALREADY landed on main
   * (merged/rebased by hand outside the app), runs the FULL sprint close-out
   * an in-app merge performs — integrated lanes -> Done (`tasksMovedToDone`),
   * batch -> terminal, outcome='merged' stamped with main's own tip as
   * `merge_sha`. Only when the branch has NOT landed does it fall back to the
   * old bookkeeping stamp (outcome='completed', no git, no lane close-out); in
   * that case, if the session has real own commits sitting on a sprint batch,
   * `laneTasksLeftOpen` reports how many integrated-lane tasks were left
   * untouched.
   */
  markComplete(request: {
    sessionId: string;
  }): Promise<
    | { success: true; data: { stamped: number; laneTasksLeftOpen?: number; tasksMovedToDone?: number } }
    | SessionGitError
  >;

  /**
   * Mirrors legacy `sessions:get-branch-commit-subjects`. Subjects of the
   * branch's OWN commits (`mainBranch..HEAD`), newest first — never main-branch
   * history.
   */
  getBranchCommitSubjects(request: {
    sessionId: string;
  }): Promise<{ success: true; data: { subjects: string[] } } | SessionGitError>;

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
   * Mirrors legacy `git:cancel-status-for-project`. Cancels in-flight git-status
   * work for every non-archived session in the project.
   */
  cancelStatusForProject(request: { projectId: number }): Promise<{ success: true } | SessionGitError>;

  /**
   * New (TASK-216): the data source for the diff panel's future BaseSelector
   * menu — every candidate base the picker can offer, resolved server-side so
   * the renderer never runs git itself. Each leg degrades independently to
   * `null` rather than throwing or fabricating an answer:
   *   • `branchPoint` — the session's recorded branch point
   *     (`resolveSessionDiffBaseRef(worktreePath, [session.baseCommit])`),
   *     `null` when `baseCommit` is unset or no longer resolves.
   *   • `defaultBranch` — the resolved project default branch name (via
   *     `origin/HEAD`'s symref, falling back to
   *     `worktreeManager.getProjectMainBranch`), `null` on a detached-HEAD
   *     project root or any other unresolvable case.
   *   • `localDefault` — that branch's LOCAL tip in this worktree plus how far
   *     HEAD trails it, `null` when `defaultBranch` is null or the local
   *     branch does not exist in this worktree.
   *   • `originDefault` — the branch's `origin/<name>` twin plus its trailing
   *     count and the freshness of the last fetch (`FETCH_HEAD`'s mtime, read
   *     only — this method NEVER runs `git fetch`), `null` when `defaultBranch`
   *     is null or there is no such origin ref.
   */
  getComparisonBases(request: { sessionId: string }): Promise<
    | { success: true; data: ComparisonBases }
    | SessionGitError
  >;

  /**
   * Start delivering "this session's worktree changed" notifications to
   * `listener` — files edited/created/removed in the worktree, and index /
   * HEAD / MERGE_HEAD movement in its git dir (`git add`, commit, a merge
   * starting or ending). The listener carries no payload: the consumer
   * refetches `getCombinedDiff` and lets THAT response be the truth.
   *
   * The returned `unsubscribe` tears the watcher down when the last listener
   * for the session leaves — the `sessionGit.onWorktreeChanged` subscription
   * calls it on abort, so a watcher lives exactly as long as a Diff tab is
   * mounted for that session and never for a session nobody is looking at.
   * `success: false` when the session or its worktree cannot be found.
   */
  subscribeWorktreeChanges(
    request: { sessionId: string },
    listener: () => void,
  ): Promise<{ success: true; unsubscribe: () => void } | SessionGitError>;
}
