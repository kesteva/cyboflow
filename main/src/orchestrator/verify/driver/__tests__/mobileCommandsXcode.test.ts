/**
 * mobileCommands — the `VERIFY_MOBILE_DRIVE=xcode` arm of the driver
 * (docs/proposals/runbook-optional-verification.md §B4.4–§B4.6).
 *
 * Driven through `runDriverCommand` so the dispatcher and the modality guard
 * are exercised too. The socket transport is a recording fake for most cases;
 * one case runs the REAL `sendDriveFrame` against a real drive socket to pin
 * the wire end to end. No simulator, no Xcode, no Maestro.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultDriverDeps, runDriverCommand, type DriverDeps } from '../driverCore';
import {
  maestroFlowYaml,
  MOBILE_EXIT_APP_EXITED,
  MOBILE_EXIT_OK,
  MOBILE_EXIT_REFUSED,
  MOBILE_EXIT_TARGET_UNRESOLVED,
  MOBILE_EXIT_USAGE,
  parseMobileArgv,
} from '../mobileCommands';
import { createDriveSocket, mintDriveToken, type DriveRequest, type DriveResponse } from '../../xcode/xcodeDriveSocketServer';

const UDID = '11111111-2222-3333-4444-555555555555';
const BUNDLE = 'com.example.Demo';

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-mcx-'));
  roots.push(dir);
  return dir;
}

function xcodeEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    VERIFY_MODALITY: 'mobile',
    VERIFY_ARTIFACTS_DIR: join(dir, 'artifacts'),
    VERIFY_SIM_UDID: UDID,
    VERIFY_APP_BUNDLE_ID: BUNDLE,
    VERIFY_DERIVED_DATA: join(dir, 'dd'),
    VERIFY_MOBILE_DRIVE: 'xcode',
    VERIFY_XCODE_DRIVE_SOCKET: '/tmp/xd-0000000000000000.sock',
    VERIFY_XCODE_DRIVE_TOKEN: 't'.repeat(64),
    ...extra,
  };
}

interface Harness {
  deps: DriverDeps;
  frames: Array<{ verb: string; args: Record<string, unknown> }>;
  tools: string[];
  out: string[];
  err: string[];
}

function harness(dir: string, answer: (verb: string, args: Record<string, unknown>) => DriveResponse): Harness {
  const frames: Harness['frames'] = [];
  const tools: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: DriverDeps = {
    ...createDefaultDriverDeps(),
    runTool: async (bin, args) => {
      tools.push(`${bin} ${args.join(' ')}`);
      if (args[1] === 'launch') return { code: 0, stdout: `${BUNDLE}: 4321\n`, stderr: '' };
      if (args[1] === 'io') return { code: 1, stdout: '', stderr: 'no frame in this test' };
      return { code: 0, stdout: '', stderr: '' };
    },
    sendDriveFrame: async (_socket, _token, verb, args) => {
      frames.push({ verb, args });
      return answer(verb, args);
    },
    isProcessAlive: () => true,
    sleep: async () => {},
    cwd: () => dir,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
  return { deps, frames, tools, out, err };
}

const OK = (message = 'ok'): DriveResponse => ({ ok: true, exit: MOBILE_EXIT_OK, message });

describe('parseMobileArgv — the new verb shapes', () => {
  it('parses mobile-capture, tap --at, swipe --from/--to, interact and activate', () => {
    expect(parseMobileArgv('mobile-capture', ['home'])).toEqual({
      ok: true,
      command: { kind: 'mobile', sub: 'capture', name: 'home.png' },
    });
    expect(parseMobileArgv('mobile-tap', ['--at', '12.5', '40'])).toEqual({
      ok: true,
      command: { kind: 'mobile', sub: 'tap', at: { x: 12.5, y: 40 } },
    });
    expect(parseMobileArgv('mobile-swipe', ['--from', '1', '2', '--to', '3', '4', '0.5'])).toEqual({
      ok: true,
      command: { kind: 'mobile', sub: 'swipe', from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, durationS: 0.5 },
    });
    expect(parseMobileArgv('mobile-interact', ['t 1 2'])).toEqual({
      ok: true,
      command: { kind: 'mobile', sub: 'interact', command: 't 1 2' },
    });
    expect(parseMobileArgv('mobile-activate', [])).toEqual({ ok: true, command: { kind: 'mobile', sub: 'activate' } });
  });

  it('refuses loose shapes', () => {
    expect(parseMobileArgv('mobile-tap', ['--at', '12px', '40'])?.ok).toBe(false);
    expect(parseMobileArgv('mobile-tap', ['--at', '1'])?.ok).toBe(false);
    expect(parseMobileArgv('mobile-swipe', ['--from', '1', '2', '3', '4'])?.ok).toBe(false);
    expect(parseMobileArgv('mobile-swipe', ['--from', '1', '2', '--to', '3', '4', '-1'])?.ok).toBe(false);
    expect(parseMobileArgv('mobile-activate', ['now'])?.ok).toBe(false);
    expect(parseMobileArgv('mobile-capture', ['../x'])?.ok).toBe(false);
  });
});

describe('VERIFY_MOBILE_DRIVE=xcode — every observe/drive verb goes through the socket', () => {
  it.each([
    [['mobile-capture', 'home'], { verb: 'capture', args: { name: 'home.png' } }],
    [['mobile-screenshot', 'home'], { verb: 'screenshot', args: { name: 'home.png' } }],
    [['mobile-tap', 'General'], { verb: 'tap', args: { target: 'General' } }],
    [['mobile-tap', '--at', '10', '20'], { verb: 'tap', args: { x: 10, y: 20 } }],
    [['mobile-swipe', 'up'], { verb: 'swipe', args: { direction: 'up' } }],
    [['mobile-swipe', '--from', '1', '2', '--to', '3', '4'], { verb: 'swipe', args: { from: [1, 2], to: [3, 4] } }],
    [['mobile-type', 'hello', 'world'], { verb: 'type', args: { text: 'hello world' } }],
    [['mobile-press', 'home'], { verb: 'press', args: { key: 'home' } }],
    [['mobile-interact', 'w 0.3'], { verb: 'interact', args: { command: 'w 0.3' } }],
    [['mobile-activate'], { verb: 'activate', args: {} }],
  ])('%j sends %j and needs no Maestro', async (argv, frame) => {
    const dir = await root();
    const h = harness(dir, () => OK());
    const code = await runDriverCommand(argv, xcodeEnv(dir), h.deps);
    expect(code).toBe(MOBILE_EXIT_OK);
    expect(h.frames).toEqual([frame]);
    expect(h.tools).toEqual([]);
  });

  it('mobile-flow is refused under xcode (exit 2), pointing at mobile-interact — nothing is sent', async () => {
    const dir = await root();
    const h = harness(dir, () => OK());
    const code = await runDriverCommand(['mobile-flow', 'flow.yaml'], xcodeEnv(dir), h.deps);
    expect(code).toBe(MOBILE_EXIT_REFUSED);
    expect(h.err.join('\n')).toContain('mobile-interact');
    expect(h.frames).toEqual([]);
  });

  it('mobile-press back is refused locally (iOS has none)', async () => {
    const dir = await root();
    const h = harness(dir, () => OK());
    expect(await runDriverCommand(['mobile-press', 'back'], xcodeEnv(dir), h.deps)).toBe(MOBILE_EXIT_REFUSED);
    expect(h.frames).toEqual([]);
  });

  it('relays the runner’s exit codes verbatim: 4 app-exited, 5 unresolved target', async () => {
    const dir = await root();
    const exited = harness(dir, () => ({ ok: false, exit: MOBILE_EXIT_APP_EXITED, message: 'app-exited pid=4321 state=NotRun' }));
    expect(await runDriverCommand(['mobile-capture', 'x'], xcodeEnv(dir), exited.deps)).toBe(MOBILE_EXIT_APP_EXITED);
    expect(exited.err[0]).toMatch(/^app-exited pid=4321/);
    const ambiguous = harness(dir, () => ({ ok: false, exit: MOBILE_EXIT_TARGET_UNRESOLVED, message: 'matches 2' }));
    expect(await runDriverCommand(['mobile-tap', 'Delete'], xcodeEnv(dir), ambiguous.deps)).toBe(
      MOBILE_EXIT_TARGET_UNRESOLVED,
    );
  });

  it('prints the recorded capture so the agent can cite it', async () => {
    const dir = await root();
    const h = harness(dir, () => ({ ok: true, exit: 0, message: 'ok: captured home.png', screenshot: 'home.png' }));
    await runDriverCommand(['mobile-capture', 'home'], xcodeEnv(dir), h.deps);
    expect(h.out).toEqual(['ok: captured home.png', 'screenshot: home.png']);
  });

  it('a socket that does not answer is exit 2 (not_testable); a missing socket env is a harness bug (exit 1)', async () => {
    const dir = await root();
    const h = harness(dir, () => OK());
    h.deps.sendDriveFrame = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await runDriverCommand(['mobile-capture', 'x'], xcodeEnv(dir), h.deps)).toBe(MOBILE_EXIT_REFUSED);
    const env = xcodeEnv(dir);
    delete env.VERIFY_XCODE_DRIVE_TOKEN;
    expect(await runDriverCommand(['mobile-capture', 'x'], env, harness(dir, () => OK()).deps)).toBe(MOBILE_EXIT_USAGE);
  });

  it('mobile-launch pins its parsed pid with the runner BEFORE readiness, and refuses when the pin is refused', async () => {
    const dir = await root();
    const pinned = harness(dir, () => OK());
    await runDriverCommand(['mobile-launch'], xcodeEnv(dir, { VERIFY_MOBILE_READY_TIMEOUT_MS: '1' }), pinned.deps);
    expect(pinned.frames[0]).toEqual({ verb: 'launch', args: { pid: 4321 } });

    const refused = harness(dir, () => ({ ok: false, exit: 2, message: 'no' }));
    const code = await runDriverCommand(['mobile-launch'], xcodeEnv(dir), refused.deps);
    expect(code).toBe(MOBILE_EXIT_REFUSED);
    expect(refused.err.join('\n')).toContain('could not pin the launched pid 4321');
    expect(refused.tools.some((t) => t.includes('screenshot'))).toBe(false);
  });

  it('end to end over a REAL drive socket', async () => {
    const dir = await root();
    const token = mintDriveToken();
    const seen: DriveRequest[] = [];
    const socket = await createDriveSocket({
      dataDir: join(dir, 'data'),
      token,
      handler: (request) => {
        seen.push(request);
        return { ok: true, exit: 0, message: `ok: ${request.verb}` };
      },
    });
    try {
      const deps: DriverDeps = { ...createDefaultDriverDeps(), stdout: () => {}, stderr: () => {} };
      const env = xcodeEnv(dir, { VERIFY_XCODE_DRIVE_SOCKET: socket.socketPath, VERIFY_XCODE_DRIVE_TOKEN: token });
      expect(await runDriverCommand(['mobile-tap', '--at', '5', '6'], env, deps)).toBe(MOBILE_EXIT_OK);
      expect(seen).toEqual([{ verb: 'tap', args: { x: 5, y: 6 } }]);
    } finally {
      await socket.close();
    }
  });
});

describe('the non-xcode rungs keep one meaning per verb', () => {
  it('mobile-capture is a simulator screenshot off xcode', async () => {
    const dir = await root();
    const h = harness(dir, () => OK());
    const code = await runDriverCommand(['mobile-capture', 'home'], xcodeEnv(dir, { VERIFY_MOBILE_DRIVE: 'none' }), h.deps);
    expect(h.tools[0]).toContain('simctl io');
    expect(code).toBe(MOBILE_EXIT_REFUSED); // the stubbed `io` fails in this harness
    expect(h.frames).toEqual([]);
  });

  it('interact / activate are xcode-only and refused on maestro', async () => {
    const dir = await root();
    const h = harness(dir, () => OK());
    const env = xcodeEnv(dir, { VERIFY_MOBILE_DRIVE: 'maestro', VERIFY_MAESTRO_BIN: '/bin/maestro' });
    expect(await runDriverCommand(['mobile-activate'], env, h.deps)).toBe(MOBILE_EXIT_REFUSED);
    expect(h.err.join('\n')).toContain('only on the xcode drive rung');
  });

  it('tap --at and swipe --from/--to render as Maestro point flows', () => {
    expect(maestroFlowYaml(BUNDLE, { kind: 'mobile', sub: 'tap', at: { x: 10, y: 20 } })).toBe(
      `appId: "${BUNDLE}"\n---\n- tapOn:\n    point: "10,20"\n`,
    );
    expect(
      maestroFlowYaml(BUNDLE, { kind: 'mobile', sub: 'swipe', from: { x: 1, y: 2 }, to: { x: 3, y: 4 }, durationS: 0.5 }),
    ).toBe(`appId: "${BUNDLE}"\n---\n- swipe:\n    start: "1, 2"\n    end: "3, 4"\n    duration: 500\n`);
  });
});
