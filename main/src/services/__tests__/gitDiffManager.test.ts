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

// ---------------------------------------------------------------------------
// TASK-680/F11: getCommitHistory, getCommitDiff, and hasChanges were converted
// from execSync to runGitAsync — these exercise the now-async public API
// directly against real temp git repos (no mocking).
// ---------------------------------------------------------------------------

describe('GitDiffManager.getCommitHistory (async)', () => {
  it('returns commits unique to the current branch, newest first, with parsed numstat', async () => {
    await withTempDir('gitdiff-history-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'base.txt', 'base\n', 'base commit');
      execSync('git checkout -b feature', { cwd: repo, stdio: 'pipe' });
      const sha1 = commitFile(repo, 'a.txt', 'a1\n', 'feature commit 1');
      const sha2 = commitFile(repo, 'b.txt', 'b1\n', 'feature commit 2');

      const manager = new GitDiffManager();
      const commits = await manager.getCommitHistory(repo, 50, 'main');

      expect(commits.map(c => c.hash)).toEqual([sha2, sha1]);
      expect(commits[0].message).toBe('feature commit 2');
      expect(commits[0].stats.filesChanged).toBe(1);
      expect(commits[0].stats.additions).toBe(1);
    });
  });

  it('returns an empty array when the branch has no commits unique from main', async () => {
    await withTempDir('gitdiff-history-empty-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'base.txt', 'base\n', 'base commit');

      const manager = new GitDiffManager();
      const commits = await manager.getCommitHistory(repo, 50, 'main');

      expect(commits).toEqual([]);
    });
  });
});

describe('GitDiffManager.getCommitDiff (async)', () => {
  it('returns the diff, stats, and changed files for a single commit hash', async () => {
    await withTempDir('gitdiff-commitdiff-single2-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'a.txt', 'a1\n', 'c1');
      const sha2 = commitFile(repo, 'a.txt', 'a1\na2\n', 'c2');

      const manager = new GitDiffManager();
      const result = await manager.getCommitDiff(repo, sha2);

      expect(result.afterHash).toBe(sha2);
      expect(result.beforeHash).toBe(`${sha2}~1`);
      expect(result.changedFiles).toEqual(['a.txt']);
      expect(result.diff).toContain('+a2');
      expect(result.stats.filesChanged).toBe(1);
    });
  });
});

describe('GitDiffManager.hasChanges (async)', () => {
  it('is false for a clean worktree and true after an uncommitted edit', async () => {
    await withTempDir('gitdiff-haschanges-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'a.txt', 'a1\n', 'c1');

      const manager = new GitDiffManager();
      expect(await manager.hasChanges(repo)).toBe(false);

      fs.writeFileSync(path.join(repo, 'a.txt'), 'a1\na2\n');
      expect(await manager.hasChanges(repo)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// TASK-208: caller-supplied `ref` reaching the four `runGitAsync(['diff', ...,
// ref])` argv sites bare is a `git diff` OPTION-INJECTION hole — a ref of
// `--output=<path>` is a valid `git diff` option that writes an arbitrary
// file and returns empty stdout, silently defeating the "unresolvable ref
// falls back" contract. Every caller-supplied ref must be rev-parse-resolved
// (and rejected outright when it is option-like) BEFORE it reaches argv.
//
// These cases are written against the REQUIRED post-fix behavior and are
// EXPECTED TO FAIL against the pre-fix code (ref passed to runGitAsync bare):
// the pre-fix `git diff --output=<marker>` call actually creates the marker
// file, which is exactly what `fs.existsSync(marker) === false` catches.
// ---------------------------------------------------------------------------

describe('GitDiffManager — ref option-injection guard (TASK-208)', () => {
  function markerPath(uniq: string): string {
    return path.join(os.tmpdir(), `cyboflow-pwn-${uniq}`);
  }

  it(
    'getDiffStatsAgainstRef rejects a --output= injection ref before it reaches `git diff --numstat` (argv site :136)',
    async () => {
      await withTempDir('gitdiff-inject-numstat-', async (repo) => {
        initRepoMain(repo);
        commitFile(repo, 'a.txt', 'a1\n', 'base');

        const marker = markerPath(`numstat-${Date.now()}`);
        expect(fs.existsSync(marker)).toBe(false);

        const manager = new GitDiffManager();
        const maliciousRef = `--output=${marker}`;

        try {
          // Must not throw: an unresolvable/rejected ref is a fallback
          // trigger, not an exception the caller has to handle.
          const result = await manager.getDiffStatsAgainstRef(repo, maliciousRef);

          expect(fs.existsSync(marker)).toBe(false);
          // The malicious "ref" must never be treated as a real diff target.
          expect(result.stats).toEqual({ additions: 0, deletions: 0, filesChanged: 0 });
        } finally {
          if (fs.existsSync(marker)) fs.unlinkSync(marker);
        }
      });
    },
  );

  it(
    'captureDiffAgainstRef rejects a --output= injection ref across its diff/changedFiles/stat legs (argv sites :468, :501, :527)',
    async () => {
      await withTempDir('gitdiff-inject-captureref-', async (repo) => {
        initRepoMain(repo);
        commitFile(repo, 'a.txt', 'a1\n', 'base');

        const marker = markerPath(`captureref-${Date.now()}`);
        expect(fs.existsSync(marker)).toBe(false);

        const manager = new GitDiffManager();
        const maliciousRef = `--output=${marker}`;

        try {
          const result = await manager.captureDiffAgainstRef(repo, maliciousRef);

          // Site :468 (`git diff <ref>`) — must not have written the marker file.
          expect(fs.existsSync(marker)).toBe(false);
          // Site :501 (`git diff --name-only <ref>`) leg — no spurious entries
          // from a "successful" injected option run.
          expect(result.changedFiles).not.toContain(marker);
          // Site :527 (`git diff --stat <ref>`) leg — stats fall back to a safe
          // default rather than reflecting a garbage/empty stdout as "no changes
          // vs a valid ref".
          expect(result.stats).toEqual({ additions: 0, deletions: 0, filesChanged: 0 });
        } finally {
          if (fs.existsSync(marker)) fs.unlinkSync(marker);
        }
      });
    },
  );

  it('getDiffStatsAgainstRef falls back without throwing for a benign but unresolvable ref', async () => {
    await withTempDir('gitdiff-unresolvable-numstat-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'a.txt', 'a1\n', 'base');

      const manager = new GitDiffManager();
      // Pre-fix, an unresolvable ref propagates as a thrown git error instead
      // of triggering the fallback — surface that as a normal assertion
      // failure rather than an unhandled rejection.
      await expect(manager.getDiffStatsAgainstRef(repo, 'no-such-branch')).resolves.toEqual(
        expect.objectContaining({ stats: { additions: 0, deletions: 0, filesChanged: 0 } }),
      );
    });
  });

  it('captureDiffAgainstRef falls back without throwing for a benign but unresolvable ref', async () => {
    await withTempDir('gitdiff-unresolvable-captureref-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'a.txt', 'a1\n', 'base');

      const manager = new GitDiffManager();
      const result = await manager.captureDiffAgainstRef(repo, 'no-such-branch');

      expect(result).toBeDefined();
      expect(result.changedFiles).toEqual([]);
      expect(result.stats).toEqual({ additions: 0, deletions: 0, filesChanged: 0 });
    });
  });
});

// ---------------------------------------------------------------------------
// TASK-209: GitDiffManager.getWorktreeStatus parses
// `git status --porcelain=v1 -z --untracked-files=all` into a per-path flag
// record (staged / unstaged / untracked / conflicted). Real temp repos, no
// mocking of fs or git.
// ---------------------------------------------------------------------------

describe('GitDiffManager.getWorktreeStatus', () => {
  it('classifies staged-only (M ) and unstaged-only ( M) as mutually exclusive flags, and both (MM) as BOTH flags set', async () => {
    await withTempDir('gitdiff-status-mm-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'staged.txt', 'v1\n', 'base staged');
      commitFile(repo, 'unstaged.txt', 'v1\n', 'base unstaged');
      commitFile(repo, 'both.txt', 'v1\n', 'base both');

      // staged-only: modify + `git add` (index differs from HEAD; worktree matches index).
      fs.writeFileSync(path.join(repo, 'staged.txt'), 'v2\n');
      execSync('git add staged.txt', { cwd: repo, stdio: 'pipe' });

      // unstaged-only: modify, never staged.
      fs.writeFileSync(path.join(repo, 'unstaged.txt'), 'v2\n');

      // both: stage one edit, then edit again unstaged — the MM case.
      fs.writeFileSync(path.join(repo, 'both.txt'), 'v2\n');
      execSync('git add both.txt', { cwd: repo, stdio: 'pipe' });
      fs.writeFileSync(path.join(repo, 'both.txt'), 'v3\n');

      const manager = new GitDiffManager();
      const entries = await manager.getWorktreeStatus(repo);
      const byPath = (p: string) => entries.find((e) => e.path === p);

      expect(byPath('staged.txt')).toEqual({
        path: 'staged.txt', staged: true, unstaged: false, untracked: false, conflicted: false,
      });
      expect(byPath('unstaged.txt')).toEqual({
        path: 'unstaged.txt', staged: false, unstaged: true, untracked: false, conflicted: false,
      });
      // The proof this is a flag record and not an enum: both bits are set together.
      expect(byPath('both.txt')).toEqual({
        path: 'both.txt', staged: true, unstaged: true, untracked: false, conflicted: false,
      });
    });
  });

  it('classifies an untracked file (??) and a staged new file (A )', async () => {
    await withTempDir('gitdiff-status-a-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'base.txt', 'base\n', 'base');

      fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');

      fs.writeFileSync(path.join(repo, 'added.txt'), 'new\n');
      execSync('git add added.txt', { cwd: repo, stdio: 'pipe' });

      const manager = new GitDiffManager();
      const entries = await manager.getWorktreeStatus(repo);
      const byPath = (p: string) => entries.find((e) => e.path === p);

      expect(byPath('untracked.txt')).toEqual({
        path: 'untracked.txt', staged: false, unstaged: false, untracked: true, conflicted: false,
      });
      expect(byPath('added.txt')).toEqual({
        path: 'added.txt', staged: true, unstaged: false, untracked: false, conflicted: false,
      });
    });
  });

  it('classifies a deleted (unstaged) file', async () => {
    await withTempDir('gitdiff-status-deleted-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'gone.txt', 'bye\n', 'base');
      fs.unlinkSync(path.join(repo, 'gone.txt'));

      const manager = new GitDiffManager();
      const entries = await manager.getWorktreeStatus(repo);
      const entry = entries.find((e) => e.path === 'gone.txt');

      expect(entry).toEqual({
        path: 'gone.txt', staged: false, unstaged: true, untracked: false, conflicted: false,
      });
    });
  });

  it('classifies a staged rename (R ), asserting oldPath and the -z new-path-first field order', async () => {
    await withTempDir('gitdiff-status-rename-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'old-name.txt', 'renamed content that is long enough to be detected as a rename\n', 'base');
      execSync('git mv old-name.txt new-name.txt', { cwd: repo, stdio: 'pipe' });

      const manager = new GitDiffManager();
      const entries = await manager.getWorktreeStatus(repo);
      const entry = entries.find((e) => e.path === 'new-name.txt');

      expect(entry).toBeDefined();
      // A parser written naively from the human-readable `R  old -> new` docs
      // example gets `-z`'s field order backwards (it emits new-path first) —
      // this pins that oldPath resolves to the OLD name, not the new one.
      expect(entry?.oldPath).toBe('old-name.txt');
      expect(entry?.staged).toBe(true);
      expect(entry?.unstaged).toBe(false);
      expect(entry?.conflicted).toBe(false);
      expect(entries.find((e) => e.path === 'old-name.txt')).toBeUndefined();
    });
  });

  it('joins a path with a space and a path with shell metacharacters to the same path the diff blob reports', async () => {
    await withTempDir('gitdiff-status-join-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'base.txt', 'base\n', 'base');

      const spaceName = 'sp ace file.txt';
      const metaName = '$(weird)`file`.txt';
      fs.writeFileSync(path.join(repo, spaceName), 'space content\n');
      fs.writeFileSync(path.join(repo, metaName), 'meta content\n');

      const manager = new GitDiffManager();
      const statusEntries = await manager.getWorktreeStatus(repo);
      // getChangedFiles (via the public diff capture) reports the same
      // unquoted, un-C-escaped path as the `diff --git a/<path> …` blob.
      const diffResult = await manager.captureWorkingDirectoryDiff(repo);

      for (const name of [spaceName, metaName]) {
        expect(diffResult.changedFiles).toContain(name);
        const statusEntry = statusEntries.find((e) => e.path === name);
        expect(statusEntry).toBeDefined();
        expect(statusEntry?.untracked).toBe(true);
        // Not merely "parsed without throwing" — the join key matches exactly.
        expect(statusEntry?.path).toBe(name);
      }
    });
  });

  it('lists every file inside an untracked directory as its own entry (the -uall proof)', async () => {
    await withTempDir('gitdiff-status-untracked-dir-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'base.txt', 'base\n', 'base');

      fs.mkdirSync(path.join(repo, 'newdir'));
      fs.writeFileSync(path.join(repo, 'newdir', 'a.txt'), 'a\n');
      fs.writeFileSync(path.join(repo, 'newdir', 'b.txt'), 'b\n');

      const manager = new GitDiffManager();
      const entries = await manager.getWorktreeStatus(repo);

      // Without -uall this would collapse to a single 'newdir/' row.
      expect(entries.find((e) => e.path === 'newdir/')).toBeUndefined();
      expect(entries.find((e) => e.path === 'newdir')).toBeUndefined();
      expect(entries.find((e) => e.path === 'newdir/a.txt')).toEqual({
        path: 'newdir/a.txt', staged: false, unstaged: false, untracked: true, conflicted: false,
      });
      expect(entries.find((e) => e.path === 'newdir/b.txt')).toEqual({
        path: 'newdir/b.txt', staged: false, unstaged: false, untracked: true, conflicted: false,
      });
    });
  });

  it('sets conflicted=true (and staged=false, unstaged=false) for a real UU merge conflict', async () => {
    await withTempDir('gitdiff-status-conflict-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'f.txt', 'base\n', 'base');
      execSync('git checkout -b feature', { cwd: repo, stdio: 'pipe' });
      commitFile(repo, 'f.txt', 'feature line\n', 'feature edit');
      execSync('git checkout main', { cwd: repo, stdio: 'pipe' });
      commitFile(repo, 'f.txt', 'main line\n', 'main edit');
      try {
        execSync('git merge feature --no-edit', { cwd: repo, stdio: 'pipe' });
      } catch {
        // Expected — the conflicting merge makes `git merge` exit non-zero.
      }

      const manager = new GitDiffManager();
      const entries = await manager.getWorktreeStatus(repo);
      const entry = entries.find((e) => e.path === 'f.txt');

      expect(entry).toEqual({
        path: 'f.txt', staged: false, unstaged: false, untracked: false, conflicted: true,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// TASK-210: GitDiffManager.getDiffGroups — per-scope diff rollups
// (unstaged/staged/untracked/committed) and merge-base (three-dot) Committed
// membership. Real temp repos, no mocking of fs or git.
// ---------------------------------------------------------------------------

function headSha2(dir: string): string {
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
}

describe('GitDiffManager.getDiffGroups', () => {
  it('gives a file staged AND separately dirty DIFFERENT +n/-n in Staged vs Unstaged', async () => {
    await withTempDir('gitdiff-groups-staged-vs-unstaged-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'f.txt', 'line1\n', 'base');
      const baseSha = headSha2(repo);

      // Stage one version of the file...
      fs.writeFileSync(path.join(repo, 'f.txt'), 'line1\nstaged-line\n');
      execSync('git add f.txt', { cwd: repo, stdio: 'pipe' });
      // ...then dirty the working tree further, on top of the staged content.
      fs.writeFileSync(path.join(repo, 'f.txt'), 'line1\nstaged-line\nworking-a\nworking-b\n');

      const manager = new GitDiffManager();
      const result = await manager.getDiffGroups(repo, baseSha);

      const staged = result.groups.find((g) => g.scope === 'staged')!;
      const unstaged = result.groups.find((g) => g.scope === 'unstaged')!;

      expect(staged.files).toContain('f.txt');
      expect(unstaged.files).toContain('f.txt');
      // Staged: index vs HEAD adds exactly 1 line ("staged-line").
      expect(staged.additions).toBe(1);
      // Unstaged: worktree vs index adds exactly 2 lines ("working-a", "working-b").
      expect(unstaged.additions).toBe(2);
      expect(staged.additions).not.toBe(unstaged.additions);
    });
  });

  it('a file committed-since-base AND separately dirty appears in Committed AND Unstaged with independent numbers', async () => {
    await withTempDir('gitdiff-groups-committed-and-dirty-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'seed.txt', 'seed\n', 'base');
      const baseSha = headSha2(repo);

      // Committed since base: a new file landing 3 lines.
      commitFile(repo, 'f.txt', 'a\nb\nc\n', 'add f since base');

      // Separately dirty on top of the committed version.
      fs.writeFileSync(path.join(repo, 'f.txt'), 'a\nb\nc\nworking\n');

      const manager = new GitDiffManager();
      const result = await manager.getDiffGroups(repo, baseSha);

      const committed = result.groups.find((g) => g.scope === 'committed')!;
      const unstaged = result.groups.find((g) => g.scope === 'unstaged')!;

      expect(committed.files).toContain('f.txt');
      expect(unstaged.files).toContain('f.txt');
      expect(committed.additions).toBe(3);
      expect(unstaged.additions).toBe(1);
      expect(committed.additions).not.toBe(unstaged.additions);
      expect(result.committedUnavailable).toBe(false);
    });
  });

  it("an untracked newline-terminated file's addition count matches the blob-based (split('\\n').length) count, not the wc-l style count", async () => {
    await withTempDir('gitdiff-groups-untracked-count-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'seed.txt', 'seed\n', 'base');
      const baseSha = headSha2(repo);

      // "a\nb\n".split('\n') === ['a', 'b', ''] → length 3. The wc-l style
      // \n-occurrence count (countUntrackedAdditions) would report 2.
      fs.writeFileSync(path.join(repo, 'new.txt'), 'a\nb\n');

      const manager = new GitDiffManager();
      const result = await manager.getDiffGroups(repo, baseSha);
      const untracked = result.groups.find((g) => g.scope === 'untracked')!;

      expect(untracked.files).toContain('new.txt');
      expect(untracked.additions).toBe(3);
      expect(untracked.additions).not.toBe(2);
    });
  });

  it('a base "ahead" of HEAD does not fill Committed with reverse deletions for untouched files', async () => {
    await withTempDir('gitdiff-groups-base-ahead-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'a.txt', 'a1\n', 'c1');
      const midSha = headSha2(repo);
      commitFile(repo, 'b.txt', 'b1\n', 'c2 - later commit');
      const aheadSha = headSha2(repo);

      // HEAD now points BEHIND aheadSha — aheadSha is "ahead" of HEAD.
      execSync(`git reset --hard ${midSha}`, { cwd: repo, stdio: 'pipe' });
      expect(headSha2(repo)).toBe(midSha);

      const manager = new GitDiffManager();
      const result = await manager.getDiffGroups(repo, aheadSha);
      const committed = result.groups.find((g) => g.scope === 'committed')!;

      // b.txt was introduced only by the now-unreachable aheadSha commit —
      // HEAD never touched it. A raw two-dot `aheadSha..HEAD` diff would
      // report it as a reverse deletion; the merge-base anchor must not.
      expect(committed.files).not.toContain('b.txt');
      expect(committed.files).toEqual([]);
      expect(committed.additions).toBe(0);
      expect(committed.deletions).toBe(0);
      expect(result.committedUnavailable).toBe(false);
    });
  });

  it('two commits with no common ancestor (unrelated histories) → Committed EMPTY and committedUnavailable=true, never the whole tree', async () => {
    await withTempDir('gitdiff-groups-unrelated-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'a.txt', 'a\n', 'base');
      const baseSha = headSha2(repo);

      execSync('git checkout --orphan other', { cwd: repo, stdio: 'pipe' });
      execSync('git rm -rf .', { cwd: repo, stdio: 'pipe' });
      commitFile(repo, 'c.txt', 'c\n', 'orphan commit');

      const manager = new GitDiffManager();
      const result = await manager.getDiffGroups(repo, baseSha);
      const committed = result.groups.find((g) => g.scope === 'committed')!;

      expect(result.committedUnavailable).toBe(true);
      expect(committed.files).toEqual([]);
      expect(committed.additions).toBe(0);
      expect(committed.deletions).toBe(0);
    });
  });

  it('resolvedBase === null → Committed empty + committedUnavailable=true, and staged/unstaged/untracked stay fully populated', async () => {
    await withTempDir('gitdiff-groups-null-base-', async (repo) => {
      initRepoMain(repo);
      commitFile(repo, 'seed.txt', 'seed\n', 'base');
      commitFile(repo, 'other.txt', 'x\n', 'add other');

      // Staged.
      fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\nstaged\n');
      execSync('git add seed.txt', { cwd: repo, stdio: 'pipe' });
      // Unstaged.
      fs.writeFileSync(path.join(repo, 'other.txt'), 'x\ny\n');
      // Untracked.
      fs.writeFileSync(path.join(repo, 'untracked.txt'), 'z\n');

      const manager = new GitDiffManager();
      const result = await manager.getDiffGroups(repo, null);

      expect(result.groups).toHaveLength(4);
      expect(result.groups.map((g) => g.scope).sort()).toEqual([
        'committed', 'staged', 'unstaged', 'untracked',
      ]);

      expect(result.committedUnavailable).toBe(true);
      const committed = result.groups.find((g) => g.scope === 'committed')!;
      expect(committed.files).toEqual([]);
      expect(committed.additions).toBe(0);
      expect(committed.deletions).toBe(0);

      const staged = result.groups.find((g) => g.scope === 'staged')!;
      const unstaged = result.groups.find((g) => g.scope === 'unstaged')!;
      const untracked = result.groups.find((g) => g.scope === 'untracked')!;
      expect(staged.files).toContain('seed.txt');
      expect(unstaged.files).toContain('other.txt');
      expect(untracked.files).toContain('untracked.txt');
    });
  });
});
