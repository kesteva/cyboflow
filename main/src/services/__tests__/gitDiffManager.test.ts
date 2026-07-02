/**
 * Security and behavioral tests for GitDiffManager.
 *
 * Behaviors covered (per TASK-678 test_strategy):
 * 1. Adversarial filename containing $(touch /tmp/marker) does NOT execute the
 *    embedded shell command when getDiffStats (wc-l path) iterates untracked files.
 * 2. Adversarial filename containing backticks does NOT execute the backticked
 *    command when createDiffForUntrackedFiles (cat path) reads file contents.
 * 3. Happy path: a normal 2-line untracked file produces additions >= 2 (the
 *    untracked file's newline count), and the diff output contains the canonical
 *    diff --git header, new file mode, +++ b/<file>, @@ hunk header, and +line prefixes.
 *
 * All tests use real temp directories and real git repos (no mocking of fs or git).
 * Skipped on Windows where some filename characters are not permitted by the OS.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitDiffManager } from '../gitDiffManager';
import { withTempDir } from '../../__test_fixtures__/tmp';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Initialise a bare git repo with one empty commit so HEAD is valid. */
function initRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  // Create an initial commit so HEAD exists
  execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: 'pipe' });
}

// ---------------------------------------------------------------------------
// Security: adversarial filename injection tests
// ---------------------------------------------------------------------------

describe('GitDiffManager — adversarial filename injection', () => {
  // Gate on non-Windows: macOS/Linux allow $, (, ), ` in filenames; Windows does not.
  it.runIf(process.platform !== 'win32')(
    'adversarial $(touch) filename does NOT create the marker file (getDiffStats path)',
    async () => {
      await withTempDir('gitdiff-injection-wc-', async (tmpDir) => {
        initRepo(tmpDir);

        // Build a unique marker name (no path separators) so it is a valid
        // filesystem name component on macOS/Linux. If the shell executes
        // $(touch cyboflow-pwned-XYZ) the file lands in the shell's cwd —
        // which for the old wc -l call was worktreePath (i.e. tmpDir).
        const markerName = `cyboflow-pwned-${Date.now()}`;
        // Check all plausible landing spots: tmpDir (old wc -l cwd), os.tmpdir(),
        // and process.cwd().
        const markerPaths = [
          path.join(tmpDir, markerName),
          path.join(os.tmpdir(), markerName),
          path.join(process.cwd(), markerName),
        ];

        // Create a file whose name embeds a $(touch marker) shell substitution.
        // $ ( ) are valid filename chars on macOS APFS and Linux ext4.
        const adversarialName = `$(touch ${markerName}).txt`;
        fs.writeFileSync(path.join(tmpDir, adversarialName), 'safe content\n');

        const manager = new GitDiffManager();
        // captureWorkingDirectoryDiff calls getDiffStats (wc-l path) internally.
        const result = await manager.captureWorkingDirectoryDiff(tmpDir);

        // The injected command must NOT have run — check all plausible spots.
        for (const p of markerPaths) {
          expect(fs.existsSync(p)).toBe(false);
          // Belt-and-suspenders cleanup in case the assertion above is wrong.
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }

        // The file should have been counted (1 newline → additions includes at least 1).
        expect(result.stats.additions).toBeGreaterThanOrEqual(1);
      });
    }
  );

  it.runIf(process.platform !== 'win32')(
    'backtick filename does NOT execute the backticked command (createDiffForUntrackedFiles path)',
    async () => {
      await withTempDir('gitdiff-injection-cat-', async (tmpDir) => {
        initRepo(tmpDir);

        // Same approach: unique name without slashes. The backtick invocation
        // `touch cyboflow-pwned-bt-XYZ` would land in the shell's cwd if run.
        const markerName = `cyboflow-pwned-bt-${Date.now()}`;
        const markerPaths = [
          path.join(tmpDir, markerName),
          path.join(os.tmpdir(), markerName),
          path.join(process.cwd(), markerName),
        ];

        // Create a file whose name embeds a backtick command substitution.
        // Backtick is a valid filename char on macOS APFS and Linux ext4.
        const adversarialName = `\`touch ${markerName}\`.md`;
        fs.writeFileSync(path.join(tmpDir, adversarialName), 'safe content\n');

        const manager = new GitDiffManager();
        // captureWorkingDirectoryDiff calls getGitDiffString → createDiffForUntrackedFiles
        // (cat path) internally.
        await manager.captureWorkingDirectoryDiff(tmpDir);

        // The injected command must NOT have run — check all plausible spots.
        for (const p of markerPaths) {
          expect(fs.existsSync(p)).toBe(false);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
      });
    }
  );
});

// ---------------------------------------------------------------------------
// Behavioral: diff output shape and line-count correctness
// ---------------------------------------------------------------------------

describe('GitDiffManager — happy path: normal untracked file', () => {
  it(
    'a 2-line untracked file produces additions >= 2 and a canonical diff block',
    async () => {
      await withTempDir('gitdiff-happy-', async (tmpDir) => {
        initRepo(tmpDir);

        // Write a normal file with exactly 2 lines (2 newline characters → wc -l reports 2).
        const fileName = 'normal.txt';
        const fileContent = 'line1\nline2\n';
        fs.writeFileSync(path.join(tmpDir, fileName), fileContent);

        const manager = new GitDiffManager();
        const result = await manager.captureWorkingDirectoryDiff(tmpDir);

        // --- Stats shape ---
        // Untracked file has 2 newlines → untrackedAdditions += 2.
        // (tracked additions may be 0 since we only have an empty initial commit.)
        expect(result.stats.additions).toBeGreaterThanOrEqual(2);

        // --- Diff output shape ---
        const diff = result.diff;

        // Must contain the canonical diff --git header.
        expect(diff).toContain(`diff --git a/${fileName} b/${fileName}`);

        // Must contain new file mode line.
        expect(diff).toContain('new file mode 100644');

        // Must contain the +++ b/<file> line.
        expect(diff).toContain(`+++ b/${fileName}`);

        // Must contain the @@ hunk header (any line count).
        expect(diff).toMatch(/@@ -0,0 \+1,\d+ @@/);

        // Must contain the file lines prefixed with '+'.
        expect(diff).toContain('+line1');
        expect(diff).toContain('+line2');
      });
    }
  );
});

// ---------------------------------------------------------------------------
// Service seams: getCombinedDiff / captureDiffAgainstRef / captureCommitDiff
// (real tmp git repos, no mocking of fs or git) — B6.
// ---------------------------------------------------------------------------

/** Init a repo whose default branch is deterministically `main`. */
function initRepoMain(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  // Force the branch name to `main` regardless of the host git's init.defaultBranch.
  execSync('git checkout -b main', { cwd: dir, stdio: 'pipe' });
}

/** Write, stage, and commit a file; return the resulting HEAD sha. */
function commitFile(dir: string, name: string, content: string, message: string): string {
  fs.writeFileSync(path.join(dir, name), content);
  execSync(`git add ${name}`, { cwd: dir, stdio: 'pipe' });
  execSync(`git commit -m "${message}"`, { cwd: dir, stdio: 'pipe' });
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
}

describe('GitDiffManager.getCombinedDiff', () => {
  it('falls back to a working-dir diff (distinguishable from a real combined diff) when there is no origin remote', async () => {
    await withTempDir('gitdiff-combined-noremote-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'a.txt', 'v1\n', 'base');
      // Uncommitted working change only — no origin remote configured.
      fs.writeFileSync(path.join(repo, 'a.txt'), 'v1\nv2-working\n');

      const manager = new GitDiffManager();
      const result = await manager.getCombinedDiff(repo, 'main');

      // The `git diff origin/main...HEAD` command fails (no origin), so the
      // method falls back to captureWorkingDirectoryDiff. That fallback must be
      // DISTINGUISHABLE from a true combined diff: a real combined diff stamps
      // beforeHash='origin/main' + afterHash='HEAD', whereas the working-dir
      // fallback stamps beforeHash=<HEAD sha> + afterHash=undefined.
      expect(result.beforeHash).not.toBe('origin/main');
      expect(result.beforeHash).toMatch(/^[0-9a-f]{40}$/); // resolved HEAD sha
      expect(result.afterHash).toBeUndefined();
      // The uncommitted change is still surfaced by the fallback.
      expect(result.diff).toContain('+v2-working');
    });
  });

  it('returns the branch-vs-origin/main diff, stats, and changedFiles when origin/main is present', async () => {
    await withTempDir('gitdiff-combined-remote-', async (repo) => {
      await withTempDir('gitdiff-combined-bare-', async (bare) => {
        execSync('git init --bare', { cwd: bare, stdio: 'pipe' });

        initRepoMain(repo);
        commitFile(repo, 'a.txt', 'origin-line\n', 'base on main');
        execSync(`git remote add origin ${bare}`, { cwd: repo, stdio: 'pipe' });
        execSync('git push origin main', { cwd: repo, stdio: 'pipe' });

        // Diverge on a feature branch: modify the tracked file + add a new one,
        // committing both (the combined diff compares committed history).
        execSync('git checkout -b feature', { cwd: repo, stdio: 'pipe' });
        commitFile(repo, 'a.txt', 'origin-line\nfeature-line\n', 'edit a on feature');
        commitFile(repo, 'b.txt', 'brand-new\n', 'feature work');

        const manager = new GitDiffManager();
        const result = await manager.getCombinedDiff(repo, 'main');

        expect(result.beforeHash).toBe('origin/main');
        expect(result.afterHash).toBe('HEAD');
        expect(result.changedFiles).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
        expect(result.stats.filesChanged).toBe(2);
        expect(result.stats.additions).toBeGreaterThanOrEqual(2);
        expect(result.diff).toContain('+feature-line');
        expect(result.diff).toContain('+brand-new');
      });
    });
  });
});

describe('GitDiffManager.captureDiffAgainstRef', () => {
  it('surfaces changes committed SINCE the ref (unlike the vs-HEAD working diff)', async () => {
    await withTempDir('gitdiff-againstref-', async (repo) => {
      initRepoMain(repo);
      const base = commitFile(repo, 'a.txt', 'a\n', 'base');
      // A change COMMITTED after the ref — invisible to `git diff HEAD`.
      commitFile(repo, 'b.txt', 'b-committed\n', 'committed since base');
      // An uncommitted untracked file — visible to both.
      fs.writeFileSync(path.join(repo, 'c.txt'), 'c-working\n');

      const manager = new GitDiffManager();
      const vsRef = await manager.captureDiffAgainstRef(repo, base);
      const vsHead = await manager.captureWorkingDirectoryDiff(repo);

      // The moving ref surfaces the committed b.txt; vs-HEAD does not.
      expect(vsRef.beforeHash).toBe(base);
      expect(vsRef.afterHash).toBeUndefined();
      expect(vsRef.changedFiles).toEqual(expect.arrayContaining(['b.txt', 'c.txt']));
      expect(vsHead.changedFiles).not.toContain('b.txt');
      // Both agree the untracked working file is a change.
      expect(vsHead.changedFiles).toContain('c.txt');
      expect(vsRef.diff).toContain('b-committed');
    });
  });
});

describe('GitDiffManager.captureCommitDiff', () => {
  it('diffs a single commit against its predecessor', async () => {
    await withTempDir('gitdiff-commitdiff-single-', async (repo) => {
      initRepoMain(repo);
      const sha1 = commitFile(repo, 'a.txt', 'a1\n', 'c1');
      const sha2 = commitFile(repo, 'a.txt', 'a2\n', 'c2');

      const manager = new GitDiffManager();
      const result = await manager.captureCommitDiff(repo, sha1, sha2);

      expect(result.beforeHash).toBe(sha1);
      expect(result.afterHash).toBe(sha2);
      expect(result.changedFiles).toEqual(['a.txt']);
      expect(result.diff).toContain('-a1');
      expect(result.diff).toContain('+a2');
    });
  });

  it('spans multiple commits when given a wide range', async () => {
    await withTempDir('gitdiff-commitdiff-multi-', async (repo) => {
      initRepoMain(repo);
      const sha1 = commitFile(repo, 'a.txt', 'a1\n', 'c1');
      commitFile(repo, 'a.txt', 'a2\n', 'c2');
      const sha3 = commitFile(repo, 'b.txt', 'b1\n', 'c3');

      const manager = new GitDiffManager();
      const result = await manager.captureCommitDiff(repo, sha1, sha3);

      expect(result.changedFiles).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
      expect(result.stats.filesChanged).toBe(2);
    });
  });

  it('defaults toCommit to HEAD when omitted (afterHash resolves to the current HEAD sha)', async () => {
    await withTempDir('gitdiff-commitdiff-head-', async (repo) => {
      initRepoMain(repo);
      const sha1 = commitFile(repo, 'a.txt', 'a1\n', 'c1');
      commitFile(repo, 'a.txt', 'a2\n', 'c2');
      const sha3 = commitFile(repo, 'b.txt', 'b1\n', 'c3');

      const manager = new GitDiffManager();
      const result = await manager.captureCommitDiff(repo, sha1);

      // afterHash is resolved from HEAD, not the literal string 'HEAD'.
      expect(result.afterHash).toBe(sha3);
      expect(result.beforeHash).toBe(sha1);
      expect(result.changedFiles).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
    });
  });
});
