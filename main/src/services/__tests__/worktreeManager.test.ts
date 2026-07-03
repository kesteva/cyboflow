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
import { writeFileSync, existsSync, mkdirSync } from 'fs';
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

// ===========================================================================
// B5 — worktreeManager destructive lifecycle (real-git tmp-repo integration).
//
// Every test builds its own repo under withTempDir(os.tmpdir()); no test ever
// mutates the cyboflow repo itself. Mirrors the mergeWorktreeToBranch style
// above (initRepo / headBranch / shaOf helpers).
// ===========================================================================

/** Set a local git identity so commits succeed in a worktree/clone. */
function ensureUser(dir: string): void {
  execSync('git config user.email "t@e.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: dir, stdio: 'pipe' });
}

/** Write `content` to `dir/rel`, stage everything, and commit with `msg`. */
function commitFile(dir: string, rel: string, content: string, msg: string): void {
  writeFileSync(join(dir, rel), content);
  execSync('git add -A', { cwd: dir, stdio: 'pipe' });
  execSync(`git commit -m "${msg}"`, { cwd: dir, stdio: 'pipe' });
}

// ---------------------------------------------------------------------------
// squashAndMergeWorktreeToMain — mutates the project's ACTUAL main branch.
// ---------------------------------------------------------------------------

describe('WorktreeManager.squashAndMergeWorktreeToMain (integration)', () => {
  it('squashes a clean multi-commit branch into ONE footer-stamped commit and fast-forwards main', async () => {
    await withTempDir('worktree-squash-ok-', async (tmpDir) => {
      initRepo(tmpDir);
      const main = headBranch(tmpDir);
      const manager = new WorktreeManager(); // no configManager → footer enabled by default
      const { worktreePath } = await manager.createWorktree(tmpDir, 'feat');
      ensureUser(worktreePath);
      commitFile(worktreePath, 'f1.txt', 'one', 'w1');
      commitFile(worktreePath, 'f2.txt', 'two', 'w2');

      const mainBefore = shaOf(tmpDir, main);
      await manager.squashAndMergeWorktreeToMain(tmpDir, worktreePath, main, 'my squash message');

      // Exactly one new commit landed on main (the squash).
      const count = execSync(`git rev-list --count ${mainBefore}..${main}`, { cwd: tmpDir }).toString().trim();
      expect(count).toBe('1');

      // The squashed commit carries the caller message AND the Cyboflow footer.
      const body = execSync(`git log -1 --format=%B ${main}`, { cwd: tmpDir }).toString();
      expect(body).toContain('my squash message');
      expect(body).toMatch(/Built using \[Cyboflow\]/);

      // Both files' content is present on main (nothing dropped by the squash).
      expect(execSync(`git show ${main}:f1.txt`, { cwd: tmpDir }).toString().trim()).toBe('one');
      expect(execSync(`git show ${main}:f2.txt`, { cwd: tmpDir }).toString().trim()).toBe('two');
    });
  });

  it('throws, aborts the rebase, leaves the worktree clean, and leaves main UNTOUCHED on a conflict', async () => {
    await withTempDir('worktree-squash-conflict-', async (tmpDir) => {
      initRepo(tmpDir);
      const main = headBranch(tmpDir);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(tmpDir, 'conf');
      ensureUser(worktreePath);
      // Both sides add the SAME file with different content → add/add conflict on rebase.
      commitFile(worktreePath, 'shared.txt', 'branch-version', 'w1');
      commitFile(tmpDir, 'shared.txt', 'main-version', 'm1');

      const mainBefore = shaOf(tmpDir, main);
      await expect(
        manager.squashAndMergeWorktreeToMain(tmpDir, worktreePath, main, 'msg'),
      ).rejects.toThrow(/Failed to squash and merge/);

      // main is byte-for-byte where it started (the highest-blast-radius invariant).
      expect(shaOf(tmpDir, main)).toBe(mainBefore);
      // The worktree was rebase-aborted → clean tree, no rebase in progress.
      expect(execSync('git status --porcelain', { cwd: worktreePath }).toString().trim()).toBe('');
      expect(() => execSync('git rev-parse --verify REBASE_HEAD', { cwd: worktreePath, stdio: 'pipe' })).toThrow();
    });
  });

  it('squashes atop main\'s advanced tip when main moved past the fork point with a NON-conflicting commit', async () => {
    await withTempDir('worktree-squash-adv-ok-', async (tmpDir) => {
      initRepo(tmpDir);
      const main = headBranch(tmpDir);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(tmpDir, 'adv');
      ensureUser(worktreePath);
      commitFile(worktreePath, 'a.txt', 'branch', 'w1');
      commitFile(worktreePath, 'a2.txt', 'branch2', 'w2');
      // Advance main with a NON-conflicting commit (different file) after the fork.
      commitFile(tmpDir, 'm.txt', 'main-adv', 'm1');

      const mainBefore = shaOf(tmpDir, main); // main's advanced tip (contains m.txt)
      // The rebase replays the branch atop main's tip; the squash base is that tip,
      // so --ff-only succeeds and lands ONE squashed commit as its direct child.
      await manager.squashAndMergeWorktreeToMain(tmpDir, worktreePath, main, 'msg');

      // Exactly one new commit landed on main, directly atop its previous tip.
      const count = execSync(`git rev-list --count ${mainBefore}..${main}`, { cwd: tmpDir }).toString().trim();
      expect(count).toBe('1');
      expect(shaOf(tmpDir, `${main}^`)).toBe(mainBefore); // squash is a child of the advanced tip

      // The tree contains BOTH main's advanced file and the branch's files.
      expect(execSync(`git show ${main}:m.txt`, { cwd: tmpDir }).toString().trim()).toBe('main-adv');
      expect(execSync(`git show ${main}:a.txt`, { cwd: tmpDir }).toString().trim()).toBe('branch');
      expect(execSync(`git show ${main}:a2.txt`, { cwd: tmpDir }).toString().trim()).toBe('branch2');

      // main's earlier history is intact (m1 still reachable and unrewritten).
      const log = execSync(`git log --format=%s ${main}`, { cwd: tmpDir }).toString();
      expect(log).toContain('m1');
    });
  });

  it('still refuses cleanly (throws, main UNTOUCHED, worktree clean) when main advances with a CONFLICTING commit', async () => {
    await withTempDir('worktree-squash-adv-conflict-', async (tmpDir) => {
      initRepo(tmpDir);
      const main = headBranch(tmpDir);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(tmpDir, 'advconf');
      ensureUser(worktreePath);
      // Branch and main both add the SAME file after the fork → rebase conflicts.
      commitFile(worktreePath, 'shared.txt', 'branch-version', 'w1');
      commitFile(tmpDir, 'shared.txt', 'main-version', 'm1');

      const mainBefore = shaOf(tmpDir, main);
      await expect(
        manager.squashAndMergeWorktreeToMain(tmpDir, worktreePath, main, 'msg'),
      ).rejects.toThrow(/Failed to squash and merge/);

      // main is byte-for-byte where it started; the rebase was aborted; tree clean.
      expect(shaOf(tmpDir, main)).toBe(mainBefore);
      expect(execSync('git status --porcelain', { cwd: worktreePath }).toString().trim()).toBe('');
      expect(() => execSync('git rev-parse --verify REBASE_HEAD', { cwd: worktreePath, stdio: 'pipe' })).toThrow();
    });
  });

  it('fires the "No commits to squash" guard when the branch is at the main tip', async () => {
    await withTempDir('worktree-squash-empty-', async (tmpDir) => {
      initRepo(tmpDir);
      const main = headBranch(tmpDir);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(tmpDir, 'empty');
      ensureUser(worktreePath);

      let caught: unknown;
      try {
        await manager.squashAndMergeWorktreeToMain(tmpDir, worktreePath, main, 'msg');
      } catch (e) {
        caught = e;
      }
      expect((caught as Error).message).toMatch(/Failed to squash and merge/);
      expect((caught as { gitOutput?: string }).gitOutput).toMatch(/No commits to squash/);
    });
  });
});

// ---------------------------------------------------------------------------
// mergeWorktreeToMain — non-squash, mutates the project's ACTUAL main branch.
// ---------------------------------------------------------------------------

describe('WorktreeManager.mergeWorktreeToMain (integration)', () => {
  it('lands ALL commits of a multi-commit branch (no squash) via rebase + ff-only', async () => {
    await withTempDir('worktree-merge-main-multi-', async (tmpDir) => {
      initRepo(tmpDir);
      const main = headBranch(tmpDir);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(tmpDir, 'multi');
      ensureUser(worktreePath);
      commitFile(worktreePath, 'a.txt', 'a', 'w1');
      commitFile(worktreePath, 'b.txt', 'b', 'w2');
      commitFile(worktreePath, 'c.txt', 'c', 'w3');

      const mainBefore = shaOf(tmpDir, main);
      await manager.mergeWorktreeToMain(tmpDir, worktreePath, main);

      // All three commits are preserved on main (not squashed into one).
      const count = execSync(`git rev-list --count ${mainBefore}..${main}`, { cwd: tmpDir }).toString().trim();
      expect(count).toBe('3');
      expect(execSync(`git show ${main}:c.txt`, { cwd: tmpDir }).toString().trim()).toBe('c');
    });
  });

  it('fires the "No commits to merge" guard when the branch is at the main tip', async () => {
    await withTempDir('worktree-merge-main-empty-', async (tmpDir) => {
      initRepo(tmpDir);
      const main = headBranch(tmpDir);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(tmpDir, 'empty2');
      ensureUser(worktreePath);

      let caught: unknown;
      try {
        await manager.mergeWorktreeToMain(tmpDir, worktreePath, main);
      } catch (e) {
        caught = e;
      }
      expect((caught as Error).message).toMatch(/Failed to merge worktree/);
      expect((caught as { gitOutput?: string }).gitOutput).toMatch(/No commits to merge/);
    });
  });

  it('throws, aborts the rebase, and leaves main UNTOUCHED on a conflict', async () => {
    await withTempDir('worktree-merge-main-conflict-', async (tmpDir) => {
      initRepo(tmpDir);
      const main = headBranch(tmpDir);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(tmpDir, 'mconf');
      ensureUser(worktreePath);
      commitFile(worktreePath, 'shared.txt', 'branch', 'w1');
      commitFile(tmpDir, 'shared.txt', 'main', 'm1');

      const mainBefore = shaOf(tmpDir, main);
      await expect(manager.mergeWorktreeToMain(tmpDir, worktreePath, main)).rejects.toThrow(/Failed to merge worktree/);
      expect(shaOf(tmpDir, main)).toBe(mainBefore);
      expect(execSync('git status --porcelain', { cwd: worktreePath }).toString().trim()).toBe('');
      expect(() => execSync('git rev-parse --verify REBASE_HEAD', { cwd: worktreePath, stdio: 'pipe' })).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// removeWorktree / removeWorktreeByPath — idempotency, forced data loss, and
// a NON-overly-broad error matcher.
// ---------------------------------------------------------------------------

describe('WorktreeManager.removeWorktree (integration)', () => {
  it('is a silent no-op when removing an already-removed worktree twice', async () => {
    await withTempDir('worktree-rm-idem-', async (tmpDir) => {
      initRepo(tmpDir);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(tmpDir, 'rm1');
      await manager.removeWorktree(tmpDir, 'rm1');
      expect(existsSync(worktreePath)).toBe(false);
      // Second removal of the now-gone tree resolves without throwing.
      await expect(manager.removeWorktree(tmpDir, 'rm1')).resolves.toBeUndefined();
    });
  });

  it('force-discards uncommitted changes in the worktree (documents intended data loss)', async () => {
    await withTempDir('worktree-rm-force-', async (tmpDir) => {
      initRepo(tmpDir);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(tmpDir, 'rm2');
      ensureUser(worktreePath);
      commitFile(worktreePath, 'tracked.txt', 'v1', 'w1');
      // Uncommitted modification that a non-forced remove would refuse to discard.
      writeFileSync(join(worktreePath, 'tracked.txt'), 'v2-uncommitted');
      expect(existsSync(join(worktreePath, 'tracked.txt'))).toBe(true);

      await manager.removeWorktree(tmpDir, 'rm2');
      // The whole tree (and the uncommitted edit) is gone — this is by design.
      expect(existsSync(worktreePath)).toBe(false);
    });
  });

  it('DOES throw on an unrelated git error (matcher is not overly broad)', async () => {
    await withTempDir('worktree-rm-nongit-', async (tmpDir) => {
      // tmpDir exists but is NOT a git repo → "not a git repository" is not in the
      // idempotency ignore-list, so it must surface rather than be swallowed.
      const manager = new WorktreeManager();
      await expect(manager.removeWorktree(tmpDir, 'whatever')).rejects.toThrow(/Failed to remove worktree/);
    });
  });

  it('removeWorktreeByPath is idempotent on an already-removed path', async () => {
    await withTempDir('worktree-rmpath-idem-', async (tmpDir) => {
      initRepo(tmpDir);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(tmpDir, 'rmp');
      await manager.removeWorktreeByPath(tmpDir, worktreePath);
      expect(existsSync(worktreePath)).toBe(false);
      await expect(manager.removeWorktreeByPath(tmpDir, worktreePath)).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// checkForRebaseConflicts / rebaseMainIntoWorktree / abortRebase — the
// pre-merge conflict gate and the mid-rebase recovery path.
// ---------------------------------------------------------------------------

describe('WorktreeManager rebase-conflict gate (integration)', () => {
  it('checkForRebaseConflicts reports the conflicting file for same-file divergent edits', async () => {
    await withTempDir('worktree-cfc-conflict-', async (tmpDir) => {
      initRepo(tmpDir);
      const main = headBranch(tmpDir);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(tmpDir, 'cfc');
      ensureUser(worktreePath);
      commitFile(worktreePath, 'shared.txt', 'branch line', 'w1');
      commitFile(tmpDir, 'shared.txt', 'main line', 'm1'); // main advances on the same file

      const res = await manager.checkForRebaseConflicts(worktreePath, main);
      expect(res.hasConflicts).toBe(true);
      expect(res.conflictingFiles).toContain('shared.txt');
      expect(res.canAutoMerge).toBe(false);
    });
  });

  it('checkForRebaseConflicts reports NO conflicts for divergent edits to different files', async () => {
    await withTempDir('worktree-cfc-clean-', async (tmpDir) => {
      initRepo(tmpDir);
      const main = headBranch(tmpDir);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(tmpDir, 'cfnc');
      ensureUser(worktreePath);
      commitFile(worktreePath, 'branch.txt', 'b', 'w1');
      commitFile(tmpDir, 'mainonly.txt', 'm', 'm1'); // main advances on a DIFFERENT file

      const res = await manager.checkForRebaseConflicts(worktreePath, main);
      expect(res.hasConflicts).toBe(false);
      expect(res.canAutoMerge).toBe(true);
    });
  });

  it('rebaseMainIntoWorktree replays main\'s commits into the worktree on a clean divergence', async () => {
    await withTempDir('worktree-rebase-ok-', async (tmpDir) => {
      initRepo(tmpDir);
      const main = headBranch(tmpDir);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(tmpDir, 'rbok');
      ensureUser(worktreePath);
      commitFile(worktreePath, 'branch.txt', 'b', 'w1');
      commitFile(tmpDir, 'mainonly.txt', 'mmm', 'm1');

      await manager.rebaseMainIntoWorktree(worktreePath, main);

      // The worktree now contains main's file AND its own, and both commits appear.
      expect(existsSync(join(worktreePath, 'mainonly.txt'))).toBe(true);
      expect(existsSync(join(worktreePath, 'branch.txt'))).toBe(true);
      const log = execSync('git log --format=%s', { cwd: worktreePath }).toString();
      expect(log).toContain('m1');
      expect(log).toContain('w1');
    });
  });

  it('leaves the worktree mid-rebase on conflict; abortRebase restores the pre-rebase HEAD cleanly', async () => {
    await withTempDir('worktree-rebase-abort-', async (tmpDir) => {
      initRepo(tmpDir);
      const main = headBranch(tmpDir);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(tmpDir, 'rbconf');
      ensureUser(worktreePath);
      commitFile(worktreePath, 'shared.txt', 'branch', 'w1');
      commitFile(tmpDir, 'shared.txt', 'main', 'm1');
      const preHead = shaOf(worktreePath, 'HEAD');

      // rebaseMainIntoWorktree does NOT self-abort — it leaves the rebase in progress.
      await expect(manager.rebaseMainIntoWorktree(worktreePath, main)).rejects.toThrow(/Failed to rebase/);
      expect(() => execSync('git rev-parse --verify REBASE_HEAD', { cwd: worktreePath, stdio: 'pipe' })).not.toThrow();

      await manager.abortRebase(worktreePath);

      expect(shaOf(worktreePath, 'HEAD')).toBe(preHead);
      expect(execSync('git status --porcelain', { cwd: worktreePath }).toString().trim()).toBe('');
      expect(() => execSync('git rev-parse --verify REBASE_HEAD', { cwd: worktreePath, stdio: 'pipe' })).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// createWorktree / initializeProject — placement, base-branch selection,
// name collision, and idempotent bootstrap.
// ---------------------------------------------------------------------------

describe('WorktreeManager.createWorktree / initializeProject (integration)', () => {
  it('creates a worktree at baseDir/<name> off the default HEAD', async () => {
    await withTempDir('worktree-create-default-', async (tmpDir) => {
      initRepo(tmpDir);
      const manager = new WorktreeManager();
      const res = await manager.createWorktree(tmpDir, 'wtA');

      expect(res.worktreePath).toBe(join(tmpDir, 'worktrees', 'wtA'));
      expect(res.baseBranch).toBe('HEAD'); // default when no explicit base branch
      expect(existsSync(res.worktreePath)).toBe(true);
      expect(execSync('git branch --list wtA', { cwd: tmpDir }).toString()).toContain('wtA');
    });
  });

  it('creates a worktree off an EXPLICIT base branch', async () => {
    await withTempDir('worktree-create-explicit-', async (tmpDir) => {
      initRepo(tmpDir);
      const manager = new WorktreeManager();
      // Give `feature` a distinct commit so we can prove the base branch was honored.
      commitFile(tmpDir, 'onmain.txt', 'x', 'extra');
      execSync('git branch feature', { cwd: tmpDir, stdio: 'pipe' });

      const res = await manager.createWorktree(tmpDir, 'wtF', 'wtFbranch', 'feature');

      expect(res.baseBranch).toBe('feature');
      expect(shaOf(res.worktreePath, 'HEAD')).toBe(shaOf(tmpDir, 'feature'));
      expect(existsSync(join(res.worktreePath, 'onmain.txt'))).toBe(true);
    });
  });

  it('re-adds without throwing on a same-name collision (existing branch reused)', async () => {
    await withTempDir('worktree-create-collision-', async (tmpDir) => {
      initRepo(tmpDir);
      const manager = new WorktreeManager();
      await manager.createWorktree(tmpDir, 'dup');
      // Second create with the same name removes the old tree and re-adds the branch.
      const res2 = await manager.createWorktree(tmpDir, 'dup');
      expect(res2.worktreePath).toBe(join(tmpDir, 'worktrees', 'dup'));
      expect(existsSync(res2.worktreePath)).toBe(true);
    });
  });

  it('initializeProject creates the worktrees base dir idempotently (default + custom folder)', async () => {
    await withTempDir('worktree-init-project-', async (tmpDir) => {
      const manager = new WorktreeManager();
      await manager.initializeProject(tmpDir);
      expect(existsSync(join(tmpDir, 'worktrees'))).toBe(true);
      // Second call is a no-op (mkdir recursive) — must not throw.
      await expect(manager.initializeProject(tmpDir)).resolves.toBeUndefined();

      // A nested custom folder is bootstrapped too.
      await manager.initializeProject(tmpDir, join('.cyboflow', 'worktrees'));
      expect(existsSync(join(tmpDir, '.cyboflow', 'worktrees'))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// gitPull / gitPush / getLastCommits — remote sync surfacing + commit shape.
// Each test stands up its own bare remote + one or two clones.
// ---------------------------------------------------------------------------

/**
 * Create a bare remote (`remote.git`), an origin-tracking repo `a` with one
 * pushed commit, and a fresh clone `b`. Both HEADs are aligned so `git clone`
 * checks out a working tree. Returns the three absolute paths.
 */
function initRemoteAndClone(tmp: string): { remote: string; a: string; b: string } {
  const remote = join(tmp, 'remote.git');
  const a = join(tmp, 'a');
  const b = join(tmp, 'b');
  execSync('git init --bare remote.git', { cwd: tmp, stdio: 'pipe' });
  mkdirSync(a);
  execSync('git init', { cwd: a, stdio: 'pipe' });
  ensureUser(a);
  commitFile(a, 'base.txt', 'base', 'base');
  execSync(`git remote add origin ${JSON.stringify(remote)}`, { cwd: a, stdio: 'pipe' });
  execSync('git push -u origin HEAD', { cwd: a, stdio: 'pipe' });
  // Point the bare remote's HEAD at the pushed branch so the clone gets a checkout.
  const branch = headBranch(a);
  execSync(`git symbolic-ref HEAD refs/heads/${branch}`, { cwd: remote, stdio: 'pipe' });
  execSync(`git clone ${JSON.stringify(remote)} ${JSON.stringify(b)}`, { cwd: tmp, stdio: 'pipe' });
  ensureUser(b);
  return { remote, a, b };
}

describe('WorktreeManager remote sync (integration)', () => {
  it('gitPull fast-forwards local to a commit pushed by another clone', async () => {
    await withTempDir('worktree-pull-ff-', async (tmpDir) => {
      const { a, b } = initRemoteAndClone(tmpDir);
      commitFile(b, 'fromb.txt', 'B', 'fromb');
      execSync('git push', { cwd: b, stdio: 'pipe' });

      const manager = new WorktreeManager();
      const res = await manager.gitPull(a);

      expect(res.output).toBeTruthy();
      expect(existsSync(join(a, 'fromb.txt'))).toBe(true); // FF pulled the remote commit
    });
  });

  it('gitPull surfaces a diverged/conflicting pull as a rejection', async () => {
    await withTempDir('worktree-pull-diverge-', async (tmpDir) => {
      const { a, b } = initRemoteAndClone(tmpDir);
      // Remote advances shared.txt one way…
      commitFile(b, 'shared.txt', 'B', 'fromb');
      execSync('git push', { cwd: b, stdio: 'pipe' });
      // …local commits shared.txt a different way (unpushed) → divergence.
      commitFile(a, 'shared.txt', 'A', 'froma');

      const manager = new WorktreeManager();
      await expect(manager.gitPull(a)).rejects.toThrow();
    });
  });

  it('gitPush advances the remote branch to the local HEAD on success', async () => {
    await withTempDir('worktree-push-ok-', async (tmpDir) => {
      const { a, remote } = initRemoteAndClone(tmpDir);
      commitFile(a, 'new.txt', 'x', 'new');
      const aHead = shaOf(a, 'HEAD');

      const manager = new WorktreeManager();
      const res = await manager.gitPush(a);

      expect(res.output).toBeTruthy();
      const branch = headBranch(a);
      expect(shaOf(remote, branch)).toBe(aHead); // remote ref now matches local HEAD
    });
  });

  it('gitPush surfaces a rejected (remote-ahead / non-ff) push as a rejection', async () => {
    await withTempDir('worktree-push-reject-', async (tmpDir) => {
      const { a, b } = initRemoteAndClone(tmpDir);
      // Remote advances via clone b…
      commitFile(b, 'fromb.txt', 'B', 'fromb');
      execSync('git push', { cwd: b, stdio: 'pipe' });
      // …local diverges without fetching → its push is non-fast-forward.
      commitFile(a, 'froma.txt', 'A', 'froma');

      const manager = new WorktreeManager();
      await expect(manager.gitPush(a)).rejects.toThrow();
    });
  });

  it('getLastCommits caps the result at `count` and returns the parsed commit shape', async () => {
    await withTempDir('worktree-lastcommits-', async (tmpDir) => {
      initRepo(tmpDir); // sets user + one empty "init" commit
      commitFile(tmpDir, 'a.txt', '1', 'c1');
      commitFile(tmpDir, 'b.txt', '2', 'c2');
      commitFile(tmpDir, 'c.txt', '3', 'c3');

      const manager = new WorktreeManager();
      const commits = await manager.getLastCommits(tmpDir, 2);

      expect(commits.length).toBe(2); // capped at count even though 4 commits exist
      expect(commits[0].message).toBe('c3'); // most-recent first
      expect(commits[0].hash).toMatch(/^[0-9a-f]{40}$/);
      expect(commits[0].author).toBeTruthy();
      expect(commits[0].date).toBeTruthy();
      // Shortstat parsing: c3 adds exactly one file with one insertion.
      expect(commits[0].filesChanged).toBe(1);
      expect(commits[0].additions).toBe(1);
    });
  });
});
