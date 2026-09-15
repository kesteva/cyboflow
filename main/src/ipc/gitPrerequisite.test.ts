import { describe, it, expect, vi } from 'vitest';
import {
  parseGitVersion,
  probeGitPrerequisite,
  setGitIdentity,
  validateGitIdentity,
  type GitPrerequisiteDependencies,
} from './gitPrerequisite';

/** A fake git: `config --get <key>` answers from `config`, anything else from `version`. */
function fakeDeps(over: {
  platform?: NodeJS.Platform;
  command?: string;
  version?: string | Error;
  config?: Record<string, string>;
}): GitPrerequisiteDependencies & { calls: string[][]; refreshed: number } {
  const config = { ...(over.config ?? {}) };
  const deps = {
    calls: [] as string[][],
    refreshed: 0,
    platform: over.platform ?? 'darwin',
    resolveGit: () => over.command ?? '/usr/bin/git',
    refreshCaches: () => {
      deps.refreshed++;
    },
    runGit: async (_command: string, args: string[]): Promise<string> => {
      deps.calls.push(args);
      if (args[0] === '--version') {
        if (over.version instanceof Error) throw over.version;
        return over.version ?? 'git version 2.45.2\n';
      }
      if (args[0] === 'config' && args[1] === '--get') {
        const value = config[args[2]];
        if (value === undefined) throw new Error('exit 1');
        return `${value}\n`;
      }
      if (args[0] === 'config' && args[1] === '--global') {
        config[args[2]] = args[3];
        return '';
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
  };
  return deps;
}

describe('parseGitVersion', () => {
  it('extracts the version token, including the Windows suffix', () => {
    expect(parseGitVersion('git version 2.45.2\n')).toBe('2.45.2');
    expect(parseGitVersion('git version 2.47.0.windows.1')).toBe('2.47.0.windows.1');
    expect(parseGitVersion('not git')).toBeNull();
  });
});

describe('probeGitPrerequisite', () => {
  it("reports 'missing' when git cannot run, and never reads config", async () => {
    const deps = fakeDeps({ version: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) });
    const result = await probeGitPrerequisite({ refresh: false }, deps);
    expect(result.state).toBe('missing');
    expect(result.binary).toEqual({ found: false, path: null, version: null });
    expect(deps.calls).toEqual([['--version']]);
  });

  it("reports 'identity' when either half of the identity is unset", async () => {
    const nameOnly = await probeGitPrerequisite({ refresh: false }, fakeDeps({ config: { 'user.name': 'Ada' } }));
    expect(nameOnly.state).toBe('identity');
    expect(nameOnly.identity).toEqual({ name: 'Ada', email: null });

    const emailOnly = await probeGitPrerequisite(
      { refresh: false },
      fakeDeps({ config: { 'user.email': 'ada@example.com' } }),
    );
    expect(emailOnly.state).toBe('identity');
  });

  it("reports 'ready' with the resolved path and version when both are set", async () => {
    const result = await probeGitPrerequisite(
      { refresh: false },
      fakeDeps({ config: { 'user.name': 'Ada', 'user.email': 'ada@example.com' } }),
    );
    expect(result).toEqual({
      platform: 'darwin',
      binary: { found: true, path: '/usr/bin/git', version: '2.45.2' },
      identity: { name: 'Ada', email: 'ada@example.com' },
      state: 'ready',
    });
  });

  it('reports a null path for the bare-name fallback and folds non-mac/win platforms to linux', async () => {
    const result = await probeGitPrerequisite(
      { refresh: false },
      fakeDeps({ platform: 'freebsd', command: 'git', config: { 'user.name': 'A', 'user.email': 'a@b' } }),
    );
    expect(result.platform).toBe('linux');
    expect(result.binary.path).toBeNull();
  });

  it('drops the memoized caches only when asked to refresh', async () => {
    const cold = fakeDeps({});
    await probeGitPrerequisite({ refresh: false }, cold);
    expect(cold.refreshed).toBe(0);
    const warm = fakeDeps({});
    await probeGitPrerequisite({ refresh: true }, warm);
    expect(warm.refreshed).toBe(1);
  });
});

describe('validateGitIdentity', () => {
  it('trims and accepts a name + a plausible email', () => {
    expect(validateGitIdentity({ name: '  Ada ', email: ' ada@example.com ' })).toEqual({
      ok: true,
      value: { name: 'Ada', email: 'ada@example.com' },
    });
  });

  it('rejects an empty name, a malformed email, and a non-object', () => {
    expect(validateGitIdentity({ name: '   ', email: 'ada@example.com' }).ok).toBe(false);
    expect(validateGitIdentity({ name: 'Ada', email: 'ada' }).ok).toBe(false);
    expect(validateGitIdentity({ name: 'Ada', email: 'a da@example.com' }).ok).toBe(false);
    expect(validateGitIdentity(null).ok).toBe(false);
  });
});

describe('setGitIdentity', () => {
  it('writes both fields with --global and returns a fresh ready probe', async () => {
    const deps = fakeDeps({});
    const result = await setGitIdentity({ name: 'Ada', email: 'ada@example.com' }, deps);
    expect(deps.calls).toContainEqual(['config', '--global', 'user.name', 'Ada']);
    expect(deps.calls).toContainEqual(['config', '--global', 'user.email', 'ada@example.com']);
    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({ state: 'ready', identity: { name: 'Ada', email: 'ada@example.com' } }),
    });
  });

  it('refuses invalid input without touching git', async () => {
    const deps = fakeDeps({});
    const result = await setGitIdentity({ name: '', email: 'x' }, deps);
    expect(result.success).toBe(false);
    expect(deps.calls).toEqual([]);
  });

  it('surfaces a git config failure as an error response', async () => {
    const deps = fakeDeps({});
    deps.runGit = vi.fn(async (_c: string, args: string[]) => {
      if (args[1] === '--global') throw new Error('could not lock config file');
      return 'git version 2.45.2';
    });
    const result = await setGitIdentity({ name: 'Ada', email: 'ada@example.com' }, deps);
    expect(result).toEqual({ success: false, error: expect.stringContaining('could not lock config file') });
  });
});
