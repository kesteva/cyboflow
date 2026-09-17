/**
 * XcodeToolchainBackend unit tests.
 *
 * NO real Apple toolchain runs: a FAKE {@link AppleCliExec} is injected and
 * every `xcodebuild` / `xcrun simctl` / `which` / `maestro` invocation is
 * canned. The `simctl list -j` fixture is realistic on the two points that
 * actually bite:
 *  - it carries an UNAVAILABLE runtime (iOS 18.0, `isAvailable: false`) that
 *    must be ignored even though it parses fine, and
 *  - its flat `devicetypes` list still contains `iPhone-6s-Plus`, which a naive
 *    newest-first pick would choose and `simctl create` would reject with
 *    `Incompatible device`. Only the runtime's own `supportedDeviceTypes` gives
 *    the right answer.
 *
 * The three-way verdict is the thing under test: `absent` only ever on an
 * AFFIRMATIVE no, `inconclusive` whenever a probe could not answer.
 */
import { describe, expect, it } from 'vitest';
import {
  XcodeToolchainBackend,
  parseMaestroPinFlag,
  parseXcodeVersion,
  type AppleCliExecResult,
} from '../xcodeToolchainBackend';

/** One recorded invocation. */
interface RecordedCall {
  command: string;
  args: string[];
  timeoutMs: number | undefined;
}

type Responder = (command: string, args: readonly string[]) => AppleCliExecResult | Error;

const ok = (stdout = ''): AppleCliExecResult => ({ stdout, stderr: '', code: 0 });
const fail = (code: number, stderr: string): AppleCliExecResult => ({ stdout: '', stderr, code });

/**
 * A realistic `xcrun simctl list -j` payload.
 *
 * `runtimes[0]` is an UNAVAILABLE iOS 18.0 (a runtime whose download was
 * removed — simctl keeps listing it). `runtimes[1]` is the available iOS 26.2
 * and carries the `supportedDeviceTypes` intersection. The flat `devicetypes`
 * list deliberately ends with the OLD `iPhone-6s-Plus` so a test can prove the
 * resolver never reaches for it.
 */
function simctlList(): string {
  return JSON.stringify({
    runtimes: [
      {
        platform: 'iOS',
        name: 'iOS 18.0',
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0',
        version: '18.0',
        isAvailable: false,
        supportedDeviceTypes: [
          {
            productFamily: 'iPhone',
            name: 'iPhone 15 Pro',
            identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro',
          },
        ],
      },
      {
        platform: 'iOS',
        name: 'iOS 26.2',
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2',
        version: '26.2',
        isAvailable: true,
        supportedDeviceTypes: [
          {
            productFamily: 'iPhone',
            name: 'iPhone 16e',
            identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16e',
          },
          {
            productFamily: 'iPhone',
            name: 'iPhone 17 Pro',
            identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
          },
          {
            productFamily: 'iPad',
            name: 'iPad Pro 13-inch (M5)',
            identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5',
          },
        ],
      },
      {
        platform: 'watchOS',
        name: 'watchOS 26.2',
        identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-26-2',
        version: '26.2',
        isAvailable: true,
        supportedDeviceTypes: [],
      },
    ],
    devicetypes: [
      {
        productFamily: 'iPhone',
        name: 'iPhone 17 Pro',
        identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      },
      {
        productFamily: 'iPhone',
        name: 'iPhone 6s Plus',
        identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-6s-Plus',
      },
    ],
    devices: {},
  });
}

/** Build a backend over a scripted exec, returning the call log alongside it. */
function makeBackend(
  respond: Responder,
  overrides: Partial<{
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    homeDir: string;
    now: () => number;
    executables: Set<string>;
  }> = {},
): { backend: XcodeToolchainBackend; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const executables = overrides.executables ?? new Set<string>();
  const backend = new XcodeToolchainBackend({
    exec: async (command, args, opts) => {
      calls.push({ command, args: [...args], timeoutMs: opts?.timeoutMs });
      const outcome = respond(command, args);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    platform: overrides.platform ?? 'darwin',
    env: overrides.env ?? {},
    homeDir: overrides.homeDir ?? '/Users/tester',
    ...(overrides.now ? { now: overrides.now } : {}),
    isExecutableFile: async (p) => executables.has(p),
  });
  return { backend, calls };
}

/** The happy-path responder: Xcode answers, simctl lists, no maestro anywhere. */
const healthyResponder: Responder = (command, args) => {
  if (command === 'xcodebuild') return ok('Xcode 26.2\nBuild version 17C5030f\n');
  if (command === 'xcrun' && args[0] === 'simctl') return ok(simctlList());
  if (command === 'which') return fail(1, '');
  return fail(127, `unexpected command ${command}`);
};

describe('parseXcodeVersion', () => {
  it('reads the version off the first line', () => {
    expect(parseXcodeVersion('Xcode 26.2\nBuild version 17C5030f\n')).toBe('26.2');
  });

  it('returns null rather than guessing at an unrecognised shape', () => {
    expect(parseXcodeVersion('xcode-select: error: tool not found')).toBeNull();
  });
});

describe('parseMaestroPinFlag', () => {
  it('prefers --udid when both flags exist', () => {
    expect(parseMaestroPinFlag('Options:\n  --device <name>\n  --udid <udid>\n')).toBe('--udid');
  });

  it('falls back to --device when only it exists', () => {
    expect(parseMaestroPinFlag('Options:\n  --device <name>\n')).toBe('--device');
  });

  it('returns null when neither exists, so the driver refuses to drive', () => {
    expect(parseMaestroPinFlag('Options:\n  --help\n  --format <fmt>\n')).toBeNull();
  });
});

describe('XcodeToolchainBackend.healthCheck', () => {
  it('is false off darwin and spawns nothing at all', async () => {
    const { backend, calls } = makeBackend(
      () => {
        throw new Error('the probe must not spawn anything off darwin');
      },
      { platform: 'linux' },
    );
    expect(await backend.healthCheck()).toBe(false);
    expect(calls).toHaveLength(0);
    const probe = await backend.probeDetail();
    expect(probe.status).toBe('absent');
    expect(probe.detail).toContain('requires macOS');
  });

  it('is true on a host with Xcode, an available iOS runtime and a compatible iPhone', async () => {
    const { backend } = makeBackend(healthyResponder);
    expect(await backend.healthCheck()).toBe(true);
    const probe = await backend.probeDetail();
    expect(probe.status).toBe('ok');
    expect(probe.xcodeVersion).toBe('26.2');
    expect(probe.newestRuntime).toBe('iOS 26.2');
    // The INTERSECTION: the newest iPhone the AVAILABLE runtime supports, never
    // the iPhone 6s Plus that still sits in the flat devicetypes list.
    expect(probe.detail).toContain('iPhone 17 Pro');
    expect(probe.detail).not.toContain('6s');
    expect(probe.detail).toContain('Maestro not found');
  });

  it('every command it issues carries a timeout', async () => {
    const { backend, calls } = makeBackend(healthyResponder);
    await backend.healthCheck();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.timeoutMs).toBe(15_000);
  });
});

describe('XcodeToolchainBackend.probeDetail — the three absent reasons', () => {
  it('reports Xcode command-line tools when xcodebuild exits non-zero', async () => {
    const { backend } = makeBackend((command, args) => {
      if (command === 'xcodebuild') {
        return fail(1, "xcode-select: error: tool 'xcodebuild' requires Xcode");
      }
      if (command === 'which') return fail(1, '');
      return healthyResponder(command, args);
    });
    const probe = await backend.probeDetail();
    expect(probe.status).toBe('absent');
    expect(probe.detail).toContain('Xcode command-line tools unavailable');
    expect(probe.detail).toContain('requires Xcode');
    expect(probe.newestRuntime).toBeNull();
    expect(await backend.healthCheck()).toBe(false);
  });

  it('reports the missing iOS runtime when every listed runtime is unavailable', async () => {
    const list = JSON.parse(simctlList()) as { runtimes: Array<{ isAvailable: boolean }> };
    for (const runtime of list.runtimes) runtime.isAvailable = false;
    const { backend } = makeBackend((command) => {
      if (command === 'xcodebuild') return ok('Xcode 26.2\n');
      if (command === 'xcrun') return ok(JSON.stringify(list));
      return fail(1, '');
    });
    const probe = await backend.probeDetail();
    expect(probe.status).toBe('absent');
    expect(probe.detail).toContain('no available iOS simulator runtime');
    expect(probe.xcodeVersion).toBe('26.2');
  });

  it('reports the missing iPhone device type when the runtime supports none', async () => {
    const list = JSON.parse(simctlList()) as {
      runtimes: Array<{ isAvailable: boolean; supportedDeviceTypes: unknown[] }>;
      devicetypes: unknown[];
    };
    // The available iOS runtime supports only iPads, and the flat fallback list
    // is emptied so nothing can rescue it.
    list.runtimes[1]!.supportedDeviceTypes = [
      {
        productFamily: 'iPad',
        name: 'iPad Pro 13-inch (M5)',
        identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5',
      },
    ];
    list.devicetypes = [];
    const { backend } = makeBackend((command) => {
      if (command === 'xcodebuild') return ok('Xcode 26.2\n');
      if (command === 'xcrun') return ok(JSON.stringify(list));
      return fail(1, '');
    });
    const probe = await backend.probeDetail();
    expect(probe.status).toBe('absent');
    expect(probe.detail).toContain('no iPhone device type is compatible with iOS 26.2');
  });
});

describe('XcodeToolchainBackend.probeDetail — inconclusive, never absent', () => {
  it('is inconclusive when xcodebuild throws (a timeout, a spawn failure)', async () => {
    const { backend } = makeBackend((command) => {
      if (command === 'xcodebuild') return new Error('timed out after 15000ms');
      return fail(1, '');
    });
    const probe = await backend.probeDetail();
    expect(probe.status).toBe('inconclusive');
    expect(probe.detail).toContain('could not answer');
    expect(probe.detail).toContain('timed out');
    expect(await backend.healthCheck()).toBe(false);
  });

  it('is inconclusive when simctl throws', async () => {
    const { backend } = makeBackend((command) => {
      if (command === 'xcodebuild') return ok('Xcode 26.2\n');
      if (command === 'xcrun') return new Error('spawn xcrun ENOENT');
      return fail(1, '');
    });
    const probe = await backend.probeDetail();
    expect(probe.status).toBe('inconclusive');
    expect(probe.xcodeVersion).toBe('26.2');
  });

  it('is inconclusive when simctl exits non-zero — a refusal to answer is not a "no"', async () => {
    const { backend } = makeBackend((command) => {
      if (command === 'xcodebuild') return ok('Xcode 26.2\n');
      if (command === 'xcrun') return fail(72, 'CoreSimulator service unavailable');
      return fail(1, '');
    });
    const probe = await backend.probeDetail();
    expect(probe.status).toBe('inconclusive');
    expect(probe.detail).toContain('CoreSimulator service unavailable');
  });

  it('is inconclusive when simctl prints unparseable JSON', async () => {
    const { backend } = makeBackend((command) => {
      if (command === 'xcodebuild') return ok('Xcode 26.2\n');
      if (command === 'xcrun') return ok('not json at all');
      return fail(1, '');
    });
    const probe = await backend.probeDetail();
    expect(probe.status).toBe('inconclusive');
    expect(probe.detail).toContain('unreadable JSON');
  });
});

describe('XcodeToolchainBackend memoization', () => {
  it('asks the host once per 60 s window, then asks again', async () => {
    let clock = 1_000;
    const { backend, calls } = makeBackend(healthyResponder, { now: () => clock });
    await backend.probeDetail();
    const afterFirst = calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    clock += 59_000;
    await backend.probeDetail();
    await backend.healthCheck();
    expect(calls).toHaveLength(afterFirst);

    clock += 2_000;
    await backend.probeDetail();
    expect(calls.length).toBeGreaterThan(afterFirst);
  });

  it('shares one in-flight probe between concurrent callers', async () => {
    const { backend, calls } = makeBackend(healthyResponder);
    const [a, b] = await Promise.all([backend.probeDetail(), backend.probeDetail()]);
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');
    const xcodebuildCalls = calls.filter((c) => c.command === 'xcodebuild');
    expect(xcodebuildCalls).toHaveLength(1);
  });
});

describe('XcodeToolchainBackend.resolveMaestroBin', () => {
  const withMaestro = (bin: string): Responder => (command, args) => {
    if (command === bin && args[0] === '--version') return ok('2.3.0\n');
    if (command === bin && args[0] === 'test') return ok('Options:\n  --udid <udid>\n');
    return healthyResponder(command, args);
  };

  it('prefers VERIFY_MAESTRO_BIN over every other candidate', async () => {
    const { backend } = makeBackend(withMaestro('/opt/custom/maestro'), {
      env: { VERIFY_MAESTRO_BIN: '/opt/custom/maestro' },
      executables: new Set([
        '/opt/custom/maestro',
        '/Users/tester/.maestro/bin/maestro',
        '/opt/homebrew/bin/maestro',
      ]),
    });
    expect(await backend.resolveMaestroBin()).toBe('/opt/custom/maestro');
  });

  it('falls through home → homebrew → /usr/local in order', async () => {
    const home = makeBackend(withMaestro('/Users/tester/.maestro/bin/maestro'), {
      executables: new Set(['/Users/tester/.maestro/bin/maestro', '/opt/homebrew/bin/maestro']),
    });
    expect(await home.backend.resolveMaestroBin()).toBe('/Users/tester/.maestro/bin/maestro');

    const brew = makeBackend(withMaestro('/opt/homebrew/bin/maestro'), {
      executables: new Set(['/opt/homebrew/bin/maestro', '/usr/local/bin/maestro']),
    });
    expect(await brew.backend.resolveMaestroBin()).toBe('/opt/homebrew/bin/maestro');

    const local = makeBackend(withMaestro('/usr/local/bin/maestro'), {
      executables: new Set(['/usr/local/bin/maestro']),
    });
    expect(await local.backend.resolveMaestroBin()).toBe('/usr/local/bin/maestro');
  });

  it('falls back to `which maestro`, and only accepts an absolute executable path', async () => {
    const { backend } = makeBackend(
      (command, args) => {
        if (command === 'which') return ok('/opt/tools/bin/maestro\n');
        return withMaestro('/opt/tools/bin/maestro')(command, args);
      },
      { executables: new Set(['/opt/tools/bin/maestro']) },
    );
    expect(await backend.resolveMaestroBin()).toBe('/opt/tools/bin/maestro');
  });

  it('rejects a relative `which` answer rather than handing back a bare name', async () => {
    const { backend } = makeBackend(
      (command) => {
        if (command === 'which') return ok('maestro\n');
        if (command === 'xcodebuild') return ok('Xcode 26.2\n');
        return fail(1, '');
      },
      { executables: new Set(['maestro']) },
    );
    expect(await backend.resolveMaestroBin()).toBeNull();
  });

  it('rejects a candidate that exists but is not an executable file', async () => {
    const { backend } = makeBackend(healthyResponder, {
      env: { VERIFY_MAESTRO_BIN: '/opt/custom/maestro' },
      executables: new Set(),
    });
    expect(await backend.resolveMaestroBin()).toBeNull();
  });

  it('memoizes: a second call spawns nothing more', async () => {
    const { backend, calls } = makeBackend(
      (command, args) => {
        if (command === 'which') return ok('/opt/tools/bin/maestro\n');
        return withMaestro('/opt/tools/bin/maestro')(command, args);
      },
      { executables: new Set(['/opt/tools/bin/maestro']) },
    );
    await backend.resolveMaestroBin();
    const after = calls.length;
    await backend.resolveMaestroBin();
    expect(calls).toHaveLength(after);
  });

  it('names the Maestro version in the probe detail when one resolves', async () => {
    const { backend } = makeBackend(withMaestro('/opt/homebrew/bin/maestro'), {
      executables: new Set(['/opt/homebrew/bin/maestro']),
    });
    const probe = await backend.probeDetail();
    expect(probe.status).toBe('ok');
    expect(probe.maestroBin).toBe('/opt/homebrew/bin/maestro');
    expect(probe.detail).toContain('Maestro 2.3.0');
  });

  it('a maestro that cannot report its version never makes the toolchain inconclusive', async () => {
    const { backend } = makeBackend(
      (command, args) => {
        if (command === '/opt/homebrew/bin/maestro') return new Error('killed');
        return healthyResponder(command, args);
      },
      { executables: new Set(['/opt/homebrew/bin/maestro']) },
    );
    const probe = await backend.probeDetail();
    expect(probe.status).toBe('ok');
    expect(probe.maestroBin).toBe('/opt/homebrew/bin/maestro');
    expect(probe.detail).toContain('Maestro unknown version');
  });
});

describe('XcodeToolchainBackend.resolvePinFlag', () => {
  it('parses --udid, memoizes per binary', async () => {
    const { backend, calls } = makeBackend((command, args) => {
      if (command === '/opt/homebrew/bin/maestro' && args[0] === 'test') {
        return ok('Usage: maestro test [OPTIONS]\n  --device <name>\n  --udid <udid>\n');
      }
      return healthyResponder(command, args);
    });
    expect(await backend.resolvePinFlag('/opt/homebrew/bin/maestro')).toBe('--udid');
    const after = calls.length;
    expect(await backend.resolvePinFlag('/opt/homebrew/bin/maestro')).toBe('--udid');
    expect(calls).toHaveLength(after);
  });

  it('reads the help text even when --help exits non-zero', async () => {
    const { backend } = makeBackend(() => ({
      stdout: '',
      stderr: 'Usage: maestro test [OPTIONS]\n  --device <name>\n',
      code: 2,
    }));
    expect(await backend.resolvePinFlag('/opt/homebrew/bin/maestro')).toBe('--device');
  });

  it('is null when the help text names neither flag, and when the probe throws', async () => {
    const neither = makeBackend(() => ok('Usage: maestro test [OPTIONS]\n  --format junit\n'));
    expect(await neither.backend.resolvePinFlag('/opt/homebrew/bin/maestro')).toBeNull();

    const threw = makeBackend(() => new Error('spawn EACCES'));
    expect(await threw.backend.resolvePinFlag('/opt/homebrew/bin/maestro')).toBeNull();
  });
});
