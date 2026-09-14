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

describe('sessionGit ops getCombinedDiff (async git plumbing, real repo)', () => {
  it('executionIds=[0]: returns the uncommitted working-directory diff', async () => {
    await withTempDir('combined-diff-uncommitted-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'a.txt', 'a1\n', 'base');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a1\na2-working\n');

      const ops = createGitOps(makeServices(repo));
      const result = (await ops.getCombinedDiff({ sessionId: 's1', executionIds: [0] })) as {
        success: boolean;
        data: { diff: string };
      };

      expect(result.success).toBe(true);
      expect(result.data.diff).toContain('+a2-working');
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
        data: { diff: string; changedFiles: string[]; stats: { filesChanged: number } };
      };

      expect(result.success).toBe(true);
      expect(result.data.changedFiles).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
      expect(result.data.diff).toContain('+a1');
      expect(result.data.diff).toContain('+b1');
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
        data: { diff: string; changedFiles: string[] };
      };

      expect(result.success).toBe(true);
      expect(result.data.changedFiles).toEqual(['a.txt']);
      expect(result.data.diff).toContain('+a1');
      expect(result.data.diff).toContain('+a2');
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
        data: { diff: string; changedFiles: string[] };
      };

      expect(result.success).toBe(true);
      expect(result.data.diff).not.toBe('');
      expect(result.data.changedFiles.length).toBeGreaterThan(0);
      expect(result.data.changedFiles).toEqual(expect.arrayContaining(['base.txt', 'c.txt']));
      expect(result.data.diff).toContain('+edited-in-place');
      expect(result.data.diff).toContain('+new-untracked');
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
        data?: { diff: string; changedFiles: string[] };
        error?: string;
      };

      expect(result.success).toBe(true);
    });
  });
});
