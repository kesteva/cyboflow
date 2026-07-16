/**
 * Parity + bounding tests for the async git plumbing helpers
 * (main/src/services/gitPlumbingCommands.ts), converted from sync `execSync`
 * spawns to `runGitAsync` (TASK: git-status async + bounding, fix 2).
 *
 * Behaviors covered:
 * 1. dirty/clean/ahead-behind matrix parity — same repo states produce the
 *    same classification the old sync execSync version produced.
 * 2. error-branch parity — merge conflict and untracked-only states still
 *    classify correctly through the async path.
 * 3. AbortSignal: a pre-aborted signal makes the call REJECT (propagate the
 *    cancellation) rather than silently reporting a false "dirty" status —
 *    the bare-catch-means-dirty contract must not swallow OUR OWN cancellation.
 *
 * All tests use real temp directories and real git repos (no mocking of fs
 * or git), matching the convention in gitDiffManager.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fastCheckWorkingDirectory, fastGetAheadBehind, fastGetDiffStats } from '../gitPlumbingCommands';
import { withTempDir } from '../../__test_fixtures__/tmp';

/** Init a repo whose default branch is deterministically `main`, with one commit. */
function initRepoMain(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  execSync('git checkout -b main', { cwd: dir, stdio: 'pipe' });
}

function commitFile(dir: string, name: string, content: string, message: string): void {
  fs.writeFileSync(path.join(dir, name), content);
  execSync(`git add ${name}`, { cwd: dir, stdio: 'pipe' });
  execSync(`git commit -m "${message}"`, { cwd: dir, stdio: 'pipe' });
}

// ---------------------------------------------------------------------------
// fastCheckWorkingDirectory — dirty/clean matrix parity
// ---------------------------------------------------------------------------

describe('fastCheckWorkingDirectory — dirty/clean matrix parity', () => {
  it('a freshly committed clean repo reports all-clean', async () => {
    await withTempDir('gitplumb-clean-', async (dir) => {
      initRepoMain(dir);
      commitFile(dir, 'a.txt', 'a\n', 'base');

      const result = await fastCheckWorkingDirectory(dir);
      expect(result).toEqual({ hasModified: false, hasStaged: false, hasUntracked: false, hasConflicts: false });
    });
  });

  it('an unstaged edit to a tracked file reports hasModified only', async () => {
    await withTempDir('gitplumb-modified-', async (dir) => {
      initRepoMain(dir);
      commitFile(dir, 'a.txt', 'a\n', 'base');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nedited\n');

      const result = await fastCheckWorkingDirectory(dir);
      expect(result.hasModified).toBe(true);
      expect(result.hasStaged).toBe(false);
      expect(result.hasUntracked).toBe(false);
      expect(result.hasConflicts).toBe(false);
    });
  });

  it('a staged (but uncommitted) edit reports hasStaged only', async () => {
    await withTempDir('gitplumb-staged-', async (dir) => {
      initRepoMain(dir);
      commitFile(dir, 'a.txt', 'a\n', 'base');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nstaged-edit\n');
      execSync('git add a.txt', { cwd: dir, stdio: 'pipe' });

      const result = await fastCheckWorkingDirectory(dir);
      expect(result.hasModified).toBe(false);
      expect(result.hasStaged).toBe(true);
      expect(result.hasUntracked).toBe(false);
      expect(result.hasConflicts).toBe(false);
    });
  });

  it('an untracked-only file reports hasUntracked only (no false modified/staged)', async () => {
    await withTempDir('gitplumb-untracked-', async (dir) => {
      initRepoMain(dir);
      commitFile(dir, 'a.txt', 'a\n', 'base');
      fs.writeFileSync(path.join(dir, 'new.txt'), 'brand new\n');

      const result = await fastCheckWorkingDirectory(dir);
      expect(result).toEqual({ hasModified: false, hasStaged: false, hasUntracked: true, hasConflicts: false });
    });
  });

  it('an unresolved merge conflict reports hasConflicts (error-branch parity)', async () => {
    await withTempDir('gitplumb-conflict-', async (dir) => {
      initRepoMain(dir);
      commitFile(dir, 'a.txt', 'base\n', 'base');
      execSync('git checkout -b feature', { cwd: dir, stdio: 'pipe' });
      commitFile(dir, 'a.txt', 'feature-line\n', 'feature edit');
      execSync('git checkout main', { cwd: dir, stdio: 'pipe' });
      commitFile(dir, 'a.txt', 'main-line\n', 'main edit');

      // Merge feature into main — conflicts on a.txt, merge stops mid-flight.
      try {
        execSync('git merge feature', { cwd: dir, stdio: 'pipe' });
      } catch {
        // Expected: merge exits non-zero on conflict.
      }

      const result = await fastCheckWorkingDirectory(dir);
      expect(result.hasConflicts).toBe(true);
    });
  });

  it('a missing worktree directory returns safe (all-dirty) defaults without throwing', async () => {
    const result = await fastCheckWorkingDirectory('/nonexistent/cyboflow-gitplumb-test-path');
    expect(result).toEqual({ hasModified: true, hasStaged: true, hasUntracked: true, hasConflicts: false });
  });
});

// ---------------------------------------------------------------------------
// fastGetAheadBehind — parity
// ---------------------------------------------------------------------------

describe('fastGetAheadBehind — ahead/behind matrix parity', () => {
  it('reports 0/0 when the branch equals base', async () => {
    await withTempDir('gitplumb-aheadbehind-equal-', async (dir) => {
      initRepoMain(dir);
      commitFile(dir, 'a.txt', 'a\n', 'base');

      const result = await fastGetAheadBehind(dir, 'main');
      expect(result).toEqual({ ahead: 0, behind: 0 });
    });
  });

  it('reports ahead-only when the branch has extra commits base lacks', async () => {
    await withTempDir('gitplumb-aheadbehind-ahead-', async (dir) => {
      initRepoMain(dir);
      commitFile(dir, 'a.txt', 'v1\n', 'base');
      execSync('git branch base-ref', { cwd: dir, stdio: 'pipe' });
      commitFile(dir, 'a.txt', 'v2\n', 'commit 2');
      commitFile(dir, 'a.txt', 'v3\n', 'commit 3');

      const result = await fastGetAheadBehind(dir, 'base-ref');
      expect(result).toEqual({ ahead: 2, behind: 0 });
    });
  });

  it('reports both ahead and behind on a diverged branch', async () => {
    await withTempDir('gitplumb-aheadbehind-diverged-', async (dir) => {
      initRepoMain(dir);
      commitFile(dir, 'a.txt', 'v1\n', 'base');
      execSync('git checkout -b feature', { cwd: dir, stdio: 'pipe' });
      commitFile(dir, 'a.txt', 'v2-feature\n', 'feature commit');

      execSync('git checkout main', { cwd: dir, stdio: 'pipe' });
      commitFile(dir, 'b.txt', 'main-only\n', 'main commit');

      const result = await fastGetAheadBehind(dir, 'main');
      // On feature: 1 commit ahead of main, 1 commit behind main.
      execSync('git checkout feature', { cwd: dir, stdio: 'pipe' });
      const resultFromFeature = await fastGetAheadBehind(dir, 'main');
      expect(resultFromFeature).toEqual({ ahead: 1, behind: 1 });
      // Sanity: the earlier call (still on main at the time) is 0 ahead/behind of itself.
      expect(result).toEqual({ ahead: 0, behind: 0 });
    });
  });
});

// ---------------------------------------------------------------------------
// fastGetDiffStats — parity
// ---------------------------------------------------------------------------

describe('fastGetDiffStats — parity', () => {
  it('reports zero stats for a clean working tree', async () => {
    await withTempDir('gitplumb-diffstats-clean-', async (dir) => {
      initRepoMain(dir);
      commitFile(dir, 'a.txt', 'a\n', 'base');

      const result = await fastGetDiffStats(dir);
      expect(result).toEqual({ additions: 0, deletions: 0, filesChanged: 0 });
    });
  });

  it('reports additions/deletions/filesChanged for an unstaged edit', async () => {
    await withTempDir('gitplumb-diffstats-edit-', async (dir) => {
      initRepoMain(dir);
      commitFile(dir, 'a.txt', 'line1\nline2\nline3\n', 'base');
      // Replace all 3 lines with 2 new lines: 3 deletions, 2 additions.
      fs.writeFileSync(path.join(dir, 'a.txt'), 'new1\nnew2\n');

      const result = await fastGetDiffStats(dir);
      expect(result.filesChanged).toBe(1);
      expect(result.additions).toBe(2);
      expect(result.deletions).toBe(3);
    });
  });
});

// ---------------------------------------------------------------------------
// AbortSignal — cancellation must propagate, not be swallowed as "dirty"
// ---------------------------------------------------------------------------

describe('AbortSignal propagation', () => {
  it('fastCheckWorkingDirectory rejects (does not return a false-dirty result) on a pre-aborted signal', async () => {
    await withTempDir('gitplumb-abort-check-', async (dir) => {
      initRepoMain(dir);
      commitFile(dir, 'a.txt', 'a\n', 'base');

      const controller = new AbortController();
      controller.abort();

      await expect(fastCheckWorkingDirectory(dir, { signal: controller.signal })).rejects.toThrow();
    });
  });

  it('fastGetAheadBehind rejects (does not return a false 0/0) on a pre-aborted signal', async () => {
    await withTempDir('gitplumb-abort-aheadbehind-', async (dir) => {
      initRepoMain(dir);
      commitFile(dir, 'a.txt', 'a\n', 'base');

      const controller = new AbortController();
      controller.abort();

      await expect(fastGetAheadBehind(dir, 'main', { signal: controller.signal })).rejects.toThrow();
    });
  });

  it('fastGetDiffStats rejects on a pre-aborted signal', async () => {
    await withTempDir('gitplumb-abort-diffstats-', async (dir) => {
      initRepoMain(dir);
      commitFile(dir, 'a.txt', 'a\n', 'base');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nedited\n');

      const controller = new AbortController();
      controller.abort();

      await expect(fastGetDiffStats(dir, { signal: controller.signal })).rejects.toThrow();
    });
  });
});
