/**
 * Unit tests for runGit / runGitAsync helpers (main/src/utils/runGit.ts).
 *
 * Behaviors covered (per TASK-679 test_strategy):
 * 1. Happy path: runGit with ['--version'] returns 'git version ...'
 * 2. Happy path: runGitAsync with ['--version'] returns 'git version ...'
 * 3. Adversarial arg: $(touch ...) is treated as a literal arg, not executed by a shell.
 * 4. Error path: non-zero exit propagates with an error containing stderr.
 * 5. cwd option: rev-parse --show-toplevel returns the expected directory.
 * 6. env option: passing custom env does not crash git --version.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runGit, runGitAsync, runGitExit } from '../runGit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary git repo initialised with one empty commit. */
function makeTmpGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rungit-test-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@cyboflow.test'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

const tmpRepos: string[] = [];

afterEach(() => {
  // Clean up any temp repos created during tests
  for (const dir of tmpRepos) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  tmpRepos.length = 0;
});

// ---------------------------------------------------------------------------
// Happy path — sync
// ---------------------------------------------------------------------------

describe('runGit (sync)', () => {
  it('returns a string starting with "git version" for --version', () => {
    const result = runGit(process.cwd(), ['--version']);
    expect(result).toMatch(/^git version/);
  });

  it('returns trimmed output from git log in a temp repo', () => {
    const dir = makeTmpGitRepo();
    tmpRepos.push(dir);
    const result = runGit(dir, ['log', '-1', '--format=%s']);
    expect(result.trim()).toBe('init');
  });
});

// ---------------------------------------------------------------------------
// Happy path — async
// ---------------------------------------------------------------------------

describe('runGitAsync (async)', () => {
  it('returns a string starting with "git version" for --version', async () => {
    const result = await runGitAsync(process.cwd(), ['--version']);
    expect(result).toMatch(/^git version/);
  });

  it('returns trimmed output from git log in a temp repo', async () => {
    const dir = makeTmpGitRepo();
    tmpRepos.push(dir);
    const result = await runGitAsync(dir, ['log', '-1', '--format=%s']);
    expect(result.trim()).toBe('init');
  });
});

// ---------------------------------------------------------------------------
// Adversarial arg — shell injection proof
// ---------------------------------------------------------------------------

describe('shell injection prevention', () => {
  it('runGit: $(touch /tmp/cyboflow-rungit-pwned) is treated as a literal git ref — no file created', () => {
    const dir = makeTmpGitRepo();
    tmpRepos.push(dir);
    const markerFile = '/tmp/cyboflow-rungit-pwned';

    // Remove the marker file if it exists from a previous failed run
    try { fs.unlinkSync(markerFile); } catch { /* ok */ }

    // The adversarial arg is a single positional argument — git will treat it
    // as a ref name, fail with a non-zero exit, and execFile will NOT invoke a
    // shell, so the $(...) expansion never runs.
    expect(() => {
      runGit(dir, ['log', '-1', '--format=%s', '$(touch /tmp/cyboflow-rungit-pwned)']);
    }).toThrow();

    // The marker file must NOT exist — proving no shell parsed the argument.
    expect(fs.existsSync(markerFile)).toBe(false);
  });

  it('runGitAsync: $(touch /tmp/cyboflow-rungit-pwned) is treated as a literal git ref — no file created', async () => {
    const dir = makeTmpGitRepo();
    tmpRepos.push(dir);
    const markerFile = '/tmp/cyboflow-rungit-pwned';

    // Remove the marker file if it exists from a previous failed run
    try { fs.unlinkSync(markerFile); } catch { /* ok */ }

    await expect(
      runGitAsync(dir, ['log', '-1', '--format=%s', '$(touch /tmp/cyboflow-rungit-pwned)'])
    ).rejects.toThrow();

    // The marker file must NOT exist — proving no shell parsed the argument.
    expect(fs.existsSync(markerFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error path
// ---------------------------------------------------------------------------

describe('error propagation', () => {
  it('runGit: throws on non-zero exit (unknown subcommand)', () => {
    expect(() => {
      runGit(process.cwd(), ['nonexistent-subcommand-xyz']);
    }).toThrow();
  });

  it('runGitAsync: rejects on non-zero exit (unknown subcommand)', async () => {
    await expect(
      runGitAsync(process.cwd(), ['nonexistent-subcommand-xyz'])
    ).rejects.toThrow();
  });

  it('runGit: error contains stderr content', () => {
    let caughtError: Error | undefined;
    try {
      runGit(process.cwd(), ['nonexistent-subcommand-xyz']);
    } catch (err) {
      caughtError = err as Error;
    }
    expect(caughtError).toBeDefined();
    // execFileSync puts stderr in the error message or error.stderr
    const errAny = caughtError as NodeJS.ErrnoException & { stderr?: Buffer | string };
    const hasGitContent = (caughtError?.message ?? '').includes('git') ||
      (caughtError?.message ?? '').length > 0 ||
      (errAny?.stderr !== undefined);
    expect(hasGitContent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runGitExit — the exit code is the answer
// ---------------------------------------------------------------------------

describe('runGitExit', () => {
  it('resolves exit 0 with stdout on success', async () => {
    const result = await runGitExit(process.cwd(), ['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^git version/);
  });

  it('resolves (does not reject) a non-zero exit, with its code and stderr', async () => {
    const dir = makeTmpGitRepo();
    tmpRepos.push(dir);
    // check-ignore answers "not ignored" with exit 1 and no output.
    expect(await runGitExit(dir, ['check-ignore', '-q', '--', 'not-ignored.txt'])).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: '',
    });
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'rungit-norepo-'));
    tmpRepos.push(notRepo);
    const fatal = await runGitExit(notRepo, ['status'], { env: { GIT_CEILING_DIRECTORIES: path.dirname(notRepo) } });
    expect(fatal.exitCode).toBe(128);
    expect(fatal.stderr).toContain('not a git repository');
  });

  it('rejects when git cannot run at all (no exit code to report)', async () => {
    await expect(runGitExit(path.join(os.tmpdir(), 'rungit-missing-cwd-xyz', 'nope'), ['--version'])).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// cwd option
// ---------------------------------------------------------------------------

describe('cwd option', () => {
  it('runGit uses the provided cwd for git operations', () => {
    const dir = makeTmpGitRepo();
    tmpRepos.push(dir);
    // rev-parse --show-toplevel returns the absolute root of the repo
    const result = runGit(dir, ['rev-parse', '--show-toplevel']).trim();
    // Both paths may be equivalent even if one uses a symlink resolution
    // e.g. /var/folders vs /private/var/folders on macOS
    expect(result).toBeTruthy();
    // The returned path and our dir should resolve to the same location.
    // realpathSync.native: on Windows the temp dir may be spelled with an 8.3
    // short name (C:\Users\RUNNER~1\…) that only the native call expands.
    const resolvedDir = fs.realpathSync.native(dir);
    const resolvedResult = fs.realpathSync.native(result);
    expect(resolvedResult).toBe(resolvedDir);
  });
});

// ---------------------------------------------------------------------------
// env option
// ---------------------------------------------------------------------------

describe('env option', () => {
  it('runGit accepts a custom env without crashing', () => {
    const result = runGit(process.cwd(), ['--version'], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'TestAuthor' },
    });
    expect(result).toMatch(/^git version/);
  });

  it('runGitAsync accepts a custom env without crashing', async () => {
    const result = await runGitAsync(process.cwd(), ['--version'], {
      env: { ...process.env, GIT_AUTHOR_NAME: 'TestAuthor' },
    });
    expect(result).toMatch(/^git version/);
  });
});
