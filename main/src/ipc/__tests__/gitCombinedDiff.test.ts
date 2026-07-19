/**
 * Behavioral tests for the `sessions:get-combined-diff` IPC handler in
 * main/src/ipc/git.ts (TASK-680/F10: the handler's execSync calls were
 * migrated to runGitAsync(cwd, args[])).
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

import { registerGitHandlers } from '../git';
import type { AppServices } from '../types';

type Handler = (...args: unknown[]) => Promise<unknown>;

function makeHandlerCapture() {
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) };
  return { ipcMain, handlers };
}

function invoke(handlers: Map<string, Handler>, channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler for channel: ${channel}`);
  return fn({} as unknown, ...args);
}

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

function makeServices(worktreePath: string): AppServices {
  return {
    sessionManager: {
      getSession: vi.fn(() => ({ id: 's1', worktreePath, isMainRepo: false, archived: false })),
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

function register(services: AppServices) {
  const { ipcMain, handlers } = makeHandlerCapture();
  registerGitHandlers(ipcMain as unknown as Parameters<typeof registerGitHandlers>[0], services);
  return handlers;
}

describe('sessions:get-combined-diff (async git plumbing, real repo)', () => {
  it('executionIds=[0]: returns the uncommitted working-directory diff', async () => {
    await withTempDir('combined-diff-uncommitted-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'a.txt', 'a1\n', 'base');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a1\na2-working\n');

      const handlers = register(makeServices(repo));
      const result = (await invoke(handlers, 'sessions:get-combined-diff', 's1', [0])) as {
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

      const handlers = register(makeServices(repo));
      const result = (await invoke(handlers, 'sessions:get-combined-diff', 's1', undefined)) as {
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

      const handlers = register(makeServices(repo));
      // Commits are newest-first: id 1 = feature commit 2, id 2 = feature commit 1.
      const result = (await invoke(handlers, 'sessions:get-combined-diff', 's1', [1, 2])) as {
        success: boolean;
        data: { diff: string; changedFiles: string[] };
      };

      expect(result.success).toBe(true);
      expect(result.data.changedFiles).toEqual(['a.txt']);
      expect(result.data.diff).toContain('+a1');
      expect(result.data.diff).toContain('+a2');
    });
  });
});
