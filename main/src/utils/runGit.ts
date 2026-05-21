/**
 * Shell-free git invocation helpers.
 *
 * Both functions use Node's execFile (not exec/execSync with a shell), so
 * arguments are passed as positional parameters to the git binary and are
 * NEVER parsed by a shell. This eliminates the shell-injection class of bugs
 * that the legacy `execSync(\`git ... ${value}\`)` pattern exposes.
 *
 * Use runGit (sync) when the caller is already synchronous (e.g. inside a
 * non-async function or a pre-existing execSync chain). Prefer runGitAsync
 * for any new code path or any async caller.
 *
 * TASK-698: Removed the dead binary-encoding option from RunGitOptions.
 * Both functions always return string — the Buffer branch was unreachable
 * and zero callers used it. If a future caller needs raw Buffer output,
 * add a separate `runGitBinary` helper rather than re-introducing
 * polymorphism here.
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsyncPromise = promisify(execFile);

export interface RunGitOptions {
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

export function runGit(cwd: string, args: string[], options: RunGitOptions = {}): string {
  const result = execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024, // 10 MB default; safer than execSync default
    env: options.env,
  });
  return result;
}

export async function runGitAsync(cwd: string, args: string[], options: RunGitOptions = {}): Promise<string> {
  const { stdout } = await execFileAsyncPromise('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    env: options.env,
  });
  return stdout;
}
