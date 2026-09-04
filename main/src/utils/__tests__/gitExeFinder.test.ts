/**
 * Unit tests for gitExeFinder: candidate-table probe order, memoization, and
 * the PATH/where fallbacks. All IO goes through GitFinderDependencies, so no
 * test touches the host filesystem or PATH — the win32 candidate table is
 * exercised via the injected `platform` seam on any host.
 *
 * Every expected path is built with the host's path.join/path.delimiter, the
 * same primitives the finder uses, so the assertions are host-independent.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import {
  clearGitExecutableCache,
  quoteForShellString,
  resolveGitCommand,
  setGitFinderDependenciesForTest,
  type GitFinderDependencies,
} from '../gitExeFinder';

interface DepsOptions {
  platform: NodeJS.Platform;
  shellPath?: string | null;
  pathEnv?: string;
  /** Paths existsSync reports as present. */
  existing?: string[];
  /** Paths that exist but fail the executability check. */
  notExecutable?: string[];
  whereGit?: string | null;
  envRecord?: Record<string, string>;
}

function makeDeps(opts: DepsOptions): GitFinderDependencies & { existsCalls: string[]; accessCalls: string[] } {
  const existsCalls: string[] = [];
  const accessCalls: string[] = [];
  const existing = new Set(opts.existing ?? []);
  const notExecutable = new Set(opts.notExecutable ?? []);
  // Standard Windows environment for the candidate table, so the WIN_* path
  // constants below match what the finder builds. Tests override per-name.
  // Built with the host path.join — the same primitive the finder uses — so
  // the joined candidates match these values on every host.
  const winEnv: Record<string, string> = opts.platform === 'win32'
    ? {
      ProgramFiles: path.join('C:', 'Program Files'),
      'ProgramFiles(x86)': path.join('C:', 'Program Files (x86)'),
      LocalAppData: path.join('C:', 'Users', 'tester', 'AppData', 'Local'),
      USERPROFILE: path.join('C:', 'Users', 'tester'),
      ...(opts.envRecord ?? {}),
    }
    : (opts.envRecord ?? {});
  const deps: GitFinderDependencies = {
    platform: opts.platform,
    existsSync: (p) => {
      existsCalls.push(p);
      return existing.has(p);
    },
    accessSync: (p) => {
      accessCalls.push(p);
      if (notExecutable.has(p)) throw new Error(`EACCES: ${p}`);
    },
    shellPath: () => (opts.shellPath === undefined ? null : opts.shellPath),
    whereGit: () => (opts.whereGit === undefined ? null : opts.whereGit),
    homeDir: () => (opts.platform === 'win32' ? path.join('C:', 'Users', 'tester') : '/home/tester'),
    env: (name) => {
      if (name in winEnv) return winEnv[name];
      if (name === 'PATH') return opts.pathEnv;
      return undefined;
    },
  };
  return Object.assign(deps, { existsCalls, accessCalls });
}

const WIN = path.join('C:', 'Program Files', 'Git', 'cmd', 'git.exe');
const WIN_X86 = path.join('C:', 'Program Files (x86)', 'Git', 'cmd', 'git.exe');
const WIN_LOCAL = path.join('C:', 'Users', 'tester', 'AppData', 'Local', 'Programs', 'Git', 'cmd', 'git.exe');
const WIN_SCOOP = path.join('C:', 'Users', 'tester', 'scoop', 'apps', 'git', 'current', 'cmd', 'git.exe');

afterEach(() => {
  setGitFinderDependenciesForTest(null);
});

describe('resolveGitCommand — win32 candidate table', () => {
  it('probes the candidates in order: ProgramFiles, ProgramFiles(x86), LocalAppData, scoop', () => {
    // ProgramFiles(x86) and scoop both exist: the x86 copy wins on order.
    setGitFinderDependenciesForTest(makeDeps({
      platform: 'win32',
      shellPath: null,
      existing: [WIN_X86, WIN_SCOOP],
    }));
    expect(resolveGitCommand()).toBe(WIN_X86);

    // LocalAppData beats scoop when it is the first existing candidate.
    setGitFinderDependenciesForTest(makeDeps({
      platform: 'win32',
      shellPath: null,
      existing: [WIN_LOCAL, WIN_SCOOP],
    }));
    expect(resolveGitCommand()).toBe(WIN_LOCAL);
  });

  it('honours the environment variables the candidate table is built from', () => {
    const redirectedRoot = 'D:\\GitRoot';
    setGitFinderDependenciesForTest(makeDeps({
      platform: 'win32',
      shellPath: null,
      envRecord: { ProgramFiles: redirectedRoot },
      existing: [path.join(redirectedRoot, 'Git', 'cmd', 'git.exe')],
    }));
    expect(resolveGitCommand()).toBe(path.join(redirectedRoot, 'Git', 'cmd', 'git.exe'));
  });

  it('skips candidates that exist but are not executable', () => {
    setGitFinderDependenciesForTest(makeDeps({
      platform: 'win32',
      shellPath: null,
      existing: [WIN, WIN_LOCAL],
      notExecutable: [WIN],
    }));
    expect(resolveGitCommand()).toBe(WIN_LOCAL);
  });

  it('falls back to whereGit when the table misses, and verifies the result exists', () => {
    const portable = path.join('D:', 'PortableGit', 'cmd', 'git.exe');
    setGitFinderDependenciesForTest(makeDeps({
      platform: 'win32',
      shellPath: null,
      whereGit: portable,
      existing: [portable],
    }));
    expect(resolveGitCommand()).toBe(portable);
  });

  it('ignores a whereGit result that does not exist on disk', () => {
    setGitFinderDependenciesForTest(makeDeps({
      platform: 'win32',
      shellPath: null,
      whereGit: path.join('D:', 'ghost', 'git.exe'),
      existing: [],
    }));
    expect(resolveGitCommand()).toBe('git');
  });

  it('probes the shell PATH first (git.exe), before the candidate table', () => {
    const pathDir = path.join('E:', 'tools');
    const onPath = path.join(pathDir, 'git.exe');
    setGitFinderDependenciesForTest(makeDeps({
      platform: 'win32',
      shellPath: pathDir,
      existing: [onPath, WIN],
    }));
    expect(resolveGitCommand()).toBe(onPath);
  });

  it('degrades to the inherited PATH when shellPath is null', () => {
    const binDir = path.join('E:', 'bin');
    const onPath = path.join(binDir, 'git.exe');
    setGitFinderDependenciesForTest(makeDeps({
      platform: 'win32',
      shellPath: null,
      pathEnv: [binDir, 'C:\\Windows'].join(path.delimiter),
      existing: [onPath],
    }));
    expect(resolveGitCommand()).toBe(onPath);
  });
});

describe('resolveGitCommand — POSIX', () => {
  it('returns the PATH hit when git resolves there', () => {
    const gitInPath = path.join('/usr/bin', 'git');
    setGitFinderDependenciesForTest(makeDeps({
      platform: 'linux',
      shellPath: ['/usr/local/bin', '/usr/bin'].join(path.delimiter),
      existing: [gitInPath],
    }));
    expect(resolveGitCommand()).toBe(gitInPath);
  });

  it('never consults the win32 candidate table or where off win32', () => {
    const deps = makeDeps({
      platform: 'darwin',
      shellPath: ['/usr/bin', '/bin'].join(path.delimiter),
      whereGit: path.join('/should', 'not', 'be', 'consulted'),
    });
    setGitFinderDependenciesForTest(deps);
    expect(resolveGitCommand()).toBe('git');
    // No candidate-shaped or where-shaped probe ever ran: only the two PATH
    // directories were checked for the bare name.
    expect(deps.existsCalls).toEqual([path.join('/usr/bin', 'git'), path.join('/bin', 'git')]);
    expect(deps.accessCalls).toEqual([]);
  });
});

describe('resolveGitCommand — memoization', () => {
  it('caches a successful resolution: the second call does not re-probe', () => {
    const deps = makeDeps({ platform: 'win32', shellPath: null, existing: [WIN] });
    setGitFinderDependenciesForTest(deps);

    expect(resolveGitCommand()).toBe(WIN);
    const probesAfterFirst = deps.existsCalls.length;
    expect(probesAfterFirst).toBeGreaterThan(0);

    expect(resolveGitCommand()).toBe(WIN);
    expect(deps.existsCalls.length).toBe(probesAfterFirst); // cached — no new probes
  });

  it('does not cache the bare fallback: a later call retries', () => {
    const deps = makeDeps({ platform: 'win32', shellPath: null });
    setGitFinderDependenciesForTest(deps);

    expect(resolveGitCommand()).toBe('git');
    const probesAfterFirst = deps.existsCalls.length;
    expect(resolveGitCommand()).toBe('git');
    expect(deps.existsCalls.length).toBeGreaterThan(probesAfterFirst); // re-probed
  });

  it('clearGitExecutableCache forces re-resolution', () => {
    const deps = makeDeps({ platform: 'win32', shellPath: null, existing: [WIN] });
    setGitFinderDependenciesForTest(deps);
    expect(resolveGitCommand()).toBe(WIN);
    const probesAfterFirst = deps.existsCalls.length;

    clearGitExecutableCache();
    expect(resolveGitCommand()).toBe(WIN);
    expect(deps.existsCalls.length).toBeGreaterThan(probesAfterFirst);
  });

  it('setGitFinderDependenciesForTest(null) stops consulting the injected deps', () => {
    // The previous version of this asserted only that the result was a
    // non-empty string, which the bare 'git' fallback guarantees — it could
    // not fail. What matters is that the injected seam is really detached.
    const deps = makeDeps({ platform: 'win32', shellPath: null, existing: [WIN] });
    setGitFinderDependenciesForTest(deps);
    expect(resolveGitCommand()).toBe(WIN);

    setGitFinderDependenciesForTest(null);
    clearGitExecutableCache();
    const probesBefore = deps.existsCalls.length;
    resolveGitCommand();

    expect(deps.existsCalls.length).toBe(probesBefore);
  });
});

describe('quoteForShellString', () => {
  it('quotes only commands containing whitespace', () => {
    expect(quoteForShellString('git')).toBe('git');
    expect(quoteForShellString('/usr/bin/git')).toBe('/usr/bin/git');
    expect(quoteForShellString(path.join('C:', 'Program Files', 'Git', 'cmd', 'git.exe')))
      .toBe(`"${path.join('C:', 'Program Files', 'Git', 'cmd', 'git.exe')}"`);
  });
});
