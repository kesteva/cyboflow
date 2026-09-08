/**
 * Shell-free git (and adjacent CLI) invocation helpers.
 *
 * Every function here uses Node's execFile (not exec/execSync with a shell), so
 * arguments are passed as positional parameters to the binary and are NEVER
 * parsed by a shell. This eliminates the shell-injection class of bugs that the
 * legacy `execSync(\`git ... ${value}\`)` pattern exposes: repo-controlled data
 * (branch names, remote names, refs) reaches these calls on ordinary dashboard
 * refreshes.
 *
 * Shell-freedom alone does NOT close git's own option-injection surface: a
 * branch literally named `--upload-pack=touch /tmp/pwned` is still a valid argv
 * element that git would parse as an option. Two mechanisms defend that:
 *   - {@link END_OF_OPTIONS} — git's own `--end-of-options` marker (git >= 2.24),
 *     placed after the last real flag so every following argv element is forced
 *     into a value position. Prefer this wherever the subcommand supports it.
 *   - {@link assertNotOptionLike} — a hard reject for values that start with `-`,
 *     for the handful of subcommands that predate `--end-of-options` (notably the
 *     trivial 3-arg `git merge-tree`).
 *
 * Use runGit (sync) when the caller is already synchronous (e.g. inside a
 * non-async function or a pre-existing execSync chain). Prefer runGitAsync
 * for any new code path or any async caller. Use runGitCapture when the caller
 * needs stderr as well as stdout (many git commands report progress on stderr).
 *
 * TASK-698: Removed the dead binary-encoding option from RunGitOptions.
 * runGit/runGitAsync always return string — the Buffer branch was unreachable
 * and zero callers used it. If a future caller needs raw Buffer output,
 * add a separate `runGitBinary` helper rather than re-introducing
 * polymorphism here.
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { getShellPath } from './shellPath';
import { resolveGitCommand } from './gitExeFinder';

const execFileAsyncPromise = promisify(execFile);

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB; safer than execSync's default

/**
 * git's universal "nothing after this is an option" marker (git >= 2.24).
 * Place it after the subcommand's own flags and before any caller-supplied
 * ref/path value. Note that `git rev-parse` only honours it in a mode that
 * consumes a single revision (i.e. together with `--verify`) — in bare
 * rev-parse it is echoed back as if it were a ref.
 */
export const END_OF_OPTIONS = '--end-of-options';

export interface RunGitOptions {
  maxBuffer?: number;
  /**
   * Extra environment for the child. Merged ON TOP of `process.env` + the
   * resolved login-shell PATH, so a caller adding e.g. GIT_AUTHOR_NAME keeps the
   * inherited environment (and can still override PATH deliberately).
   */
  env?: NodeJS.ProcessEnv;
  /** Abort the child process (rejects with an AbortError) when the signal fires. Async variants only. */
  signal?: AbortSignal;
  /** Kill the child process if it runs longer than this many ms. Async variants only. */
  timeout?: number;
}

/** Both output streams of a completed child. */
export interface CommandOutput {
  stdout: string;
  stderr: string;
}

/**
 * Reject a caller-supplied ref/branch/path value that git would parse as an
 * OPTION rather than a value. Only needed where `--end-of-options` is not
 * available; everywhere else prefer the marker, which is enforced by git itself.
 */
export function assertNotOptionLike(value: string, label: string): string {
  if (value.startsWith('-')) {
    throw new Error(
      `Refusing to pass ${label} "${value}" to git: values starting with "-" are parsed as options`,
    );
  }
  return value;
}

/**
 * Build the child environment: inherited process env, with PATH replaced by the
 * user's login-shell PATH.
 *
 * macOS GUI apps (a launched .app, not a terminal child) inherit a minimal PATH,
 * so a plain execFile('git') can miss a Homebrew/nvm/asdf git or the `gh` CLI.
 * `getShellPath()` owns the caching and the config-driven invalidation
 * (configManager clears it when `additionalPaths` changes), so this resolves
 * through it on every call rather than adding a second cache layer that would go
 * stale behind that invalidation. A resolution failure degrades to the inherited
 * PATH rather than failing the git call.
 */
export function buildCommandEnv(override?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  try {
    const shellPath = getShellPath();
    if (shellPath) base.PATH = shellPath;
  } catch (error) {
    console.warn('[runGit] Falling back to inherited PATH; shell PATH resolution failed:', error);
  }
  return override ? { ...base, ...override } : base;
}

export function runGit(cwd: string, args: string[], options: RunGitOptions = {}): string {
  return execFileSync(resolveGitCommand(), args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    env: buildCommandEnv(options.env),
    windowsHide: true,
  });
}

export async function runGitAsync(cwd: string, args: string[], options: RunGitOptions = {}): Promise<string> {
  const { stdout } = await runToolCapture(resolveGitCommand(), cwd, args, options);
  return stdout;
}

/** git twin of {@link runGitAsync} for callers that also need stderr. */
export function runGitCapture(cwd: string, args: string[], options: RunGitOptions = {}): Promise<CommandOutput> {
  return runToolCapture(resolveGitCommand(), cwd, args, options);
}

/**
 * Generic execFile runner used by the runGitAsync/runGitCapture twins (with the
 * git command resolved by gitExeFinder) and for the non-git CLIs that sit
 * alongside these call sites (currently `gh`), so they get the same shell-free
 * argv handling and the same login-shell PATH resolution.
 */
export async function runToolCapture(
  bin: string,
  cwd: string,
  args: string[],
  options: RunGitOptions = {},
): Promise<CommandOutput> {
  const { stdout, stderr } = await execFileAsyncPromise(bin, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    env: buildCommandEnv(options.env),
    signal: options.signal,
    timeout: options.timeout,
    windowsHide: true,
  });
  return { stdout, stderr };
}
