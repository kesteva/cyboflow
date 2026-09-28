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
import { delimiter } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  XcodeToolchainBackend,
  parseMaestroPinFlag,
  parseOpenjdkVersion,
  parseXcodeVersion,
  SIMCTL_FIRST_LAUNCH_HINT,
  type AppleCliExecResult,
} from '../xcodeToolchainBackend';

/** The wider opts shape {@link XcodeToolchainBackend}'s `runMaestro` actually passes (B6). */
type RecordedOpts = { timeoutMs?: number; env?: NodeJS.ProcessEnv };

/** One recorded invocation. */
interface RecordedCall {
  command: string;
  args: string[];
  timeoutMs: number | undefined;
  /** `undefined` unless the call went through `runMaestro` with a resolved JAVA_HOME (B6). */
  env: NodeJS.ProcessEnv | undefined;
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

/**
 * Build a backend over a scripted exec, returning the call log alongside it.
 *
 * `directories` / `readdirEntries` back the B6 JAVA_HOME seams (the backend's
 * injected `isDirectory` / `readdir`) — defaulted to "nothing exists" so that,
 * unless a test opts in, `resolveJavaHome` runs entirely against fakes and
 * never touches the real host filesystem, exactly like `executables` already
 * does for `isExecutableFile`.
 */
function makeBackend(
  respond: Responder,
  overrides: Partial<{
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    homeDir: string;
    now: () => number;
    executables: Set<string>;
    directories: Set<string>;
    readdirEntries: Record<string, string[]>;
  }> = {},
): { backend: XcodeToolchainBackend; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const executables = overrides.executables ?? new Set<string>();
  const directories = overrides.directories ?? new Set<string>();
  const readdirEntries = overrides.readdirEntries ?? {};
  const backend = new XcodeToolchainBackend({
    exec: async (command, args, opts) => {
      calls.push({
        command,
        args: [...args],
        timeoutMs: opts?.timeoutMs,
        env: (opts as RecordedOpts | undefined)?.env,
      });
      const outcome = respond(command, args);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    platform: overrides.platform ?? 'darwin',
    env: overrides.env ?? {},
    homeDir: overrides.homeDir ?? '/Users/tester',
    ...(overrides.now ? { now: overrides.now } : {}),
    isExecutableFile: async (p) => executables.has(p),
    isDirectory: async (p) => directories.has(p),
    readdir: async (dir) => {
      const entries = readdirEntries[dir];
      if (entries === undefined) throw new Error(`ENOENT: ${dir}`);
      return entries;
    },
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

describe('parseOpenjdkVersion (B6)', () => {
  it('ranks the bare `openjdk` formula above every pinned @N — it tracks the current release', () => {
    expect(parseOpenjdkVersion('openjdk')).toBeGreaterThan(parseOpenjdkVersion('openjdk@21'));
  });

  it('ranks a higher @N above a lower one', () => {
    expect(parseOpenjdkVersion('openjdk@21')).toBeGreaterThan(parseOpenjdkVersion('openjdk@17'));
    expect(parseOpenjdkVersion('openjdk@17')).toBeGreaterThan(parseOpenjdkVersion('openjdk@8'));
  });

  it('sorts a name that is not an openjdk formula at all lowest', () => {
    expect(parseOpenjdkVersion('not-openjdk')).toBeLessThan(parseOpenjdkVersion('openjdk@8'));
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

  it('names the pending first-launch install when simctl times out — the cause seen after an Xcode upgrade', async () => {
    const { backend } = makeBackend((command) => {
      if (command === 'xcodebuild') return ok('Xcode 27.0\n');
      if (command === 'xcrun') return new Error('timed out after 15000ms');
      return fail(1, '');
    });
    const probe = await backend.probeDetail();
    expect(probe.status).toBe('inconclusive');
    expect(probe.detail).toContain(SIMCTL_FIRST_LAUNCH_HINT);
    expect(probe.detail).toContain('xcodebuild -runFirstLaunch');
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

/*
 * iOS Simulator only, so these model a DARWIN host: the fixtures are POSIX
 * absolute paths (`/Users/tester/...`, `/sim/data/Containers/...`) and the code
 * under test joins them with `node:path`. On a win32 runner that join yields
 * `\Users\tester\...`, which can never match the fixture — the suite would be
 * measuring the runner's path separator, not the behaviour. The production
 * paths are already darwin-gated (`if (this.platform !== 'darwin') return
 * null`), so there is nothing here for Windows to cover.
 */
describe.skipIf(process.platform === 'win32')('XcodeToolchainBackend.resolveMaestroBin', () => {
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

/*
 * B6 — MAESTRO JAVA_HOME. See the darwin-only guard in the `resolveMaestroBin`
 * describe block above: same reasoning applies here (POSIX absolute paths,
 * `node:path` joins), so this whole block is skipped on a win32 runner.
 */
describe.skipIf(process.platform === 'win32')('XcodeToolchainBackend.resolveJavaHome', () => {
  it('rung 1: an existing JAVA_HOME wins when it actually names a JDK, and spawns nothing', async () => {
    const { backend, calls } = makeBackend(healthyResponder, {
      env: { JAVA_HOME: '/Users/tester/.jdks/17' },
      executables: new Set(['/Users/tester/.jdks/17/bin/java']),
    });
    expect(await backend.resolveJavaHome()).toBe('/Users/tester/.jdks/17');
    expect(calls).toHaveLength(0);
  });

  it('rung 1 is rejected when JAVA_HOME does not actually contain bin/java, and falls through', async () => {
    const { backend } = makeBackend(
      (command) => {
        if (command === '/usr/libexec/java_home') {
          return ok('/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home\n');
        }
        return fail(1, '');
      },
      {
        env: { JAVA_HOME: '/Users/tester/stale-jdk' },
        executables: new Set(), // no bin/java under the stale JAVA_HOME
        directories: new Set(['/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home']),
      },
    );
    expect(await backend.resolveJavaHome()).toBe(
      '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
    );
  });

  it('rung 2: `/usr/libexec/java_home`, exit 0 and an existing directory', async () => {
    const { backend, calls } = makeBackend(
      (command) => {
        if (command === '/usr/libexec/java_home') {
          return ok('/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home\n');
        }
        return fail(1, '');
      },
      { directories: new Set(['/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home']) },
    );
    expect(await backend.resolveJavaHome()).toBe(
      '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
    );
    const call = calls.find((c) => c.command === '/usr/libexec/java_home');
    expect(call?.args).toEqual([]);
    expect(call?.timeoutMs).toBe(15_000);
  });

  it('rung 2 is rejected when java_home answers a path that is not an existing directory', async () => {
    const { backend } = makeBackend(
      (command) => {
        if (command === '/usr/libexec/java_home') return ok('/nowhere\n');
        return fail(1, '');
      },
      { directories: new Set() }, // /nowhere does not exist
    );
    expect(await backend.resolveJavaHome()).toBeNull();
  });

  it('rung 2 exiting non-zero (no JDK registered) falls through without throwing', async () => {
    const { backend } = makeBackend((command) => {
      if (command === '/usr/libexec/java_home') {
        return fail(1, 'Unable to find any JVMs matching version');
      }
      return fail(1, '');
    });
    expect(await backend.resolveJavaHome()).toBeNull();
  });

  it('rung 2 throwing (no such binary) falls through without throwing', async () => {
    const { backend } = makeBackend((command) => {
      if (command === '/usr/libexec/java_home') return new Error('spawn ENOENT');
      return fail(1, '');
    });
    expect(await backend.resolveJavaHome()).toBeNull();
  });

  it('rung 3: the newest /opt/homebrew/opt/openjdk*, ranked above a lower pinned version', async () => {
    const home21 = '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home';
    const home17 = '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home';
    const { backend } = makeBackend(() => fail(1, ''), {
      readdirEntries: { '/opt/homebrew/opt': ['openjdk@17', 'openjdk@21', 'not-openjdk'] },
      directories: new Set([home21, home17]),
    });
    expect(await backend.resolveJavaHome()).toBe(home21);
  });

  it('rung 3 skips a listed formula whose Home directory does not actually exist', async () => {
    const home17 = '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home';
    const { backend } = makeBackend(() => fail(1, ''), {
      readdirEntries: { '/opt/homebrew/opt': ['openjdk@21', 'openjdk@17'] },
      // openjdk@21's Home is missing (e.g. a half-uninstalled formula); only
      // openjdk@17's answers, so it must still be found.
      directories: new Set([home17]),
    });
    expect(await backend.resolveJavaHome()).toBe(home17);
  });

  it('rung 4: /usr/local/opt/openjdk*, only reached when the homebrew prefix has none', async () => {
    const home = '/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home';
    const { backend } = makeBackend(() => fail(1, ''), {
      // '/opt/homebrew/opt' is absent entirely (readdir throws — not installed
      // on this architecture), so rung 4 must still be reached.
      readdirEntries: { '/usr/local/opt': ['openjdk'] },
      directories: new Set([home]),
    });
    expect(await backend.resolveJavaHome()).toBe(home);
  });

  it('rung 2 outranks rung 3: a java_home answer wins over an installed Homebrew formula', async () => {
    const registered = '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home';
    const brew = '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home';
    const { backend } = makeBackend(
      (command) => (command === '/usr/libexec/java_home' ? ok(`${registered}\n`) : fail(1, '')),
      {
        readdirEntries: { '/opt/homebrew/opt': ['openjdk@17'] },
        directories: new Set([registered, brew]),
      },
    );
    expect(await backend.resolveJavaHome()).toBe(registered);
  });

  it('rung 3 outranks rung 4: the Apple Silicon prefix wins even over a NEWER Intel formula', async () => {
    const arm = '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home';
    const intel = '/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home';
    const { backend } = makeBackend(() => fail(1, ''), {
      readdirEntries: { '/opt/homebrew/opt': ['openjdk@17'], '/usr/local/opt': ['openjdk@21'] },
      directories: new Set([arm, intel]),
    });
    expect(await backend.resolveJavaHome()).toBe(arm);
  });

  it('is null when every rung misses, never throwing', async () => {
    const { backend } = makeBackend(() => fail(1, ''));
    expect(await backend.resolveJavaHome()).toBeNull();
  });

  it('is null off darwin and spawns nothing', async () => {
    const { backend, calls } = makeBackend(
      () => {
        throw new Error('must not spawn off darwin');
      },
      { platform: 'linux' },
    );
    expect(await backend.resolveJavaHome()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('memoizes: a second call spawns nothing more', async () => {
    const home = '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home';
    const { backend, calls } = makeBackend(
      (command) => {
        if (command === '/usr/libexec/java_home') return ok(`${home}\n`);
        return fail(1, '');
      },
      { directories: new Set([home]) },
    );
    expect(await backend.resolveJavaHome()).toBe(home);
    const after = calls.length;
    expect(await backend.resolveJavaHome()).toBe(home);
    expect(calls).toHaveLength(after);
  });
});

describe.skipIf(process.platform === 'win32')(
  'XcodeToolchainBackend — B6: maestro invocations receive JAVA_HOME',
  () => {
    const maestroBin = '/opt/homebrew/bin/maestro';
    const javaHome = '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home';

    // The child's env is built from the INHERITED process env (what the host
    // transport would otherwise pass), not the backend's lookup `env` — so the
    // inherited PATH is stubbed here, and each test injects a DIFFERENT lookup
    // PATH to prove it is not the one prefixed.
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('resolvePinFlag runs `maestro test --help` with JAVA_HOME set and PATH prefixed with $JAVA_HOME/bin', async () => {
      const { backend, calls } = makeBackend(
        (command, args) => {
          if (command === '/usr/libexec/java_home') return ok(`${javaHome}\n`);
          if (command === maestroBin && args[0] === 'test') {
            return ok('Usage: maestro test [OPTIONS]\n  --udid <udid>\n');
          }
          return fail(1, '');
        },
        { directories: new Set([javaHome]), env: { PATH: '/lookup/only' } },
      );
      vi.stubEnv('PATH', '/usr/bin:/bin');
      expect(await backend.resolvePinFlag(maestroBin)).toBe('--udid');
      const testCall = calls.find((c) => c.command === maestroBin && c.args[0] === 'test');
      expect(testCall?.env?.JAVA_HOME).toBe(javaHome);
      expect(testCall?.env?.PATH).toBe(`${javaHome}/bin${delimiter}/usr/bin:/bin`);
    });

    it('describeMaestro runs `maestro --version` with the same JAVA_HOME (surfaced through probeDetail)', async () => {
      const { backend, calls } = makeBackend(
        (command, args) => {
          if (command === '/usr/libexec/java_home') return ok(`${javaHome}\n`);
          if (command === maestroBin && args[0] === '--version') return ok('1.39.0\n');
          return healthyResponder(command, args);
        },
        { directories: new Set([javaHome]), executables: new Set([maestroBin]), env: { PATH: '/lookup/only' } },
      );
      vi.stubEnv('PATH', '/usr/bin');
      const probe = await backend.probeDetail();
      expect(probe.maestroBin).toBe(maestroBin);
      expect(probe.javaHome).toBe(javaHome);
      expect(probe.detail).toContain('Maestro 1.39.0');
      const versionCall = calls.find((c) => c.command === maestroBin && c.args[0] === '--version');
      expect(versionCall?.env?.JAVA_HOME).toBe(javaHome);
      expect(versionCall?.env?.PATH).toBe(`${javaHome}/bin${delimiter}/usr/bin`);
    });

    it('a NARROWED lookup env (the itest injects `{}`) still hands maestro the full inherited env', async () => {
      // Regression pin: building the child env from the lookup env would run a
      // real Maestro with nothing but JAVA_HOME and PATH=$JAVA_HOME/bin — no
      // HOME, no TMPDIR, no PATH to `uname`/`sed` — once the transport honours `env`.
      const { backend, calls } = makeBackend(
        (command, args) => {
          if (command === maestroBin && args[0] === 'test') return ok('  --udid <udid>\n');
          return fail(1, '');
        },
        { env: { JAVA_HOME: javaHome }, executables: new Set([`${javaHome}/bin/java`]) },
      );
      vi.stubEnv('PATH', '/fixture/shims:/usr/bin:/bin');
      vi.stubEnv('CYBOFLOW_B6_INHERITED_SENTINEL', 'kept');
      expect(await backend.resolvePinFlag(maestroBin)).toBe('--udid');
      const testCall = calls.find((c) => c.command === maestroBin && c.args[0] === 'test');
      expect(testCall?.env?.CYBOFLOW_B6_INHERITED_SENTINEL).toBe('kept');
      expect(testCall?.env?.JAVA_HOME).toBe(javaHome);
      expect(testCall?.env?.PATH).toBe(`${javaHome}/bin${delimiter}/fixture/shims:/usr/bin:/bin`);
    });

    it('runs maestro WITHOUT an env override when no JAVA_HOME resolves — unchanged pre-B6 behaviour', async () => {
      const { backend, calls } = makeBackend(
        (command, args) => {
          if (command === maestroBin && args[0] === 'test') {
            return ok('Usage: maestro test [OPTIONS]\n  --device <name>\n');
          }
          return fail(1, ''); // java_home and both homebrew readdirs all miss
        },
      );
      expect(await backend.resolvePinFlag(maestroBin)).toBe('--device');
      const testCall = calls.find((c) => c.command === maestroBin && c.args[0] === 'test');
      expect(testCall?.env).toBeUndefined();
    });

    it('probeDetail reports "no JAVA_HOME resolved" alongside the Maestro version when none resolves', async () => {
      const { backend } = makeBackend(
        (command, args) => {
          if (command === maestroBin && args[0] === '--version') return ok('1.39.0\n');
          return healthyResponder(command, args);
        },
        { executables: new Set([maestroBin]) },
      );
      const probe = await backend.probeDetail();
      expect(probe.javaHome).toBeNull();
      expect(probe.detail).toContain('Maestro 1.39.0 (no JAVA_HOME resolved)');
    });
  },
);
