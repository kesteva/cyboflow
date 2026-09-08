import { describe, expect, it, vi } from 'vitest';
import { describeMissingInterpreter, probeCliVersion } from '../cliVersionProbe';

const MISSING_NODE = 'Command failed: /Users/dev/.local/bin/codex --version\nenv: node: No such file or directory\n';

describe('describeMissingInterpreter', () => {
  it('extracts the interpreter from a shebang failure', () => {
    expect(describeMissingInterpreter(MISSING_NODE)).toBe('node');
    expect(describeMissingInterpreter('env: python3: No such file or directory')).toBe('python3');
  });

  it('returns null for unrelated failures', () => {
    expect(describeMissingInterpreter(undefined)).toBeNull();
    expect(describeMissingInterpreter('spawn ENOENT')).toBeNull();
    expect(describeMissingInterpreter('Command failed: codex --version\nnot logged in')).toBeNull();
  });
});

describe('probeCliVersion', () => {
  it('returns the direct version without a Node fallback', async () => {
    const runCommand = vi.fn().mockReturnValue('codex-cli 0.144.3\n');

    const result = await probeCliVersion('/opt/codex/bin/codex', { PATH: '/opt/codex/bin' }, {
      runCommand,
      resolveNodeScript: () => null,
      resolveNodeExecutable: () => Promise.resolve('/usr/bin/node'),
    });

    expect(result).toEqual({ version: 'codex-cli 0.144.3', usedNodeFallback: false });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith('/opt/codex/bin/codex', ['--version'], {
      PATH: '/opt/codex/bin',
    });
  });

  it('retries an npm shim through Node when its shebang interpreter is missing', async () => {
    const runCommand = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error(MISSING_NODE);
      })
      .mockReturnValue('0.144.3\n');

    const result = await probeCliVersion('/Users/dev/.local/bin/codex', { PATH: '/usr/bin' }, {
      runCommand,
      resolveNodeScript: () => '/Users/dev/.local/lib/codex/index.js',
      resolveNodeExecutable: () => Promise.resolve('/Users/dev/.nvm/versions/node/v22.3.0/bin/node'),
    });

    expect(result).toEqual({ version: '0.144.3', usedNodeFallback: true });
    expect(runCommand).toHaveBeenLastCalledWith(
      '/Users/dev/.nvm/versions/node/v22.3.0/bin/node',
      ['--no-warnings', '--enable-source-maps', '/Users/dev/.local/lib/codex/index.js', '--version'],
      { PATH: '/usr/bin' },
    );
  });

  it('runs the Electron binary as plain Node when that is the only interpreter', async () => {
    const runCommand = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error(MISSING_NODE);
      })
      .mockReturnValue('1.0.0');

    const result = await probeCliVersion('/Users/dev/.local/bin/claude', { PATH: '/usr/bin' }, {
      runCommand,
      resolveNodeScript: () => null,
      resolveNodeExecutable: () => Promise.resolve('/Applications/Cyboflow.app/Contents/MacOS/Cyboflow'),
      execPath: '/Applications/Cyboflow.app/Contents/MacOS/Cyboflow',
    });

    expect(result.usedNodeFallback).toBe(true);
    expect(runCommand).toHaveBeenLastCalledWith(
      '/Applications/Cyboflow.app/Contents/MacOS/Cyboflow',
      ['/Users/dev/.local/bin/claude', '--version'],
      { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' },
    );
  });

  it('rethrows failures that are not a missing interpreter without retrying', async () => {
    const runCommand = vi.fn().mockImplementation(() => {
      throw new Error('Command failed: codex --version\nnot logged in');
    });

    await expect(
      probeCliVersion('/opt/codex/bin/codex', {}, {
        runCommand,
        resolveNodeScript: () => null,
        resolveNodeExecutable: () => Promise.resolve('/usr/bin/node'),
      }),
    ).rejects.toThrow('not logged in');
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('reports both failures when the Node fallback also fails', async () => {
    const runCommand = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error(MISSING_NODE);
      })
      .mockImplementationOnce(() => {
        throw new Error('spawn EACCES');
      });

    await expect(
      probeCliVersion('/Users/dev/.local/bin/codex', {}, {
        runCommand,
        resolveNodeScript: () => null,
        resolveNodeExecutable: () => Promise.resolve('/usr/bin/node'),
      }),
    ).rejects.toThrow(/env: node: No such file or directory[\s\S]*Node fallback via \/usr\/bin\/node also failed: spawn EACCES/);
  });
});

describe('probeCliVersion — Windows .cmd shims', () => {
  const NPM_SHIM = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd';
  const SIBLING_EXE = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.exe';

  function einval(): Error {
    const error = new Error('spawn EINVAL');
    (error as NodeJS.ErrnoException).code = 'EINVAL';
    return error;
  }

  it('probes the sibling native .exe shell-less when one sits next to the shim', async () => {
    const runCommand = vi.fn().mockReturnValue('1.2.3 (Claude Code)\n');

    const result = await probeCliVersion(NPM_SHIM, { PATH: 'C:\\npm' }, {
      runCommand,
      platform: 'win32',
      fileExists: (p) => p === SIBLING_EXE,
      resolveNodeScript: () => null,
      resolveNodeExecutable: () => Promise.resolve('C:\\Program Files\\nodejs\\node.exe'),
    });

    expect(result).toEqual({ version: '1.2.3 (Claude Code)', usedNodeFallback: false });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(SIBLING_EXE, ['--version'], { PATH: 'C:\\npm' });
  });

  it('spawns the shim through cmd.exe /d /s /c with verbatim quoting when no sibling exists', async () => {
    const runCommand = vi.fn().mockReturnValue('1.2.3\n');

    const result = await probeCliVersion('C:\\Users\\dev\\npm\\claude.cmd', { PATH: 'C:\\npm' }, {
      runCommand,
      platform: 'win32',
      fileExists: () => false,
    });

    expect(result).toEqual({ version: '1.2.3', usedNodeFallback: false });
    expect(runCommand).toHaveBeenCalledTimes(1);
    const [command, args, env, options] = runCommand.mock.calls[0] as [
      string, string[], NodeJS.ProcessEnv, { windowsVerbatimArguments?: boolean },
    ];
    // What this site owns is that the plan reaches the runCommand seam intact,
    // verbatim flag and all, and that it targets the shim it was given. The
    // exact /c string is pinned once, in win32ShimProbe's suite.
    expect(command).toBe(process.env.comspec || 'cmd.exe');
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(args[3]).toContain('claude.cmd');
    expect(options).toEqual({ windowsVerbatimArguments: true });
    expect(env).toEqual({ PATH: 'C:\\npm' });
  });

  it('tries the sibling .exe first and falls back to the cmd.exe wrapper when it fails', async () => {
    const runCommand = vi
      .fn()
      .mockImplementationOnce(() => {
        throw einval();
      })
      .mockReturnValue('1.2.3\n');

    const result = await probeCliVersion(NPM_SHIM, {}, {
      runCommand,
      platform: 'win32',
      fileExists: () => true,
    });

    expect(result.usedNodeFallback).toBe(false);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand).toHaveBeenLastCalledWith(
      process.env.comspec || 'cmd.exe',
      expect.arrayContaining(['/d', '/s', '/c']),
      {},
      { windowsVerbatimArguments: true },
    );
  });

  it('a failed shim probe is a clean combined error and never enters the Node fallback', async () => {
    const runCommand = vi.fn().mockImplementation(() => {
      throw new Error("'claude' is not recognized as an internal or external command");
    });
    const resolveNodeExecutable = vi.fn(() => Promise.resolve('C:\\node\\node.exe'));

    await expect(
      probeCliVersion('C:\\npm\\claude.cmd', {}, {
        runCommand,
        platform: 'win32',
        fileExists: () => false,
        resolveNodeScript: () => null,
        resolveNodeExecutable,
      }),
    ).rejects.toThrow(/Windows shim probe of "C:\\npm\\claude\.cmd" failed.*not recognized/s);
    expect(resolveNodeExecutable).not.toHaveBeenCalled();
  });

  it('does not wrap a native .exe in cmd.exe on win32', async () => {
    const runCommand = vi.fn().mockReturnValue('1.2.3\n');

    await probeCliVersion('C:\\npm\\claude.exe', {}, {
      runCommand,
      platform: 'win32',
      fileExists: () => false,
    });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith('C:\\npm\\claude.exe', ['--version'], {});
  });

  it('keeps macOS byte-identical: a .cmd path on darwin is probed directly', async () => {
    const runCommand = vi.fn().mockReturnValue('1.2.3\n');

    await probeCliVersion('/opt/cmd-shim/claude.cmd', { PATH: '/usr/bin' }, {
      runCommand,
      platform: 'darwin',
      fileExists: () => true,
    });

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith('/opt/cmd-shim/claude.cmd', ['--version'], { PATH: '/usr/bin' });
  });

  it('maps a residual EINVAL on a non-shim path to a clean probe failure', async () => {
    const runCommand = vi.fn().mockImplementation(() => {
      throw einval();
    });
    const resolveNodeExecutable = vi.fn(() => Promise.resolve('C:\\node\\node.exe'));

    await expect(
      probeCliVersion('C:\\tools\\claude', {}, {
        runCommand,
        platform: 'win32',
        resolveNodeScript: () => null,
        resolveNodeExecutable,
      }),
    ).rejects.toThrow(/failed with EINVAL \(shell-less spawn refused\)/);
    expect(resolveNodeExecutable).not.toHaveBeenCalled();
  });
});
