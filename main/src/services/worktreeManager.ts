import { join, dirname } from 'path';
import { mkdir } from 'fs/promises';
import { withLock } from '../utils/mutex';
import { appendCommitFooter } from '../utils/commitFooter';
import { runGitCapture, assertNotOptionLike, END_OF_OPTIONS } from '../utils/runGit';
import { gitIdentityFallbackArgs } from '../utils/gitIdentityFallback';
import type { ConfigManager } from './configManager';

// Interface for raw commit data
interface RawCommitData {
  hash: string;
  message: string;
  date: string | Date;
  author?: string;
  additions?: number;
  deletions?: number;
  filesChanged?: number;
}

/**
 * Machine-readable tag for "this branch has nothing left to merge — its work is
 * already in the main branch". Both merge methods below throw it, and both merge
 * IPC handlers translate it into an `alreadyUpToDate` result instead of a
 * "Merge failed" toast: the usual cause is that the AGENT merged the work in
 * chat, so the right next step is to mark the session complete, not to report a
 * failure. Matched on this code, never on the message text.
 */
export const ALREADY_UP_TO_DATE_CODE = 'already_up_to_date';

/** Tag an Error with {@link ALREADY_UP_TO_DATE_CODE} and return it. */
function alreadyUpToDate(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: ALREADY_UP_TO_DATE_CODE });
}

/**
 * Narrow seam for the Codex-broker reaper (see {@link CodexBrokerReaper}). Worktree
 * removal is the single chokepoint every dismiss/merge/delete path funnels through,
 * so it is where we reap the detached `openai-codex` plugin broker daemons rooted in
 * the worktree being removed. Kept as a minimal interface so WorktreeManager stays
 * decoupled and unit-testable (a fake satisfies it).
 */
export interface WorktreeBrokerReaper {
  reapForWorktree(worktreePath: string): Promise<void>;
}

/**
 * Typed, identifiable error thrown by {@link WorktreeManager.mergeWorktreeToBranch}
 * when rebasing a per-task run branch onto the integration branch hits a conflict
 * (or the integration update is not a fast-forward). The retired scheduler-model
 * sprint caught THIS specific class to mark a batch task `failed` without crashing
 * the batch — distinguishing a real merge conflict from any other launch/IO
 * failure. Preserved with the merge primitives for future callers.
 */
export class MergeConflictError extends Error {
  readonly gitOutput: string;
  readonly worktreePath: string;
  readonly targetBranch: string;
  constructor(message: string, details: { gitOutput: string; worktreePath: string; targetBranch: string }) {
    super(message);
    this.name = 'MergeConflictError';
    this.gitOutput = details.gitOutput;
    this.worktreePath = details.worktreePath;
    this.targetBranch = details.targetBranch;
  }
}

/** Narrow runtime guard for {@link MergeConflictError} (survives instanceof across module copies). */
export function isMergeConflictError(err: unknown): err is MergeConflictError {
  return err instanceof MergeConflictError || (err instanceof Error && err.name === 'MergeConflictError');
}

/**
 * Every git invocation below goes through runGitCapture (execFile, argv array,
 * login-shell PATH) — never a shell string. Repo-controlled values reach nearly
 * all of them: branch, remote and ref names arrive from the on-disk repository
 * and are re-read on every dashboard refresh, so a shell string would make a
 * branch named `$(…)` executable. `END_OF_OPTIONS` additionally stops a branch
 * named `--upload-pack=…` from being parsed as a git option.
 *
 * runGitCapture returns both streams because several callers below surface git's
 * progress output, which git writes to stderr.
 */

export class WorktreeManager {
  private projectsCache: Map<string, { baseDir: string }> = new Map();

  constructor(
    private configManager?: ConfigManager,
    private codexBrokerReaper?: WorktreeBrokerReaper,
  ) {
    // No longer initialized with a single repo path
  }

  /**
   * Best-effort reap of any detached Codex broker tree rooted in a just-removed
   * worktree. Fail-soft by contract: the reaper never throws, but we still guard
   * so a missing reaper (tests) or an unexpected error can never turn a successful
   * worktree removal into a failure.
   */
  private async reapCodexBrokers(worktreePath: string): Promise<void> {
    if (!this.codexBrokerReaper) return;
    try {
      await this.codexBrokerReaper.reapForWorktree(worktreePath);
    } catch (error) {
      console.warn(`[WorktreeManager] Codex broker reap failed for ${worktreePath}:`, error);
    }
  }

  private getProjectPaths(projectPath: string, worktreeFolder?: string) {
    const cacheKey = `${projectPath}:${worktreeFolder || 'worktrees'}`;
    if (!this.projectsCache.has(cacheKey)) {
      const folderName = worktreeFolder || 'worktrees';
      let baseDir: string;
      
      // Check if worktreeFolder is an absolute path
      if (worktreeFolder && (worktreeFolder.startsWith('/') || worktreeFolder.includes(':'))) {
        baseDir = worktreeFolder;
      } else {
        baseDir = join(projectPath, folderName);
      }
      
      this.projectsCache.set(cacheKey, { baseDir });
    }
    return this.projectsCache.get(cacheKey)!;
  }

  async initializeProject(projectPath: string, worktreeFolder?: string): Promise<void> {
    const { baseDir } = this.getProjectPaths(projectPath, worktreeFolder);
    try {
      await mkdir(baseDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create worktrees directory:', error);
    }
  }

  /**
   * Private helper: execute the git-worktree-add sequence for a given path and branch.
   * Both `createWorktree` and `createDeterministicWorktree` delegate here so the
   * git logic is not duplicated.
   */
  private async _createAtPath(
    projectPath: string,
    worktreePath: string,
    branchName: string,
    baseBranch?: string,
    // A/B experiments (migration 049): pin the new worktree's branch to an EXACT
    // committish (a raw SHA), not a branch tip. When set, the `refs/heads/<base>`
    // guard is skipped (a SHA is not a branch) and `git worktree add -b` cuts the
    // branch at that commit — so "the base branch moved between the two arm
    // worktree creations" is impossible by construction (both arms pin the same
    // pre-resolved SHA). See experiments.startSideBySide.
    baseCommittish?: string,
  ): Promise<{ worktreePath: string; baseCommit: string; baseBranch: string }> {
    try {
      // First check if this is a git repository
      try {
        await runGitCapture(projectPath, ['rev-parse', '--is-inside-work-tree']);
      } catch {
        // Initialize git repository
        await runGitCapture(projectPath, ['init']);
      }

      // Clean up any existing worktree directory first
      try {
        await runGitCapture(projectPath, ['worktree', 'remove', '--force', END_OF_OPTIONS, worktreePath]);
      } catch {
        // Ignore cleanup errors
      }

      // Check if the repository has any commits
      try {
        await runGitCapture(projectPath, ['rev-parse', 'HEAD']);
      } catch {
        // Repository has no commits yet, create initial commit
        try {
          await runGitCapture(projectPath, ['add', '-A']);
        } catch {
          // Ignore add errors (no files to add)
        }
        // A machine with no git identity would fail here with "Author identity
        // unknown" — fill in only the missing halves, for this command only.
        await runGitCapture(projectPath, [
          ...(await gitIdentityFallbackArgs(projectPath)),
          'commit', '-m', 'Initial commit', '--allow-empty',
        ]);
      }

      // Check if branch already exists
      let branchExists = false;
      try {
        await runGitCapture(projectPath, [
          'show-ref', '--verify', '--quiet', END_OF_OPTIONS, `refs/heads/${branchName}`,
        ]);
        branchExists = true;
      } catch {
        // Branch doesn't exist, will create it
      }

      // Capture the base commit before creating worktree
      let baseCommit: string;
      let actualBaseBranch: string;

      if (branchExists) {
        // SHA-PIN GUARD (A/B experiments): when an exact committish is requested,
        // an existing branch of the same name would SILENTLY bypass the pin (the
        // attach path below ignores baseCommittish). Hard-error instead so a caller
        // that needs a specific base SHA never gets a worktree on a stale branch.
        if (baseCommittish) {
          throw new Error(
            `Cannot pin worktree to committish '${baseCommittish}': branch '${branchName}' already exists`,
          );
        }
        // Use existing branch
        await runGitCapture(projectPath, ['worktree', 'add', END_OF_OPTIONS, worktreePath, branchName]);

        // Get the commit this branch is based on
        baseCommit = (
          await runGitCapture(projectPath, ['rev-parse', '--verify', END_OF_OPTIONS, branchName])
        ).stdout.trim();
        actualBaseBranch = branchName;
      } else if (baseCommittish) {
        // A/B pin: cut the branch at an EXACT commit. Skip the refs/heads guard (a
        // raw SHA is not a branch); actualBaseBranch keeps the human-facing branch
        // label the caller passed (or 'HEAD') for the session row.
        actualBaseBranch = baseBranch || 'HEAD';
        // rev-parse both validates the SHA (a bad committish fails loudly) and
        // records the pinned base commit.
        baseCommit = (
          await runGitCapture(projectPath, ['rev-parse', '--verify', END_OF_OPTIONS, baseCommittish])
        ).stdout.trim();
        await runGitCapture(projectPath, [
          'worktree', 'add', '-b', branchName, END_OF_OPTIONS, worktreePath, baseCommittish,
        ]);
      } else {
        // Create new branch from specified base branch (or current HEAD if not specified)
        const baseRef = baseBranch || 'HEAD';
        actualBaseBranch = baseBranch || 'HEAD';

        // Verify that the base branch exists if specified
        if (baseBranch) {
          try {
            await runGitCapture(projectPath, [
              'show-ref', '--verify', '--quiet', END_OF_OPTIONS, `refs/heads/${baseBranch}`,
            ]);
          } catch {
            throw new Error(`Base branch '${baseBranch}' does not exist`);
          }
        }

        // Capture the base commit before creating the worktree
        baseCommit = (
          await runGitCapture(projectPath, ['rev-parse', '--verify', END_OF_OPTIONS, baseRef])
        ).stdout.trim();

        await runGitCapture(projectPath, [
          'worktree', 'add', '-b', branchName, END_OF_OPTIONS, worktreePath, baseRef,
        ]);
      }

      console.log(`[WorktreeManager] Worktree created successfully at: ${worktreePath}`);

      return { worktreePath, baseCommit, baseBranch: actualBaseBranch };
    } catch (error) {
      console.error(`[WorktreeManager] Failed to create worktree:`, error);
      throw new Error(`Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async createWorktree(projectPath: string, name: string, branch?: string, baseBranch?: string, worktreeFolder?: string, baseCommittish?: string): Promise<{ worktreePath: string; baseCommit: string; baseBranch: string }> {
    return await withLock(`worktree-create-${projectPath}-${name}`, async () => {
      const { baseDir } = this.getProjectPaths(projectPath, worktreeFolder);
      const worktreePath = join(baseDir, name);
      const branchName = branch || name;
      return await this._createAtPath(projectPath, worktreePath, branchName, baseBranch, baseCommittish);
    });
  }

  /**
   * Create a worktree using deterministic, sortable naming:
   *   - worktree path: `<projectPath>/.cyboflow/worktrees/<workflowName>/<runId8>`
   *   - git branch:    `cyboflow/<workflowName>/<runId8>`
   *
   * where `runId8` = first 8 characters of `runId`.
   *
   * A named mutex (`worktree-create-<projectPath>-<runId8>`) guards against
   * concurrent creates targeting the same path.
   */
  async createDeterministicWorktree(
    projectPath: string,
    workflowName: string,
    runId: string,
    baseBranch?: string,
  ): Promise<{ worktreePath: string; branchName: string; baseCommit: string; baseBranch: string }> {
    const runId8 = runId.slice(0, 8);
    const branchName = `cyboflow/${workflowName}/${runId8}`;
    const worktreePath = join(projectPath, '.cyboflow', 'worktrees', workflowName, runId8);

    return await withLock(`worktree-create-${projectPath}-${runId8}`, async () => {
      // Ensure parent directory exists before git creates the worktree leaf
      await mkdir(dirname(worktreePath), { recursive: true });
      const result = await this._createAtPath(projectPath, worktreePath, branchName, baseBranch);
      return { ...result, branchName };
    });
  }

  async removeWorktree(projectPath: string, name: string, worktreeFolder?: string): Promise<void> {
    return await withLock(`worktree-remove-${projectPath}-${name}`, async () => {
      const { baseDir } = this.getProjectPaths(projectPath, worktreeFolder);
      const worktreePath = join(baseDir, name);

      try {
        await runGitCapture(projectPath, ['worktree', 'remove', '--force', END_OF_OPTIONS, worktreePath]);
      } catch (error: unknown) {
        const err = error as Error & { stderr?: string; stdout?: string };
        const errorMessage = err.stderr || err.stdout || err.message || String(err);

        // If the worktree is not found, that's okay - it might have been manually deleted
        if (errorMessage.includes('is not a working tree') ||
            errorMessage.includes('does not exist') ||
            errorMessage.includes('No such file or directory')) {
          console.log(`Worktree ${worktreePath} already removed or doesn't exist, skipping...`);
          // Still reap: a manually-deleted worktree can leave its detached Codex
          // broker running with a now-gone cwd.
          await this.reapCodexBrokers(worktreePath);
          return;
        }

        // For other errors, still throw
        throw new Error(`Failed to remove worktree: ${errorMessage}`);
      }
      await this.reapCodexBrokers(worktreePath);
    });
  }

  /**
   * Remove a worktree by its ABSOLUTE path (GAP-B run close-out).
   *
   * `removeWorktree` above computes the path from a flat `name` + worktree
   * folder, which matches the SESSION worktree layout. Workflow runs use a
   * nested deterministic layout (`.cyboflow/worktrees/<workflow>/<runId8>`) that
   * the name-based helper cannot reconstruct, so run close-out passes the
   * absolute `workflow_runs.worktree_path` here instead. Idempotent: an
   * already-removed / missing tree is treated as success.
   */
  async removeWorktreeByPath(projectPath: string, worktreePath: string): Promise<void> {
    return await withLock(`worktree-remove-${worktreePath}`, async () => {
      try {
        await runGitCapture(projectPath, ['worktree', 'remove', '--force', END_OF_OPTIONS, worktreePath]);
      } catch (error: unknown) {
        const err = error as Error & { stderr?: string; stdout?: string };
        const errorMessage = err.stderr || err.stdout || err.message || String(err);
        if (errorMessage.includes('is not a working tree') ||
            errorMessage.includes('does not exist') ||
            errorMessage.includes('No such file or directory')) {
          console.log(`Worktree ${worktreePath} already removed or doesn't exist, skipping...`);
          await this.reapCodexBrokers(worktreePath);
          return;
        }
        throw new Error(`Failed to remove worktree: ${errorMessage}`);
      }
      await this.reapCodexBrokers(worktreePath);
    });
  }

  /**
   * Delete a local branch (run close-out). Must be called AFTER the worktree is
   * removed, so the branch is no longer checked out in any worktree.
   *
   * `force` selects `git branch -D` (discard even if unmerged) over the safe
   * `git branch -d`. Run close-out always force-deletes:
   *   - dismiss discards the run, so its commits go with the branch;
   *   - merge has already replayed the content into main, and a SQUASH merge
   *     leaves the branch a non-ancestor of main (so a safe `-d` would wrongly
   *     report "not fully merged") — force is required for the squash case.
   *
   * Idempotent: a blank name or an already-gone branch resolves as success,
   * mirroring removeWorktreeByPath so close-out never fails on already-clean
   * state. (Create-PR intentionally does NOT call this — that branch lives on
   * origin.)
   */
  async deleteBranch(projectPath: string, branchName: string, opts?: { force?: boolean }): Promise<void> {
    const branch = branchName.trim();
    if (branch === '') return;
    return await withLock(`branch-delete-${projectPath}-${branch}`, async () => {
      const flag = opts?.force ? '-D' : '-d';
      try {
        await runGitCapture(projectPath, ['branch', flag, END_OF_OPTIONS, branch]);
      } catch (error: unknown) {
        const err = error as Error & { stderr?: string; stdout?: string };
        const errorMessage = err.stderr || err.stdout || err.message || String(err);
        // Already gone — treat as success (matches removeWorktreeByPath idempotency).
        if (errorMessage.includes('not found') ||
            errorMessage.includes("Can't find") ||
            errorMessage.includes('does not exist')) {
          console.log(`Branch ${branch} already deleted or doesn't exist, skipping...`);
          return;
        }
        throw new Error(`Failed to delete branch ${branch}: ${errorMessage}`);
      }
    });
  }

  /**
   * Create a bare branch REF (no worktree) off a base branch — the integration
   * branch for a parallel-sprint batch (`sprint/<id8>` off the project main
   * branch). Idempotent: an already-existing branch of the same name is treated
   * as success (so a rehydrating scheduler does not fail when the ref survived a
   * crash). Returns the SHA the branch points at.
   *
   * Unlike createDeterministicWorktree this does NOT add a working tree — the
   * integration branch is only ever materialized as a worktree transiently (per
   * per-task run / at finalize), never as a standing checkout.
   */
  async createBranchRef(
    projectPath: string,
    branchName: string,
    baseBranch: string,
  ): Promise<{ sha: string }> {
    const branch = branchName.trim();
    if (branch === '') throw new Error('createBranchRef: branchName is empty');
    return await withLock(`branch-create-${projectPath}-${branch}`, async () => {
      try {
        await runGitCapture(projectPath, ['branch', END_OF_OPTIONS, branch, baseBranch]);
      } catch (error: unknown) {
        const err = error as Error & { stderr?: string; stdout?: string };
        const errorMessage = err.stderr || err.stdout || err.message || String(err);
        // Already exists — treat as success (idempotent rehydration).
        if (!errorMessage.includes('already exists')) {
          throw new Error(`Failed to create branch ${branch}: ${errorMessage}`);
        }
      }
      const { stdout } = await runGitCapture(projectPath, [
        'rev-parse', '--verify', END_OF_OPTIONS, branch,
      ]);
      return { sha: stdout.trim() };
    });
  }

  async listWorktrees(projectPath: string): Promise<Array<{ path: string; branch: string }>> {
    try {
      const { stdout } = await runGitCapture(projectPath, ['worktree', 'list', '--porcelain']);
      
      const worktrees: Array<{ path: string; branch: string }> = [];
      const lines = stdout.split('\n');
      
      let currentWorktree: { path?: string; branch?: string } = {};
      
      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          if (currentWorktree.path && currentWorktree.branch) {
            worktrees.push({ 
              path: currentWorktree.path, 
              branch: currentWorktree.branch 
            });
          }
          currentWorktree = { path: line.substring(9) };
        } else if (line.startsWith('branch ')) {
          currentWorktree.branch = line.substring(7).replace('refs/heads/', '');
        }
      }
      
      if (currentWorktree.path && currentWorktree.branch) {
        worktrees.push({ 
          path: currentWorktree.path, 
          branch: currentWorktree.branch 
        });
      }
      
      return worktrees;
    } catch (error) {
      throw new Error(`Failed to list worktrees: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async listBranches(projectPath: string): Promise<Array<{ name: string; isCurrent: boolean; hasWorktree: boolean }>> {
    try {
      // Get all local branches
      const { stdout: branchOutput } = await runGitCapture(projectPath, ['branch']);
      
      // Get all worktrees to identify which branches have worktrees
      const worktrees = await this.listWorktrees(projectPath);
      const worktreeBranches = new Set(worktrees.map(w => w.branch));
      
      const branches: Array<{ name: string; isCurrent: boolean; hasWorktree: boolean }> = [];
      const lines = branchOutput.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        const isCurrent = line.startsWith('*');
        // Remove leading *, +, and spaces. The + indicates uncommitted changes
        const name = line.replace(/^[\*\+]?\s*[\+]?\s*/, '').trim();
        if (name) {
          branches.push({ 
            name, 
            isCurrent,
            hasWorktree: worktreeBranches.has(name)
          });
        }
      }
      
      // Sort branches: worktree branches first, then the rest
      branches.sort((a, b) => {
        if (a.hasWorktree && !b.hasWorktree) return -1;
        if (!a.hasWorktree && b.hasWorktree) return 1;
        // Within each group, sort alphabetically
        return a.name.localeCompare(b.name);
      });
      
      return branches;
    } catch (error) {
      console.error(`[WorktreeManager] Error listing branches:`, error);
      return [];
    }
  }

  async getProjectMainBranch(projectPath: string): Promise<string> {
    
    try {
      // ONLY check the current branch in the project root directory
      const currentBranchResult = await runGitCapture(projectPath, ['branch', '--show-current']);
      const currentBranch = currentBranchResult.stdout.trim();
      
      if (currentBranch) {
        return currentBranch;
      }
      
      // Throw error if we're in detached HEAD state
      throw new Error(`Cannot determine main branch: repository at ${projectPath} is in detached HEAD state`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('detached HEAD')) {
        throw error;
      }
      throw new Error(`Failed to get main branch for project at ${projectPath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Return the current HEAD commit sha of a worktree.
   *
   * Used by RunLauncher to snapshot `base_sha` when a workflow run is hosted
   * inside an existing session's worktree (session<->run restructure, Phase 1):
   * the run reuses the session tree rather than creating its own, so there is
   * no createDeterministicWorktree return to read the base commit from — we
   * snapshot the session worktree's HEAD here instead.
   */
  async getHeadCommit(worktreePath: string): Promise<string> {
    try {
      const { stdout } = await runGitCapture(worktreePath, ['rev-parse', 'HEAD']);
      return stdout.trim();
    } catch (error) {
      throw new Error(
        `Failed to get HEAD commit for worktree at ${worktreePath}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  // Deprecated: Use getProjectMainBranch instead
  async detectMainBranch(projectPath: string): Promise<string> {
    console.warn('[WorktreeManager] detectMainBranch is deprecated, use getProjectMainBranch instead');
    return await this.getProjectMainBranch(projectPath);
  }

  // Deprecated: Use getProjectMainBranch instead
  async getEffectiveMainBranch(project: { path: string; main_branch?: string }): Promise<string> {
    console.warn('[WorktreeManager] getEffectiveMainBranch is deprecated, use getProjectMainBranch instead');
    return await this.getProjectMainBranch(project.path);
  }

  /**
   * Whether this worktree's branch appears to have ALREADY LANDED in the main
   * branch — the "the agent merged it for me in chat" case, which our own merge
   * path never observed and therefore never stamped.
   *
   * Answering this from git is unavoidably heuristic, because a landing can
   * rewrite the commits: a squash produces one commit with different SHAs and a
   * different shape, a cherry-pick or rebase produces equivalent patches with
   * new SHAs. So we ask three questions and accept any yes:
   *
   *   1. `rev-list <main>..HEAD` is empty — every commit is literally in main
   *      (a fast-forward or rebase landing).
   *   2. `git cherry` reports no '+' commits — every commit has a patch
   *      equivalent in main (cherry-pick / rebase-with-new-SHAs).
   *   3. `git diff <main> HEAD` is empty — the two trees are identical, which is
   *      what a squash landing leaves behind when main has not moved on.
   *
   * `ownCommits` (measured from git's own `--fork-point`, falling back to a
   * plain merge-base) is what keeps an EMPTY session quiet: with no commits of
   * its own, questions 1 and 3 are vacuously true, and prompting the operator to
   * "mark complete" a session that did nothing would be pure noise. A session
   * that never committed reports landed=false.
   *
   * False negatives are the safe direction and are expected — a squash landing
   * followed by unrelated commits on main answers no to all three. The operator
   * still reaches the same decision through the merge dialog's
   * already-up-to-date path.
   *
   * Never throws: any git failure reports landed=false (fail-closed — a probe
   * that cannot see the repo must not claim work landed).
   */
  async getBranchLandingState(
    worktreePath: string,
    mainBranch: string,
  ): Promise<{ landed: boolean; ownCommits: number; commitsAhead: number }> {
    const notLanded = { landed: false, ownCommits: 0, commitsAhead: 0 };
    try {
      const branch = assertNotOptionLike(mainBranch, 'main branch');

      // git's own fork-point heuristic (it consults main's reflog, so it still
      // answers after a fast-forward landing swallowed the branch); plain
      // merge-base is the fallback when there is no reflog to consult.
      let fork = '';
      try {
        const { stdout } = await runGitCapture(worktreePath, [
          'merge-base', '--fork-point', END_OF_OPTIONS, branch, 'HEAD',
        ]);
        fork = stdout.trim();
      } catch {
        fork = '';
      }
      if (fork === '') {
        const { stdout } = await runGitCapture(worktreePath, [
          'merge-base', END_OF_OPTIONS, branch, 'HEAD',
        ]);
        fork = stdout.trim();
      }
      if (fork === '') return notLanded;

      const { stdout: ownRaw } = await runGitCapture(worktreePath, [
        'rev-list', '--count', END_OF_OPTIONS, `${assertNotOptionLike(fork, 'fork point')}..HEAD`,
      ]);
      let ownCommits = Number.parseInt(ownRaw.trim(), 10) || 0;

      const { stdout: aheadRaw } = await runGitCapture(worktreePath, [
        'rev-list', '--count', END_OF_OPTIONS, `${branch}..HEAD`,
      ]);
      const commitsAhead = Number.parseInt(aheadRaw.trim(), 10) || 0;

      if (ownCommits === 0) {
        // A FAST-FORWARD landing hides the fork: main now points AT our tip, so
        // --fork-point answers HEAD and the branch looks like it did nothing.
        // That is the same fingerprint an untouched session leaves (HEAD == main,
        // nothing ahead) — and the two need opposite answers. The per-worktree
        // HEAD reflog separates them: it records this branch's own commits
        // regardless of what main later absorbed.
        if (commitsAhead > 0) return notLanded; // behind main with nothing of ours
        ownCommits = await this.countOwnCommitsFromReflog(worktreePath);
        if (ownCommits === 0) return notLanded; // genuinely untouched session
        return { landed: true, ownCommits, commitsAhead };
      }

      if (commitsAhead === 0) return { landed: true, ownCommits, commitsAhead };

      // Patch-equivalence: '+' marks a commit with no equivalent in main.
      const { stdout: cherry } = await runGitCapture(worktreePath, ['cherry', END_OF_OPTIONS, branch, 'HEAD']);
      const unapplied = cherry.split('\n').filter((line: string) => line.trim().startsWith('+'));
      if (cherry.trim() !== '' && unapplied.length === 0) {
        return { landed: true, ownCommits, commitsAhead };
      }

      // Identical trees — the shape a squash landing leaves behind.
      try {
        await runGitCapture(worktreePath, ['diff', '--quiet', END_OF_OPTIONS, branch, 'HEAD']);
        return { landed: true, ownCommits, commitsAhead };
      } catch {
        // Non-zero exit means the trees differ: real unmerged work.
      }

      return { landed: false, ownCommits, commitsAhead };
    } catch (error) {
      console.error(`[WorktreeManager] getBranchLandingState failed for ${worktreePath}:`, error);
      return notLanded;
    }
  }

  /**
   * How many commits this worktree made on its own branch, read from the
   * PER-WORKTREE HEAD reflog (`commit` / `commit (amend)` / `commit (initial)`
   * entries). Only consulted when the commit graph has stopped being able to
   * answer — see the fast-forward branch in {@link getBranchLandingState}.
   *
   * Reflogs are local and expirable, so this is best-effort by nature; it fails
   * closed (0), which reports "not landed" and costs the operator nothing more
   * than the plain dismiss confirmation.
   */
  private async countOwnCommitsFromReflog(worktreePath: string): Promise<number> {
    try {
      const { stdout } = await runGitCapture(worktreePath, ['reflog', 'show', '--format=%gs', 'HEAD']);
      return stdout.split('\n').filter((line: string) => /^commit(\s|:)/.test(line.trim())).length;
    } catch {
      return 0;
    }
  }

  async hasChangesToRebase(worktreePath: string, mainBranch: string): Promise<boolean> {
    try {
      // Check if main branch has commits that the current branch doesn't have
      // Use cross-platform approach
      let stdout = '0';
      try {
        const result = await runGitCapture(worktreePath, [
          'rev-list', '--count', END_OF_OPTIONS, `HEAD..${mainBranch}`,
        ]);
        stdout = result.stdout;
      } catch {
        // Error checking, assume no changes
        stdout = '0';
      }
      const commitCount = parseInt(stdout.trim());
      return commitCount > 0;
    } catch (error) {
      console.error(`[WorktreeManager] Error checking for changes to rebase:`, error);
      return false;
    }
  }

  async checkForRebaseConflicts(worktreePath: string, mainBranch: string): Promise<{
    hasConflicts: boolean;
    conflictingFiles?: string[];
    conflictingCommits?: { ours: string[]; theirs: string[] };
    canAutoMerge?: boolean;
  }> {
    try {
      
      // First check if there are any changes to rebase
      const hasChanges = await this.hasChangesToRebase(worktreePath, mainBranch);
      if (!hasChanges) {
        return { hasConflicts: false, canAutoMerge: true };
      }

      // Get the merge base
      const { stdout: mergeBase } = await runGitCapture(worktreePath, [
        'merge-base', END_OF_OPTIONS, 'HEAD', mainBranch,
      ]);
      const base = mergeBase.trim();

      // Try a dry-run merge to detect conflicts
      // We use merge-tree to check for conflicts without modifying the working tree
      try {
        // The trivial 3-arg `merge-tree` predates `--end-of-options`, so the ref
        // guard is explicit here instead.
        const { stdout: mergeTreeOutput } = await runGitCapture(worktreePath, [
          'merge-tree',
          assertNotOptionLike(base, 'merge base'),
          'HEAD',
          assertNotOptionLike(mainBranch, 'main branch'),
        ]);

        // Parse merge-tree output for conflicts
        const conflictMarkers = mergeTreeOutput.match(/<<<<<<< /g);
        const hasConflicts = conflictMarkers && conflictMarkers.length > 0;
        
        if (hasConflicts) {
          // Get list of files that would conflict
          const { stdout: diffOutput } = await runGitCapture(worktreePath, [
            'diff', '--name-only', END_OF_OPTIONS, `${base}...HEAD`,
          ]);
          const ourFiles = diffOutput.trim().split('\n').filter(f => f);

          const { stdout: theirDiffOutput } = await runGitCapture(worktreePath, [
            'diff', '--name-only', END_OF_OPTIONS, `${base}...${mainBranch}`,
          ]);
          const theirFiles = theirDiffOutput.trim().split('\n').filter(f => f);

          // Find files modified in both branches
          const conflictingFiles = ourFiles.filter(f => theirFiles.includes(f));

          // Get commit info for better error reporting
          const { stdout: ourCommits } = await runGitCapture(worktreePath, [
            'log', '--oneline', END_OF_OPTIONS, `${base}..HEAD`,
          ]);
          const { stdout: theirCommits } = await runGitCapture(worktreePath, [
            'log', '--oneline', END_OF_OPTIONS, `${base}..${mainBranch}`,
          ]);

          console.log(`[WorktreeManager] Found conflicts in files: ${conflictingFiles.join(', ')}`);
          
          return {
            hasConflicts: true,
            conflictingFiles,
            conflictingCommits: {
              ours: ourCommits.trim().split('\n').filter(c => c),
              theirs: theirCommits.trim().split('\n').filter(c => c)
            },
            canAutoMerge: false
          };
        }
        
        return { hasConflicts: false, canAutoMerge: true };
        
      } catch (error: unknown) {
        const err = error as Error & { stderr?: string; stdout?: string };
        // If merge-tree is not available (older git), fall back to checking modified files
        console.log(`[WorktreeManager] merge-tree not available, using fallback conflict detection`);
        
        // Get files changed in both branches
        const { stdout: diffOutput } = await runGitCapture(worktreePath, [
          'diff', '--name-only', END_OF_OPTIONS, `${base}...HEAD`,
        ]);
        const ourFiles = diffOutput.trim().split('\n').filter(f => f);

        const { stdout: theirDiffOutput } = await runGitCapture(worktreePath, [
          'diff', '--name-only', END_OF_OPTIONS, `${base}...${mainBranch}`,
        ]);
        const theirFiles = theirDiffOutput.trim().split('\n').filter(f => f);

        // Find files modified in both branches (potential conflicts)
        const conflictingFiles = ourFiles.filter(f => theirFiles.includes(f));

        if (conflictingFiles.length > 0) {
          // Get commit info
          const { stdout: ourCommits } = await runGitCapture(worktreePath, [
            'log', '--oneline', END_OF_OPTIONS, `${base}..HEAD`,
          ]);
          const { stdout: theirCommits } = await runGitCapture(worktreePath, [
            'log', '--oneline', END_OF_OPTIONS, `${base}..${mainBranch}`,
          ]);

          console.log(`[WorktreeManager] Potential conflicts in files: ${conflictingFiles.join(', ')}`);
          
          return {
            hasConflicts: true,
            conflictingFiles,
            conflictingCommits: {
              ours: ourCommits.trim().split('\n').filter(c => c),
              theirs: theirCommits.trim().split('\n').filter(c => c)
            },
            canAutoMerge: false
          };
        }
        
        return { hasConflicts: false, canAutoMerge: true };
      }
    } catch (error: unknown) {
      console.error(`[WorktreeManager] Error checking for rebase conflicts:`, error);
      // On error, return unknown status
      return { 
        hasConflicts: false, 
        canAutoMerge: false 
      };
    }
  }

  async rebaseMainIntoWorktree(worktreePath: string, mainBranch: string): Promise<void> {
    return await withLock(`git-rebase-${worktreePath}`, async () => {
      const executedCommands: string[] = [];
      let lastOutput = '';

      try {
        // Rebase the current worktree branch onto local main branch
        executedCommands.push(`git rebase ${mainBranch} (in ${worktreePath})`);
        const rebaseResult = await runGitCapture(worktreePath, ['rebase', END_OF_OPTIONS, mainBranch]);
        lastOutput = rebaseResult.stdout || rebaseResult.stderr || '';
      } catch (error: unknown) {
        const err = error as Error & { stderr?: string; stdout?: string };
        console.error(`[WorktreeManager] Failed to rebase ${mainBranch} into worktree:`, err);

        // Create detailed error with git command output
        const gitError = new Error(`Failed to rebase ${mainBranch} into worktree`) as Error & {
          gitCommand?: string;
          gitOutput?: string;
          workingDirectory?: string;
          originalError?: Error;
        };
        gitError.gitCommand = executedCommands.join(' && ');
        gitError.gitOutput = err.stderr || err.stdout || lastOutput || err.message || '';
        gitError.workingDirectory = worktreePath;
        gitError.originalError = err;

        throw gitError;
      }
    });
  }

  async abortRebase(worktreePath: string): Promise<void> {
    try {
      // Check if we're in the middle of a rebase
      await runGitCapture(worktreePath, ['status', '--porcelain=v1']);

      // Abort the rebase
      const { stderr } = await runGitCapture(worktreePath, ['rebase', '--abort']);

      if (stderr && !stderr.includes('No rebase in progress')) {
        throw new Error(`Failed to abort rebase: ${stderr}`);
      }
    } catch (error: unknown) {
      const err = error as Error;
      console.error(`[WorktreeManager] Error aborting rebase:`, err);
      throw new Error(`Failed to abort rebase: ${err.message}`);
    }
  }

  async squashAndMergeWorktreeToMain(projectPath: string, worktreePath: string, mainBranch: string, commitMessage: string): Promise<void> {
    return await withLock(`git-squash-merge-${worktreePath}`, async () => {
      const executedCommands: string[] = [];
      let lastOutput = '';

      try {
        console.log(`[WorktreeManager] Squashing and merging worktree to ${mainBranch}: ${worktreePath}`);

        // Get current branch name in worktree
        executedCommands.push(`git branch --show-current (in ${worktreePath})`);
        const { stdout: currentBranch, stderr: stderr1 } = await runGitCapture(worktreePath, ['branch', '--show-current']);
        lastOutput = currentBranch || stderr1 || '';
        const branchName = currentBranch.trim();

        // SAFETY CHECK 1: Rebase worktree onto main FIRST before squashing. This
        // replays the branch's commits directly atop main's CURRENT tip, so the
        // squash base computed below is main's tip — not the (possibly stale)
        // fork point.
        executedCommands.push(`git rebase ${mainBranch} (in ${worktreePath})`);
        try {
          const rebaseWorktreeResult = await runGitCapture(worktreePath, ['rebase', END_OF_OPTIONS, mainBranch]);
          lastOutput = rebaseWorktreeResult.stdout || rebaseWorktreeResult.stderr || '';
          console.log(`[WorktreeManager] Successfully rebased worktree onto ${mainBranch} before squashing`);
        } catch (error: unknown) {
          const err = error as Error & { stderr?: string; stdout?: string };
          // If rebase fails, abort it in the worktree
          try {
            await runGitCapture(worktreePath, ['rebase', '--abort']);
          } catch {
            // Ignore abort errors
          }

          throw new Error(
            `Failed to rebase worktree onto ${mainBranch} before squashing. Conflicts must be resolved first.\n\n` +
            `Git output: ${err.stderr || err.stdout || err.message}`
          );
        }

        // Compute the squash base AFTER the rebase. The rebased branch is now a
        // descendant of main's tip, so merge-base(main, HEAD) === main's tip.
        // Resetting to THIS base (rather than the pre-rebase fork point) leaves
        // the squashed commit a direct child of main's tip, so the final
        // --ff-only can succeed even when main advanced past the fork with
        // non-conflicting commits. Using the stale fork point would drop main's
        // advanced commits from the squashed branch's ancestry and make ff-only
        // always refuse.
        executedCommands.push(`git merge-base ${mainBranch} HEAD (in ${worktreePath})`);
        const { stdout: baseCommit, stderr: stderr2 } = await runGitCapture(worktreePath, [
          'merge-base', END_OF_OPTIONS, mainBranch, 'HEAD',
        ]);
        lastOutput = baseCommit || stderr2 || '';
        const base = baseCommit.trim();

        // Check if there are any changes to squash (post-rebase): empty iff the
        // branch adds nothing beyond main's tip — already merged, at the tip, or
        // its commits collapsed to nothing against main. Detected AFTER the rebase
        // so a now-redundant branch does not mint an empty squash commit.
        const { stdout: commits, stderr: stderr3 } = await runGitCapture(worktreePath, [
          'log', '--oneline', END_OF_OPTIONS, `${base}..HEAD`,
        ]);
        lastOutput = commits || stderr3 || '';
        if (!commits.trim()) {
          throw alreadyUpToDate(`No commits to squash. The branch is already up to date with ${mainBranch}.`);
        }

        // Now squash all commits since base (main's tip) into one
        executedCommands.push(`git reset --soft ${base} (in ${worktreePath})`);
        const resetResult = await runGitCapture(worktreePath, ['reset', '--soft', END_OF_OPTIONS, base]);
        lastOutput = resetResult.stdout || resetResult.stderr || '';

        // Add Cyboflow footer if enabled
        const fullMessage = appendCommitFooter(commitMessage, this.configManager);

        executedCommands.push(`git commit -m "..." (in ${worktreePath})`);
        const commitResult = await runGitCapture(worktreePath, ['commit', '-m', fullMessage]);
        lastOutput = commitResult.stdout || commitResult.stderr || '';

        // Switch to main branch in the main repository
        executedCommands.push(`git checkout ${mainBranch} (in ${projectPath})`);
        const checkoutResult = await runGitCapture(projectPath, ['checkout', END_OF_OPTIONS, mainBranch]);
        lastOutput = checkoutResult.stdout || checkoutResult.stderr || '';

        // SAFETY CHECK 2: Use --ff-only merge to prevent history rewriting
        // This will fail if local main has diverged from the worktree branch
        executedCommands.push(`git merge --ff-only ${branchName} (in ${projectPath})`);
        try {
          const mergeResult = await runGitCapture(projectPath, ['merge', '--ff-only', END_OF_OPTIONS, branchName]);
          lastOutput = mergeResult.stdout || mergeResult.stderr || '';
          console.log(`[WorktreeManager] Successfully fast-forwarded ${mainBranch} to ${branchName}`);
        } catch (error: unknown) {
          const err = error as Error & { stderr?: string; stdout?: string };
          throw new Error(
            `Failed to fast-forward ${mainBranch} to ${branchName}.\n\n` +
            `This usually means ${mainBranch} has commits that ${branchName} doesn't have.\n` +
            `You may need to rebase the worktree onto ${mainBranch} first, or reset ${mainBranch} to match origin.\n\n` +
            `Git output: ${err.stderr || err.stdout || err.message}`
          );
        }

        console.log(`[WorktreeManager] Successfully squashed and merged worktree to ${mainBranch}`);
      } catch (error: unknown) {
        const err = error as Error & { stderr?: string; stdout?: string };
        console.error(`[WorktreeManager] Failed to squash and merge worktree to ${mainBranch}:`, err);

        // Create detailed error with git command output
        const gitError = new Error(`Failed to squash and merge worktree to ${mainBranch}`) as Error & {
          gitCommands?: string[];
          gitOutput?: string;
          workingDirectory?: string;
          projectPath?: string;
          originalError?: Error;
        };
        gitError.gitCommands = executedCommands;
        // Prioritize actual error messages over lastOutput (which may contain unrelated data like commit counts)
        gitError.gitOutput = err.stderr || err.stdout || err.message || lastOutput || '';
        gitError.workingDirectory = worktreePath;
        gitError.projectPath = projectPath;
        gitError.originalError = err;
        // Carry the machine-readable tag through the wrap: the caller decides
        // between "merge failed" and "already landed" on the code, and the wrap
        // replaces the message it would otherwise have to match on.
        if ((err as { code?: string }).code === ALREADY_UP_TO_DATE_CODE) {
          (gitError as { code?: string }).code = ALREADY_UP_TO_DATE_CODE;
        }

        throw gitError;
      }
    });
  }

  async mergeWorktreeToMain(projectPath: string, worktreePath: string, mainBranch: string): Promise<void> {
    return await withLock(`git-merge-worktree-${worktreePath}`, async () => {
      const executedCommands: string[] = [];
      let lastOutput = '';

      try {
        console.log(`[WorktreeManager] Merging worktree to ${mainBranch} (without squashing): ${worktreePath}`);

        // Get current branch name in worktree
        executedCommands.push(`git branch --show-current (in ${worktreePath})`);
        const { stdout: currentBranch, stderr: stderr1 } = await runGitCapture(worktreePath, ['branch', '--show-current']);
        lastOutput = currentBranch || stderr1 || '';
        const branchName = currentBranch.trim();

        // Check if there are any changes to merge
        const { stdout: commits, stderr: stderr2 } = await runGitCapture(worktreePath, [
          'log', '--oneline', END_OF_OPTIONS, `${mainBranch}..HEAD`,
        ]);
        lastOutput = commits || stderr2 || '';
        if (!commits.trim()) {
          throw alreadyUpToDate(`No commits to merge. The branch is already up to date with ${mainBranch}.`);
        }

        // SAFETY CHECK 1: Rebase worktree onto main FIRST (resolves conflicts in worktree, not main)
        executedCommands.push(`git rebase ${mainBranch} (in ${worktreePath})`);
        try {
          const rebaseWorktreeResult = await runGitCapture(worktreePath, ['rebase', END_OF_OPTIONS, mainBranch]);
          lastOutput = rebaseWorktreeResult.stdout || rebaseWorktreeResult.stderr || '';
          console.log(`[WorktreeManager] Successfully rebased worktree onto ${mainBranch}`);
        } catch (error: unknown) {
          const err = error as Error & { stderr?: string; stdout?: string };
          // If rebase fails, abort it in the worktree
          try {
            await runGitCapture(worktreePath, ['rebase', '--abort']);
          } catch {
            // Ignore abort errors
          }

          throw new Error(
            `Failed to rebase worktree onto ${mainBranch}. Conflicts must be resolved first.\n\n` +
            `Git output: ${err.stderr || err.stdout || err.message}`
          );
        }

        // Switch to main branch in the main repository
        executedCommands.push(`git checkout ${mainBranch} (in ${projectPath})`);
        const checkoutResult = await runGitCapture(projectPath, ['checkout', END_OF_OPTIONS, mainBranch]);
        lastOutput = checkoutResult.stdout || checkoutResult.stderr || '';

        // SAFETY CHECK 2: Use --ff-only merge to prevent history rewriting
        // This will fail if local main has diverged from the worktree branch
        executedCommands.push(`git merge --ff-only ${branchName} (in ${projectPath})`);
        try {
          const mergeResult = await runGitCapture(projectPath, ['merge', '--ff-only', END_OF_OPTIONS, branchName]);
          lastOutput = mergeResult.stdout || mergeResult.stderr || '';
          console.log(`[WorktreeManager] Successfully fast-forwarded ${mainBranch} to ${branchName}`);
        } catch (error: unknown) {
          const err = error as Error & { stderr?: string; stdout?: string };
          throw new Error(
            `Failed to fast-forward ${mainBranch} to ${branchName}.\n\n` +
            `This usually means ${mainBranch} has commits that ${branchName} doesn't have.\n` +
            `You may need to rebase the worktree onto ${mainBranch} first, or reset ${mainBranch} to match origin.\n\n` +
            `Git output: ${err.stderr || err.stdout || err.message}`
          );
        }

        console.log(`[WorktreeManager] Successfully merged worktree to ${mainBranch} (without squashing)`);
      } catch (error: unknown) {
        const err = error as Error & { stderr?: string; stdout?: string };
        console.error(`[WorktreeManager] Failed to merge worktree to ${mainBranch}:`, err);

        // Create detailed error with git command output
        const gitError = new Error(`Failed to merge worktree to ${mainBranch}`) as Error & {
          gitCommands?: string[];
          gitOutput?: string;
          workingDirectory?: string;
          projectPath?: string;
          originalError?: Error;
        };
        gitError.gitCommands = executedCommands;
        // Prioritize actual error messages over lastOutput (which may contain unrelated data like commit counts)
        gitError.gitOutput = err.stderr || err.stdout || err.message || lastOutput || '';
        gitError.workingDirectory = worktreePath;
        gitError.projectPath = projectPath;
        gitError.originalError = err;
        // Carry the machine-readable tag through the wrap: the caller decides
        // between "merge failed" and "already landed" on the code, and the wrap
        // replaces the message it would otherwise have to match on.
        if ((err as { code?: string }).code === ALREADY_UP_TO_DATE_CODE) {
          (gitError as { code?: string }).code = ALREADY_UP_TO_DATE_CODE;
        }

        throw gitError;
      }
    });
  }

  /**
   * Merge a per-task run's worktree branch into an ARBITRARY target branch — the
   * parallel-sprint integration branch (`sprint/<id8>`) — instead of main. A
   * generalization of {@link mergeWorktreeToMain}: same rebase-then-fast-forward
   * semantics, parameterized on the target. Does NOT special-case main.
   *
   * Topology: the target (integration) branch is a BARE ref (no checkout); each
   * per-task run branch was cut off the integration tip via
   * `createDeterministicWorktree(..., baseBranch=integrationBranch)`. So:
   *   1. rebase the worktree branch onto the (possibly advanced) integration tip
   *      — resolves conflicts in the worktree, never touching the shared ref;
   *   2. fast-forward the integration ref to the rebased worktree HEAD via
   *      `git branch -f` (a strict ff by construction once the rebase succeeds,
   *      because the rebased branch is an ancestor-descendant of the integration
   *      tip). Because the integration branch is never checked out, `branch -f`
   *      cannot be refused for "checked out in a worktree".
   *
   * On a rebase conflict (or any non-ff) the rebase is aborted in the worktree and
   * a typed {@link MergeConflictError} is thrown — the scheduler marks the batch
   * task `failed` and continues draining other tasks (the batch does NOT crash).
   * On success the integration branch points at the run's content; the caller
   * (scheduler) then removes the worktree + deletes the run branch.
   */
  async mergeWorktreeToBranch(projectPath: string, worktreePath: string, targetBranch: string): Promise<void> {
    return await withLock(`git-merge-worktree-${worktreePath}`, async () => {
      const executedCommands: string[] = [];
      let lastOutput = '';

      // Resolve the worktree's own branch name up front so error paths can name it.
      let branchName = '';
      try {
        console.log(`[WorktreeManager] Merging worktree into branch ${targetBranch}: ${worktreePath}`);

        executedCommands.push(`git branch --show-current (in ${worktreePath})`);
        const { stdout: currentBranch, stderr: stderr1 } = await runGitCapture(worktreePath, ['branch', '--show-current']);
        lastOutput = currentBranch || stderr1 || '';
        branchName = currentBranch.trim();

        // Nothing to merge: the run made no commits beyond the integration tip
        // (e.g. a commit-less flow). Treat as a benign success — the integration
        // ref is already at-or-ahead of this branch, so there is nothing to do.
        const { stdout: commits, stderr: stderr2 } = await runGitCapture(worktreePath, [
          'log', '--oneline', END_OF_OPTIONS, `${targetBranch}..HEAD`,
        ]);
        lastOutput = commits || stderr2 || '';
        if (!commits.trim()) {
          console.log(`[WorktreeManager] No commits to merge into ${targetBranch}; benign no-op.`);
          return;
        }

        // SAFETY 1: rebase the worktree branch onto the integration tip. Conflicts
        // surface here and are resolved in the worktree, never on the shared ref.
        executedCommands.push(`git rebase ${targetBranch} (in ${worktreePath})`);
        try {
          const rebaseResult = await runGitCapture(worktreePath, ['rebase', END_OF_OPTIONS, targetBranch]);
          lastOutput = rebaseResult.stdout || rebaseResult.stderr || '';
          console.log(`[WorktreeManager] Rebased worktree onto ${targetBranch}`);
        } catch (error: unknown) {
          const err = error as Error & { stderr?: string; stdout?: string };
          // Abort so the worktree is left clean for inspection / a later retry.
          try {
            await runGitCapture(worktreePath, ['rebase', '--abort']);
          } catch {
            // ignore abort failures — best effort.
          }
          throw new MergeConflictError(
            `Failed to rebase worktree branch ${branchName} onto ${targetBranch}: conflicts must be resolved first.`,
            {
              gitOutput: err.stderr || err.stdout || err.message || lastOutput || '',
              worktreePath,
              targetBranch,
            },
          );
        }

        // SAFETY 2: fast-forward the integration ref to the rebased worktree HEAD.
        // `git branch -f <target> HEAD` is a strict ff here (the rebased branch is
        // a descendant of the integration tip) and is rejected by git only if the
        // target is checked out — which the bare integration ref never is.
        executedCommands.push(`git branch -f ${targetBranch} HEAD (in ${worktreePath})`);
        try {
          const ffResult = await runGitCapture(worktreePath, ['branch', '-f', END_OF_OPTIONS, targetBranch, 'HEAD']);
          lastOutput = ffResult.stdout || ffResult.stderr || '';
          console.log(`[WorktreeManager] Fast-forwarded ${targetBranch} to ${branchName}`);
        } catch (error: unknown) {
          const err = error as Error & { stderr?: string; stdout?: string };
          throw new MergeConflictError(
            `Failed to fast-forward ${targetBranch} to ${branchName}.`,
            {
              gitOutput: err.stderr || err.stdout || err.message || lastOutput || '',
              worktreePath,
              targetBranch,
            },
          );
        }

        console.log(`[WorktreeManager] Merged worktree branch ${branchName} into ${targetBranch}`);
      } catch (error: unknown) {
        // A MergeConflictError is already shaped + identifiable — rethrow as-is.
        if (isMergeConflictError(error)) {
          console.error(`[WorktreeManager] Merge conflict into ${targetBranch}:`, error.gitOutput);
          throw error;
        }
        const err = error as Error & { stderr?: string; stdout?: string };
        console.error(`[WorktreeManager] Failed to merge worktree into ${targetBranch}:`, err);
        const gitError = new Error(`Failed to merge worktree into ${targetBranch}`) as Error & {
          gitCommands?: string[];
          gitOutput?: string;
          workingDirectory?: string;
          projectPath?: string;
          originalError?: Error;
        };
        gitError.gitCommands = executedCommands;
        gitError.gitOutput = err.stderr || err.stdout || err.message || lastOutput || '';
        gitError.workingDirectory = worktreePath;
        gitError.projectPath = projectPath;
        gitError.originalError = err;
        throw gitError;
      }
    });
  }

  generateRebaseCommands(mainBranch: string): string[] {
    return [
      `git rebase ${mainBranch}`
    ];
  }

  generateSquashCommands(mainBranch: string, branchName: string): string[] {
    return [
      `# In worktree: Rebase onto ${mainBranch} to get latest changes`,
      `git rebase ${mainBranch}`,
      `# In worktree: Squash all commits into one`,
      `git reset --soft $(git merge-base ${mainBranch} HEAD)`,
      `git commit -m "Your commit message"`,
      `# In main repo: Switch to ${mainBranch}`,
      `git checkout ${mainBranch}`,
      `# In main repo: Merge the worktree branch`,
      `git merge --ff-only ${branchName}`
    ];
  }

  generateMergeCommands(mainBranch: string, branchName: string): string[] {
    return [
      `# In worktree: Rebase onto ${mainBranch} to get latest changes`,
      `git rebase ${mainBranch}`,
      `# In main repo: Switch to ${mainBranch}`,
      `git checkout ${mainBranch}`,
      `# In main repo: Merge the worktree branch`,
      `git merge --ff-only ${branchName}`
    ];
  }

  async gitPull(worktreePath: string): Promise<{ output: string }> {
    try {
      const { stdout, stderr } = await runGitCapture(worktreePath, ['pull']);
      const output = stdout || stderr || 'Pull completed successfully';
      
      return { output };
    } catch (error: unknown) {
      const err = error as Error & { stderr?: string; stdout?: string };
      const gitError = new Error(err.message || 'Git pull failed') as Error & {
        gitOutput?: string;
        workingDirectory?: string;
      };
      gitError.gitOutput = err.stderr || err.stdout || err.message || '';
      gitError.workingDirectory = worktreePath;
      throw gitError;
    }
  }

  async gitPush(worktreePath: string): Promise<{ output: string }> {
    try {
      // Push the current branch and SET its upstream in one shot. A worktree
      // branch (e.g. a quick-session `quick-…` branch) has never been pushed and
      // has no tracking upstream, so a bare `git push` fails with "The current
      // branch … has no upstream branch". `-u origin HEAD` pushes the current
      // branch to origin/<same-name> and records the tracking ref; it is
      // idempotent for an already-tracked branch (re-affirms the same upstream).
      const { stdout, stderr } = await runGitCapture(worktreePath, ['push', '-u', 'origin', 'HEAD']);
      const output = stdout || stderr || 'Push completed successfully';
      
      return { output };
    } catch (error: unknown) {
      const err = error as Error & { stderr?: string; stdout?: string };
      const gitError = new Error(err.message || 'Git push failed') as Error & {
        gitOutput?: string;
        workingDirectory?: string;
      };
      gitError.gitOutput = err.stderr || err.stdout || err.message || '';
      gitError.workingDirectory = worktreePath;
      throw gitError;
    }
  }

  /**
   * Resolve the `origin` remote URL and the current branch name for a worktree.
   * Used by the run-scoped Create-PR flow (cyboflow.runs.createPr) to build the
   * GitHub compare URL after pushing — the worktree-path twin of the session
   * `sessions:get-remote-url` IPC handler (which does the same two git reads).
   */
  async getRemoteUrlAndBranch(worktreePath: string): Promise<{ remoteUrl: string; branchName: string }> {
    const { stdout: remoteOut } = await runGitCapture(worktreePath, ['remote', 'get-url', 'origin']);
    const { stdout: branchOut } = await runGitCapture(worktreePath, ['branch', '--show-current']);
    return { remoteUrl: remoteOut.trim(), branchName: branchOut.trim() };
  }

  async getLastCommits(worktreePath: string, count: number = 20): Promise<RawCommitData[]> {
    // `count` reaches here straight off an IPC channel, so it is coerced to a
    // positive integer rather than trusted: an argv element like `-1 --foo`
    // would otherwise land in git's option position.
    const limit = Math.max(1, Math.floor(Number(count) || 20));
    try {
      // The single quotes around the old --pretty format were SHELL quoting, so
      // they must not survive into the argv form (they would become literal
      // characters in every commit hash).
      const { stdout } = await runGitCapture(worktreePath, [
        'log', `-${limit}`, '--pretty=format:%H|%s|%ai|%an', '--shortstat',
      ]);

      const commits: RawCommitData[] = [];
      const lines = stdout.split('\n');
      let i = 0;
      
      while (i < lines.length) {
        const commitLine = lines[i];
        if (!commitLine || !commitLine.includes('|')) {
          i++;
          continue;
        }
        
        const parts = commitLine.split('|');
        const hash = parts.shift() || '';
        const author = (parts.pop() || '').trim();
        const date = (parts.pop() || '').trim();
        const message = parts.join('|');

        const commit: RawCommitData = {
          hash: hash.trim(),
          message: message.trim(),
          date,
          author: author || 'Unknown'
        };
        
        if (i + 1 < lines.length && lines[i + 1].trim()) {
          const statsLine = lines[i + 1].trim();
          const statsMatch = statsLine.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
          
          if (statsMatch) {
            commit.filesChanged = parseInt(statsMatch[1]) || 0;
            commit.additions = parseInt(statsMatch[2]) || 0;
            commit.deletions = parseInt(statsMatch[3]) || 0;
            i++;
          }
        }
        
        commits.push(commit);
        i++;
      }
      
      return commits;
    } catch (error: unknown) {
      const err = error as Error & { stderr?: string; stdout?: string };
      const gitError = new Error(err.message || 'Failed to get commits') as Error & {
        gitOutput?: string;
        workingDirectory?: string;
      };
      gitError.gitOutput = err.stderr || err.stdout || err.message || '';
      gitError.workingDirectory = worktreePath;
      throw gitError;
    }
  }

  async getOriginBranch(worktreePath: string, branch: string): Promise<string | null> {
    try {
      await runGitCapture(worktreePath, ['rev-parse', '--verify', END_OF_OPTIONS, `origin/${branch}`]);
      return `origin/${branch}`;
    } catch {
      return null;
    }
  }
}
