/**
 * mobileSimulatorSession unit tests.
 *
 * NO real simulator is ever created: a FAKE {@link AppleCliExec} scripts every
 * `xcrun` / `ps` invocation and records the argv. The filesystem, by contrast,
 * is REAL — a `mkdtemp` sandbox under `os.tmpdir()` — because `owner.json`'s
 * write ORDER (before the device exists, updated the moment it does) and the
 * rollback's directory removal are the two things most worth proving against
 * actual bytes rather than a fake.
 *
 * The `simctl list -j` fixture is the one that bites in production: an
 * UNAVAILABLE iOS 18.0 runtime that must be skipped, an available iOS 26.2
 * whose `supportedDeviceTypes` is the compatibility answer, and a flat
 * `devicetypes` list still carrying `iPhone-6s-Plus` — the device a naive
 * newest-first pick chooses and `simctl create` rejects with
 * `Incompatible device`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VERIFY_MOBILE_DIRNAME,
  VERIFY_SIM_NAME_PREFIX,
  compareSimVersions,
  createMobileSimulatorSessionFactory,
  pickNewestIPhone,
  resolveSimTarget,
  type AppleCliExecResult,
  type SimulatorOwnerMarker,
} from '../mobileSimulatorSession';

const CREATED_UDID = 'A1B2C3D4-0000-4000-8000-000000000001';
/** Another instance's device. It must NEVER appear in an argv this module emits. */
const FOREIGN_UDID = 'FFFFFFFF-9999-4999-8999-999999999999';

const IPHONE_17 = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro';
const IOS_26_2 = 'com.apple.CoreSimulator.SimRuntime.iOS-26-2';

interface RecordedCall {
  command: string;
  args: string[];
  timeoutMs: number | undefined;
}

type Responder = (command: string, args: readonly string[]) => AppleCliExecResult | Error;

const ok = (stdout = ''): AppleCliExecResult => ({ stdout, stderr: '', code: 0 });
const fail = (code: number, stderr: string): AppleCliExecResult => ({ stdout: '', stderr, code });

const tempDirs: string[] = [];
function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyboflow-mobile-sim-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function simctlListJson(): string {
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
        identifier: IOS_26_2,
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
            identifier: IPHONE_17,
          },
          {
            productFamily: 'iPad',
            name: 'iPad Pro 13-inch (M5)',
            identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5',
          },
        ],
      },
    ],
    // Still carries the ancient device the naive pick would choose.
    devicetypes: [
      { productFamily: 'iPhone', name: 'iPhone 17 Pro', identifier: IPHONE_17 },
      {
        productFamily: 'iPhone',
        name: 'iPhone 6s Plus',
        identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-6s-Plus',
      },
    ],
    devices: {},
  });
}

/** `xcrun simctl list -j devices` — one device of ours, one belonging to somebody else. */
function devicesJson(ours: Array<{ name: string; udid: string }>): string {
  return JSON.stringify({
    devices: {
      [IOS_26_2]: [
        ...ours.map((d) => ({ ...d, state: 'Booted', isAvailable: true })),
        { name: 'iPhone 17 Pro', udid: 'DECOY-not-ours', state: 'Shutdown', isAvailable: true },
      ],
    },
  });
}

/** The happy-path responder: `ps` answers, simctl lists, creates, boots. */
const happyResponder: Responder = (command, args) => {
  if (command === 'ps') return ok('Wed Sep 17 09:00:00 2026\n');
  if (command !== 'xcrun') return fail(127, `unexpected command ${command}`);
  const [tool, verb] = args;
  if (tool !== 'simctl') return fail(127, `unexpected xcrun tool ${String(tool)}`);
  if (verb === 'list' && args[2] === '-j' && args[3] === 'devices') {
    return ok(devicesJson([{ name: `${VERIFY_SIM_NAME_PREFIX}req-1`, udid: CREATED_UDID }]));
  }
  if (verb === 'list') return ok(simctlListJson());
  if (verb === 'create') return ok(`${CREATED_UDID}\n`);
  return ok();
};

function makeFactory(
  respond: Responder,
  overrides: Partial<{
    platform: NodeJS.Platform;
    pid: number;
    processKill: (pid: number, signal: 0) => void;
  }> = {},
): { factory: ReturnType<typeof createMobileSimulatorSessionFactory>; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const factory = createMobileSimulatorSessionFactory({
    exec: async (command, args, opts) => {
      calls.push({ command, args: [...args], timeoutMs: opts?.timeoutMs });
      const outcome = respond(command, args);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    platform: overrides.platform ?? 'darwin',
    pid: overrides.pid ?? 4711,
    ...(overrides.processKill ? { processKill: overrides.processKill } : {}),
    now: () => Date.parse('2026-09-17T16:00:00.000Z'),
  });
  return { factory, calls };
}

function readMarker(dataDir: string, requestId: string): SimulatorOwnerMarker {
  const raw = readFileSync(join(dataDir, VERIFY_MOBILE_DIRNAME, requestId, 'owner.json'), 'utf8');
  return JSON.parse(raw) as SimulatorOwnerMarker;
}

function writeMarker(dataDir: string, requestId: string, marker: SimulatorOwnerMarker): string {
  const dir = join(dataDir, VERIFY_MOBILE_DIRNAME, requestId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'owner.json'), JSON.stringify(marker), 'utf8');
  return dir;
}

describe('compareSimVersions', () => {
  it('compares numerically, not lexicographically', () => {
    expect(compareSimVersions('26.2', '9.10')).toBeGreaterThan(0);
    expect(compareSimVersions('18.0', '18.1')).toBeLessThan(0);
    expect(compareSimVersions('26.2', '26.2')).toBe(0);
  });
});

describe('pickNewestIPhone', () => {
  it('ranks by model number, ignoring non-iPhone families', () => {
    const picked = pickNewestIPhone([
      { productFamily: 'iPhone', name: 'iPhone 16e', identifier: 'a' },
      { productFamily: 'iPad', name: 'iPad Pro', identifier: 'b' },
      { productFamily: 'iPhone', name: 'iPhone 17 Pro', identifier: 'c' },
      { productFamily: 'iPhone', name: 'iPhone SE (3rd generation)', identifier: 'd' },
    ]);
    expect(picked).toEqual({ id: 'c', name: 'iPhone 17 Pro' });
  });

  it('is null when no iPhone is present', () => {
    expect(pickNewestIPhone([{ productFamily: 'iPad', name: 'iPad Pro', identifier: 'b' }])).toBeNull();
  });
});

describe('resolveSimTarget — the intersection is load-bearing', () => {
  it('picks the newest AVAILABLE runtime and an iPhone that runtime supports', () => {
    const target = resolveSimTarget(JSON.parse(simctlListJson()));
    expect(target.runtimeId).toBe(IOS_26_2);
    expect(target.runtimeName).toBe('iOS 26.2');
    expect(target.deviceTypeId).toBe(IPHONE_17);
    // NEVER the ancient device sitting in the flat devicetypes list.
    expect(target.deviceTypeId).not.toContain('6s');
  });

  it('honours a runtime pin by identifier or by name', () => {
    expect(resolveSimTarget(JSON.parse(simctlListJson()), { runtime: IOS_26_2 }).runtimeId).toBe(IOS_26_2);
    expect(resolveSimTarget(JSON.parse(simctlListJson()), { runtime: 'iOS 26.2' }).runtimeId).toBe(IOS_26_2);
  });

  it('refuses a pinned runtime that is not available', () => {
    expect(() => resolveSimTarget(JSON.parse(simctlListJson()), { runtime: 'iOS 18.0' })).toThrow(
      /not installed or not available/,
    );
  });

  it('refuses a pinned device type the runtime does not support', () => {
    expect(() =>
      resolveSimTarget(JSON.parse(simctlListJson()), { deviceType: 'iPhone 6s Plus' }),
    ).toThrow(/not compatible with iOS 26.2/);
  });

  it('falls back to the flat devicetypes list when a runtime publishes none', () => {
    const list = JSON.parse(simctlListJson()) as {
      runtimes: Array<{ supportedDeviceTypes?: unknown }>;
    };
    delete list.runtimes[1].supportedDeviceTypes;
    expect(resolveSimTarget(list).deviceTypeId).toBe(IPHONE_17);
  });
});

describe('acquire — the happy path', () => {
  it('emits the exact argv sequence, writes the marker before create, stamps the udid after', async () => {
    const dataDir = makeDataDir();
    const markerAtCreate: SimulatorOwnerMarker[] = [];
    const { factory, calls } = makeFactory((command, args) => {
      if (command === 'xcrun' && args[1] === 'create') {
        markerAtCreate.push(readMarker(dataDir, 'req-1'));
      }
      return happyResponder(command, args);
    });

    const handle = await factory.acquire({
      requestId: 'req-1',
      dataDir,
      bootTimeoutMs: 180_000,
    });

    expect(calls.map((c) => [c.command, ...c.args].join(' '))).toEqual([
      'ps -o lstart= -p 4711',
      'xcrun simctl list -j',
      `xcrun simctl create ${VERIFY_SIM_NAME_PREFIX}req-1 ${IPHONE_17} ${IOS_26_2}`,
      `xcrun simctl boot ${CREATED_UDID}`,
      `xcrun simctl bootstatus ${CREATED_UDID} -b`,
      `xcrun simctl status_bar ${CREATED_UDID} override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4`,
      `xcrun simctl ui ${CREATED_UDID} appearance light`,
    ]);

    // The marker existed, and carried NO udid, at the instant the device was created.
    expect(markerAtCreate).toHaveLength(1);
    expect(markerAtCreate[0]).toMatchObject({
      pid: 4711,
      pidStartedAt: 'Wed Sep 17 09:00:00 2026',
      simName: `${VERIFY_SIM_NAME_PREFIX}req-1`,
      simUdid: null,
      requestId: 'req-1',
    });

    const after = readMarker(dataDir, 'req-1');
    expect(after.simUdid).toBe(CREATED_UDID);
    expect(after.simName).toBe(`${VERIFY_SIM_NAME_PREFIX}req-1`);

    expect(handle.udid).toBe(CREATED_UDID);
    expect(handle.runtimeName).toBe('iOS 26.2');
    expect(handle.deviceTypeId).toBe(IPHONE_17);
    expect(handle.requestDir).toBe(join(dataDir, VERIFY_MOBILE_DIRNAME, 'req-1'));
    // Fresh AND EMPTY — an inherited DerivedData is a corrupted build.
    expect(existsSync(handle.derivedDataDir)).toBe(true);
    expect(readdirSync(handle.derivedDataDir)).toEqual([]);
  });

  it('gives bootstatus the caller’s boot budget and everything else the standard bound', async () => {
    const dataDir = makeDataDir();
    const { factory, calls } = makeFactory(happyResponder);
    await factory.acquire({ requestId: 'req-1', dataDir, bootTimeoutMs: 180_000 });
    const bootstatus = calls.find((c) => c.args[1] === 'bootstatus');
    expect(bootstatus?.timeoutMs).toBe(180_000);
    for (const call of calls.filter((c) => c.args[1] !== 'bootstatus')) {
      expect(call.timeoutMs).toBe(15_000);
    }
  });

  it('names ONLY the udid it created — no other device identifier ever appears', async () => {
    const dataDir = makeDataDir();
    const { factory, calls } = makeFactory((command, args) => {
      if (command === 'xcrun' && args[1] === 'list' && args[3] === 'devices') {
        return ok(
          devicesJson([
            { name: `${VERIFY_SIM_NAME_PREFIX}req-1`, udid: CREATED_UDID },
            { name: `${VERIFY_SIM_NAME_PREFIX}other`, udid: FOREIGN_UDID },
          ]),
        );
      }
      return happyResponder(command, args);
    });
    const handle = await factory.acquire({ requestId: 'req-1', dataDir, bootTimeoutMs: 1_000 });
    await handle.dispose();
    for (const call of calls) {
      expect(call.args).not.toContain(FOREIGN_UDID);
      expect(call.args).not.toContain('DECOY-not-ours');
    }
  });

  it('honours device-type and runtime pins', async () => {
    const dataDir = makeDataDir();
    const { factory, calls } = makeFactory(happyResponder);
    await factory.acquire({
      requestId: 'req-1',
      dataDir,
      bootTimeoutMs: 1_000,
      runtime: 'iOS 26.2',
      deviceType: 'iPhone 16e',
    });
    const create = calls.find((c) => c.args[1] === 'create');
    expect(create?.args[3]).toBe('com.apple.CoreSimulator.SimDeviceType.iPhone-16e');
    expect(create?.args[4]).toBe(IOS_26_2);
  });

  it('does not let a failed status-bar override fail the acquire', async () => {
    const dataDir = makeDataDir();
    const { factory } = makeFactory((command, args) => {
      if (command === 'xcrun' && (args[1] === 'status_bar' || args[1] === 'ui')) {
        return new Error('simctl status_bar is unavailable on this runtime');
      }
      return happyResponder(command, args);
    });
    const handle = await factory.acquire({ requestId: 'req-1', dataDir, bootTimeoutMs: 1_000 });
    expect(handle.udid).toBe(CREATED_UDID);
  });
});

describe('acquire — rollback', () => {
  it('deletes the device and removes the request dir when the boot times out', async () => {
    const dataDir = makeDataDir();
    const { factory, calls } = makeFactory((command, args) => {
      if (command === 'xcrun' && args[1] === 'bootstatus') {
        return new Error('xcrun timed out after 180000ms');
      }
      return happyResponder(command, args);
    });

    await expect(
      factory.acquire({ requestId: 'req-1', dataDir, bootTimeoutMs: 180_000 }),
    ).rejects.toThrow(/acquire failed at simctl bootstatus: xcrun timed out after 180000ms/);

    const emitted = calls.map((c) => c.args.join(' '));
    expect(emitted).toContain(`simctl shutdown ${CREATED_UDID}`);
    expect(emitted).toContain(`simctl delete ${CREATED_UDID}`);
    expect(existsSync(join(dataDir, VERIFY_MOBILE_DIRNAME, 'req-1'))).toBe(false);
  });

  it('keeps the original failure as the cause', async () => {
    const dataDir = makeDataDir();
    const boom = new Error('xcrun timed out after 180000ms');
    const { factory } = makeFactory((command, args) => {
      if (command === 'xcrun' && args[1] === 'boot') return boom;
      return happyResponder(command, args);
    });
    await expect(
      factory.acquire({ requestId: 'req-1', dataDir, bootTimeoutMs: 1_000 }),
    ).rejects.toMatchObject({ cause: boom });
  });

  it('removes only the request dir when it fails BEFORE any device exists', async () => {
    const dataDir = makeDataDir();
    const { factory, calls } = makeFactory((command, args) => {
      if (command === 'xcrun' && args[1] === 'list') return ok('{ not json');
      return happyResponder(command, args);
    });
    await expect(
      factory.acquire({ requestId: 'req-1', dataDir, bootTimeoutMs: 1_000 }),
    ).rejects.toThrow(/acquire failed at simctl list/);
    expect(calls.some((c) => c.args.includes('delete'))).toBe(false);
    expect(existsSync(join(dataDir, VERIFY_MOBILE_DIRNAME, 'req-1'))).toBe(false);
  });

  it('rolls back when no compatible iPhone resolves, naming the reason', async () => {
    const dataDir = makeDataDir();
    const { factory } = makeFactory((command, args) => {
      if (command === 'xcrun' && args[1] === 'list') {
        return ok(JSON.stringify({ runtimes: [], devicetypes: [], devices: {} }));
      }
      return happyResponder(command, args);
    });
    await expect(
      factory.acquire({ requestId: 'req-1', dataDir, bootTimeoutMs: 1_000 }),
    ).rejects.toThrow(/no available iOS simulator runtime is installed/);
  });
});

describe('dispose', () => {
  it('shuts down, deletes and removes the request dir', async () => {
    const dataDir = makeDataDir();
    const { factory, calls } = makeFactory(happyResponder);
    const handle = await factory.acquire({ requestId: 'req-1', dataDir, bootTimeoutMs: 1_000 });
    calls.length = 0;
    await handle.dispose();
    expect(calls.map((c) => c.args.join(' '))).toEqual([
      `simctl shutdown ${CREATED_UDID}`,
      `simctl delete ${CREATED_UDID}`,
    ]);
    expect(existsSync(handle.requestDir)).toBe(false);
  });

  it('is idempotent — a second call does nothing', async () => {
    const dataDir = makeDataDir();
    const { factory, calls } = makeFactory(happyResponder);
    const handle = await factory.acquire({ requestId: 'req-1', dataDir, bootTimeoutMs: 1_000 });
    await handle.dispose();
    calls.length = 0;
    await handle.dispose();
    expect(calls).toHaveLength(0);
  });

  it('swallows every failure — a teardown must never mask a verdict', async () => {
    const dataDir = makeDataDir();
    const { factory } = makeFactory((command, args) => {
      if (command === 'xcrun' && (args[1] === 'shutdown' || args[1] === 'delete')) {
        return new Error('CoreSimulator service went away');
      }
      return happyResponder(command, args);
    });
    const handle = await factory.acquire({ requestId: 'req-1', dataDir, bootTimeoutMs: 1_000 });
    await expect(handle.dispose()).resolves.toBeUndefined();
  });

  it('still removes the request dir when the device commands fail', async () => {
    const dataDir = makeDataDir();
    const { factory } = makeFactory((command, args) => {
      if (command === 'xcrun' && args[1] === 'shutdown') return fail(164, 'Invalid device');
      return happyResponder(command, args);
    });
    const handle = await factory.acquire({ requestId: 'req-1', dataDir, bootTimeoutMs: 1_000 });
    await handle.dispose();
    expect(existsSync(handle.requestDir)).toBe(false);
  });
});

describe('sweepStaleSimulators', () => {
  const deadMarker = (requestId: string, udid: string | null): SimulatorOwnerMarker => ({
    pid: 9001,
    pidStartedAt: 'Tue Sep 16 08:00:00 2026',
    simName: `${VERIFY_SIM_NAME_PREFIX}${requestId}`,
    simUdid: udid,
    requestId,
    createdAt: '2026-09-16T08:00:00.000Z',
  });

  it('returns immediately off darwin, spawning nothing', async () => {
    const { factory, calls } = makeFactory(
      () => {
        throw new Error('the sweep must not spawn anything off darwin');
      },
      { platform: 'win32' },
    );
    await expect(factory.sweepStaleSimulators({ dataDir: makeDataDir() })).resolves.toEqual({
      deleted: [],
      skipped: [],
    });
    expect(calls).toHaveLength(0);
  });

  it('deletes the device and the dir when the owning pid is gone', async () => {
    const dataDir = makeDataDir();
    const dir = writeMarker(dataDir, 'dead-1', deadMarker('dead-1', CREATED_UDID));
    const { factory, calls } = makeFactory(
      (command, args) => {
        if (command === 'xcrun' && args[1] === 'list' && args[3] === 'devices') {
          return ok(devicesJson([{ name: `${VERIFY_SIM_NAME_PREFIX}dead-1`, udid: CREATED_UDID }]));
        }
        return happyResponder(command, args);
      },
      {
        processKill: () => {
          const err: NodeJS.ErrnoException = new Error('kill ESRCH');
          err.code = 'ESRCH';
          throw err;
        },
      },
    );

    const result = await factory.sweepStaleSimulators({ dataDir });
    expect(result.deleted).toEqual([CREATED_UDID]);
    expect(result.skipped).toEqual([]);
    const emitted = calls.map((c) => c.args.join(' '));
    expect(emitted).toContain(`simctl shutdown ${CREATED_UDID}`);
    expect(emitted).toContain(`simctl delete ${CREATED_UDID}`);
    expect(existsSync(dir)).toBe(false);
  });

  it('looks the udid up by name when the marker never got one stamped', async () => {
    const dataDir = makeDataDir();
    writeMarker(dataDir, 'dead-2', deadMarker('dead-2', null));
    const { factory } = makeFactory(
      (command, args) => {
        if (command === 'xcrun' && args[1] === 'list' && args[3] === 'devices') {
          return ok(devicesJson([{ name: `${VERIFY_SIM_NAME_PREFIX}dead-2`, udid: CREATED_UDID }]));
        }
        return happyResponder(command, args);
      },
      {
        processKill: () => {
          throw new Error('kill ESRCH');
        },
      },
    );
    const result = await factory.sweepStaleSimulators({ dataDir });
    expect(result.deleted).toEqual([CREATED_UDID]);
  });

  it('skips a LIVE owner: same pid, same start time', async () => {
    const dataDir = makeDataDir();
    const dir = writeMarker(dataDir, 'live-1', {
      ...deadMarker('live-1', CREATED_UDID),
      pidStartedAt: 'Wed Sep 17 09:00:00 2026',
    });
    const { factory, calls } = makeFactory(
      (command, args) => {
        if (command === 'ps') return ok('Wed Sep 17 09:00:00 2026\n');
        if (command === 'xcrun' && args[1] === 'list' && args[3] === 'devices') {
          return ok(devicesJson([{ name: `${VERIFY_SIM_NAME_PREFIX}live-1`, udid: CREATED_UDID }]));
        }
        return happyResponder(command, args);
      },
      { processKill: () => undefined },
    );

    const result = await factory.sweepStaleSimulators({ dataDir });
    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual(['marker:live-1']);
    expect(calls.some((c) => c.args.includes('delete'))).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  it('treats a REUSED pid as dead: the pid lives but its start time moved', async () => {
    const dataDir = makeDataDir();
    writeMarker(dataDir, 'reused-1', {
      ...deadMarker('reused-1', CREATED_UDID),
      pidStartedAt: 'Tue Sep 16 08:00:00 2026',
    });
    const { factory } = makeFactory(
      (command, args) => {
        if (command === 'ps') return ok('Wed Sep 17 09:00:00 2026\n');
        if (command === 'xcrun' && args[1] === 'list' && args[3] === 'devices') {
          return ok(devicesJson([{ name: `${VERIFY_SIM_NAME_PREFIX}reused-1`, udid: CREATED_UDID }]));
        }
        return happyResponder(command, args);
      },
      { processKill: () => undefined },
    );
    const result = await factory.sweepStaleSimulators({ dataDir });
    expect(result.deleted).toEqual([CREATED_UDID]);
  });

  it('leaves a cyboflow-verify device alone when no marker under this data dir claims it', async () => {
    const dataDir = makeDataDir();
    const { factory, calls } = makeFactory(
      (command, args) => {
        if (command === 'xcrun' && args[1] === 'list' && args[3] === 'devices') {
          return ok(
            devicesJson([{ name: `${VERIFY_SIM_NAME_PREFIX}someone-else`, udid: FOREIGN_UDID }]),
          );
        }
        return happyResponder(command, args);
      },
      { processKill: () => undefined },
    );
    const result = await factory.sweepStaleSimulators({ dataDir });
    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual([`device:${VERIFY_SIM_NAME_PREFIX}someone-else`]);
    for (const call of calls) expect(call.args).not.toContain(FOREIGN_UDID);
  });

  it('leaves an unreadable marker alone rather than guessing its owner is dead', async () => {
    const dataDir = makeDataDir();
    const dir = join(dataDir, VERIFY_MOBILE_DIRNAME, 'corrupt-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner.json'), '{ this is not json', 'utf8');
    const { factory, calls } = makeFactory(
      (command, args) => {
        if (command === 'xcrun' && args[1] === 'list' && args[3] === 'devices') return ok(devicesJson([]));
        return happyResponder(command, args);
      },
      {
        processKill: () => {
          throw new Error('kill ESRCH');
        },
      },
    );
    const result = await factory.sweepStaleSimulators({ dataDir });
    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual(['marker:corrupt-1']);
    expect(calls.some((c) => c.args.includes('delete'))).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  it('never throws when the data dir has no verify-mobile tree at all', async () => {
    const { factory } = makeFactory((command, args) => {
      if (command === 'xcrun' && args[1] === 'list' && args[3] === 'devices') return ok(devicesJson([]));
      return happyResponder(command, args);
    });
    await expect(factory.sweepStaleSimulators({ dataDir: makeDataDir() })).resolves.toEqual({
      deleted: [],
      skipped: [],
    });
  });
});
