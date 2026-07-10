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
