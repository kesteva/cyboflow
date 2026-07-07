/**
 * WorktreeManager.createWorktree — exact-committish (SHA) pinning (migration 049,
 * A/B experiments). Both arm worktrees pin the SAME pre-resolved base SHA so the
 * base-branch-moved race is impossible; a branch-name collision hard-errors so the
 * pin can never be silently bypassed by the branch-exists attach path.
 *
 * Integration test — requires `git` on PATH.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { WorktreeManager } from '../worktreeManager';
import { withTempDir } from '../../__test_fixtures__/tmp';

function initRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  execSync('git config commit.gpgsign false', { cwd: dir, stdio: 'pipe' });
}

describe('WorktreeManager.createWorktree — baseCommittish pinning', () => {
  it('pins the worktree branch to an exact SHA even after the base branch moves', async () => {
    await withTempDir('wt-pin-', async (tmpDir) => {
      initRepo(tmpDir);
      execSync('git commit --allow-empty -m "c1"', { cwd: tmpDir, stdio: 'pipe' });
      const firstSha = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();
      // Move the base branch forward.
      execSync('git commit --allow-empty -m "c2"', { cwd: tmpDir, stdio: 'pipe' });

      const manager = new WorktreeManager();
      const a = await manager.createWorktree(tmpDir, 'arm-a', undefined, undefined, undefined, firstSha);
      const b = await manager.createWorktree(tmpDir, 'arm-b', undefined, undefined, undefined, firstSha);

      // Both arms cut from the pinned first commit, NOT the moved-forward tip.
      expect(a.baseCommit).toBe(firstSha);
      expect(b.baseCommit).toBe(firstSha);
      expect(a.baseCommit).toBe(b.baseCommit);
    });
  });

  it('HARD-ERRORS when the branch already exists and a committish is pinned', async () => {
    await withTempDir('wt-pin-collide-', async (tmpDir) => {
      initRepo(tmpDir);
      execSync('git commit --allow-empty -m "c1"', { cwd: tmpDir, stdio: 'pipe' });
      const sha = execSync('git rev-parse HEAD', { cwd: tmpDir }).toString().trim();
      // Pre-create a branch with the target worktree name.
      execSync('git branch collide', { cwd: tmpDir, stdio: 'pipe' });

      const manager = new WorktreeManager();
      await expect(
        manager.createWorktree(tmpDir, 'collide', undefined, undefined, undefined, sha),
      ).rejects.toThrow(/already exists/);
    });
  });

  it('fails loudly on a bad committish', async () => {
    await withTempDir('wt-pin-bad-', async (tmpDir) => {
      initRepo(tmpDir);
      execSync('git commit --allow-empty -m "c1"', { cwd: tmpDir, stdio: 'pipe' });
      const manager = new WorktreeManager();
      await expect(
        manager.createWorktree(tmpDir, 'arm-bad', undefined, undefined, undefined, 'deadbeefdeadbeef'),
      ).rejects.toThrow();
    });
  });
});
