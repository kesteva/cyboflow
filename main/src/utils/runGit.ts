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
 */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsyncPromise = promisify(execFile);

export interface RunGitOptions {
  encoding?: 'utf8' | 'buffer';
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

export function runGit(cwd: string, args: string[], options: RunGitOptions = {}): string {
  const encoding = options.encoding ?? 'utf8';
  const result = execFileSync('git', args, {
    cwd,
    encoding: encoding as BufferEncoding,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024, // 10 MB default; safer than execSync default
    env: options.env,
  });
  // execFileSync returns Buffer when encoding === 'buffer', else string.
  // We type the public surface as string for the common case; callers needing
  // Buffer can cast (rare).
  return typeof result === 'string' ? result : (result as Buffer).toString('utf8');
}

export async function runGitAsync(cwd: string, args: string[], options: RunGitOptions = {}): Promise<string> {
  const { stdout } = await execFileAsyncPromise('git', args, {
    cwd,
    encoding: (options.encoding ?? 'utf8') as BufferEncoding,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    env: options.env,
  });
  return typeof stdout === 'string' ? stdout : (stdout as Buffer).toString('utf8');
}
