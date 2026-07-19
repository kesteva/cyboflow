/**
 * Regression tests for CommitManager.waitForStructuredCommit (F20).
 *
 * The prior implementation treated ANY clean working tree as proof Claude
 * created a commit — a turn that made no changes, or discarded its edits,
 * or simply started clean would report a pre-existing HEAD as a "new"
 * structured commit. The fix captures the baseline HEAD when the wait
 * begins and only reports success once HEAD has actually moved past that
 * baseline while the tree is clean.
 *
 * A follow-up regression: waitForStructuredCommit is invoked from
 * ExecutionTracker.endExecution, which runs AFTER Claude's turn (and its
 * structured commit) already completed. Baselining HEAD at wait-start meant
 * a correctly-created commit never registered as "new" (the wait itself
 * starts after HEAD already moved). The fix threads an optional
 * `baselineHead` through so callers can pass the PRE-TURN hash instead of
 * capturing HEAD at the start of the wait, and the first poll iteration
 * runs immediately (no initial delay) so an already-existing commit
 * resolves without waiting a full poll interval.
 *
 * Uses real temp git repos (no mocking), matching the convention in
 * gitPlumbingCommands.test.ts. Real wall-clock time is involved because the
 * poll interval (1s) is not injectable — tests are sized to still run fast
 * (single-digit seconds).
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { CommitManager } from '../commitManager';
import { withTempDir } from '../../__test_fixtures__/tmp';

function initRepoMain(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  execSync('git checkout -b main', { cwd: dir, stdio: 'pipe' });
}

function commitFile(dir: string, name: string, content: string, message: string): void {
  execSync(`sh -c 'printf "%s" ${JSON.stringify(content)} > ${name}'`, { cwd: dir, stdio: 'pipe' });
  execSync(`git add ${name}`, { cwd: dir, stdio: 'pipe' });
  execSync(`git commit -m "${message}"`, { cwd: dir, stdio: 'pipe' });
}

describe('CommitManager.waitForStructuredCommit — baseline-HEAD false-positive fix', () => {
  it('clean tree + unchanged HEAD keeps waiting and times out (no false success)', async () => {
    await withTempDir('commit-wait-timeout-', async (dir) => {
      initRepoMain(dir);
      commitFile(dir, 'a.txt', 'a\n', 'base');
      const preExistingHead = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();

      const commitManager = new CommitManager();
      // Tree is clean from the start and HEAD never moves during the wait —
      // the old code would report `preExistingHead` as a fresh commit here.
      const result = await commitManager.waitForStructuredCommit('sess-timeout', dir, 800);

      expect(result).toEqual({ success: false, error: 'Timeout waiting for commit' });
      // Sanity: HEAD really is unchanged (the bug's premise).
      expect(execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim()).toBe(preExistingHead);
    });
  }, 10000);

  it('HEAD change + clean tree succeeds and reports the new hash', async () => {
    await withTempDir('commit-wait-success-', async (dir) => {
      initRepoMain(dir);
      commitFile(dir, 'a.txt', 'a\n', 'base');

      const commitManager = new CommitManager();
      const resultPromise = commitManager.waitForStructuredCommit('sess-success', dir, 5000);

      // Give the baseline-HEAD capture (one async git call, issued before
      // the poll loop starts) time to land before creating the commit the
      // poll is meant to detect — avoids racing our own baseline read.
      await new Promise((resolve) => setTimeout(resolve, 200));
      commitFile(dir, 'b.txt', 'b\n', 'claude commit');
      const newHead = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();

      const result = await resultPromise;
      expect(result).toEqual({ success: true, commitHash: newHead });
    });
  }, 10000);

  it('with an explicit baseline, a commit made BEFORE the wait starts resolves success immediately', async () => {
    await withTempDir('commit-wait-preexisting-baseline-', async (dir) => {
      initRepoMain(dir);
      commitFile(dir, 'a.txt', 'a\n', 'base');
      const preTurnHead = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();

      // Simulate the turn (and Claude's structured commit) already having
      // completed BEFORE waitForStructuredCommit is even called — the
      // ExecutionTracker.endExecution ordering that triggered the regression.
      commitFile(dir, 'b.txt', 'b\n', 'claude commit');
      const newHead = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();

      const commitManager = new CommitManager();
      const start = Date.now();
      const result = await commitManager.waitForStructuredCommit('sess-preexisting', dir, 30000, preTurnHead);
      const elapsedMs = Date.now() - start;

      expect(result).toEqual({ success: true, commitHash: newHead });
      // Must resolve on the immediate first check, well under one poll interval.
      expect(elapsedMs).toBeLessThan(1000);
    });
  }, 10000);

  it('with an explicit baseline, an unchanged HEAD + clean tree still times out (no false positive)', async () => {
    await withTempDir('commit-wait-baseline-timeout-', async (dir) => {
      initRepoMain(dir);
      commitFile(dir, 'a.txt', 'a\n', 'base');
      const preTurnHead = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();

      const commitManager = new CommitManager();
      // Tree is clean and HEAD never moves — passing the baseline explicitly
      // must not short-circuit to success.
      const result = await commitManager.waitForStructuredCommit('sess-baseline-timeout', dir, 800, preTurnHead);

      expect(result).toEqual({ success: false, error: 'Timeout waiting for commit' });
      expect(execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim()).toBe(preTurnHead);
    });
  }, 10000);
});
