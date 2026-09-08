import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// Mock the two IO surfaces: the shell-PATH helpers and the version exec.
vi.mock('./shellPath', () => ({ getShellPath: vi.fn(), findExecutableInPath: vi.fn() }));
vi.mock('child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'child_process';
import { getShellPath, findExecutableInPath } from './shellPath';
import { detectClaudeBinary } from './claudeCodeTest';

const mockExecFile = execFile as unknown as Mock;
const mockGetShellPath = getShellPath as unknown as Mock;
const mockFindExecutableInPath = findExecutableInPath as unknown as Mock;

const ENHANCED_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

/**
 * Drive the (promisified) execFile. The mocked module has no custom-promisify
 * symbol, so util.promisify wraps it generically: cb(err, value) → the promise
 * resolves `value`. Resolving `{ stdout, stderr }` therefore mirrors the shape
 * the real custom-promisified execFile hands back.
 */
function versionProbeReturns(error: Error | null, stdout = '1.2.3\n'): void {
  mockExecFile.mockImplementation(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (e: Error | null, out?: { stdout: string; stderr: string }) => void,
    ) => {
      cb(error, error ? undefined : { stdout, stderr: '' });
    },
  );
}

describe('detectClaudeBinary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetShellPath.mockReturnValue(ENHANCED_PATH);
    mockFindExecutableInPath.mockReturnValue('/opt/homebrew/bin/claude');
  });

  it('resolves via shell PATH and runs the version probe under the enhanced PATH', async () => {
    versionProbeReturns(null);

    const result = await detectClaudeBinary();

    expect(result).toEqual({ found: true, path: '/opt/homebrew/bin/claude', version: '1.2.3' });
    // The env passed to the probe must carry the SAME enhanced PATH used for
    // resolution — packaged apps' restricted PATH otherwise breaks the exec.
    expect(mockExecFile).toHaveBeenCalledWith(
      '/opt/homebrew/bin/claude',
      ['--version'],
      expect.objectContaining({
        timeout: 5_000,
        env: expect.objectContaining({ PATH: ENHANCED_PATH }),
      }),
      expect.any(Function),
    );
  });

  it('a configured path wins over PATH resolution but still probes under the enhanced PATH', async () => {
    versionProbeReturns(null);

    const result = await detectClaudeBinary('/custom/bin/claude');

    expect(result).toEqual({ found: true, path: '/custom/bin/claude', version: '1.2.3' });
    expect(mockFindExecutableInPath).not.toHaveBeenCalled();
    const [, , opts] = mockExecFile.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(opts.env.PATH).toBe(ENHANCED_PATH);
  });

  it('a blank configured path falls through to PATH resolution', async () => {
    versionProbeReturns(null);

    const result = await detectClaudeBinary('   ');

    expect(mockFindExecutableInPath).toHaveBeenCalledWith('claude');
    expect(result.path).toBe('/opt/homebrew/bin/claude');
  });

  it('reports not-found when the version probe fails', async () => {
    versionProbeReturns(new Error('spawn ENOENT'));

    expect(await detectClaudeBinary()).toEqual({ found: false, path: null, version: null });
  });

  it('reports not-found without probing when no binary resolves', async () => {
    mockFindExecutableInPath.mockReturnValue(null);

    expect(await detectClaudeBinary()).toEqual({ found: false, path: null, version: null });
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe('detectClaudeBinary — Windows .cmd shims', () => {
  const NPM_SHIM = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd';
  const SIBLING_EXE = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.exe';

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetShellPath.mockReturnValue(ENHANCED_PATH);
    mockFindExecutableInPath.mockReturnValue(NPM_SHIM);
  });

  it('probes a .cmd shim through the sibling native .exe when present', async () => {
    versionProbeReturns(null, '2.0.19\n');

    const result = await detectClaudeBinary(undefined, {
      platform: 'win32',
      fileExists: (p) => p === SIBLING_EXE,
    });

    expect(result).toEqual({ found: true, path: NPM_SHIM, version: '2.0.19' });
    expect(mockExecFile).toHaveBeenCalledWith(
      SIBLING_EXE,
      ['--version'],
      expect.objectContaining({ env: expect.objectContaining({ PATH: ENHANCED_PATH }) }),
      expect.any(Function),
    );
  });

  it('wraps a .cmd shim in cmd.exe /d /s /c when no sibling exists', async () => {
    versionProbeReturns(null, '2.0.19\n');

    const result = await detectClaudeBinary(undefined, {
      platform: 'win32',
      fileExists: () => false,
    });

    expect(result).toEqual({ found: true, path: NPM_SHIM, version: '2.0.19' });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [command, args, opts] = mockExecFile.mock.calls[0] as [string, string[], Record<string, unknown>];
    // This site owns the hand-off to execFile: the shim plan arrives with its
    // verbatim flag and names the shim. The exact /c string is pinned once, in
    // win32ShimProbe's suite.
    expect(command).toBe(process.env.comspec || 'cmd.exe');
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(args[3]).toContain(NPM_SHIM);
    expect(opts.windowsVerbatimArguments).toBe(true);
  });

  it('falls through to the cmd.exe wrapper when the sibling .exe probe fails', async () => {
    mockExecFile
      .mockImplementationOnce(
        (
          _file: string,
          _args: string[],
          _opts: unknown,
          cb: (e: Error | null) => void,
        ) => cb(new Error('spawn EINVAL')),
      )
      .mockImplementationOnce(
        (
          _file: string,
          _args: string[],
          _opts: unknown,
          cb: (e: Error | null, out?: { stdout: string; stderr: string }) => void,
        ) => cb(null, { stdout: '2.0.19\n', stderr: '' }),
      );

    const result = await detectClaudeBinary(undefined, {
      platform: 'win32',
      fileExists: () => true,
    });

    expect(result).toEqual({ found: true, path: NPM_SHIM, version: '2.0.19' });
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it('reports not-found when every shim plan fails (unchanged failure semantics)', async () => {
    versionProbeReturns(new Error("'claude' is not recognized as an internal or external command"));

    const result = await detectClaudeBinary(undefined, {
      platform: 'win32',
      fileExists: () => false,
    });

    expect(result).toEqual({ found: false, path: null, version: null });
  });

  it('keeps probing a .cmd path directly off win32 (POSIX unchanged)', async () => {
    mockFindExecutableInPath.mockReturnValue('/opt/cmd-shim/claude.cmd');
    versionProbeReturns(null, '2.0.19\n');

    const result = await detectClaudeBinary(undefined, { platform: 'darwin' });

    expect(result).toEqual({ found: true, path: '/opt/cmd-shim/claude.cmd', version: '2.0.19' });
    expect(mockExecFile).toHaveBeenCalledWith(
      '/opt/cmd-shim/claude.cmd',
      ['--version'],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('a configured .cmd path is shim-probed too', async () => {
    versionProbeReturns(null, '2.0.19\n');

    const result = await detectClaudeBinary('C:\\custom\\bin\\claude.CMD', {
      platform: 'win32',
      fileExists: () => false,
    });

    expect(result.found).toBe(true);
    expect(result.path).toBe('C:\\custom\\bin\\claude.CMD');
    const [command] = mockExecFile.mock.calls[0] as [string];
    expect(command).toBe(process.env.comspec || 'cmd.exe');
    expect(mockFindExecutableInPath).not.toHaveBeenCalled();
  });
});
