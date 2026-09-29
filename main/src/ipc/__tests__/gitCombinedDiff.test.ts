/**
 * Behavioral tests for `getCombinedDiff` in main/src/ipc/gitOps.ts — the ops
 * implementation behind the `cyboflow.sessionGit.getCombinedDiff` tRPC
 * procedure, formerly the `sessions:get-combined-diff` IPC handler
 * (TASK-680/F10: the handler's execSync calls were migrated to
 * runGitAsync(cwd, args[])).
 *
 * These use a REAL temp git repo and a REAL GitDiffManager (no execSync/
 * runGitAsync mocking) so the test exercises the actual async git plumbing
 * end-to-end, matching the style of services/__tests__/gitDiffManager.test.ts.
 * Only the non-git collaborators (sessionManager, worktreeManager, electron,
 * panelManager, index) are stubbed.
 */
import { describe, it, expect, vi } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withTempDir } from '../../__test_fixtures__/tmp';
import { GitDiffManager } from '../../services/gitDiffManager';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { isPackaged: false, getPath: vi.fn(() => '/mock'), getName: vi.fn(() => 'Cyboflow'), getVersion: vi.fn(() => '0.1.0') },
}));

vi.mock('../../index', () => ({ mainWindow: null }));

vi.mock('../../services/panelManager', () => ({
  panelManager: {
    createPanel: vi.fn(async () => ({ id: 'panel-git-1', state: { customState: {} } })),
    getPanelsForSession: vi.fn(() => []),
  },
}));

vi.mock('../claudePanel', () => ({
  claudePanelManager: { registerPanel: vi.fn(), startPanel: vi.fn(async () => {}) },
}));

import { createGitOps } from '../gitOps';
import type { AppServices } from '../types';

function inertDb() {
  const stmt = { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] };
  return { prepare: () => stmt, transaction: <T>(fn: (...a: unknown[]) => T) => fn };
}

/** Init a repo whose default branch is deterministically `main`. */
function initRepoMain(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  execSync('git checkout -b main', { cwd: dir, stdio: 'pipe' });
}

/** Write, stage, and commit a file; return the resulting HEAD sha. */
function commitFile(dir: string, name: string, content: string, message: string): string {
  fs.writeFileSync(path.join(dir, name), content);
  execSync(`git add ${name}`, { cwd: dir, stdio: 'pipe' });
  execSync(`git commit -m "${message}"`, { cwd: dir, stdio: 'pipe' });
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
}

function makeServices(worktreePath: string, sessionOverrides: Record<string, unknown> = {}): AppServices {
  return {
    sessionManager: {
      getSession: vi.fn(() => ({ id: 's1', worktreePath, isMainRepo: false, archived: false, ...sessionOverrides })),
      getProjectForSession: vi.fn(() => ({ id: 7, name: 'Proj', path: worktreePath })),
    },
    gitDiffManager: new GitDiffManager(),
    worktreeManager: {
      getProjectMainBranch: vi.fn(async () => 'main'),
      getOriginBranch: vi.fn(async () => null),
      getLastCommits: vi.fn(async () => []),
    },
    claudeCodeManager: {},
    gitStatusManager: {
      updateGitStatusAfterRebase: vi.fn(async () => {}),
      updateProjectGitStatusAfterMainUpdate: vi.fn(async () => {}),
      refreshSessionGitStatus: vi.fn(async () => {}),
    },
    databaseService: { getDb: () => inertDb() },
    configManager: { isDemoMode: () => false, getConfig: () => ({}) },
    endLiveSession: vi.fn(async () => {}),
  } as unknown as AppServices;
}

/** A 40-hex-char string is a resolved git SHA — never a branch/ref name. */
const SHA_RE = /^[0-9a-f]{40}$/;

describe('sessionGit ops getCombinedDiff (async git plumbing, real repo)', () => {
  it('executionIds=[0]: returns the uncommitted working-directory diff', async () => {
    await withTempDir('combined-diff-uncommitted-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'a.txt', 'a1\n', 'base');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a1\na2-working\n');

      const ops = createGitOps(makeServices(repo));
      const result = (await ops.getCombinedDiff({ sessionId: 's1', executionIds: [0] })) as {
        success: boolean;
        data: { diff: string; resolvedBase: string | null; worktree: { entries: unknown[]; groups: unknown[]; committedUnavailable: boolean } };
      };

      expect(result.success).toBe(true);
      expect(result.data.diff).toContain('+a2-working');
      // executionIds=[0] is the working-dir-vs-HEAD rung — resolvedBase is
      // null, never undefined and never a branch name (TASK-212).
      expect(result.data.resolvedBase).toBeNull();
      expect(result.data.worktree).toBeDefined();
      expect(Array.isArray(result.data.worktree.groups)).toBe(true);
    });
  });

  it('no executionIds, multiple commits: diffs from before the branch to the working directory', async () => {
    await withTempDir('combined-diff-multi-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'base.txt', 'base\n', 'base commit');
      execSync('git checkout -b feature', { cwd: repo, stdio: 'pipe' });
      commitFile(repo, 'a.txt', 'a1\n', 'feature commit 1');
      commitFile(repo, 'b.txt', 'b1\n', 'feature commit 2');

      const ops = createGitOps(makeServices(repo));
      const result = (await ops.getCombinedDiff({ sessionId: 's1' })) as {
        success: boolean;
        data: { diff: string; changedFiles: string[]; stats: { filesChanged: number }; resolvedBase: string | null };
      };

      expect(result.success).toBe(true);
      expect(result.data.changedFiles).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
      expect(result.data.diff).toContain('+a1');
      expect(result.data.diff).toContain('+b1');
      // No baseCommit recorded — falls back to the merge-base of HEAD and the
      // resolved 'main' branch, echoed back as a resolved SHA, not a branch name.
      expect(result.data.resolvedBase).toMatch(SHA_RE);
    });
  });

  it('no executionIds, no baseCommit, main ADVANCED past the branch point: anchors on the merge-base, not the main tip', async () => {
    await withTempDir('combined-diff-advanced-main-', async (repo) => {
      initRepoMain(repo);
      const branchPoint = commitFile(repo, 'base.txt', 'base\n', 'base commit');
      execSync('git checkout -b feature', { cwd: repo, stdio: 'pipe' });
      commitFile(repo, 'a.txt', 'a1\n', 'feature commit');
      // main advances with a file the feature branch never touched.
      execSync('git checkout main', { cwd: repo, stdio: 'pipe' });
      commitFile(repo, 'main-only.txt', 'main-only\n', 'main advances');
      execSync('git checkout feature', { cwd: repo, stdio: 'pipe' });

      const ops = createGitOps(makeServices(repo));
      const result = (await ops.getCombinedDiff({ sessionId: 's1' })) as {
        success: boolean;
        data: { diff: string; changedFiles: string[]; resolvedBase: string | null };
      };

      expect(result.success).toBe(true);
      expect(result.data.resolvedBase).toBe(branchPoint);
      expect(result.data.changedFiles).toEqual(['a.txt']);
      // A two-dot diff vs the advanced main tip would carry a reverse hunk here.
      expect(result.data.diff).not.toContain('main-only');
    });
  });

  it('executionIds range [1,2]: diffs from the older commit\'s parent to the newer commit', async () => {
    await withTempDir('combined-diff-range-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'base.txt', 'base\n', 'base commit');
      execSync('git checkout -b feature', { cwd: repo, stdio: 'pipe' });
      commitFile(repo, 'a.txt', 'a1\n', 'feature commit 1');
      commitFile(repo, 'a.txt', 'a1\na2\n', 'feature commit 2');

      const ops = createGitOps(makeServices(repo));
      // Commits are newest-first: id 1 = feature commit 2, id 2 = feature commit 1.
      const result = (await ops.getCombinedDiff({ sessionId: 's1', executionIds: [1, 2] })) as {
        success: boolean;
        data: { diff: string; changedFiles: string[]; resolvedBase: string | null };
      };

      expect(result.success).toBe(true);
      expect(result.data.changedFiles).toEqual(['a.txt']);
      expect(result.data.diff).toContain('+a1');
      expect(result.data.diff).toContain('+a2');
      // The commit-range branch reports its OWN from-hash as resolvedBase.
      expect(result.data.resolvedBase).toMatch(SHA_RE);
    });
  });

  it('no executionIds, zero commits on the branch: uncommitted edits still render (TASK-207)', async () => {
    await withTempDir('combined-diff-zero-commits-', async (repo) => {
      initRepoMain(repo);
      const baseSha = commitFile(repo, 'base.txt', 'base\n', 'base commit');
      execSync('git checkout -b feature', { cwd: repo, stdio: 'pipe' });

      // Zero commits of its own on `feature` — only uncommitted work: an edit to
      // the tracked file and a new untracked file.
      fs.writeFileSync(path.join(repo, 'base.txt'), 'base\nedited-in-place\n');
      fs.writeFileSync(path.join(repo, 'c.txt'), 'new-untracked\n');

      const ops = createGitOps(makeServices(repo, { baseCommit: baseSha }));
      const result = (await ops.getCombinedDiff({ sessionId: 's1' })) as {
        success: boolean;
        data: { diff: string; changedFiles: string[]; resolvedBase: string | null; worktree: { committedUnavailable: boolean } };
      };

      expect(result.success).toBe(true);
      expect(result.data.diff).not.toBe('');
      expect(result.data.changedFiles.length).toBeGreaterThan(0);
      expect(result.data.changedFiles).toEqual(expect.arrayContaining(['base.txt', 'c.txt']));
      expect(result.data.diff).toContain('+edited-in-place');
      expect(result.data.diff).toContain('+new-untracked');
      // session.baseCommit is already a resolved 40-char SHA and is echoed
      // back as resolvedBase verbatim (TASK-212).
      expect(result.data.resolvedBase).toBe(baseSha);
      expect(result.data.worktree.committedUnavailable).toBe(false);
    });
  });

  it('no executionIds, repo with no commits at all: degrades without throwing', async () => {
    await withTempDir('combined-diff-no-commits-at-all-', async (repo) => {
      // git init only — no commits, so HEAD is unborn and no branch exists yet.
      execSync('git init', { cwd: repo, stdio: 'pipe' });
      execSync('git config user.email "test@example.com"', { cwd: repo, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: repo, stdio: 'pipe' });
      fs.writeFileSync(path.join(repo, 'untracked.txt'), 'hello\n');

      const ops = createGitOps(makeServices(repo));
      const result = (await ops.getCombinedDiff({ sessionId: 's1' })) as {
        success: boolean;
        data?: { diff: string; changedFiles: string[]; resolvedBase: string | null; worktree: { committedUnavailable: boolean } };
        error?: string;
      };

      expect(result.success).toBe(true);
      // Nothing resolves (no baseCommit, no main branch, unborn HEAD) — this
      // degrades to the working-dir-vs-HEAD rung, so resolvedBase is null and
      // the Committed group comes back unavailable rather than a stand-in.
      expect(result.data?.resolvedBase).toBeNull();
      expect(result.data?.worktree.committedUnavailable).toBe(true);
    });
  });

  describe('scope routing (TASK-212)', () => {
    it("scope: 'staged' returns only the staged hunk; scope: 'unstaged' returns only the unstaged hunk, for a file dirty both ways", async () => {
      await withTempDir('combined-diff-scope-', async (repo) => {
        initRepoMain(repo);
        commitFile(repo, 'a.txt', 'a1\n', 'base');

        // Stage one change, then make a SEPARATE unstaged edit on top — the
        // file is both staged and unstaged simultaneously (porcelain `MM`).
        fs.writeFileSync(path.join(repo, 'a.txt'), 'a1\nstaged-line\n');
        execSync('git add a.txt', { cwd: repo, stdio: 'pipe' });
        fs.writeFileSync(path.join(repo, 'a.txt'), 'a1\nstaged-line\nunstaged-line\n');

        const ops = createGitOps(makeServices(repo));

        const staged = (await ops.getCombinedDiff({ sessionId: 's1', scope: 'staged' })) as {
          success: boolean;
          data: { diff: string; resolvedBase: string | null };
        };
        expect(staged.success).toBe(true);
        expect(staged.data.diff).toContain('+staged-line');
        expect(staged.data.diff).not.toContain('+unstaged-line');

        const unstaged = (await ops.getCombinedDiff({ sessionId: 's1', scope: 'unstaged' })) as {
          success: boolean;
          data: { diff: string; resolvedBase: string | null };
        };
        expect(unstaged.success).toBe(true);
        expect(unstaged.data.diff).toContain('+unstaged-line');
        expect(unstaged.data.diff).not.toContain('+staged-line');
      });
    });
  });
});

describe("sessionGit ops getCombinedDiff scope: 'untracked' — symlink containment (SEC-9)", () => {
  it.runIf(process.platform !== 'win32')(
    'an untracked symlink to a file outside the worktree is not rendered into the scoped blob',
    async () => {
      await withTempDir('combined-diff-symlink-outside-', async (outside) => {
        const secretPath = path.join(outside, 'secret.txt');
        fs.writeFileSync(secretPath, 'SUPER-SECRET-TOKEN-do-not-leak\n');

        await withTempDir('combined-diff-symlink-repo-', async (repo) => {
          initRepoMain(repo);
          commitFile(repo, 'a.txt', 'a1\n', 'base');
          fs.symlinkSync(secretPath, path.join(repo, 'leak.txt'));
          fs.writeFileSync(path.join(repo, 'real.txt'), 'r1\n');

          const ops = createGitOps(makeServices(repo));
          const result = (await ops.getCombinedDiff({ sessionId: 's1', scope: 'untracked' })) as {
            success: boolean;
            data: { diff: string; stats: { additions: number } };
          };

          expect(result.success).toBe(true);
          expect(result.data.diff).not.toContain('SUPER-SECRET-TOKEN');
          expect(result.data.diff).not.toContain('+++ b/leak.txt');
          expect(result.data.diff).toContain('+++ b/real.txt');
          // real.txt = "r1\n" → 2 split elements; the link adds nothing.
          expect(result.data.stats.additions).toBe(2);
        });
      });
    },
  );
});
