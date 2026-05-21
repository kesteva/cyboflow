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
