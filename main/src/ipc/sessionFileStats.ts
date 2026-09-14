/**
 * Git-derived file/line stats for a session — what `sessions:get-statistics`
 * reports as `files.*` (the quick-session card's "files seen" + "+N −M" meter
 * and SessionStats' Files Modified / Lines Added / Lines Deleted).
 *
 * These used to be summed from the `execution_diffs` table, which is written
 * ONLY by ExecutionTracker.endExecution — i.e. when the agent PROCESS EXITS.
 * A warm-SDK or PTY quick session keeps one process alive across every turn,
 * so such a session accumulates ZERO rows however much it edits, and the card
 * read "0 files seen, +0 −0" while the Diff tab beside it listed hundreds of
 * changed files. Sessions that DID get rows were no better: each row is a diff
 * against that turn's HEAD, so a session that commits its work reports 0 too.
 *
 * The honest source is the same one the Diff tab uses: the worktree compared
 * against the commit the session branched from (`base_commit`), which counts
 * committed AND uncommitted AND untracked work, and — unlike a comparison
 * against live main — survives the session's commits being merged into main
 * (see getSessionCommitHistory in ipc/gitOps.ts for the same rationale).
 *
 * Known and accepted: an IN-PLACE session works in the user's own checkout
 * rather than a private worktree, so pre-existing dirty or untracked files
 * there count toward its totals. That is deliberate — the Diff tab shows those
 * same files for the same session, and a card that disagreed with the panel
 * beside it is the bug this whole module exists to fix. Isolating them would
 * need a dirty-tree baseline captured at session start, which nothing records.
 */
import type { GitDiffManager } from '../services/gitDiffManager';
import type { Logger } from '../utils/logger';
import { runGitAsync, END_OF_OPTIONS, assertNotOptionLike } from '../utils/runGit';

/** The `files` block of the sessions:get-statistics payload, minus executionCount. */
export interface SessionFileStats {
  totalFilesChanged: number;
  totalLinesAdded: number;
  totalLinesDeleted: number;
  filesModified: string[];
}

/** The slice of GitDiffManager this module needs (keeps the tests honest). */
type DiffStatsSource = Pick<GitDiffManager, 'getDiffStatsAgainstRef'>;

/**
 * Resolve the ref a session's work should be diffed against: its recorded
 * branch point when that commit still exists, else the project's main branch.
 * Returns null when neither resolves (worktree gone, `base_commit` gc'd and no
 * main branch) — the caller then has no git-derived answer to report.
 */
export async function resolveSessionDiffBaseRef(
  worktreePath: string,
  candidates: Array<string | null | undefined>,
): Promise<string | null> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      assertNotOptionLike(candidate, 'base ref candidate');
    } catch {
      // A `-`-prefixed candidate would be parsed by git as an OPTION, not a
      // value (TASK-208) — reject it locally rather than even attempting to
      // resolve it, and try the next candidate.
      continue;
    }
    try {
      // `^{commit}` forces a commit-ish resolution, so a branch name, a tag and
      // a raw sha all validate the same way; --quiet keeps git silent on miss;
      // --end-of-options forces the value position (TASK-208). Return the
      // RESOLVED sha (rev-parse's stdout), not the candidate string, so the
      // caller diffs against a concrete commit rather than a moving/ambiguous
      // ref name. Fall back to the candidate itself in the (git-cannot-happen
      // in practice, but harmless) case rev-parse succeeds with empty stdout.
      const resolved = (
        await runGitAsync(worktreePath, [
          'rev-parse',
          '--verify',
          '--quiet',
          END_OF_OPTIONS,
          `${candidate}^{commit}`,
        ])
      ).trim();
      return resolved || candidate;
    } catch {
      // Unresolvable in this worktree — try the next candidate.
    }
  }
  return null;
}

/**
 * Compute a session's file stats from git, or return null when git cannot
 * answer (no worktree, archived session whose worktree was removed, no
 * resolvable base ref, git failure). A null return means "no git-derived
 * answer" — never a zeroed one, so the caller can fall back rather than
 * publish a confident 0.
 */
export async function computeSessionFileStats(params: {
  worktreePath: string | null | undefined;
  baseCommit?: string | null;
  /**
   * Ref to compare against when `baseCommit` does not resolve (or was never
   * recorded, as for a main-repo session). Lazy on purpose: resolving it costs
   * its own git child process, and this whole function runs on the stats poll,
   * so a session whose `base_commit` still resolves — nearly all of them —
   * never pays for it.
   */
  resolveFallbackRef?: () => Promise<string | null | undefined>;
  gitDiffManager: DiffStatsSource;
  logger?: Logger;
}): Promise<SessionFileStats | null> {
  const { worktreePath, baseCommit, resolveFallbackRef, gitDiffManager, logger } = params;
  if (!worktreePath) return null;

  try {
    const baseRef =
      (await resolveSessionDiffBaseRef(worktreePath, [baseCommit])) ??
      (resolveFallbackRef
        ? await resolveSessionDiffBaseRef(worktreePath, [await resolveFallbackRef()])
        : null);
    if (!baseRef) {
      logger?.verbose(`[SessionFileStats] No resolvable base ref in ${worktreePath}`);
      return null;
    }

    const { stats, changedFiles } = await gitDiffManager.getDiffStatsAgainstRef(worktreePath, baseRef);
    return {
      totalFilesChanged: stats.filesChanged,
      totalLinesAdded: stats.additions,
      totalLinesDeleted: stats.deletions,
      filesModified: changedFiles,
    };
  } catch (error) {
    logger?.warn(
      `[SessionFileStats] Could not compute git file stats in ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
