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
