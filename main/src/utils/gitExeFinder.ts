/**
 * Git discovery for GUI launches — the git twin of {@link ./nodeFinder}.
 *
 * A Start-Menu or .app launch does not always carry a PATH that reaches git, so
 * a bare `execFile('git')` fails with ENOENT even though git works in the user's
 * terminal. Returning an ABSOLUTE path is the fix. {@link resolveGitCommand}
 * resolves once, best-first: the shell PATH (`git.exe` on Windows — a
 * suffix-less `git` there is a sh script and a `.cmd` shim hits Node's EINVAL
 * hardening), the standard Windows install locations, `where`/`which`, then the
 * bare name. A success is memoized; a failure is not, so a later call retries
 * after the user installs git. All IO goes through {@link GitFinderDependencies}.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { getShellPath } from './shellPath';

/** Returned when nothing resolvable is found — the spawn will ENOENT as before. */
const GIT_FALLBACK = 'git';

export interface GitFinderDependencies {
  /** Host platform the resolution runs against (process.platform in production). */
  platform: NodeJS.Platform;
  existsSync(path: string): boolean;
  accessSync(path: string, mode: number): void;
  /**
   * The PATH to search, already resolved for the launch context (the enriched
   * shell PATH on macOS GUI launches; null when resolution fails).
   */
  shellPath(): string | null;
  /** Last-ditch `where git`/`which git`; null when it fails. */
  whereGit(): string | null;
  homeDir(): string;
  env(name: string): string | undefined;
}

let cachedGitCommand: string | null = null;
let testDependencies: Partial<GitFinderDependencies> | null = null;

/** Clear the cached resolved git command (tests, or after a git install). */
export function clearGitExecutableCache(): void {
  cachedGitCommand = null;
}

/**
 * Test seam: override individual IO dependencies (merged over the real ones).
 * Null restores production behavior. Clears the memoized cache.
 */
export function setGitFinderDependenciesForTest(deps: Partial<GitFinderDependencies> | null): void {
  testDependencies = deps;
  cachedGitCommand = null;
}

function defaultDependencies(platform: NodeJS.Platform): GitFinderDependencies {
  return {
    platform,
    existsSync: (p) => fs.existsSync(p),
    accessSync: (p, mode) => {
      fs.accessSync(p, mode);
    },
    shellPath: () => {
      try {
        return getShellPath();
      } catch (error) {
        console.warn('[GitExeFinder] shell PATH resolution failed; using the inherited PATH:', error);
        return null;
      }
    },
    whereGit: () => {
      try {
        const command = platform === 'win32' ? 'where git' : 'which git';
        const firstLine = execSync(command, { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
        return firstLine || null;
      } catch {
        return null;
      }
    },
    homeDir: () => os.homedir(),
    env: (name) => process.env[name],
  };
}

function currentDependencies(): GitFinderDependencies {
  // Defaults derive from the injected platform (when a test provides one), so
  // no default dependency reads the host platform behind the seam.
  const platform = testDependencies?.platform ?? process.platform;
  if (!testDependencies) return defaultDependencies(platform);
  return { ...defaultDependencies(platform), ...testDependencies };
}

/** An absolute git path when one is found, the bare `'git'` fallback otherwise. */
export function resolveGitCommand(): string {
  if (cachedGitCommand) {
    return cachedGitCommand;
  }
  const resolved = resolveGitCommandUncached(currentDependencies());
  if (resolved !== GIT_FALLBACK) {
    cachedGitCommand = resolved;
  }
  return resolved;
}

function resolveGitCommandUncached(deps: GitFinderDependencies): string {
  const fromPath = probePathForGit(deps);
  if (fromPath) {
    return fromPath;
  }

  if (deps.platform === 'win32') {
    for (const candidate of windowsGitCandidates(deps)) {
      if (!deps.existsSync(candidate)) continue;
      try {
        deps.accessSync(candidate, fs.constants.X_OK);
        console.log(`[GitExeFinder] Found git at: ${candidate}`);
        return candidate;
      } catch {
        // Exists but not executable — keep searching.
      }
    }

    const viaWhere = deps.whereGit();
    if (viaWhere && deps.existsSync(viaWhere)) {
      console.log(`[GitExeFinder] Found git using where: ${viaWhere}`);
      return viaWhere;
    }
  }

  console.warn(`[GitExeFinder] Could not find git executable, falling back to "${GIT_FALLBACK}"`);
  return GIT_FALLBACK;
}

/** Rung 1 of the ladder in the module header: walk the resolved PATH. */
function probePathForGit(deps: GitFinderDependencies): string | null {
  const searchPath = deps.shellPath() ?? deps.env('PATH') ?? '';
  const directories = searchPath.split(path.delimiter).filter((dir) => dir.length > 0);
  const names = deps.platform === 'win32' ? ['git.exe'] : ['git'];

  for (const dir of directories) {
    for (const name of names) {
      const fullPath = path.join(dir, name);
      if (!deps.existsSync(fullPath)) continue;
      try {
        deps.accessSync(fullPath, fs.constants.X_OK);
        console.log(`[GitExeFinder] Found git in PATH: ${fullPath}`);
        return fullPath;
      } catch {
        // Not executable — keep searching.
      }
    }
  }
  return null;
}

/**
 * Standard Windows install locations, in probe order. `cmd\git.exe` (not
 * `bin\git.exe`) is the copy that runs without its bin/ shims on PATH.
 */
function windowsGitCandidates(deps: GitFinderDependencies): string[] {
  const programFiles = deps.env('ProgramFiles') ?? 'C:\\Program Files';
  const programFilesX86 = deps.env('ProgramFiles(x86)') ?? 'C:\\Program Files (x86)';
  const localAppData = deps.env('LocalAppData') ?? path.join(deps.homeDir(), 'AppData', 'Local');
  const userProfile = deps.env('USERPROFILE') ?? deps.homeDir();
  return [
    path.join(programFiles, 'Git', 'cmd', 'git.exe'),
    path.join(programFilesX86, 'Git', 'cmd', 'git.exe'),
    path.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'),
    path.join(userProfile, 'scoop', 'apps', 'git', 'current', 'cmd', 'git.exe'),
  ];
}

/**
 * Quote a resolved command for a SHELL command string, where argv is not
 * available. Double quotes work in both POSIX sh and cmd.exe; only quoted when
 * needed, so the bare `'git'` fallback interpolates unchanged.
 */
export function quoteForShellString(command: string): string {
  return /\s/.test(command) ? `"${command}"` : command;
}
