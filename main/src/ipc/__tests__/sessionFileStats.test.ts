/**
 * computeSessionFileStats / resolveSessionDiffBaseRef — the git-derived `files`
 * block of sessions:get-statistics.
 *
 * Two contracts are locked here:
 *   - base-ref preference: the session's recorded branch point wins, the
 *     project's main branch is the fallback, and an unresolvable pair yields
 *     null (never a confident zero — the caller must be free to fall back to
 *     the execution_diffs aggregation instead of publishing "0 files changed"
 *     for a session that changed plenty).
 *   - failure is null, not zero: a missing worktree / dead git returns null.
 *
 * Runs against a real git repo, since ref resolution is exactly the part a
 * mocked git would fake into meaninglessness.
 */
import { describe, it, expect, vi } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitDiffManager } from '../../services/gitDiffManager';
import { withTempDir } from '../../__test_fixtures__/tmp';
import { computeSessionFileStats, resolveSessionDiffBaseRef } from '../sessionFileStats';

function initRepo(dir: string): void {
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: 'pipe' });
}

function commitAll(dir: string, message: string): void {
  execSync('git add -A', { cwd: dir, stdio: 'pipe' });
  execSync(`git commit -m "${message}"`, { cwd: dir, stdio: 'pipe' });
}

function headSha(dir: string): string {
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
}

const MISSING_SHA = '0'.repeat(40);

describe('resolveSessionDiffBaseRef', () => {
  it('prefers the first resolvable candidate and skips the unresolvable ones', async () => {
    await withTempDir('session-baseref-', async (tmpDir) => {
      initRepo(tmpDir);
      const sha = headSha(tmpDir);

      expect(await resolveSessionDiffBaseRef(tmpDir, [sha, 'main'])).toBe(sha);
      // A gc'd / never-existed base commit falls through to the main branch,
      // resolved to its SHA (TASK-208: the resolved commit-ish, not the raw
      // candidate string, is what must reach downstream argv).
      expect(await resolveSessionDiffBaseRef(tmpDir, [MISSING_SHA, 'main'])).toBe(sha);
      // Empty candidates are ignored rather than treated as a ref.
      expect(await resolveSessionDiffBaseRef(tmpDir, [null, undefined, 'main'])).toBe(sha);
    });
  });

  it('returns null when nothing resolves', async () => {
    await withTempDir('session-baseref-none-', async (tmpDir) => {
      initRepo(tmpDir);
      expect(await resolveSessionDiffBaseRef(tmpDir, [MISSING_SHA, 'no-such-branch'])).toBeNull();
      expect(await resolveSessionDiffBaseRef(tmpDir, [])).toBeNull();
    });
  });
});

describe('computeSessionFileStats', () => {
  it('reports the work a session committed since its branch point', async () => {
    await withTempDir('session-filestats-', async (tmpDir) => {
      initRepo(tmpDir);
      const baseCommit = headSha(tmpDir);

      fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'one\ntwo\n');
      commitAll(tmpDir, 'work');
      fs.writeFileSync(path.join(tmpDir, 'untracked.ts'), 'three\n');
      const resolveFallbackRef = vi.fn(async () => 'main');

      const stats = await computeSessionFileStats({
        worktreePath: tmpDir,
        baseCommit,
        resolveFallbackRef,
        gitDiffManager: new GitDiffManager(),
      });

      expect(stats).toEqual({
        totalFilesChanged: 2,
        totalLinesAdded: 3,
        totalLinesDeleted: 0,
        filesModified: ['a.ts', 'untracked.ts'],
      });
      // The main-branch fallback costs its own git process, so the common path
      // (a resolvable base commit) must never reach for it.
      expect(resolveFallbackRef).not.toHaveBeenCalled();
    });
  });

  it('falls back to the main branch when the recorded base commit is gone', async () => {
    await withTempDir('session-filestats-fallback-', async (tmpDir) => {
      initRepo(tmpDir);
      execSync('git checkout -b feature', { cwd: tmpDir, stdio: 'pipe' });
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'one\n');
      commitAll(tmpDir, 'work');

      const stats = await computeSessionFileStats({
        worktreePath: tmpDir,
        baseCommit: MISSING_SHA,
        resolveFallbackRef: async () => 'main',
        gitDiffManager: new GitDiffManager(),
      });

      expect(stats).toEqual({
        totalFilesChanged: 1,
        totalLinesAdded: 1,
        totalLinesDeleted: 0,
        filesModified: ['a.ts'],
      });
    });
  });

  it('returns null (not zeroes) when there is no worktree to inspect', async () => {
    const gitDiffManager = { getDiffStatsAgainstRef: vi.fn() };

    expect(
      await computeSessionFileStats({ worktreePath: null, baseCommit: 'abc', gitDiffManager }),
    ).toBeNull();
    expect(gitDiffManager.getDiffStatsAgainstRef).not.toHaveBeenCalled();
  });

  it('returns null when no base ref resolves — an archived worktree must not read as "0 files changed"', async () => {
    await withTempDir('session-filestats-noref-', async (tmpDir) => {
      initRepo(tmpDir);
      const gitDiffManager = { getDiffStatsAgainstRef: vi.fn() };

      const stats = await computeSessionFileStats({
        worktreePath: tmpDir,
        baseCommit: MISSING_SHA,
        resolveFallbackRef: async () => 'no-such-branch',
        gitDiffManager,
      });

      expect(stats).toBeNull();
      expect(gitDiffManager.getDiffStatsAgainstRef).not.toHaveBeenCalled();
    });
  });

  it('returns null when the diff itself fails', async () => {
    await withTempDir('session-filestats-throw-', async (tmpDir) => {
      initRepo(tmpDir);
      const gitDiffManager = {
        getDiffStatsAgainstRef: vi.fn().mockRejectedValue(new Error('git exploded')),
      };
      const logger = { warn: vi.fn(), verbose: vi.fn() };

      const stats = await computeSessionFileStats({
        worktreePath: tmpDir,
        baseCommit: headSha(tmpDir),
        resolveFallbackRef: async () => 'main',
        gitDiffManager,
        logger: logger as unknown as Parameters<typeof computeSessionFileStats>[0]['logger'],
      });

      expect(stats).toBeNull();
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});
