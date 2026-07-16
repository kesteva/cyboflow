import { execSync, ExtendedExecSyncOptions } from '../utils/commandExecutor';
import { runGitAsync, RunGitOptions } from '../utils/runGit';
import * as fs from 'fs';

/**
 * Optimized git commands using plumbing (low-level) commands
 * These are generally faster than porcelain commands like `git status`
 */

export interface GitIndexStatus {
  hasModified: boolean;
  hasStaged: boolean;
  hasUntracked: boolean;
  hasConflicts: boolean;
}

/** Options threaded through to runGitAsync for the async status helpers below. */
export type FastGitOptions = Pick<RunGitOptions, 'signal' | 'timeout'>;

/**
 * An AbortError means WE cancelled the git child (superseded/torn-down fetch),
 * not that git reported something meaningful — it must never be swallowed into
 * a boolean dirty/clean signal like a real git failure is. Rethrow it so it
 * propagates to the caller instead.
 */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Fast check if working directory has any changes using git plumbing commands
 * Much faster than running full `git status --porcelain`
 */
export async function fastCheckWorkingDirectory(cwd: string, options: FastGitOptions = {}): Promise<GitIndexStatus> {
  const result: GitIndexStatus = {
    hasModified: false,
    hasStaged: false,
    hasUntracked: false,
    hasConflicts: false
  };

  // Check if the directory exists before attempting git operations
  // This prevents ENOENT errors when worktrees have been deleted (e.g., /tmp cleanup)
  try {
    fs.accessSync(cwd, fs.constants.F_OK);
  } catch {
    // Directory doesn't exist - return safe defaults
    console.warn(`[GitPlumbing] Directory does not exist: ${cwd}`);
    return {
      hasModified: true,
      hasStaged: true,
      hasUntracked: true,
      hasConflicts: false
    };
  }

  try {
    // 1. Refresh the index first (very fast, updates git's cache)
    try {
      await runGitAsync(cwd, ['update-index', '--refresh', '--ignore-submodules'], options);
    } catch (err) {
      if (isAbortError(err)) throw err;
      // Some files may have been modified, that's ok
    }

    // 2. Check for unstaged changes (modified files in working directory)
    try {
      await runGitAsync(cwd, ['diff-files', '--quiet', '--ignore-submodules'], options);
    } catch (err) {
      if (isAbortError(err)) throw err;
      result.hasModified = true;
    }

    // 3. Check for staged changes (in index)
    try {
      await runGitAsync(cwd, ['diff-index', '--cached', '--quiet', 'HEAD', '--ignore-submodules'], options);
    } catch (err) {
      if (isAbortError(err)) throw err;
      result.hasStaged = true;
    }

    // 4. Check for untracked files (more efficient than ls-files for just checking existence)
    const untrackedCheck = (await runGitAsync(
      cwd,
      ['ls-files', '--others', '--exclude-standard', '--directory', '--no-empty-directory'],
      options
    )).trim();

    if (untrackedCheck) {
      result.hasUntracked = true;
    }

    // 5. Check for merge conflicts
    const conflictCheck = (await runGitAsync(cwd, ['diff', '--name-only', '--diff-filter=U'], options)).trim();

    if (conflictCheck) {
      result.hasConflicts = true;
    }

    return result;
  } catch (error) {
    // A deliberate cancellation must propagate, not be reported as "dirty".
    if (isAbortError(error)) throw error;
    // If any unexpected error, return safe defaults
    return {
      hasModified: true,
      hasStaged: true,
      hasUntracked: true,
      hasConflicts: false
    };
  }
}

/**
 * Get count of commits ahead/behind using rev-list (faster than rev-parse)
 */
export async function fastGetAheadBehind(
  cwd: string,
  baseBranch: string,
  options: FastGitOptions = {}
): Promise<{ ahead: number; behind: number }> {
  // Check if the directory exists before attempting git operations
  try {
    fs.accessSync(cwd, fs.constants.F_OK);
  } catch {
    console.warn(`[GitPlumbing] Directory does not exist: ${cwd}`);
    return { ahead: 0, behind: 0 };
  }

  try {
    // Arg-array form also kills the shell-injection/quoting risk baseBranch used to carry.
    const result = (await runGitAsync(cwd, ['rev-list', '--left-right', '--count', `${baseBranch}...HEAD`], options)).trim();

    const [behind, ahead] = result.split('\t').map(n => parseInt(n, 10));
    return {
      ahead: ahead || 0,
      behind: behind || 0
    };
  } catch (err) {
    if (isAbortError(err)) throw err;
    return { ahead: 0, behind: 0 };
  }
}

/**
 * Get statistics about changes (additions/deletions) efficiently
 */
export async function fastGetDiffStats(
  cwd: string,
  options: FastGitOptions = {}
): Promise<{ additions: number; deletions: number; filesChanged: number }> {
  // Check if the directory exists before attempting git operations
  try {
    fs.accessSync(cwd, fs.constants.F_OK);
  } catch {
    console.warn(`[GitPlumbing] Directory does not exist: ${cwd}`);
    return { additions: 0, deletions: 0, filesChanged: 0 };
  }

  try {
    // Use numstat for machine-readable output (faster to parse)
    const result = (await runGitAsync(cwd, ['diff', '--numstat'], options)).trim();

    if (!result) {
      return { additions: 0, deletions: 0, filesChanged: 0 };
    }

    const lines = result.split('\n');
    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      const [added, deleted] = line.split('\t');
      if (added !== '-') additions += parseInt(added, 10);
      if (deleted !== '-') deletions += parseInt(deleted, 10);
    }

    return {
      additions,
      deletions,
      filesChanged: lines.length
    };
  } catch (err) {
    if (isAbortError(err)) throw err;
    return { additions: 0, deletions: 0, filesChanged: 0 };
  }
}

/**
 * Check if a specific path has been modified (useful for targeted checks)
 */
export function isPathModified(cwd: string, path: string): boolean {
  // Check if the directory exists before attempting git operations
  try {
    fs.accessSync(cwd, fs.constants.F_OK);
  } catch {
    console.warn(`[GitPlumbing] Directory does not exist: ${cwd}`);
    return false;
  }

  try {
    // TODO(TASK-680): migrate to runGit(cwd, args[]) — see main/src/utils/runGit.ts
    execSync(`git diff-files --quiet --ignore-submodules -- "${path}"`, { cwd, encoding: 'utf8', silent: true });
    return false;
  } catch {
    return true;
  }
}

/**
 * Get current branch name efficiently
 */
export function getCurrentBranch(cwd: string): string | null {
  // Check if the directory exists before attempting git operations
  try {
    fs.accessSync(cwd, fs.constants.F_OK);
  } catch {
    console.warn(`[GitPlumbing] Directory does not exist: ${cwd}`);
    return null;
  }

  try {
    return execSync('git symbolic-ref --short HEAD', { cwd }).toString().trim();
  } catch {
    // Might be in detached HEAD state
    try {
      return execSync('git rev-parse --short HEAD', { cwd }).toString().trim();
    } catch {
      return null;
    }
  }
}

/**
 * Check if repository is in the middle of a rebase
 */
export function isRebasing(cwd: string): boolean {
  // Check if the directory exists before attempting git operations
  try {
    fs.accessSync(cwd, fs.constants.F_OK);
  } catch {
    console.warn(`[GitPlumbing] Directory does not exist: ${cwd}`);
    return false;
  }

  try {
    // Check for rebase directories
    execSync('test -d .git/rebase-merge || test -d .git/rebase-apply', { cwd });
    return true;
  } catch {
    return false;
  }
}