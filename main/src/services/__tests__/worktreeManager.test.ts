/**
 * Tests for WorktreeManager.createDeterministicWorktree
 *
 * Behaviors covered (per TASK-352 test_strategy):
 * 1. Returned worktreePath ends with `.cyboflow/worktrees/<workflowName>/<runId8>`
 * 2. Returned branchName matches `cyboflow/<workflowName>/<runId8>`
 * 3. Integration: git branch is actually created in a temp repo (requires `git` in PATH)
 *
 * The path/branch-scheme unit tests stub only `_createAtPath` (the git logic)
 * and use a real temp directory so `mkdir` can run normally without mocking.
 * The integration test uses a real temp git repo initialised via execSync.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { WorktreeManager } from '../worktreeManager';

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
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'worktree-unit-'));
    });

    afterEach(() => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    });

    it('worktreePath ends with .cyboflow/worktrees/<workflowName>/<runId8>', async () => {
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

    it('branchName matches cyboflow/<workflowName>/<runId8>', async () => {
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

    it('uses only the first 8 chars of runId', async () => {
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

    it('_createAtPath is called with the computed worktreePath and branchName', async () => {
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

  // -------------------------------------------------------------------------
  // Integration: real git in a temp repo
  // -------------------------------------------------------------------------

  describe('branch matches scheme (integration)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'worktree-manager-test-'));
      // Init a git repo with an initial commit so worktree add works
      execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
      execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
      execSync('git commit --allow-empty -m "init"', { cwd: tmpDir, stdio: 'pipe' });
    });

    afterEach(() => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    });

    it('creates branch cyboflow/<workflowName>/<runId8> in the repo', async () => {
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
