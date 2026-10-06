import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OmpPtyManager } from '../ompPtyManager';
import type { CliVersionProbeResult } from '../../cli/cliVersionProbe';
import type { SessionManager } from '../../../sessionManager';
import type { Logger } from '../../../../utils/logger';
import { OMP_MIN_SUPPORTED_VERSION, OMP_TESTED_VERSION } from '../ompVersions';

const findExecutableInPath = vi.fn<(executable: string) => string | null>();

vi.mock('../../../../utils/shellPath', () => ({
  getShellPath: () => '/usr/bin:/bin',
  findExecutableInPath: (executable: string) => findExecutableInPath(executable),
}));

// Keep the spawn-environment assertions hermetic: the real resolver probes the
// filesystem and can shell out looking for a Node install.
vi.mock('../../../../utils/nodeFinder', () => ({
  findNodeExecutable: () => Promise.resolve('/usr/bin/node'),
  findCliNodeScript: () => null,
  testNodeExecutable: () => Promise.resolve(true),
  clearNodeExecutableCache: () => undefined,
}));

const NODE_FALLBACK_FLAG = 'ompNeedsNodeFallback';

class AvailabilityOmpPtyManager extends OmpPtyManager {
  readonly probedPaths: string[] = [];
  readonly probeResults = new Map<string, CliVersionProbeResult | Error>();
  readonly warnings: string[] = [];

  protected override async probeVersion(executablePath: string): Promise<CliVersionProbeResult> {
    this.probedPaths.push(executablePath);
    const stub = this.probeResults.get(executablePath);
    if (!stub) throw new Error(`no probe stub for ${executablePath}`);
    if (stub instanceof Error) throw stub;
    return stub;
  }

  constructor(sessionManager: SessionManager) {
    super(sessionManager, {
      verbose: () => undefined,
      info: () => undefined,
      warn: (message: string) => {
        this.warnings.push(message);
      },
      error: () => undefined,
    } as unknown as Logger);
  }

  callTestCliAvailability(customPath?: string) {
    return this.testCliAvailability(customPath);
  }

  callGetCliNotAvailableMessage(error?: string): string {
    return this.getCliNotAvailableMessage(error);
  }
}

function makeManager(): AvailabilityOmpPtyManager {
  return new AvailabilityOmpPtyManager({
    getDbSession: () => ({ agent_permission_mode: 'default' }),
  } as unknown as SessionManager);
}

beforeEach(() => {
  findExecutableInPath.mockReset();
  delete (global as typeof global & Record<string, boolean>)[NODE_FALLBACK_FLAG];
});

afterEach(() => {
  delete (global as typeof global & Record<string, boolean>)[NODE_FALLBACK_FLAG];
});

describe('OmpPtyManager.testCliAvailability', () => {
  it('resolves via PATH — there is no bundled binary in v1', async () => {
    const manager = makeManager();
    findExecutableInPath.mockReturnValue('/Users/dev/.local/bin/omp');
    manager.probeResults.set('/Users/dev/.local/bin/omp', {
      version: 'omp/17.3.2',
      usedNodeFallback: false,
    });

    const availability = await manager.callTestCliAvailability();

    expect(availability).toEqual({
      available: true,
      version: 'omp/17.3.2',
      path: '/Users/dev/.local/bin/omp',
    });
  });

  it('honours an explicit custom path over PATH discovery', async () => {
    const manager = makeManager();
    manager.probeResults.set('/custom/omp', { version: 'omp/17.3.2', usedNodeFallback: false });

    const availability = await manager.callTestCliAvailability('/custom/omp');

    expect(availability.path).toBe('/custom/omp');
    expect(manager.probedPaths).toEqual(['/custom/omp']);
    expect(findExecutableInPath).not.toHaveBeenCalled();
  });

  it('reports "not found" when omp is nowhere on PATH', async () => {
    const manager = makeManager();
    findExecutableInPath.mockReturnValue(null);

    expect(await manager.callTestCliAvailability()).toEqual({
      available: false,
      error: 'omp executable not found in PATH',
    });
  });

  it('refuses a binary below the version floor, but still reports the version', async () => {
    const manager = makeManager();
    findExecutableInPath.mockReturnValue('/Users/dev/.local/bin/omp');
    manager.probeResults.set('/Users/dev/.local/bin/omp', { version: 'omp/17.2.9', usedNodeFallback: false });

    const availability = await manager.callTestCliAvailability();

    expect(availability.available).toBe(false);
    expect(availability.version).toBe('omp/17.2.9');
    expect(availability.error).toContain(OMP_MIN_SUPPORTED_VERSION);
  });

  it('accepts a version newer than tested, and logs a warning rather than refusing', async () => {
    const manager = makeManager();
    findExecutableInPath.mockReturnValue('/Users/dev/.local/bin/omp');
    manager.probeResults.set('/Users/dev/.local/bin/omp', { version: 'omp/99.0.0', usedNodeFallback: false });

    const availability = await manager.callTestCliAvailability();

    expect(availability).toEqual({
      available: true,
      version: 'omp/99.0.0',
      path: '/Users/dev/.local/bin/omp',
    });
    expect(manager.warnings.some((w) => w.includes(OMP_TESTED_VERSION))).toBe(true);
  });

  it('pins the Node fallback when a PATH shim only answers through Node', async () => {
    const manager = makeManager();
    findExecutableInPath.mockReturnValue('/Users/dev/.local/bin/omp');
    manager.probeResults.set('/Users/dev/.local/bin/omp', { version: 'omp/17.3.2', usedNodeFallback: true });

    const availability = await manager.callTestCliAvailability();

    expect(availability.available).toBe(true);
    expect((global as typeof global & Record<string, boolean>)[NODE_FALLBACK_FLAG]).toBe(true);
  });

  it('reports unavailable when --version fails outright', async () => {
    const manager = makeManager();
    findExecutableInPath.mockReturnValue('/Users/dev/.local/bin/omp');
    manager.probeResults.set('/Users/dev/.local/bin/omp', new Error('spawn EACCES'));

    const availability = await manager.callTestCliAvailability();

    expect(availability.available).toBe(false);
    expect(availability.error).toContain('spawn EACCES');
  });
});

describe('OmpPtyManager.getCliNotAvailableMessage', () => {
  it('diagnoses a missing shebang interpreter instead of telling the user to reinstall', () => {
    const message = makeManager().callGetCliNotAvailableMessage(
      'Failed to run "/Users/dev/.local/bin/omp --version": Command failed\nenv: node: No such file or directory',
    );

    expect(message).toContain('OMP WAS found');
    expect(message).toContain('interpreter "node" is not on the spawn PATH');
    expect(message).not.toContain('Install OMP with');
  });

  it('gives an upgrade instruction (not an install instruction) for a too-old binary', () => {
    const message = makeManager().callGetCliNotAvailableMessage(
      `omp 17.2.0 is older than the minimum supported version ${OMP_MIN_SUPPORTED_VERSION}`,
    );

    expect(message).toContain('too old');
    expect(message).toContain('brew upgrade can1357/tap/omp');
  });

  it('keeps the install instruction for an ordinary missing CLI', () => {
    const message = makeManager().callGetCliNotAvailableMessage('omp executable not found in PATH');

    expect(message).toContain('curl -fsSL https://omp.sh/install | sh');
    expect(message).toContain('brew install can1357/tap/omp');
  });
});
