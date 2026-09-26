/**
 * xcodeDriveSession unit tests (docs/proposals/runbook-optional-verification.md
 * §B4, §B5, §B7).
 *
 * WHAT IS REAL: the bridge client (over the schema-validating fake child in
 * fakeMcpBridge.ts — a wrong argument key fails the call), the drive socket
 * (a real unix socket in a tmp data dir, driven with the driver's own
 * `sendDriveFrame`), the hierarchy parser, the ledger, and the filesystem
 * (captures are really copied and hashed). WHAT IS FAKED: the bridge child,
 * and `isProcessAlive` — the pin's liveness is scripted per test.
 *
 * NO real `xcrun mcpbridge` is ever spawned.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MOBILE_EXIT_APP_EXITED,
  MOBILE_EXIT_OK,
  MOBILE_EXIT_REFUSED,
  MOBILE_EXIT_TARGET_UNRESOLVED,
} from '../../driver/mobileCommands';
import { createXcodeMcpBridgeClient, type XcodeMcpBridgeClientOptions } from '../xcodeMcpBridgeClient';
import {
  VERIFY_XCODE_DRIVE_SOCKET_ENV,
  VERIFY_XCODE_DRIVE_TOKEN_ENV,
  sendDriveFrame,
  type DriveResponse,
} from '../xcodeDriveSocketServer';
import {
  endXcodeSessionBestEffort,
  HOME_BUTTON_COMMAND,
  openXcodeDriveSession,
  RETURN_KEY_COMMAND,
  type OpenXcodeDriveSessionOptions,
  type XcodeDriveSession,
} from '../xcodeDriveSession';
import { END_OK, FakeBridge, START_OK, type FakeBridgeOptions, type ToolScript } from './fakeMcpBridge';

const UDID = 'D473B910-328C-443D-93D8-B241052F57CD';
const BUNDLE = 'com.acme.app';
const KEY = 'Cyboflow Verify 0123456789abcdef0123456789abcdef';

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
const sessions: XcodeDriveSession[] = [];
afterEach(async () => {
  while (sessions.length > 0) await (sessions.pop() as XcodeDriveSession).close();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

interface AppView {
  /** The app block's pid, or `null` to omit the block entirely. */
  pid: number | null;
  /** Extra element lines for the app's block. */
  elements?: string[];
  state?: string;
}

function hierarchyText(view: AppView): string {
  const lines = ['Device orientation: Unknown', '------------------------'];
  if (view.pid === null) {
    lines.push(
      'Application bundle identifier: com.apple.springboard',
      'Application UI orientation: Portrait',
      "Application, pid: 55, label: ' '",
      ' Window, {{0.0, 0.0}, {402.0, 874.0}}, hitPoint: {201.0, 437.0}',
    );
  } else {
    lines.push(
      `Application bundle identifier: ${BUNDLE}`,
      'Application UI orientation: Portrait',
      `Application, pid: ${view.pid}, label: 'Acme'`,
      ' Window, {{0.0, 0.0}, {402.0, 874.0}}, hitPoint: {201.0, 437.0}',
      ...(view.elements ?? [
        "  Button, {{16.0, 380.3}, {370.0, 52.0}}, identifier: 'general', label: 'General', hitPoint: {201.0, 406.3}",
      ]),
    );
  }
  return `${lines.join('\n')}\n`;
}

interface World {
  bridge: FakeBridge;
  options: OpenXcodeDriveSessionOptions;
  /** Every Synthesize's arguments, in order. */
  synths: Array<Record<string, unknown>>;
  /** Mutable: what the next Synthesize shows. */
  view: AppView;
  alive: Set<number>;
  order: string[];
  artifactsDir: string;
}

function makeWorld(tools: Partial<Record<string, ToolScript>> = {}, fake: FakeBridgeOptions = {}): World {
  const toolDir = tmp('cf-xd-tool-');
  const artifactsDir = tmp('cf-xd-art-');
  const dataDir = tmp('cf-xd-');
  const synths: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  let n = 0;
  const world: Partial<World> = { synths, order, artifactsDir, alive: new Set<number>(), view: { pid: 4321 } };
  const synth: ToolScript = (args) => {
    synths.push(args);
    order.push(`synth ${String(args.interactionCommand ?? '')}`);
    n += 1;
    const shot = join(toolDir, `shot-${n}.png`);
    const hier = join(toolDir, `hier-${n}.txt`);
    const logs = join(toolDir, `logs-${n}.txt`);
    writeFileSync(shot, `png-bytes-${n}`);
    writeFileSync(hier, hierarchyText(world.view as AppView));
    writeFileSync(logs, 'Acme[4321]: fatal error: Index out of range\n');
    return {
      structured: {
        applicationState: (world.view as AppView).state ?? 'NotRun',
        screenshotPath: shot,
        thumbnailScreenshotPath: shot,
        hierarchyPath: hier,
        logsPath: logs,
      },
    };
  };
  const bridge = new FakeBridge({
    tools: {
      DeviceInteractionStartSession: (args) => {
        order.push('start');
        return (START_OK as ToolScript)(args);
      },
      DeviceInteractionSynthesize: synth,
      DeviceInteractionEndSession: (args) => {
        order.push('end');
        return END_OK(args);
      },
      ...tools,
    } as Record<string, ToolScript>,
    ...fake,
  });
  const options: OpenXcodeDriveSessionOptions = {
    requestId: 'vr-1',
    udid: UDID,
    appBundleId: BUNDLE,
    dataDir,
    artifactsDir,
    recordSessionKey: async (key) => {
      order.push(`record ${key}`);
    },
    createClient: (opts: XcodeMcpBridgeClientOptions) =>
      createXcodeMcpBridgeClient({ ...opts, spawn: () => bridge, killGraceMs: 40 }),
    isProcessAlive: (pid) => (world.alive as Set<number>).has(pid),
    mintSessionIdentifier: () => KEY,
    teardownStepTimeoutMs: 300,
  };
  world.bridge = bridge;
  world.options = options;
  return world as World;
}

async function open(world: World): Promise<XcodeDriveSession> {
  const result = await openXcodeDriveSession(world.options);
  if (!result.ok) throw new Error(`expected an open session, got ${result.degradeReason}: ${result.detail}`);
  sessions.push(result.session);
  return result.session;
}

function verb(session: XcodeDriveSession, name: string, args: Record<string, unknown> = {}): Promise<DriveResponse> {
  return sendDriveFrame(
    session.env[VERIFY_XCODE_DRIVE_SOCKET_ENV] as string,
    session.env[VERIFY_XCODE_DRIVE_TOKEN_ENV] as string,
    name,
    args,
    5_000,
  );
}

describe('openXcodeDriveSession — the §B4.2 order', () => {
  it('records the key in owner.json BEFORE StartSession, and starts on the leased udid', async () => {
    const world = makeWorld();
    const session = await open(world);
    expect(world.order.slice(0, 2)).toEqual([`record ${KEY}`, 'start']);
    const start = world.bridge.calls.find((c) => c.name === 'DeviceInteractionStartSession');
    expect(start?.arguments).toEqual({ deviceIdentifier: UDID, sessionIdentifier: KEY });
    expect(session.env.VERIFY_MOBILE_DRIVE).toBe('xcode');
    expect(existsSync(session.env[VERIFY_XCODE_DRIVE_SOCKET_ENV] as string)).toBe(true);
    expect((session.env[VERIFY_XCODE_DRIVE_TOKEN_ENV] as string).length).toBeGreaterThanOrEqual(32);
  });

  it('a marker that cannot be written spawns nothing and degrades', async () => {
    const world = makeWorld();
    world.options.recordSessionKey = async () => {
      throw new Error('EACCES');
    };
    const result = await openXcodeDriveSession(world.options);
    expect(result).toMatchObject({ ok: false, degradeReason: 'xcode-session-failed' });
    expect(world.bridge.received).toHaveLength(0);
  });

  it('an unapproved client degrades with xcode-approval-missing and reaps the bridge', async () => {
    const world = makeWorld({
      DeviceInteractionStartSession: () => ({ toolError: "This agent isn't approved to use Xcode's tools yet" }),
    });
    const result = await openXcodeDriveSession(world.options);
    expect(result).toMatchObject({ ok: false, degradeReason: 'xcode-approval-missing' });
    expect(world.bridge.signals).toContain('SIGTERM');
  });

  it('a session bound to ANOTHER device is ended and degraded, never driven', async () => {
    const world = makeWorld({
      DeviceInteractionStartSession: (args) => ({
        structured: {
          interactionSessionKey: args.sessionIdentifier,
          deviceUUID: 'FFFFFFFF-0000-0000-0000-000000000000',
          deviceIsSimulator: true,
          skillToTrigger: 'device-interaction',
          summary: '…',
        },
      }),
    });
    const result = await openXcodeDriveSession(world.options);
    expect(result).toMatchObject({ ok: false, degradeReason: 'xcode-session-failed' });
    expect(world.bridge.calls.map((c) => c.name)).toContain('DeviceInteractionEndSession');
    expect(world.bridge.signals).toContain('SIGTERM');
  });
});

describe('verbs over the socket (§B4.5)', () => {
  it('mobile-capture synthesizes with NO command and NO activation, and records a hashed copy in the ledger', async () => {
    const world = makeWorld();
    const session = await open(world);
    const res = await verb(session, 'capture', { name: 'home' });
    expect(res).toMatchObject({ ok: true, exit: MOBILE_EXIT_OK, screenshot: 'home.png', pid: 4321 });
    expect(world.synths[0]).toEqual({ interactSessionKey: KEY });
    const bytes = readFileSync(join(world.artifactsDir, 'home.png'));
    const entry = session.ledger.entries[0];
    expect(entry).toMatchObject({
      kind: 'capture',
      name: 'home.png',
      verb: 'mobile-capture',
      foregroundBundleId: BUNDLE,
      pid: 4321,
      activated: false,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });

  it('mobile-tap <label> captures first, then taps the FRESH hierarchy’s hitPoint', async () => {
    const world = makeWorld();
    const session = await open(world);
    const res = await verb(session, 'tap', { target: 'General' });
    expect(res.exit).toBe(MOBILE_EXIT_OK);
    expect(world.synths.map((s) => s.interactionCommand)).toEqual([undefined, 't 201 406.3']);
  });

  it('refuses an ambiguous label with the distinct exit code and lists the candidates — no tap is sent', async () => {
    const world = makeWorld();
    world.view = {
      pid: 4321,
      elements: [
        "  Button, {{0.0, 100.0}, {100.0, 40.0}}, label: 'Delete', hitPoint: {50.0, 120.0}",
        "  Button, {{0.0, 300.0}, {100.0, 40.0}}, label: 'Delete', hitPoint: {50.0, 320.0}",
      ],
    };
    const session = await open(world);
    const res = await verb(session, 'tap', { target: 'Delete' });
    expect(res.exit).toBe(MOBILE_EXIT_TARGET_UNRESOLVED);
    expect(res.message).toContain('(50, 120)');
    expect(res.message).toContain('(50, 320)');
    expect(world.synths).toHaveLength(1);
  });

  it('refuses a label that matches nothing, naming what IS on screen', async () => {
    const world = makeWorld();
    const session = await open(world);
    const res = await verb(session, 'tap', { target: 'Nope' });
    expect(res.exit).toBe(MOBILE_EXIT_TARGET_UNRESOLVED);
    expect(res.message).toContain('"General"');
  });

  it('mobile-tap --at taps the given point with no pre-capture', async () => {
    const world = makeWorld();
    const session = await open(world);
    await verb(session, 'tap', { x: 10, y: 20.25 });
    expect(world.synths.map((s) => s.interactionCommand)).toEqual(['t 10 20.3']);
  });

  it('mobile-swipe <dir> maps the window frame; --from/--to passes points through', async () => {
    const world = makeWorld();
    const session = await open(world);
    await verb(session, 'swipe', { direction: 'up' });
    await verb(session, 'swipe', { from: [1, 2], to: [3, 4], duration: 0.5 });
    expect(world.synths.map((s) => s.interactionCommand)).toEqual([
      undefined,
      's 201 611.8 201 262.2 0.3',
      's 1 2 3 4 0.5',
    ]);
  });

  it('press home / enter use the grammar; back is refused (iOS has none)', async () => {
    const world = makeWorld();
    const session = await open(world);
    expect((await verb(session, 'press', { key: 'home' })).exit).toBe(MOBILE_EXIT_OK);
    expect((await verb(session, 'press', { key: 'enter' })).exit).toBe(MOBILE_EXIT_OK);
    expect((await verb(session, 'press', { key: 'back' })).exit).toBe(MOBILE_EXIT_REFUSED);
    expect(world.synths.map((s) => s.interactionCommand)).toEqual([HOME_BUTTON_COMMAND, RETURN_KEY_COMMAND]);
  });

  it('mobile-activate is the ONLY verb that passes activationBundleId', async () => {
    const world = makeWorld();
    const session = await open(world);
    await verb(session, 'type', { text: 'hello world' });
    await verb(session, 'interact', { command: 'w 0.3' });
    await verb(session, 'activate');
    expect(world.synths.map((s) => s.activationBundleId)).toEqual([undefined, undefined, BUNDLE]);
    expect(world.synths.map((s) => s.interactionCommand)).toEqual(['type hello world', 'w 0.3', undefined]);
    expect(session.ledger.entries.map((e) => (e.kind === 'capture' ? e.activated : null))).toEqual([false, false, true]);
  });

  it('a mid-run bridge error is exit 2 (not_testable), never a verdict', async () => {
    const world = makeWorld({
      DeviceInteractionSynthesize: () => ({ toolError: "Session with that key doesn't exist" }),
    });
    const session = await open(world);
    const res = await verb(session, 'capture', { name: 'x' });
    expect(res.exit).toBe(MOBILE_EXIT_REFUSED);
    expect(res.message).toContain('session is gone');
  });
});

describe('pid pinning (§B4.6)', () => {
  it('a relaunched app (different pid in its block) is exit 4 with the log tail', async () => {
    const world = makeWorld();
    const session = await open(world);
    world.alive.add(4321);
    await verb(session, 'launch', { pid: 4321 });
    world.view = { pid: 9999 };
    const res = await verb(session, 'capture', { name: 'after' });
    expect(res.exit).toBe(MOBILE_EXIT_APP_EXITED);
    expect(res.message).toMatch(/^app-exited pid=4321 state=NotRun/);
    expect(res.message).toContain('Index out of range');
  });

  it('a missing app block is exit 4', async () => {
    const world = makeWorld();
    const session = await open(world);
    world.alive.add(4321);
    await verb(session, 'launch', { pid: 4321 });
    world.view = { pid: null };
    expect((await verb(session, 'capture', { name: 'gone' })).exit).toBe(MOBILE_EXIT_APP_EXITED);
  });

  it('a dead pin fails BEFORE any Synthesize, so nothing can relaunch the app', async () => {
    const world = makeWorld();
    const session = await open(world);
    await verb(session, 'launch', { pid: 4321 }); // never marked alive
    const res = await verb(session, 'activate');
    expect(res.exit).toBe(MOBILE_EXIT_APP_EXITED);
    expect(world.synths).toHaveLength(0);
  });

  it('press home tolerates the app leaving the foreground, but the pid must live', async () => {
    const world = makeWorld();
    const session = await open(world);
    world.alive.add(4321);
    await verb(session, 'launch', { pid: 4321 });
    world.view = { pid: null, state: 'RunningInBackground' };
    expect((await verb(session, 'press', { key: 'home' })).exit).toBe(MOBILE_EXIT_OK);
    // …and the next non-home verb holds the strict rule again.
    expect((await verb(session, 'capture', { name: 'springboard' })).exit).toBe(MOBILE_EXIT_APP_EXITED);
  });

  it('NotRun is not a crash (a non-workspace session always says it); Crashed is', async () => {
    const world = makeWorld();
    const session = await open(world);
    world.alive.add(4321);
    await verb(session, 'launch', { pid: 4321 });
    expect((await verb(session, 'capture', { name: 'a' })).exit).toBe(MOBILE_EXIT_OK);
    world.view = { pid: 4321, state: 'Crashed' };
    expect((await verb(session, 'capture', { name: 'b' })).exit).toBe(MOBILE_EXIT_APP_EXITED);
  });
});

describe('close() — the §B4.8 teardown', () => {
  it('ends the session, then stops the bridge, then removes the socket', async () => {
    const world = makeWorld();
    const session = await open(world);
    const socketPath = session.env[VERIFY_XCODE_DRIVE_SOCKET_ENV] as string;
    const steps = await session.close();
    expect(steps.map((s) => [s.step, s.ok])).toEqual([
      ['end-session', true],
      ['bridge', true],
      ['socket', true],
    ]);
    expect(world.order[world.order.length - 1]).toBe('end');
    expect(world.bridge.signals[0]).toBe('SIGTERM');
    expect(existsSync(socketPath)).toBe(false);
    expect(world.bridge.calls.find((c) => c.name === 'DeviceInteractionEndSession')?.arguments).toEqual({
      interactionSessionKey: KEY,
    });
  });

  it('a hung EndSession never skips the bridge or the socket step', async () => {
    const world = makeWorld({ DeviceInteractionEndSession: () => 'hang' });
    const session = await open(world);
    const socketPath = session.env[VERIFY_XCODE_DRIVE_SOCKET_ENV] as string;
    const steps = await session.close();
    expect(steps[0]).toMatchObject({ step: 'end-session', ok: false });
    expect(steps.slice(1).map((s) => [s.step, s.ok])).toEqual([
      ['bridge', true],
      ['socket', true],
    ]);
    expect(existsSync(socketPath)).toBe(false);
  });

  it('is idempotent', async () => {
    const world = makeWorld();
    const session = await open(world);
    const first = await session.close();
    expect(await session.close()).toBe(first);
    expect(world.bridge.calls.filter((c) => c.name === 'DeviceInteractionEndSession')).toHaveLength(1);
  });
});

describe('endXcodeSessionBestEffort (§B4.9)', () => {
  it('ends the key it was given and closes its bridge', async () => {
    const world = makeWorld();
    await endXcodeSessionBestEffort('Cyboflow Verify stale', { createClient: world.options.createClient });
    expect(world.bridge.calls.find((c) => c.name === 'DeviceInteractionEndSession')?.arguments).toEqual({
      interactionSessionKey: 'Cyboflow Verify stale',
    });
    expect(world.bridge.signals).toContain('SIGTERM');
  });

  it('ignores an unapproved answer without throwing', async () => {
    const world = makeWorld({
      DeviceInteractionEndSession: () => ({ toolError: "This agent isn't approved to use Xcode's tools yet" }),
    });
    await expect(
      endXcodeSessionBestEffort('Cyboflow Verify stale', { createClient: world.options.createClient }),
    ).resolves.toBeUndefined();
  });
});
