/**
 * Behavioral tests for the `commit` op in main/src/ipc/gitOps.ts (behind the
 * `cyboflow.sessionGit.commit` tRPC procedure) — specifically the
 * mutation-boundary conflict guard (eval ROB-5 / SCP-1).
 *
 * The renderer's WorktreeStrip disables Commit when its LAST FETCHED status
 * snapshot shows a conflict, but the snapshot can go stale: an agent may drive
 * the tree into a merge conflict after the dialog opened. `git add -A` stages
 * conflict markers without complaint, so the authoritative check must be in
 * the op itself, against the live index, immediately before staging.
 *
 * Real temp repo, real GitDiffManager, real git (mirrors gitCombinedDiff.test.ts).
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

function git(dir: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initRepoMain(dir: string): void {
  git(dir, 'init');
  git(dir, 'config user.email "test@example.com"');
  git(dir, 'config user.name "Test"');
  git(dir, 'checkout -b main');
}

function commitFile(dir: string, name: string, content: string, message: string): string {
  fs.writeFileSync(path.join(dir, name), content);
  git(dir, `add -- "${name}"`);
  git(dir, `commit -m "${message}"`);
  return git(dir, 'rev-parse HEAD');
}

/** Drive `dir` into a real `UU` merge conflict on `f.txt`; returns HEAD before the merge. */
function makeConflict(dir: string): string {
  const head = commitFile(dir, 'f.txt', 'base\n', 'base');
  git(dir, 'checkout -b other');
  commitFile(dir, 'f.txt', 'theirs\n', 'theirs');
  git(dir, 'checkout main');
  commitFile(dir, 'f.txt', 'ours\n', 'ours');
  const mainHead = git(dir, 'rev-parse HEAD');
  try {
    git(dir, 'merge other');
  } catch {
    // expected: conflict
  }
  expect(git(dir, 'diff --name-only --diff-filter=U')).toBe('f.txt');
  void head;
  return mainHead;
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

describe('sessionGit ops commit — live conflict guard at the mutation boundary (ROB-5 / SCP-1)', () => {
  it('refuses to stage or commit a tree with an unmerged path, leaving HEAD and the index untouched', async () => {
    await withTempDir('commit-conflict-guard-', async (repo) => {
      initRepoMain(repo);
      const headBefore = makeConflict(repo);
      // Simulate the stale-snapshot race: the renderer believed the tree was
      // clean; the op must not trust that and must probe the live index.
      const ops = createGitOps(makeServices(repo));
      const result = (await ops.commit({ sessionId: 's1', message: 'should not land' })) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Resolve conflicts before committing/);
      expect(result.error).toContain('f.txt');
      // No commit was created …
      expect(git(repo, 'rev-parse HEAD')).toBe(headBefore);
      // … and nothing was staged: the path is still unmerged and the file
      // still carries its conflict markers.
      expect(git(repo, 'diff --name-only --diff-filter=U')).toBe('f.txt');
      expect(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8')).toContain('<<<<<<<');
    });
  }, 60_000);

  it('commits normally once the conflict is resolved', async () => {
    await withTempDir('commit-conflict-resolved-', async (repo) => {
      initRepoMain(repo);
      const headBefore = makeConflict(repo);
      fs.writeFileSync(path.join(repo, 'f.txt'), 'resolved\n');
      git(repo, 'add -- f.txt');
      expect(git(repo, 'diff --name-only --diff-filter=U')).toBe('');

      const ops = createGitOps(makeServices(repo));
      const result = (await ops.commit({ sessionId: 's1', message: 'resolve' })) as { success: boolean; error?: string };

      expect(result.success).toBe(true);
      expect(git(repo, 'rev-parse HEAD')).not.toBe(headBefore);
      expect(git(repo, 'status --porcelain')).toBe('');
    });
  }, 60_000);
});
