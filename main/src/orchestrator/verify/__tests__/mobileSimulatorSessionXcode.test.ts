/**
 * mobileSimulatorSession — the Stage 3 xcode-rung additions
 * (docs/proposals/runbook-optional-verification.md §B3, §B4.2, §B4.9):
 *  - `minRuntimeMajor`: the iOS 27 floor DeviceInteraction needs, and the
 *    distinct error the runner retries without it on;
 *  - `recordXcodeSessionKey`: the session key reaches `owner.json` (and a
 *    failed write rejects, so the runner never starts an unrecorded session);
 *  - the sweep ends a dead owner's session BEFORE destroying its device.
 *
 * Same posture as mobileSimulatorSession.test.ts: a scripted exec, a real
 * mkdtemp filesystem.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIN_RUNTIME_UNSATISFIED_PREFIX,
  VERIFY_MOBILE_DIRNAME,
  VERIFY_SIM_NAME_PREFIX,
  createMobileSimulatorSessionFactory,
  resolveSimTarget,
  type AppleCliExecResult,
  type SimulatorOwnerMarker,
} from '../mobileSimulatorSession';

const UDID = 'A1B2C3D4-0000-4000-8000-000000000027';
const IOS_26 = 'com.apple.CoreSimulator.SimRuntime.iOS-26-2';
const IOS_27 = 'com.apple.CoreSimulator.SimRuntime.iOS-27-0';
const IPHONE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro';

const ok = (stdout = ''): AppleCliExecResult => ({ stdout, stderr: '', code: 0 });

const dirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cyboflow-sim-xcode-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

function runtime(id: string, version: string): Record<string, unknown> {
  return {
    platform: 'iOS',
    name: `iOS ${version}`,
    identifier: id,
    version,
    isAvailable: true,
    supportedDeviceTypes: [{ productFamily: 'iPhone', name: 'iPhone 17 Pro', identifier: IPHONE }],
  };
}

function listJson(runtimes: Array<Record<string, unknown>>): unknown {
  return { runtimes, devicetypes: [], devices: {} };
}

describe('resolveSimTarget — minRuntimeMajor (§B3)', () => {
  const both = listJson([runtime(IOS_26, '26.2'), runtime(IOS_27, '27.0')]);

  it('with no floor the newest runtime wins, as before', () => {
    expect(resolveSimTarget(both).runtimeId).toBe(IOS_27);
  });

  it('with a floor, never picks an older runtime even when it is the only other choice', () => {
    expect(resolveSimTarget(both, { minRuntimeMajor: 27 }).runtimeId).toBe(IOS_27);
  });

  it('throws the recognisable prefix when nothing installed meets the floor', () => {
    const only26 = listJson([runtime(IOS_26, '26.2')]);
    expect(() => resolveSimTarget(only26, { minRuntimeMajor: 27 })).toThrow(MIN_RUNTIME_UNSATISFIED_PREFIX);
  });

  it('applies the floor to a PINNED runtime too', () => {
    expect(() => resolveSimTarget(both, { runtime: IOS_26, minRuntimeMajor: 27 })).toThrow(
      MIN_RUNTIME_UNSATISFIED_PREFIX,
    );
    expect(resolveSimTarget(both, { runtime: IOS_27, minRuntimeMajor: 27 }).runtimeId).toBe(IOS_27);
  });
});

function factoryFor(
  opts: { list?: unknown; ownerDead?: boolean; endXcodeSession?: (key: string) => Promise<void> } = {},
): { factory: ReturnType<typeof createMobileSimulatorSessionFactory>; calls: string[] } {
  const calls: string[] = [];
  const factory = createMobileSimulatorSessionFactory({
    exec: async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'ps') return ok('Wed Sep 17 09:00:00 2026\n');
      if (args[1] === 'list' && args[3] === 'devices') return ok(JSON.stringify({ devices: {} }));
      if (args[1] === 'list') return ok(JSON.stringify(opts.list ?? listJson([runtime(IOS_27, '27.0')])));
      if (args[1] === 'create') return ok(`${UDID}\n`);
      return ok();
    },
    platform: 'darwin',
    pid: 4711,
    processKill: () => {
      if (opts.ownerDead) throw new Error('kill ESRCH');
    },
    ...(opts.endXcodeSession ? { endXcodeSession: opts.endXcodeSession } : {}),
  });
  return { factory, calls };
}

describe('acquire — minRuntimeMajor reaches the target resolution', () => {
  it('rolls back with the recognisable prefix when the host has no iOS 27 runtime', async () => {
    const { factory, calls } = factoryFor({ list: listJson([runtime(IOS_26, '26.2')]) });
    await expect(
      factory.acquire({ requestId: 'req-x', dataDir: dataDir(), bootTimeoutMs: 1000, minRuntimeMajor: 27 }),
    ).rejects.toThrow(MIN_RUNTIME_UNSATISFIED_PREFIX);
    expect(calls.some((c) => c.includes('simctl create'))).toBe(false);
  });

  it('creates the device on the iOS 27 runtime when the floor is met', async () => {
    const { factory, calls } = factoryFor({ list: listJson([runtime(IOS_26, '26.2'), runtime(IOS_27, '27.0')]) });
    const handle = await factory.acquire({
      requestId: 'req-y',
      dataDir: dataDir(),
      bootTimeoutMs: 1000,
      minRuntimeMajor: 27,
    });
    expect(handle.runtimeId).toBe(IOS_27);
    expect(calls).toContain(`xcrun simctl create ${VERIFY_SIM_NAME_PREFIX}req-y ${IPHONE} ${IOS_27}`);
  });
});

describe('recordXcodeSessionKey (§B4.2)', () => {
  it('stamps the key into owner.json alongside the udid', async () => {
    const dir = dataDir();
    const { factory } = factoryFor();
    const handle = await factory.acquire({ requestId: 'req-k', dataDir: dir, bootTimeoutMs: 1000 });
    await handle.recordXcodeSessionKey('Cyboflow Verify 00ff');
    const marker = JSON.parse(
      readFileSync(join(dir, VERIFY_MOBILE_DIRNAME, 'req-k', 'owner.json'), 'utf8'),
    ) as SimulatorOwnerMarker;
    expect(marker.xcodeSessionKey).toBe('Cyboflow Verify 00ff');
    expect(marker.simUdid).toBe(UDID);
  });

  it('rejects when the marker cannot be written, so no unrecorded session is started', async () => {
    const dir = dataDir();
    const { factory } = factoryFor();
    const handle = await factory.acquire({ requestId: 'req-ro', dataDir: dir, bootTimeoutMs: 1000 });
    rmSync(handle.requestDir, { recursive: true, force: true });
    await expect(handle.recordXcodeSessionKey('Cyboflow Verify dead')).rejects.toThrow();
  });
});

describe('retainXcodeSessionKey (X-2)', () => {
  it('keeps the key past dispose, where a dead-owner sweep ends it and reclaims the marker', async () => {
    const dir = dataDir();
    const ended: string[] = [];
    const { factory } = factoryFor({
      ownerDead: true,
      endXcodeSession: async (key) => {
        ended.push(key);
      },
    });
    const handle = await factory.acquire({ requestId: 'req-lost', dataDir: dir, bootTimeoutMs: 1000 });
    await handle.recordXcodeSessionKey('Cyboflow Verify lost');
    await handle.retainXcodeSessionKey?.('Cyboflow Verify lost');
    await handle.dispose();

    // The request dir (and its owner.json) is gone; the retained marker is not.
    const root = join(dir, VERIFY_MOBILE_DIRNAME);
    const left = readdirSync(root);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^req-lost\.xcode-[0-9a-f]{12}$/);
    const marker = JSON.parse(readFileSync(join(root, left[0], 'owner.json'), 'utf8')) as SimulatorOwnerMarker;
    expect(marker).toMatchObject({ xcodeSessionKey: 'Cyboflow Verify lost', simUdid: UDID, pid: 4711 });

    await factory.sweepStaleSimulators({ dataDir: dir });
    expect(ended).toEqual(['Cyboflow Verify lost']);
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('sweepStaleSimulators — ends a dead owner’s Xcode session first (§B4.9)', () => {
  function writeDeadMarker(dir: string, marker: Partial<SimulatorOwnerMarker>): void {
    const requestDir = join(dir, VERIFY_MOBILE_DIRNAME, 'dead-x');
    mkdirSync(requestDir, { recursive: true });
    const full: SimulatorOwnerMarker = {
      pid: 9001,
      pidStartedAt: '',
      simName: `${VERIFY_SIM_NAME_PREFIX}dead-x`,
      simUdid: UDID,
      requestId: 'dead-x',
      createdAt: '2026-09-16T08:00:00.000Z',
      ...marker,
    };
    writeFileSync(join(requestDir, 'owner.json'), JSON.stringify(full));
  }

  it('calls EndSession with the marker key before destroying the device', async () => {
    const dir = dataDir();
    writeDeadMarker(dir, { xcodeSessionKey: 'Cyboflow Verify abc' });
    const order: string[] = [];
    const { factory, calls } = factoryFor({
      ownerDead: true,
      endXcodeSession: async (key) => {
        order.push(`end ${key}`);
        order.push(`calls-before-end=${calls.filter((c) => c.includes('simctl delete')).length}`);
      },
    });
    const result = await factory.sweepStaleSimulators({ dataDir: dir });
    expect(result.deleted).toEqual([UDID]);
    expect(order).toEqual(['end Cyboflow Verify abc', 'calls-before-end=0']);
  });

  it('still reclaims the device when EndSession rejects', async () => {
    const dir = dataDir();
    writeDeadMarker(dir, { xcodeSessionKey: 'Cyboflow Verify abc' });
    const { factory } = factoryFor({
      ownerDead: true,
      endXcodeSession: async () => {
        throw new Error("This agent isn't approved to use Xcode's tools yet");
      },
    });
    const result = await factory.sweepStaleSimulators({ dataDir: dir });
    expect(result.deleted).toEqual([UDID]);
  });

  it('never calls EndSession for a marker that carries no key', async () => {
    const dir = dataDir();
    writeDeadMarker(dir, {});
    let ended = 0;
    const { factory } = factoryFor({
      ownerDead: true,
      endXcodeSession: async () => {
        ended += 1;
      },
    });
    await factory.sweepStaleSimulators({ dataDir: dir });
    expect(ended).toBe(0);
  });
});
