/**
 * Shared row/payload types for the workflow-run File Explorer
 * (cyboflow.runs.listFiles / cyboflow.runs.readFile).
 *
 * A run's files live in its git worktree (workflow_runs.worktree_path). The
 * File Explorer rail lists that tree and reads individual files read-only so the
 * user can inspect what an agent produced. Paths are RELATIVE to the worktree
 * root and use POSIX ('/') separators on the wire.
 */

/** One entry (file or directory) in a worktree directory listing. */
export interface RunFileEntry {
  /** Base name (the last path segment). */
  name: string;
  /** Path relative to the worktree root, POSIX-style ('/' separators). */
  path: string;
  /** True for a directory; false for a regular file. */
  isDirectory: boolean;
  /** Byte size for regular files; omitted for directories / unstatable entries. */
  size?: number;
}

/** Why a file's text content was withheld, or null when content is present. */
export type RunFileUnviewableReason = 'binary' | 'too-large';

/** Aggregate +/- stats for a run's working-directory diff. */
export interface RunGitDiffStats {
  additions: number;
  deletions: number;
  filesChanged: number;
}

/**
 * The working-directory diff of a run's git worktree
 * (cyboflow.runs.gitDiff). Flow runs have workflow_runs.session_id = NULL and
 * are keyed by runId (not sessionId), so the diff is resolved from
 * workflow_runs.worktree_path rather than the session-scoped diff path. `diff`
 * is the raw unified-diff string the DiffViewer parses; an empty string means
 * the worktree has no working-directory changes.
 */
export interface RunGitDiff {
  /** Raw unified-diff text (empty string when there are no changes). */
  diff: string;
  /** Aggregate +/- stats mirroring GitDiffManager's GitDiffStats. */
  stats: RunGitDiffStats;
  /** Paths (worktree-relative) that changed. */
  changedFiles: string[];
  /**
   * The SHA `diff`/`stats`/`changedFiles` were actually diffed against — the
   * resolved form of whichever ref (comparisonRef, then baseRef) the caller
   * supplied. `null` only for the working-directory-vs-HEAD fallback (no
   * resolvable ref was supplied), never a substitute for "unknown". Downstream
   * consumers rely on this to know they are looking at the SAME base as the
   * grouped worktree view below.
   */
  resolvedBase: string | null;
  /**
   * The worktree's per-path status flags + the four group rollups
   * (unstaged/staged/untracked/committed), computed against the SAME
   * `resolvedBase` above — the grouped Diff-tab view.
   */
  worktree: WorktreeStatusPayload;
}

/**
 * Which diff-viewer group a `WorktreeStatusEntry` belongs in. 'committed' has
 * no `git status` counterpart (it covers commits made since a base ref, e.g.
 * `captureDiffAgainstRef`'s ref) — status only ever classifies the working
 * tree + index, so this member exists purely for callers grouping alongside a
 * status join, not something `getWorktreeStatus` itself ever produces.
 */
export type DiffGroupScope = 'unstaged' | 'staged' | 'untracked' | 'committed';

/**
 * One `git status --porcelain=v1 -z --untracked-files=all` entry, as a flag
 * record rather than an enum: a path with both staged and unstaged changes
 * (porcelain `MM`) sets BOTH `staged` and `unstaged`, which a single-scope
 * classification cannot represent. `conflicted` is mutually exclusive with
 * the other three flags — an unmerged path (`UU`/`AA`/`DD`/`AU`/`UA`/`DU`/
 * `UD`) sets only `conflicted`, never `staged`/`unstaged` (see
 * GitDiffManager.getWorktreeStatus).
 */
export interface WorktreeStatusEntry {
  /** Path relative to the worktree root ('/' separators). For a rename, the NEW path. */
  path: string;
  /** Present only for a rename/copy: the path this entry was renamed/copied from. */
  oldPath?: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

/**
 * Per-scope membership + aggregate +/- rollup for one `DiffGroupScope`
 * (TASK-210). Computed from an INDEPENDENT `git diff --numstat` call per
 * scope rather than derived from a single base-relative diff blob: a file
 * that is both committed-since-base and separately dirty in the working tree
 * needs different numbers in the Committed group vs. the Unstaged group, and
 * a single combined diff cannot represent that. `files` is the membership
 * list for that group (worktree-relative paths).
 */
export interface DiffGroupRollup {
  scope: DiffGroupScope;
  files: string[];
  additions: number;
  deletions: number;
  /**
   * Per-file +/- for THIS scope, keyed by the same worktree-relative path as
   * `files` — the scope-specific numbers a grouped row shows (a file that is
   * both Staged and Unstaged has different deltas in each, which the
   * base-relative combined diff cannot express). Optional on the wire so an
   * older/stub producer (e.g. main/src/index.ts's empty payload) stays
   * valid; consumers fall back to the combined-diff numbers when absent.
   */
  fileStats?: Record<string, { additions: number; deletions: number }>;
}

/**
 * Wire payload combining `getWorktreeStatus`'s per-path flags with the
 * per-scope rollups from `GitDiffManager.getDiffGroups` (TASK-210). `groups`
 * always has exactly 4 entries, one per `DiffGroupScope`, in a fixed render
 * order (unstaged, staged, untracked, committed).
 *
 * `committedUnavailable` is true whenever Committed membership could not be
 * computed from a merge-base with HEAD — no base ref supplied, or the
 * merge-base step failed (e.g. unrelated histories with no common ancestor).
 * In that case Committed's `files`/`additions`/`deletions` are all empty/zero
 * — this NEVER falls back to treating "the whole tree" as committed.
 */
export interface WorktreeStatusPayload {
  entries: WorktreeStatusEntry[];
  groups: DiffGroupRollup[];
  committedUnavailable: boolean;
}

/**
 * Success payload of `cyboflow.sessionGit.getComparisonBases` (TASK-216) —
 * the candidate bases the Diff tab's BaseSelector offers. Declared once here
 * so the ops contract, the tRPC router and the renderer cannot drift; each
 * leg's null semantics are documented on the contract method
 * (main/src/orchestrator/trpc/contracts/sessionGitOps.ts).
 */
export interface ComparisonBases {
  branchPoint: { ref: string; shortSha: string } | null;
  defaultBranch: string | null;
  localDefault: { ref: string; behind: number } | null;
  originDefault: { ref: string; behind: number; fetchedAt: string | null } | null;
}

/** The result of reading a single file from a run's worktree. */
export interface RunFileContent {
  /** Path relative to the worktree root, POSIX-style ('/' separators). */
  path: string;
  /**
   * UTF-8 text content, or null when the file is binary or exceeds the viewer
   * size cap (see `unviewableReason`).
   */
  content: string | null;
  /** Byte size of the file on disk. */
  size: number;
  /**
   * Set when `content` is null to explain why: 'binary' (NUL bytes detected) or
   * 'too-large' (over the viewer cap). Null when `content` is present.
   */
  unviewableReason: RunFileUnviewableReason | null;
}
