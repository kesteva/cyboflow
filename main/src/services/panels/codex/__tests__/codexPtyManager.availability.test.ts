import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { CodexPtyManager } from '../codexPtyManager';
import type { ResolvedCodexExecutable } from '../codexExecutablePath';
import type { CliVersionProbeResult } from '../../cli/cliVersionProbe';
import type { SessionManager } from '../../../sessionManager';

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
  findClaudeCodeScript: () => null,
  testNodeExecutable: () => Promise.resolve(true),
  clearNodeExecutableCache: () => undefined,
}));

const BUNDLED: ResolvedCodexExecutable = {
  executablePath: '/Applications/Cyboflow.app/Contents/Resources/app.asar.unpacked/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
  pathDir: '/Applications/Cyboflow.app/Contents/Resources/app.asar.unpacked/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex-path',
  version: '0.144.3',
  target: 'aarch64-apple-darwin',
};

const NODE_FALLBACK_FLAG = 'codexNeedsNodeFallback';

class AvailabilityCodexPtyManager extends CodexPtyManager {
  bundled: ResolvedCodexExecutable | null = null;
  readonly probedPaths: string[] = [];
  readonly probeResults = new Map<string, CliVersionProbeResult | Error>();

  protected override resolveBundledExecutable(): ResolvedCodexExecutable | null {
    return this.bundled;
  }

  protected override async probeVersion(executablePath: string): Promise<CliVersionProbeResult> {
    this.probedPaths.push(executablePath);
    const stub = this.probeResults.get(executablePath);
    if (!stub) throw new Error(`no probe stub for ${executablePath}`);
    if (stub instanceof Error) throw stub;
    return stub;
  }

  callTestCliAvailability(customPath?: string) {
    return this.testCliAvailability(customPath);
  }

  callGetCliNotAvailableMessage(error?: string): string {
    return this.getCliNotAvailableMessage(error);
  }

  callGetSystemEnvironment(): Promise<{ [key: string]: string }> {
    return this.getSystemEnvironment();
  }
}

function makeManager(): AvailabilityCodexPtyManager {
  return new AvailabilityCodexPtyManager({
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

describe('CodexPtyManager.testCliAvailability', () => {
  it('prefers the bundled Codex binary over anything on PATH', async () => {
    const manager = makeManager();
    manager.bundled = BUNDLED;
    manager.probeResults.set(BUNDLED.executablePath, {
      version: 'codex-cli 0.144.3',
      usedNodeFallback: false,
    });

    const availability = await manager.callTestCliAvailability();

    expect(availability).toEqual({
      available: true,
      version: 'codex-cli 0.144.3',
      path: BUNDLED.executablePath,
    });
    // The PATH hunt is the regression under test: the bundled binary is native
    // per-arch, so a user's broken npm shim must never be consulted.
    expect(findExecutableInPath).not.toHaveBeenCalled();
  });

  it('puts the bundled codex-path directory on the spawn PATH', async () => {
    const manager = makeManager();
    manager.bundled = BUNDLED;
    manager.probeResults.set(BUNDLED.executablePath, {
      version: 'codex-cli 0.144.3',
      usedNodeFallback: false,
    });

    await manager.callTestCliAvailability();
    const environment = await manager.callGetSystemEnvironment();

    // The spawn PATH is joined with path.delimiter (':' on POSIX, ';' on win32).
    expect(environment.PATH.split(path.delimiter)[0]).toBe(BUNDLED.pathDir);
  });

  it('falls back to PATH when this tree ships no bundled binary', async () => {
    const manager = makeManager();
    manager.bundled = null;
    findExecutableInPath.mockReturnValue('/Users/dev/.local/bin/codex');
    manager.probeResults.set('/Users/dev/.local/bin/codex', {
      version: '0.140.0',
      usedNodeFallback: false,
    });

    const availability = await manager.callTestCliAvailability();

    expect(availability).toEqual({
      available: true,
      version: '0.140.0',
      path: '/Users/dev/.local/bin/codex',
    });
    expect((global as typeof global & Record<string, boolean>)[NODE_FALLBACK_FLAG]).toBeUndefined();
  });

  it('falls back to PATH when the bundled binary fails its probe', async () => {
    const manager = makeManager();
    manager.bundled = BUNDLED;
    manager.probeResults.set(BUNDLED.executablePath, new Error('bad bundle'));
    findExecutableInPath.mockReturnValue('/opt/homebrew/bin/codex');
    manager.probeResults.set('/opt/homebrew/bin/codex', {
      version: '0.145.0',
      usedNodeFallback: false,
    });

    const availability = await manager.callTestCliAvailability();

    expect(availability.path).toBe('/opt/homebrew/bin/codex');
    // A broken bundle must not leave its codex-path on the spawn PATH.
    const environment = await manager.callGetSystemEnvironment();
    expect(environment.PATH.split(':')).not.toContain(BUNDLED.pathDir);
  });

  it('pins the Node fallback when a PATH shim only answers through Node', async () => {
    const manager = makeManager();
    manager.bundled = null;
    findExecutableInPath.mockReturnValue('/Users/dev/.local/bin/codex');
    manager.probeResults.set('/Users/dev/.local/bin/codex', {
      version: '0.140.0',
      usedNodeFallback: true,
    });

    const availability = await manager.callTestCliAvailability();

    expect(availability.available).toBe(true);
    // node-pty cannot observe a shebang failure in its forked child, so the
    // spawn must be told up front to invoke Node explicitly.
    expect((global as typeof global & Record<string, boolean>)[NODE_FALLBACK_FLAG]).toBe(true);
  });

  it('honours an explicit custom path over the bundled binary', async () => {
    const manager = makeManager();
    manager.bundled = BUNDLED;
    manager.probeResults.set('/custom/codex', { version: '9.9.9', usedNodeFallback: false });

    const availability = await manager.callTestCliAvailability('/custom/codex');

    expect(availability.path).toBe('/custom/codex');
    expect(manager.probedPaths).toEqual(['/custom/codex']);
  });

  it('reports "not found" when neither the bundle nor PATH has Codex', async () => {
    const manager = makeManager();
    manager.bundled = null;
    findExecutableInPath.mockReturnValue(null);

    expect(await manager.callTestCliAvailability()).toEqual({
      available: false,
      error: 'codex executable not found in PATH',
    });
  });
});

describe('CodexPtyManager.getCliNotAvailableMessage', () => {
  it('diagnoses a missing shebang interpreter instead of telling the user to reinstall', () => {
    const message = makeManager().callGetCliNotAvailableMessage(
      'Failed to run "/Users/dev/.local/bin/codex --version": Command failed\nenv: node: No such file or directory',
    );

    expect(message).toContain('Codex WAS found');
    expect(message).toContain('interpreter "node" is not on the spawn PATH');
    expect(message).not.toContain('Install and sign in to Codex');
  });

  it('keeps the install instruction for an ordinary missing CLI', () => {
    const message = makeManager().callGetCliNotAvailableMessage('codex executable not found in PATH');

    expect(message).toContain('Install and sign in to Codex');
  });
});
