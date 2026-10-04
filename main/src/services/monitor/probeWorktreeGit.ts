/**
 * One-shot git read of a worktree's uncommitted / ahead-of-main state, for reap
 * targets `GitStatusManager` has no cache entry for.
 *
 * The status cache is keyed by SESSION id, so an orphan worktree (no owning
 * session or run — exactly what "Reap all stale" targets) can never be in it.
 * Without this probe the confirm dialog could not warn that a stale worktree holds
 * uncommitted work the prune then discards. It runs only when a manifest is
 * resolved (the destructive gate), never on the snapshot poll.
 */
import path from 'node:path';
import { runGitAsync } from '../../utils/runGit';

export interface WorktreeGitProbe {
  dirty: boolean;
  /** Every changed or untracked file (`git status --porcelain --untracked-files=all`). */
  dirtyFileCount: number;
  /** Commits on HEAD not on the project's main branch; null when that base can't be resolved. */
  aheadOfMain: number | null;
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

const GIT_TIMEOUT_MS = 15_000;

const defaultRunner: GitRunner = (cwd, args) => runGitAsync(cwd, args, { timeout: GIT_TIMEOUT_MS });

/**
 * The main branch is the branch checked out in the project root — the same rule as
 * `WorktreeManager.getProjectMainBranch`. The root is the parent of the worktree's
 * (shared) git common dir.
 */
async function resolveMainBranch(worktreePath: string, git: GitRunner): Promise<string | null> {
  const commonDir = (await git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  if (!commonDir || path.basename(commonDir) !== '.git') return null;
  const branch = (await git(path.dirname(commonDir), ['branch', '--show-current'])).trim();
  return branch || null;
}

/** Null when the path can't be read as a git worktree at all (gone, not a repo). */
export async function probeWorktreeGit(
  worktreePath: string,
  git: GitRunner = defaultRunner,
): Promise<WorktreeGitProbe | null> {
  let statusOut: string;
  try {
    statusOut = await git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']);
  } catch {
    return null;
  }
  const dirtyFileCount = statusOut.split('\n').filter((line) => line.trim().length > 0).length;

  let aheadOfMain: number | null = null;
  try {
    const main = await resolveMainBranch(worktreePath, git);
    if (main) {
      const count = (await git(worktreePath, ['rev-list', '--count', `${main}..HEAD`, '--'])).trim();
      const n = Number.parseInt(count, 10);
      aheadOfMain = Number.isFinite(n) ? n : null;
    }
  } catch {
    aheadOfMain = null;
  }
  return { dirty: dirtyFileCount > 0, dirtyFileCount, aheadOfMain };
}
