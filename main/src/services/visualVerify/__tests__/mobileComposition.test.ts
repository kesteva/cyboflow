/**
 * mobileComposition unit tests — the composition root's mobile half
 * (docs/proposals/mobile-verification-tier.md §8, §8.2, T15).
 *
 * Three rules are asserted, because each is the kind that typechecks either way
 * and only fails on a real host:
 *
 *  1. OFF DARWIN, NOTHING IS CONSTRUCTED AND NOTHING SPAWNS. The injected exec
 *     is recorded, and the assertion is that it was never called — a factory
 *     that merely returned `false` after asking the host would still spawn
 *     `xcrun` on Linux/Windows, where it does not exist.
 *  2. ONE INSTANCE, SHARED. `probe` and `probeRow` must read the SAME backend,
 *     so its 60 s verdict memo is honoured across the gate and the panel rather
 *     than each paying its own `simctl list` sweep.
 *  3. THE PANEL'S FAIL-OPEN RULE. `absent` (the host answered no) is the ONLY
 *     status that becomes `'missing'`; an `inconclusive` probe, and every
 *     off-darwin call, stay `'inconclusive'`. `fix` is null in every state,
 *     because the app can install neither Xcode nor Maestro.
 *
 * No real Apple toolchain runs anywhere in this file: the exec transport is
 * injected and every `xcodebuild` / `xcrun` / `which` invocation is canned.
 */
import { describe, expect, it, vi } from 'vitest';
import { composeMobileVerification } from '../mobileComposition';
import type {
  AppleCliExec,
  AppleCliExecResult,
} from '../../../orchestrator/verify/mobileSimulatorSession';

interface RecordedCall {
  command: string;
  args: string[];
}

const ok = (stdout = ''): AppleCliExecResult => ({ stdout, stderr: '', code: 0 });
const fail = (code: number, stderr = ''): AppleCliExecResult => ({ stdout: '', stderr, code });

/**
 * A `simctl list -j` payload with ONE available iOS runtime carrying a
 * compatible iPhone in its own `supportedDeviceTypes` — enough for the probe to
 * reach `ok`. (The intersection rule itself is covered in
 * xcodeToolchainBackend.test.ts; this file only needs a healthy answer.)
 */
function simctlList(): string {
  return JSON.stringify({
    runtimes: [
      {
        platform: 'iOS',
        name: 'iOS 26.2',
        identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-2',
        version: '26.2',
        isAvailable: true,
        supportedDeviceTypes: [
          {
            productFamily: 'iPhone',
            name: 'iPhone 17 Pro',
            identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
          },
        ],
      },
    ],
    devicetypes: [
      {
        productFamily: 'iPhone',
        name: 'iPhone 17 Pro',
        identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      },
    ],
    devices: {},
  });
}

type Responder = (command: string, args: readonly string[]) => AppleCliExecResult | Error;

/** The happy path: Xcode answers, simctl lists, no maestro on the host. */
const healthy: Responder = (command, args) => {
  if (command === 'xcodebuild') return ok('Xcode 26.2\nBuild version 17C5030f\n');
  if (command === 'xcrun' && args[0] === 'simctl') return ok(simctlList());
  if (command === 'which') return fail(1);
  return fail(127, `unexpected command ${command}`);
};

function recordingExec(respond: Responder): { exec: AppleCliExec; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const exec: AppleCliExec = async (command, args) => {
    calls.push({ command, args: [...args] });
    const outcome = respond(command, args);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { exec, calls };
}

function compose(platform: NodeJS.Platform, respond: Responder = healthy) {
  const { exec, calls } = recordingExec(respond);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), verbose: vi.fn(), debug: vi.fn() };
  const composition = composeMobileVerification({
    dataDir: '/tmp/cyboflow-test-data-dir',
    platform,
    exec,
    homeDir: '/Users/tester',
    env: {},
    logger,
  });
  return { composition, calls, logger };
}

describe('composeMobileVerification off darwin', () => {
  it('constructs neither backend nor session, and never spawns', async () => {
    const { composition, calls } = compose('linux');

    expect(composition.toolchain).toBeNull();
    expect(composition.session).toBeNull();
    expect(await composition.probe()).toBe(false);
    await composition.probeRow();
    await composition.sweepAtBoot();

    // The whole point: the gate answered `false` without asking a host that has
    // no `xcrun` to ask.
    expect(calls).toEqual([]);
  });

  it('reports inconclusive with no fix — never missing', async () => {
    const { composition } = compose('win32');
    const row = await composition.probeRow();

    expect(row.id).toBe('mobile-simulator');
    // NOT 'missing': the app cannot install an iOS toolchain on Windows, so
    // "missing" would render as an instruction with nothing behind it.
    expect(row.state).toBe('inconclusive');
    expect(row.fix).toBeNull();
    expect(row.detail).toMatch(/macOS/);
  });

  it('sweepAtBoot is a no-op that resolves', async () => {
    const { composition, logger } = compose('linux');
    await expect(composition.sweepAtBoot()).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('composeMobileVerification on darwin', () => {
  it('constructs the toolchain and the session factory once', () => {
    const { composition } = compose('darwin');
    expect(composition.toolchain).not.toBeNull();
    expect(composition.session).not.toBeNull();
  });

  it('probe and probeRow share ONE backend (the 60 s verdict memo is not paid twice)', async () => {
    const { composition, calls } = compose('darwin');

    expect(await composition.probe()).toBe(true);
    const first = calls.length;
    expect(first).toBeGreaterThan(0);

    const row = await composition.probeRow();
    expect(row.state).toBe('ok');
    // Second read served from the shared memo: two backends would have
    // re-spawned `xcodebuild` + `simctl list` here.
    expect(calls.length).toBe(first);
  });

  it('maps an AFFIRMATIVE absence to missing, with no fix offered', async () => {
    // `xcodebuild` answers, but simctl lists no available iOS runtime: the host
    // said no, which is the one case that justifies 'missing'.
    const { composition } = compose('darwin', (command, args) => {
      if (command === 'xcodebuild') return ok('Xcode 26.2\n');
      if (command === 'xcrun' && args[0] === 'simctl')
        return ok(JSON.stringify({ runtimes: [], devicetypes: [], devices: {} }));
      if (command === 'which') return fail(1);
      return fail(127);
    });

    const row = await composition.probeRow();
    expect(row.state).toBe('missing');
    // Still null: installing an iOS runtime is not something this app can do.
    expect(row.fix).toBeNull();
    expect(await composition.probe()).toBe(false);
  });

  it('maps a probe that could not answer to inconclusive, never missing', async () => {
    const { composition } = compose('darwin', (command) => {
      if (command === 'xcodebuild') return new Error('spawn xcodebuild ETIMEDOUT');
      return fail(127);
    });

    const row = await composition.probeRow();
    expect(row.state).toBe('inconclusive');
    expect(row.fix).toBeNull();
    // Gate 1 nevertheless fails CLOSED off the same probe: an unanswerable
    // toolchain must not lease a 2 GB simulator boot.
    expect(await composition.probe()).toBe(false);
  });

  it('the row detail names the Xcode version, the runtime and the Maestro state', async () => {
    const { composition } = compose('darwin');
    const row = await composition.probeRow();

    expect(row.detail).toMatch(/26\.2/);
    expect(row.detail).toMatch(/iOS 26\.2/);
    expect(row.detail.toLowerCase()).toMatch(/maestro/);
    // Stage 1 runs on Apple's own command-line tools; the Xcode MCP is Stage 3
    // design and must not be advertised anywhere a user reads.
    expect(row.detail.toLowerCase()).not.toMatch(/mcpbridge/);
  });

  it('sweepAtBoot sweeps the injected data dir and swallows a failure', async () => {
    const { composition, logger } = compose('darwin', (command, args) => {
      if (command === 'xcrun' && args[0] === 'simctl') return new Error('simctl exploded');
      return fail(127);
    });

    // A sweep is best-effort reclamation, never a boot precondition.
    await expect(composition.sweepAtBoot()).resolves.toBeUndefined();
    const logged = logger.info.mock.calls.length + logger.warn.mock.calls.length;
    expect(logged).toBeGreaterThan(0);
  });
});
