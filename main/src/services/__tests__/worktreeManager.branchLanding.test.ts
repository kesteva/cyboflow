/**
 * WorktreeManager.getBranchLandingState — "has this branch's work already landed
 * in main?", the git-side half of the session delivery probe.
 *
 * This drives a DESTRUCTIVE prompt: it is what tells the dismiss dialog to offer
 * Mark complete (which preserves the session's findings) instead of dismissing
 * outright. So each real landing shape gets a case, because each one leaves a
 * different fingerprint in git:
 *
 *   fast-forward   → the branch's commits are literally in main
 *   cherry-pick    → equivalent patches, different SHAs (git cherry sees them)
 *   squash         → one unrelated commit, but identical trees
 *   still unmerged → none of the above
 *   empty session  → no commits of its own; must NOT report landed, or every
 *                    abandoned exploratory session grows an extra prompt
 *
 * Integration test — requires `git` on PATH.
 */
import { describe, it, expect, vi } from 'vitest';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { WorktreeManager } from '../worktreeManager';
import { withTempDir } from '../../__test_fixtures__/tmp';

// Every case here drives a dozen real `git` subprocesses against a temp repo.
// vitest's 5s default is sized for in-process work: it is enough when this file
// runs alone (~1s a case) and not when the full suite has a fork on every core,
// where the same case has been seen at 8.8s. That made the failure a property of
// what else was running, not of the code under test. Time out on a genuine hang
// instead.
vi.setConfig({ testTimeout: 60_000 });

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe' }).toString().trim();
}

function initRepo(dir: string): void {
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  execSync('git config commit.gpgsign false', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git('add -A', dir);
  git('commit -m base', dir);
}

/** Commit a file change on the current branch. */
function commitFile(dir: string, name: string, body: string, message: string): void {
  writeFileSync(join(dir, name), body);
  git('add -A', dir);
  git(`commit -m ${JSON.stringify(message)}`, dir);
}

/**
 * A repo with `main` and a worktree on `feature` carrying one commit — the
 * shape every case starts from. Returns the worktree path.
 */
async function seedFeatureWorktree(repo: string, manager: WorktreeManager): Promise<string> {
  const { worktreePath } = await manager.createWorktree(repo, 'feature');
  commitFile(worktreePath, 'feature.txt', 'feature work\n', 'feat: the work');
  return worktreePath;
}

describe('WorktreeManager.getBranchLandingState', () => {
  it('reports NOT landed while the branch still holds unmerged work', async () => {
    await withTempDir('wt-landing-open-', async (repo) => {
      initRepo(repo);
      const manager = new WorktreeManager();
      const worktreePath = await seedFeatureWorktree(repo, manager);

      const state = await manager.getBranchLandingState(worktreePath, 'main');

      expect(state.landed).toBe(false);
      expect(state.ownCommits).toBe(1);
      expect(state.commitsAhead).toBe(1);
    });
  });

  it('reports landed after a fast-forward merge into main', async () => {
    await withTempDir('wt-landing-ff-', async (repo) => {
      initRepo(repo);
      const manager = new WorktreeManager();
      const worktreePath = await seedFeatureWorktree(repo, manager);

      git('merge --ff-only feature', repo);

      const state = await manager.getBranchLandingState(worktreePath, 'main');
      expect(state.landed).toBe(true);
      expect(state.commitsAhead).toBe(0);
    });
  });

  it('reports landed after the work was cherry-picked onto main (new SHAs)', async () => {
    await withTempDir('wt-landing-cherry-', async (repo) => {
      initRepo(repo);
      const manager = new WorktreeManager();
      const worktreePath = await seedFeatureWorktree(repo, manager);
      const sha = git('rev-parse HEAD', worktreePath);

      // Main moves on independently, THEN takes the work as its own commit —
      // exactly what an agent merging in chat leaves behind.
      commitFile(repo, 'unrelated.txt', 'main moved\n', 'chore: unrelated');
      git(`cherry-pick ${sha}`, repo);

      const state = await manager.getBranchLandingState(worktreePath, 'main');
      // Trees differ (main has unrelated.txt), so this can only be caught by
      // patch equivalence.
      expect(state.commitsAhead).toBeGreaterThan(0);
      expect(state.landed).toBe(true);
    });
  });

  it('reports landed after a squash merge (different commit, identical tree)', async () => {
    await withTempDir('wt-landing-squash-', async (repo) => {
      initRepo(repo);
      const manager = new WorktreeManager();
      const worktreePath = await seedFeatureWorktree(repo, manager);
      commitFile(worktreePath, 'more.txt', 'second commit\n', 'feat: more work');

      git('merge --squash feature', repo);
      git('commit -m "feat: everything, squashed"', repo);

      const state = await manager.getBranchLandingState(worktreePath, 'main');
      // Two branch commits collapsed into one unrelated SHA: neither the
      // rev-list nor the patch-equivalence check fires — only identical trees.
      expect(state.commitsAhead).toBe(2);
      expect(state.landed).toBe(true);
    });
  });

  it('reports NOT landed for a session that never committed anything', async () => {
    // Vacuously "nothing left to merge" — but there is nothing to mark complete
    // either, and prompting here would tax every abandoned exploratory session.
    await withTempDir('wt-landing-empty-', async (repo) => {
      initRepo(repo);
      const manager = new WorktreeManager();
      const { worktreePath } = await manager.createWorktree(repo, 'idle');

      const state = await manager.getBranchLandingState(worktreePath, 'main');

      expect(state.landed).toBe(false);
      expect(state.ownCommits).toBe(0);
    });
  });

  it('fails closed on an unreadable worktree rather than claiming a landing', async () => {
    const manager = new WorktreeManager();
    const state = await manager.getBranchLandingState('/nonexistent/worktree/path', 'main');
    expect(state.landed).toBe(false);
  });
});
