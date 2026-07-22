/**
 * Regression test for TASK-086's root cause: captureWorkingDirectoryDiff
 * diffs the working tree against HEAD, which never advances across turns
 * for a session whose commit mode never commits (e.g. commitMode:
 * 'disabled', including in-place sessions). Successive calls therefore each
 * return the FULL CUMULATIVE diff since the last real commit, not a
 * per-turn delta — so naively summing stats_additions/stats_deletions/
 * stats_files_changed across execution_diffs rows over-counts by roughly Nx
 * over N turns.
 *
 * This test exercises the real GitDiffManager against a real git repo
 * (no mocking) to empirically confirm the cumulative behavior, mirroring 3
 * turns of a commit-disabled session: write more file changes, call
 * captureWorkingDirectoryDiff, without ever committing in between.
 *
 * The fix itself (contiguous same-before_commit_hash run collapsing) lives
 * in main/src/ipc/session.ts (aggregateExecutionDiffTotals) and is covered
 * by main/src/ipc/__tests__/aggregateExecutionDiffTotals.test.ts — this file
 * only documents/locks the GitDiffManager-level behavior that fix works
 * around.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitDiffManager } from '../gitDiffManager';
import { withTempDir } from '../../__test_fixtures__/tmp';

function initRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: 'pipe' });
}

describe('GitDiffManager.captureWorkingDirectoryDiff — cumulative-diff behavior', () => {
  it('each successive call over uncommitted turns returns the FULL cumulative diff, not a per-turn delta', async () => {
    await withTempDir('gitdiff-cumulative-', async (tmpDir) => {
      initRepo(tmpDir);
      const manager = new GitDiffManager();
      const filePath = path.join(tmpDir, 'foo.ts');

      // Turn 1: write 5 lines to a new tracked-after-add file, then diff.
      // (Untracked files are picked up via getUntrackedFiles/ls-files, same
      // as the real "new file this session" case.)
      fs.writeFileSync(filePath, Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n') + '\n');
      const turn1 = await manager.captureWorkingDirectoryDiff(tmpDir);
      expect(turn1.stats.additions).toBe(5);
      expect(turn1.stats.filesChanged).toBe(1);

      // Turn 2: append 7 more lines (12 total) — no commit happened between
      // turn 1 and turn 2, so beforeCommitHash === HEAD from turn 1.
      const twelveLines = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n') + '\n';
      fs.writeFileSync(filePath, twelveLines);
      const turn2 = await manager.captureWorkingDirectoryDiff(tmpDir);
      // Cumulative: reflects ALL 12 lines added since HEAD, not the 7-line delta.
      expect(turn2.stats.additions).toBe(12);
      expect(turn2.stats.filesChanged).toBe(1);

      // Turn 3: append more lines (20 total) plus a second new file.
      const twentyLines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
      fs.writeFileSync(filePath, twentyLines);
      fs.writeFileSync(path.join(tmpDir, 'bar.ts'), 'a\nb\n');
      const turn3 = await manager.captureWorkingDirectoryDiff(tmpDir);
      expect(turn3.stats.additions).toBe(22); // 20 (foo.ts) + 2 (bar.ts)
      expect(turn3.stats.filesChanged).toBe(2);

      // The bug: naively summing per-turn stats (as the pre-fix IPC handler
      // did) triples-counts the true final delta (22 lines, 2 files).
      const naiveSum = turn1.stats.additions + turn2.stats.additions + turn3.stats.additions;
      expect(naiveSum).toBe(39); // 5 + 12 + 22 — over-counts the true total by ~1.8x
      expect(naiveSum).toBeGreaterThan(turn3.stats.additions);

      // The correct total for this 3-turn uncommitted run is just the LAST
      // row's stats (turn3), since every earlier row is a subset of it.
      expect(turn3.stats.additions).toBe(22);
    });
  });

  it('beforeHash is identical across uncommitted turns (confirms HEAD never advances)', async () => {
    await withTempDir('gitdiff-cumulative-hash-', async (tmpDir) => {
      initRepo(tmpDir);
      const manager = new GitDiffManager();
      const filePath = path.join(tmpDir, 'foo.ts');

      fs.writeFileSync(filePath, 'a\n');
      const turn1 = await manager.captureWorkingDirectoryDiff(tmpDir);

      fs.writeFileSync(filePath, 'a\nb\n');
      const turn2 = await manager.captureWorkingDirectoryDiff(tmpDir);

      expect(turn1.beforeHash).toBeTruthy();
      expect(turn2.beforeHash).toBe(turn1.beforeHash);
    });
  });
});
