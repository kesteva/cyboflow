import type { IpcMain } from 'electron';
import * as os from 'os';
import * as path from 'path';
import {
  GIT_DETECT_CHANNEL,
  GIT_SET_IDENTITY_CHANNEL,
  type GitDetectRequest,
  type GitIdentityInput,
  type GitPrerequisiteResult,
} from '../../../shared/types/gitPrerequisite';
import { clearGitExecutableCache, resolveGitCommand } from '../utils/gitExeFinder';
import { runToolCapture } from '../utils/runGit';
import { clearShellPathCache } from '../utils/shellPath';

/**
 * The onboarding git prerequisite probe (`git:detect`) and the identity writer
 * (`git:set-identity`). See shared/types/gitPrerequisite.ts for the contract
 * and why it exists.
 *
 * The probe resolves git through the same ladder every worktree operation
 * uses ({@link resolveGitCommand} → the login-shell PATH, the standard Windows
 * install dirs, `where`), NOT a bare `git --version`: a packaged GUI launch
 * carries the login PATH, not the terminal's, so a bare spawn can miss a git
 * the user's shell finds — and, the other way round, the probe must fail
 * exactly where the worktree job would. `refresh` drops both memoized
 * resolutions first so a "Check again" after installing git is not answered
 * from a cache captured before it existed.
 *
 * Identity is read as the EFFECTIVE config from the user's home directory
 * (global + system + includes), the same view a brand-new project under it
 * gets — not `--global` alone, which would misreport a system-level identity
 * as missing.
 */

/** Test seam: the IO the probe performs. Defaults are the real thing. */
export interface GitPrerequisiteDependencies {
  platform: NodeJS.Platform;
  /** Resolve the git command (absolute path or the bare `git` fallback). */
  resolveGit(): string;
  /** Run git with argv in the user's home dir; rejects on a non-zero exit. */
  runGit(command: string, args: string[]): Promise<string>;
  refreshCaches(): void;
}

function defaultDependencies(): GitPrerequisiteDependencies {
  return {
    platform: process.platform,
    resolveGit: resolveGitCommand,
    runGit: async (command, args) => {
      const { stdout } = await runToolCapture(command, os.homedir(), args, { timeout: 15_000 });
      return stdout;
    },
    refreshCaches: () => {
      clearShellPathCache();
      clearGitExecutableCache();
    },
  };
}

function normalizePlatform(platform: NodeJS.Platform): GitPrerequisiteResult['platform'] {
  if (platform === 'darwin' || platform === 'win32') return platform;
  return 'linux';
}

/** "git version 2.45.2.windows.1" → "2.45.2.windows.1"; null when the shape is unexpected. */
export function parseGitVersion(stdout: string): string | null {
  const match = /git version\s+(\S+)/.exec(stdout);
  return match ? match[1] : null;
}

async function readConfig(deps: GitPrerequisiteDependencies, command: string, key: string): Promise<string | null> {
  try {
    const value = (await deps.runGit(command, ['config', '--get', key])).trim();
    return value.length > 0 ? value : null;
  } catch {
    // `git config --get` exits 1 when the key is unset.
    return null;
  }
}

export async function probeGitPrerequisite(
  request: GitDetectRequest,
  deps: GitPrerequisiteDependencies = defaultDependencies(),
): Promise<GitPrerequisiteResult> {
  if (request.refresh) deps.refreshCaches();
  const platform = normalizePlatform(deps.platform);
  const command = deps.resolveGit();

  let version: string | null = null;
  try {
    version = parseGitVersion(await deps.runGit(command, ['--version']));
  } catch (error) {
    console.warn('[GitPrerequisite] git is not runnable:', error instanceof Error ? error.message : error);
    return {
      platform,
      binary: { found: false, path: null, version: null },
      identity: { name: null, email: null },
      state: 'missing',
    };
  }

  const [name, email] = await Promise.all([
    readConfig(deps, command, 'user.name'),
    readConfig(deps, command, 'user.email'),
  ]);
  return {
    platform,
    binary: { found: true, path: path.isAbsolute(command) ? command : null, version },
    identity: { name, email },
    state: name && email ? 'ready' : 'identity',
  };
}

/** Loose sanity check — git itself accepts anything, this only catches an empty or obviously mistyped field. */
export function validateGitIdentity(input: unknown): { ok: true; value: GitIdentityInput } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Expected { name, email }.' };
  const { name, email } = input as Partial<Record<keyof GitIdentityInput, unknown>>;
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const trimmedEmail = typeof email === 'string' ? email.trim() : '';
  if (trimmedName.length === 0) return { ok: false, error: 'Enter the name git should sign commits with.' };
  if (!/^[^\s@]+@[^\s@]+$/.test(trimmedEmail)) return { ok: false, error: 'Enter a valid email address.' };
  return { ok: true, value: { name: trimmedName, email: trimmedEmail } };
}

/** Writes both fields with `git config --global`, then returns a fresh probe. */
export async function setGitIdentity(
  input: unknown,
  deps: GitPrerequisiteDependencies = defaultDependencies(),
): Promise<{ success: true; data: GitPrerequisiteResult } | { success: false; error: string }> {
  const validated = validateGitIdentity(input);
  if (!validated.ok) return { success: false, error: validated.error };
  const command = deps.resolveGit();
  try {
    await deps.runGit(command, ['config', '--global', 'user.name', validated.value.name]);
    await deps.runGit(command, ['config', '--global', 'user.email', validated.value.email]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[GitPrerequisite] git config --global failed:', message);
    return { success: false, error: `Could not write your git identity: ${message}` };
  }
  return { success: true, data: await probeGitPrerequisite({ refresh: false }, deps) };
}

export function registerGitPrerequisiteHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    GIT_DETECT_CHANNEL,
    async (_event, request: unknown): Promise<{ success: true; data: GitPrerequisiteResult }> => {
      const refresh =
        typeof request === 'object' && request !== null && (request as Partial<GitDetectRequest>).refresh === true;
      return { success: true, data: await probeGitPrerequisite({ refresh }) };
    },
  );
  ipcMain.handle(GIT_SET_IDENTITY_CHANNEL, (_event, input: unknown) => setGitIdentity(input));
}
