/**
 * Tests for WorktreeManager.createDeterministicWorktree
 *
 * Behaviors covered (per TASK-352 test_strategy):
 * 1. Returned worktreePath ends with `.cyboflow/worktrees/<workflowName>/<runId8>`
 * 2. Returned branchName matches `cyboflow/<workflowName>/<runId8>`
 * 3. Integration: git branch is actually created in a temp repo (requires `git` in PATH)
 *
 * The path/branch-scheme unit tests stub only `_createAtPath` (the git logic)
 * and use withTempDir so `mkdir` can run normally without mocking.
 * The integration test uses a real temp git repo initialised via execSync.
 */
import { describe, it, expect, vi } from 'vitest';
import { execSync } from 'child_process';
import { join } from 'path';
import { WorktreeManager, MergeConflictError, isMergeConflictError } from '../worktreeManager';
import { withTempDir } from '../../__test_fixtures__/tmp';

// ---------------------------------------------------------------------------
// Type helper to reach _createAtPath for spying.
// We cast to a structurally-compatible interface rather than using `unknown`
// so TypeScript can resolve the method signature for vi.spyOn.
// ---------------------------------------------------------------------------
interface WorktreeManagerWithPrivates {
  _createAtPath(
    projectPath: string,
    worktreePath: string,
    branchName: string,
    baseBranch?: string,
  ): Promise<{ worktreePath: string; baseCommit: string; baseBranch: string }>;
}

// ---------------------------------------------------------------------------
// Unit-level: stub _createAtPath so no real git is needed.
// We still use real temp dirs so mkdir succeeds without mocking fs/promises.
// ---------------------------------------------------------------------------

describe('WorktreeManager.createDeterministicWorktree', () => {
  describe('path matches scheme', () => {
    it('worktreePath ends with .cyboflow/worktrees/<workflowName>/<runId8>', async () => {
      await withTempDir('worktree-unit-', async (tmpDir) => {
        const manager = new WorktreeManager();
        const runId = 'a3f2b1c09d8e7f6b5a4c3d2e1f0a9b8c';
        const expectedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'sprint', 'a3f2b1c0');

        const stub = vi.spyOn(manager as unknown as WorktreeManagerWithPrivates, '_createAtPath').mockResolvedValue({
          worktreePath: expectedWorktreePath,
          baseCommit: 'abc123',
          baseBranch: 'HEAD',
        });

        const result = await manager.createDeterministicWorktree(tmpDir, 'sprint', runId);

        expect(result.worktreePath).toMatch(/\.cyboflow[/\\]worktrees[/\\]sprint[/\\]a3f2b1c0$/);

        stub.mockRestore();
      });
    });

    it('branchName matches cyboflow/<workflowName>/<runId8>', async () => {
      await withTempDir('worktree-unit-', async (tmpDir) => {
        const manager = new WorktreeManager();
        const runId = 'a3f2b1c09d8e7f6b5a4c3d2e1f0a9b8c';
        const expectedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'sprint', 'a3f2b1c0');

        const stub = vi.spyOn(manager as unknown as WorktreeManagerWithPrivates, '_createAtPath').mockResolvedValue({
          worktreePath: expectedWorktreePath,
          baseCommit: 'abc123',
          baseBranch: 'HEAD',
        });

        const result = await manager.createDeterministicWorktree(tmpDir, 'sprint', runId);

        expect(result.branchName).toBe('cyboflow/sprint/a3f2b1c0');

        stub.mockRestore();
      });
    });

    it('uses only the first 8 chars of runId', async () => {
      await withTempDir('worktree-unit-', async (tmpDir) => {
        const manager = new WorktreeManager();
        const capturedBranch: { name: string } = { name: '' };
        const expectedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'compound', '12345678');

        const stub = vi.spyOn(manager as unknown as WorktreeManagerWithPrivates, '_createAtPath').mockImplementation(
          async (_projectPath: unknown, _wtp: unknown, branchName: unknown) => {
            capturedBranch.name = branchName as string;
            return {
              worktreePath: expectedWorktreePath,
              baseCommit: 'abc123',
              baseBranch: 'HEAD',
            };
          }
        );

        await manager.createDeterministicWorktree(
          tmpDir,
          'compound',
          '1234567890abcdef1234567890abcdef',
        );

        expect(capturedBranch.name).toBe('cyboflow/compound/12345678');

        stub.mockRestore();
      });
    });

    it('_createAtPath is called with the computed worktreePath and branchName', async () => {
      await withTempDir('worktree-unit-', async (tmpDir) => {
        const manager = new WorktreeManager();
        const runId = 'a3f2b1c09d8e7f6b5a4c3d2e1f0a9b8c';
        const expectedWorktreePath = join(tmpDir, '.cyboflow', 'worktrees', 'sprint', 'a3f2b1c0');

        const stub = vi.spyOn(manager as unknown as WorktreeManagerWithPrivates, '_createAtPath').mockResolvedValue({
          worktreePath: expectedWorktreePath,
          baseCommit: 'abc123',
          baseBranch: 'HEAD',
        });

        await manager.createDeterministicWorktree(tmpDir, 'sprint', runId);

        expect(stub).toHaveBeenCalledWith(
          tmpDir,
          expectedWorktreePath,
          'cyboflow/sprint/a3f2b1c0',
          undefined,
        );

        stub.mockRestore();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Integration: real git in a temp repo
  // -------------------------------------------------------------------------

  describe('branch matches scheme (integration)', () => {
    it('creates branch cyboflow/<workflowName>/<runId8> in the repo', async () => {
      await withTempDir('worktree-manager-test-', async (tmpDir) => {
        // Init a git repo with an initial commit so worktree add works
        execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git commit --allow-empty -m "init"', { cwd: tmpDir, stdio: 'pipe' });

        const manager = new WorktreeManager();
        const runId = 'a3f2b1c09d8e7f6b5a4c3d2e1f0a9b8c';

        const result = await manager.createDeterministicWorktree(tmpDir, 'sprint', runId);

        expect(result.branchName).toBe('cyboflow/sprint/a3f2b1c0');

        // Verify git branch exists
        const branches = execSync('git branch --list "cyboflow/sprint/a3f2b1c0"', { cwd: tmpDir }).toString().trim();
        expect(branches).toContain('cyboflow/sprint/a3f2b1c0');

        // Verify worktree path
        expect(result.worktreePath).toMatch(/\.cyboflow[/\\]worktrees[/\\]sprint[/\\]a3f2b1c0$/);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// deleteBranch (run close-out) — real temp git repo.
// ---------------------------------------------------------------------------

/** Init a temp git repo with one empty initial commit so branches can be made. */
function initRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: 'pipe' });
}

describe('WorktreeManager.deleteBranch (integration)', () => {
  it('no-ops on a blank branch name without invoking git', async () => {
    const manager = new WorktreeManager();
    // Blank name returns before any git call, so a bogus path is fine.
    await expect(manager.deleteBranch('/nonexistent', '   ')).resolves.toBeUndefined();
  });

  it('is idempotent when the branch is already gone', async () => {
    await withTempDir('worktree-delbranch-missing-', async (tmpDir) => {
      initRepo(tmpDir);
      const manager = new WorktreeManager();
      await expect(manager.deleteBranch(tmpDir, 'never-existed')).resolves.toBeUndefined();
    });
  });

  it('safe-deletes a merged (at-HEAD) branch', async () => {
    await withTempDir('worktree-delbranch-safe-', async (tmpDir) => {
      initRepo(tmpDir);
      execSync('git branch merged-feat', { cwd: tmpDir, stdio: 'pipe' });

      const manager = new WorktreeManager();
      await manager.deleteBranch(tmpDir, 'merged-feat');

      expect(execSync('git branch --list merged-feat', { cwd: tmpDir }).toString().trim()).toBe('');
    });
  });

  it('force-deletes an unmerged branch that a safe delete would refuse', async () => {
    await withTempDir('worktree-delbranch-force-', async (tmpDir) => {
      initRepo(tmpDir);
      const base = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir }).toString().trim();
      // Branch with a commit absent from base → unmerged.
      execSync('git checkout -b unmerged-feat', { cwd: tmpDir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m "feat-only"', { cwd: tmpDir, stdio: 'pipe' });
      execSync(`git checkout ${base}`, { cwd: tmpDir, stdio: 'pipe' });

      const manager = new WorktreeManager();
      await manager.deleteBranch(tmpDir, 'unmerged-feat', { force: true });

      expect(execSync('git branch --list unmerged-feat', { cwd: tmpDir }).toString().trim()).toBe('');
    });
  });
});

// ---------------------------------------------------------------------------
// getHeadCommit (session<->run restructure, Phase 1) — real temp git repo.
//
// RunLauncher uses this to snapshot base_sha when a run is hosted inside an
// existing session's worktree. It returns the worktree's current HEAD sha.
// ---------------------------------------------------------------------------

describe('WorktreeManager.getHeadCommit (integration)', () => {
  it('returns the trimmed HEAD sha of the worktree', async () => {
    await withTempDir('worktree-headcommit-', async (tmpDir) => {
      initRepo(tmpDir);
      const expected = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();

      const manager = new WorktreeManager();
      const head = await manager.getHeadCommit(tmpDir);

      expect(head).toBe(expected);
      // A full 40-char (or longer) sha with no surrounding whitespace.
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      expect(head).toBe(head.trim());
    });
  });

  it('tracks HEAD forward after a new commit', async () => {
    await withTempDir('worktree-headcommit-advance-', async (tmpDir) => {
      initRepo(tmpDir);
      const manager = new WorktreeManager();
      const first = await manager.getHeadCommit(tmpDir);

      execSync('git commit --allow-empty -m "second"', { cwd: tmpDir, stdio: 'pipe' });
      const second = await manager.getHeadCommit(tmpDir);

      expect(second).not.toBe(first);
      expect(second).toBe(execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim());
    });
  });

  it('throws a clear error for a non-git path', async () => {
    await withTempDir('worktree-headcommit-nogit-', async (tmpDir) => {
      const manager = new WorktreeManager();
      await expect(manager.getHeadCommit(tmpDir)).rejects.toThrow(/Failed to get HEAD commit/);
    });
  });
});

// ---------------------------------------------------------------------------
// mergeWorktreeToBranch (parallel-sprint P4) — real temp git repo.
//
// Mirrors the production topology: an integration branch (bare ref) cut off main,
// a per-task run worktree branched off the integration tip with its own commit,
// then merged (rebase + ff-only) BACK into the integration branch.
// ---------------------------------------------------------------------------

/** The current default branch name of `dir` (master vs main varies by git). */
function headBranch(dir: string): string {
  return execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir }).toString().trim();
}

/** Resolve the SHA a ref points at. */
function shaOf(dir: string, ref: string): string {
  return execSync(`git rev-parse ${ref}`, { cwd: dir }).toString().trim();
}

describe('WorktreeManager.mergeWorktreeToBranch (integration)', () => {
  it('rebases + fast-forwards a run worktree branch into the integration branch', async () => {
    await withTempDir('worktree-merge-branch-ok-', async (tmpDir) => {
      initRepo(tmpDir);
      const main = headBranch(tmpDir);
      const manager = new WorktreeManager();

      // Cut the integration branch (bare ref) off main, then a run worktree off it.
      const integ = 'sprint/abc12345';
      await manager.createBranchRef(tmpDir, integ, main);
      const runId = 'aabbccdd00112233aabbccdd00112233';
      const { worktreePath, branchName } = await manager.createDeterministicWorktree(tmpDir, 'task', runId, integ);

      // The run does real work: a tracked commit on its branch.
      execSync('git config user.email "t@e.com"', { cwd: worktreePath, stdio: 'pipe' });
      execSync('git config user.name "T"', { cwd: worktreePath, stdio: 'pipe' });
      execSync('echo "hello from task" > task.txt', { cwd: worktreePath, stdio: 'pipe' });
      execSync('git add -A', { cwd: worktreePath, stdio: 'pipe' });
      execSync('git commit -m "task work"', { cwd: worktreePath, stdio: 'pipe' });
      const runHead = shaOf(worktreePath, 'HEAD');

      await manager.mergeWorktreeToBranch(tmpDir, worktreePath, integ);

      // The integration branch fast-forwarded to the run's HEAD.
      expect(shaOf(tmpDir, integ)).toBe(runHead);
      // Main is untouched (per-task merges land on integration, not main).
      expect(shaOf(tmpDir, main)).not.toBe(runHead);
    });
  });

  it('integrates a dependent worktree cut off the advanced integration tip', async () => {
    await withTempDir('worktree-merge-branch-chain-', async (tmpDir) => {
      initRepo(tmpDir);
      const main = headBranch(tmpDir);
      const manager = new WorktreeManager();
      const integ = 'sprint/chain0001';
      await manager.createBranchRef(tmpDir, integ, main);

      // First task integrates onto a fresh file.
      const wtA = (await manager.createDeterministicWorktree(tmpDir, 'task', 'a'.repeat(32), integ)).worktreePath;
      execSync('git config user.email "t@e.com"', { cwd: wtA, stdio: 'pipe' });
      execSync('git config user.name "T"', { cwd: wtA, stdio: 'pipe' });
      execSync('echo A > a.txt && git add -A && git commit -m a', { cwd: wtA, stdio: 'pipe' });
      await manager.mergeWorktreeToBranch(tmpDir, wtA, integ);

      // Second task is cut off the ADVANCED integration tip → sees a.txt → no conflict.
      const wtB = (await manager.createDeterministicWorktree(tmpDir, 'task', 'b'.repeat(32), integ)).worktreePath;
      expect(execSync('cat a.txt', { cwd: wtB }).toString().trim()).toBe('A'); // prereq visible
      execSync('git config user.email "t@e.com"', { cwd: wtB, stdio: 'pipe' });
      execSync('git config user.name "T"', { cwd: wtB, stdio: 'pipe' });
      execSync('echo B > b.txt && git add -A && git commit -m b', { cwd: wtB, stdio: 'pipe' });
      await manager.mergeWorktreeToBranch(tmpDir, wtB, integ);

      const head = shaOf(tmpDir, integ);
      expect(shaOf(tmpDir, `${head}`)).toBe(head);
      expect(execSync(`git show ${integ}:b.txt`, { cwd: tmpDir }).toString().trim()).toBe('B');
      expect(execSync(`git show ${integ}:a.txt`, { cwd: tmpDir }).toString().trim()).toBe('A');
    });
  });

  it('throws an identifiable MergeConflictError on a conflicting change and leaves the worktree clean', async () => {
    await withTempDir('worktree-merge-branch-conflict-', async (tmpDir) => {
      initRepo(tmpDir);
      const main = headBranch(tmpDir);
      const manager = new WorktreeManager();
      const integ = 'sprint/conflict1';
      await manager.createBranchRef(tmpDir, integ, main);

      // Seed a file on integration so both sides can touch the same line.
      const wtSeed = (await manager.createDeterministicWorktree(tmpDir, 'task', 'c'.repeat(32), integ)).worktreePath;
      execSync('git config user.email "t@e.com"', { cwd: wtSeed, stdio: 'pipe' });
      execSync('git config user.name "T"', { cwd: wtSeed, stdio: 'pipe' });
      execSync('echo base > shared.txt && git add -A && git commit -m seed', { cwd: wtSeed, stdio: 'pipe' });
      await manager.mergeWorktreeToBranch(tmpDir, wtSeed, integ);

      // The run worktree edits shared.txt one way…
      const wtRun = (await manager.createDeterministicWorktree(tmpDir, 'task', 'd'.repeat(32), integ)).worktreePath;
      execSync('git config user.email "t@e.com"', { cwd: wtRun, stdio: 'pipe' });
      execSync('git config user.name "T"', { cwd: wtRun, stdio: 'pipe' });
      execSync('echo run-change > shared.txt && git add -A && git commit -m run', { cwd: wtRun, stdio: 'pipe' });

      // …and integration moves the SAME line a different way underneath it.
      const wtOther = (await manager.createDeterministicWorktree(tmpDir, 'task', 'e'.repeat(32), integ)).worktreePath;
      execSync('git config user.email "t@e.com"', { cwd: wtOther, stdio: 'pipe' });
      execSync('git config user.name "T"', { cwd: wtOther, stdio: 'pipe' });
      execSync('echo other-change > shared.txt && git add -A && git commit -m other', { cwd: wtOther, stdio: 'pipe' });
      await manager.mergeWorktreeToBranch(tmpDir, wtOther, integ);

      const integBefore = shaOf(tmpDir, integ);

      // Rebasing the run branch onto the advanced integration tip conflicts.
      let caught: unknown;
      try {
        await manager.mergeWorktreeToBranch(tmpDir, wtRun, integ);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MergeConflictError);
      expect(isMergeConflictError(caught)).toBe(true);
      expect((caught as MergeConflictError).targetBranch).toBe(integ);
      expect((caught as MergeConflictError).gitOutput).toMatch(/CONFLICT|conflict/i);

      // Integration branch is UNCHANGED (the failed merge did not advance it).
      expect(shaOf(tmpDir, integ)).toBe(integBefore);
      // The worktree was rebase-aborted → no rebase in progress, tree is clean.
      const status = execSync('git status --porcelain', { cwd: wtRun }).toString().trim();
      expect(status).toBe('');
      expect(() => execSync('git rev-parse --verify REBASE_HEAD', { cwd: wtRun, stdio: 'pipe' })).toThrow();
    });
  });

  it('is a benign no-op when the run branch has no commits beyond the integration tip', async () => {
    await withTempDir('worktree-merge-branch-empty-', async (tmpDir) => {
      initRepo(tmpDir);
      const main = headBranch(tmpDir);
      const manager = new WorktreeManager();
      const integ = 'sprint/empty0001';
      await manager.createBranchRef(tmpDir, integ, main);
      const { worktreePath } = await manager.createDeterministicWorktree(tmpDir, 'task', 'f'.repeat(32), integ);
      const before = shaOf(tmpDir, integ);

      // No commits made in the worktree → nothing to merge → resolves, ref unchanged.
      await expect(manager.mergeWorktreeToBranch(tmpDir, worktreePath, integ)).resolves.toBeUndefined();
      expect(shaOf(tmpDir, integ)).toBe(before);
    });
  });
});
