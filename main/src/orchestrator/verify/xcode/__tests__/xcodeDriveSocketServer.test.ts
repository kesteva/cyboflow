/**
 * xcodeDriveSocketServer unit tests — REAL unix sockets under a per-test temp
 * dir (never the user's data dir), so the path rules, modes and cleanup are
 * observed on the filesystem rather than asserted about a mock.
 *
 * Covers: the token is required and compared on every frame; a round trip
 * reaches the handler and only whitelisted fields come back; frames are
 * serialised; oversized / malformed frames are refused; close() unlinks the
 * socket and removes the fallback dir; the long-path fallback; EADDRINUSE
 * never clobbers; the boot sweep; and the capture ledger's pass-evidence rule.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createCaptureLedger,
  createDriveSocket,
  DRIVE_EXIT_REFUSED,
  DriveTransportError,
  evaluateLedgerEvidence,
  ledgerPin,
  MAX_SOCKET_PATH_BYTES,
  mintDriveToken,
  parseDriveResponse,
  recordLedgerCapture,
  recordLedgerLaunch,
  sendDriveFrame,
  sweepStaleDriveSockets,
  type DriveRequest,
  type DriveResponse,
  type DriveSocket,
  type LedgerCaptureInput,
} from '../xcodeDriveSocketServer';
import { MOBILE_EXIT_REFUSED } from '../../driver/mobileCommands';

let root: string;
const open: DriveSocket[] = [];

/**
 * A SHORT root: `os.tmpdir()` on macOS is `/var/folders/<2>/<28>/T/`, whose
 * realpath alone eats ~60 of the 103 sun_path bytes — the very hazard the
 * long-path fallback exists for. `/tmp` (realpath `/private/tmp`) leaves room.
 */
const SHORT_TMP = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(SHORT_TMP, 'xds-')));
});

afterEach(async () => {
  for (const socket of open.splice(0)) await socket.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function start(
  handler: (request: DriveRequest) => Promise<DriveResponse> | DriveResponse,
  extra: { dataDir?: string; token?: string; maxFrameBytes?: number; randomHex?: () => string; shortTmpDir?: string } = {},
): Promise<{ socket: DriveSocket; token: string }> {
  const token = extra.token ?? mintDriveToken();
  const socket = await createDriveSocket({
    dataDir: extra.dataDir ?? path.join(root, 'data'),
    token,
    handler,
    shortTmpDir: extra.shortTmpDir ?? root,
    ...(extra.maxFrameBytes !== undefined ? { maxFrameBytes: extra.maxFrameBytes } : {}),
    ...(extra.randomHex !== undefined ? { randomHex: extra.randomHex } : {}),
  });
  open.push(socket);
  return { socket, token };
}

/** Write raw bytes and collect every response line until the server ends the connection. */
function rawExchange(socketPath: string, payload: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let data = '';
    client.setEncoding('utf8');
    client.once('connect', () => client.write(payload));
    client.on('data', (chunk: string) => {
      data += chunk;
    });
    client.once('error', reject);
    client.once('close', () => resolve(data.split('\n').filter((line) => line.length > 0)));
  });
}

const OK: DriveResponse = { ok: true, exit: 0, applicationState: 'Running' };

// Unix-domain sockets + POSIX modes — the drive socket is macOS-only (Xcode).
describe.skipIf(process.platform === 'win32')('createDriveSocket — path and modes', () => {
  it('binds <dataDir>/sockets/xd-<16hex>.sock in a 0700 dir, socket 0600', async () => {
    const { socket } = await start(() => OK);
    expect(socket.socketPath).toMatch(new RegExp(`^${root}/data/sockets/xd-[0-9a-f]{16}\\.sock$`));
    expect(socket.fallbackDir).toBeNull();
    expect(fs.statSync(path.dirname(socket.socketPath)).mode & 0o777).toBe(0o700);
    const info = fs.lstatSync(socket.socketPath);
    expect(info.isSocket()).toBe(true);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('tightens an existing sockets dir that is group/other accessible', async () => {
    const dataDir = path.join(root, 'loose');
    fs.mkdirSync(path.join(dataDir, 'sockets'), { recursive: true, mode: 0o755 });
    fs.chmodSync(path.join(dataDir, 'sockets'), 0o755);
    await start(() => OK, { dataDir });
    expect(fs.statSync(path.join(dataDir, 'sockets')).mode & 0o777).toBe(0o700);
  });

  it('refuses a sockets path that is a symlink', async () => {
    const dataDir = path.join(root, 'linked');
    fs.mkdirSync(path.join(root, 'elsewhere'));
    fs.mkdirSync(dataDir);
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(dataDir, 'sockets'));
    await expect(start(() => OK, { dataDir })).rejects.toThrow(/not a directory/);
  });

  it('falls back to a 0700 mkdtemp under the short tmpdir when the path would exceed the sun_path bound', async () => {
    const longDataDir = path.join(root, 'x'.repeat(120));
    const { socket, token } = await start(() => OK, { dataDir: longDataDir });
    expect(socket.fallbackDir).not.toBeNull();
    expect(socket.socketPath.startsWith(`${socket.fallbackDir as string}/xd-`)).toBe(true);
    expect(Buffer.byteLength(socket.socketPath)).toBeLessThanOrEqual(MAX_SOCKET_PATH_BYTES);
    expect(fs.statSync(socket.fallbackDir as string).mode & 0o777).toBe(0o700);
    // The long data dir was never created: nothing is written where the socket could not live.
    expect(fs.existsSync(longDataDir)).toBe(false);
    await expect(sendDriveFrame(socket.socketPath, token, 'mobile-capture', {}, 2_000)).resolves.toEqual(OK);
  });

  it('asserts the length even on the fallback path', async () => {
    const hugeTmp = path.join(root, 'y'.repeat(95));
    fs.mkdirSync(hugeTmp);
    await expect(start(() => OK, { dataDir: path.join(root, 'z'.repeat(120)), shortTmpDir: hugeTmp })).rejects.toThrow(
      /sun_path/,
    );
    // The fallback dir it made was removed again.
    expect(fs.readdirSync(hugeTmp)).toEqual([]);
  });

  it('fails on EADDRINUSE and never unlinks the live socket it collided with', async () => {
    const hex = '0123456789abcdef';
    const first = await start(() => OK, { randomHex: () => hex });
    await expect(start(() => OK, { randomHex: () => hex })).rejects.toThrow(/EADDRINUSE/);
    // The first server is untouched and still answers.
    await expect(sendDriveFrame(first.socket.socketPath, first.token, 'mobile-capture', {}, 2_000)).resolves.toEqual(OK);
  });

  it('refuses a weak token and a malformed name seam', async () => {
    await expect(start(() => OK, { token: 'short' })).rejects.toThrow(/at least 32/);
    await expect(start(() => OK, { randomHex: () => '../../etc' })).rejects.toThrow(/16 lowercase hex/);
  });
});

describe.skipIf(process.platform === 'win32')('frames', () => {
  it('round-trips an authenticated frame and hands the handler verb + args, never the token', async () => {
    const seen: DriveRequest[] = [];
    const { socket, token } = await start((request) => {
      seen.push(request);
      return { ok: true, exit: 0, applicationState: 'Running', screenshot: 'cap-1.png', hierarchy: 'cap-1.txt', pid: 4321 };
    });
    const response = await sendDriveFrame(socket.socketPath, token, 'mobile-capture', { name: 'home' }, 2_000);
    expect(response).toEqual({
      ok: true,
      exit: 0,
      applicationState: 'Running',
      screenshot: 'cap-1.png',
      hierarchy: 'cap-1.txt',
      pid: 4321,
    });
    expect(seen).toEqual([{ verb: 'mobile-capture', args: { name: 'home' } }]);
    expect(JSON.stringify(seen)).not.toContain(token);
  });

  it('whitelists the response: extra handler fields never reach the driver', async () => {
    const { socket, token } = await start(
      () => ({ ...OK, sessionKey: 'Cyboflow Verify secret' }) as unknown as DriveResponse,
    );
    const response = await sendDriveFrame(socket.socketPath, token, 'mobile-capture', {}, 2_000);
    expect(response).toEqual(OK);
  });

  it('refuses a frame with no token, and one with the wrong token, without calling the handler', async () => {
    let calls = 0;
    const { socket } = await start(() => {
      calls += 1;
      return OK;
    });
    const missing = await rawExchange(socket.socketPath, `${JSON.stringify({ verb: 'mobile-capture', args: {} })}\n`);
    expect(missing.map((line) => JSON.parse(line))).toEqual([
      { ok: false, exit: DRIVE_EXIT_REFUSED, message: 'unauthorized' },
    ]);
    const wrong = await sendDriveFrame(socket.socketPath, mintDriveToken(), 'mobile-capture', {}, 2_000);
    expect(wrong).toEqual({ ok: false, exit: DRIVE_EXIT_REFUSED, message: 'unauthorized' });
    expect(calls).toBe(0);
  });

  it('stops reading a connection after a bad-token frame, even if valid frames follow on it', async () => {
    let calls = 0;
    const { socket, token } = await start(() => {
      calls += 1;
      return OK;
    });
    const lines = await rawExchange(
      socket.socketPath,
      `${JSON.stringify({ token: 'nope', verb: 'a' })}\n${JSON.stringify({ token, verb: 'b' })}\n`,
    );
    expect(lines).toHaveLength(1);
    expect(calls).toBe(0);
  });

  it('refuses malformed frames: not JSON, not an object, no verb, non-object args', async () => {
    const { socket, token } = await start(() => OK);
    const cases = ['not json', '[1,2]', JSON.stringify({ token }), JSON.stringify({ token, verb: 'x', args: [1] })];
    for (const payload of cases) {
      const [line] = await rawExchange(socket.socketPath, `${payload}\n`);
      const parsed = JSON.parse(line as string) as DriveResponse;
      expect(parsed.ok).toBe(false);
      expect(parsed.exit).toBe(DRIVE_EXIT_REFUSED);
      expect(parsed.message).toMatch(/malformed frame/);
    }
  });

  it('refuses an oversized frame, with or without a newline', async () => {
    let calls = 0;
    const { socket, token } = await start(
      () => {
        calls += 1;
        return OK;
      },
      { maxFrameBytes: 256 },
    );
    const big = JSON.stringify({ token, verb: 'mobile-type', args: { text: 'x'.repeat(1_000) } });
    const [withNewline] = await rawExchange(socket.socketPath, `${big}\n`);
    expect(JSON.parse(withNewline as string)).toMatchObject({ ok: false, message: 'frame too large' });
    const [unterminated] = await rawExchange(socket.socketPath, big);
    expect(JSON.parse(unterminated as string)).toMatchObject({ ok: false, message: 'frame too large' });
    expect(calls).toBe(0);
  });

  it('turns a throwing handler, or an invalid handler result, into a refusal', async () => {
    const { socket, token } = await start((request) => {
      if (request.verb === 'boom') throw new Error('synthesize exploded');
      return { ok: true } as unknown as DriveResponse;
    });
    await expect(sendDriveFrame(socket.socketPath, token, 'boom', {}, 2_000)).resolves.toEqual({
      ok: false,
      exit: DRIVE_EXIT_REFUSED,
      message: 'drive handler failed: synthesize exploded',
    });
    await expect(sendDriveFrame(socket.socketPath, token, 'other', {}, 2_000)).resolves.toMatchObject({
      ok: false,
      exit: DRIVE_EXIT_REFUSED,
    });
  });

  it('serialises frames: two concurrent verbs never run the handler at once', async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const { socket, token } = await start(async (request) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push(request.verb);
      active -= 1;
      return OK;
    });
    await Promise.all([
      sendDriveFrame(socket.socketPath, token, 'first', {}, 2_000),
      sendDriveFrame(socket.socketPath, token, 'second', {}, 2_000),
      sendDriveFrame(socket.socketPath, token, 'third', {}, 2_000),
    ]);
    expect(maxActive).toBe(1);
    expect(order).toHaveLength(3);
  });

  it('the refusal exit equals the driver MOBILE_EXIT_REFUSED (not_testable)', () => {
    expect(DRIVE_EXIT_REFUSED).toBe(MOBILE_EXIT_REFUSED);
  });
});

describe.skipIf(process.platform === 'win32')('close', () => {
  it('unlinks the socket; later frames fail to connect', async () => {
    const { socket, token } = await start(() => OK);
    await socket.close();
    expect(fs.existsSync(socket.socketPath)).toBe(false);
    const error = await sendDriveFrame(socket.socketPath, token, 'mobile-capture', {}, 1_000).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(DriveTransportError);
    expect((error as DriveTransportError).reason).toBe('connect');
  });

  it('removes the fallback dir and is idempotent', async () => {
    const { socket } = await start(() => OK, { dataDir: path.join(root, 'q'.repeat(120)) });
    const first = socket.close();
    expect(socket.close()).toBe(first);
    await first;
    expect(fs.existsSync(socket.fallbackDir as string)).toBe(false);
  });

  it('does not wait on an in-flight handler; the driver sees the socket close', async () => {
    const { socket, token } = await start(() => new Promise<DriveResponse>(() => {}));
    const pending = sendDriveFrame(socket.socketPath, token, 'mobile-capture', {}, 5_000).catch((err: unknown) => err);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await socket.close();
    const error = await pending;
    expect(error).toBeInstanceOf(DriveTransportError);
    expect((error as DriveTransportError).reason).toBe('closed');
  });
});

describe.skipIf(process.platform === 'win32')('sendDriveFrame', () => {
  it('times out a verb that never answers', async () => {
    const { socket, token } = await start(() => new Promise<DriveResponse>(() => {}));
    const error = await sendDriveFrame(socket.socketPath, token, 'slow', {}, 50).catch((err: unknown) => err);
    expect((error as DriveTransportError).reason).toBe('timeout');
  });

  it('rejects a malformed or oversized answer', async () => {
    const socketPath = path.join(root, 'rogue.sock');
    const rogue = net.createServer((conn) => {
      conn.once('data', (chunk) => {
        const frame = JSON.parse(String(chunk)) as { verb: string };
        conn.write(frame.verb === 'big' ? 'y'.repeat(4_096) : '{"ok":"yes"}\n');
      });
    });
    await new Promise<void>((resolve) => rogue.listen(socketPath, resolve));
    try {
      const malformed = await sendDriveFrame(socketPath, 't', 'x', {}, 1_000).catch((err: unknown) => err);
      expect((malformed as DriveTransportError).reason).toBe('malformed-response');
      const oversized = await sendDriveFrame(socketPath, 't', 'big', {}, 1_000, { maxResponseBytes: 1_024 }).catch(
        (err: unknown) => err,
      );
      expect((oversized as DriveTransportError).reason).toBe('oversized-response');
    } finally {
      await new Promise<void>((resolve) => rogue.close(() => resolve()));
    }
  });

  it('parseDriveResponse keeps only well-typed known fields', () => {
    expect(parseDriveResponse('{"ok":false,"exit":4,"message":"app-exited pid=9 state=Crashed","pid":9}')).toEqual({
      ok: false,
      exit: 4,
      message: 'app-exited pid=9 state=Crashed',
      pid: 9,
    });
    expect(parseDriveResponse('{"ok":true,"exit":1.5}')).toBeNull();
    expect(parseDriveResponse('{"ok":true,"exit":0,"pid":-1,"screenshot":7}')).toEqual({ ok: true, exit: 0 });
    expect(parseDriveResponse('nope')).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('sweepStaleDriveSockets', () => {
  it('removes a dead xd-* socket, keeps a live one, ignores other files', async () => {
    const dataDir = path.join(root, 'data');
    const live = await start(() => OK, { dataDir });
    const socketsDir = path.join(dataDir, 'sockets');
    // A stale socket node: bind, then drop the server without close() so the file stays.
    const stalePath = path.join(socketsDir, 'xd-aaaaaaaaaaaaaaaa.sock');
    const stale = net.createServer();
    await new Promise<void>((resolve) => stale.listen(stalePath, resolve));
    // Unref and close the handle without libuv's unlink by detaching the path first.
    fs.renameSync(stalePath, `${stalePath}.moved`);
    await new Promise<void>((resolve) => stale.close(() => resolve()));
    fs.renameSync(`${stalePath}.moved`, stalePath);
    fs.writeFileSync(path.join(socketsDir, 'orch.sock'), '');
    fs.writeFileSync(path.join(socketsDir, 'xd-bbbbbbbbbbbbbbbb.sock'), 'not a socket');

    const removed = await sweepStaleDriveSockets(dataDir);
    expect(removed).toEqual([stalePath]);
    expect(fs.existsSync(stalePath)).toBe(false);
    expect(fs.existsSync(live.socket.socketPath)).toBe(true);
    expect(fs.existsSync(path.join(socketsDir, 'orch.sock'))).toBe(true);
    expect(fs.existsSync(path.join(socketsDir, 'xd-bbbbbbbbbbbbbbbb.sock'))).toBe(true);
  });

  it('returns nothing for a data dir with no sockets dir', async () => {
    await expect(sweepStaleDriveSockets(path.join(root, 'absent'))).resolves.toEqual([]);
  });
});

describe('capture ledger', () => {
  const APP = 'com.example.fixtureapp';
  const capture = (overrides: Partial<LedgerCaptureInput> = {}): LedgerCaptureInput => ({
    name: 'home',
    verb: 'mobile-capture',
    sha256: 'a'.repeat(64),
    file: 'cap-home.png',
    applicationState: 'Running',
    foregroundBundleId: APP,
    pid: 100,
    activated: false,
    ...overrides,
  });

  it('records captures and launches in order with a monotonic seq, as plain JSON', () => {
    const ledger = createCaptureLedger(APP);
    recordLedgerLaunch(ledger, 100, new Date('2026-09-24T20:00:00Z'));
    recordLedgerCapture(ledger, capture(), new Date('2026-09-24T20:00:05Z'));
    expect(ledger.entries.map((entry) => [entry.kind, entry.seq])).toEqual([
      ['launch', 0],
      ['capture', 1],
    ]);
    expect(ledgerPin(ledger)).toBe(100);
    expect(JSON.parse(JSON.stringify(ledger))).toEqual(ledger);
    expect(ledger.entries[1]).toMatchObject({ at: '2026-09-24T20:00:05.000Z', activated: false });
  });

  it('counts a cited foreground capture of the pinned launch', () => {
    const ledger = createCaptureLedger(APP);
    recordLedgerLaunch(ledger, 100);
    recordLedgerCapture(ledger, capture());
    const verdict = evaluateLedgerEvidence(ledger, ['A'.repeat(64)]);
    expect(verdict).toMatchObject({ counts: true, capture: { name: 'home' } });
  });

  it('does not count an uncited, unknown, or missing citation', () => {
    const ledger = createCaptureLedger(APP);
    recordLedgerLaunch(ledger, 100);
    recordLedgerCapture(ledger, capture());
    expect(evaluateLedgerEvidence(ledger, [])).toMatchObject({ counts: false, reason: /cites no screenshot/ });
    expect(evaluateLedgerEvidence(ledger, ['f'.repeat(64)])).toMatchObject({
      counts: false,
      reason: /not a harness capture/,
    });
  });

  it('does not count a capture with another app in the foreground', () => {
    const ledger = createCaptureLedger(APP);
    recordLedgerLaunch(ledger, 100);
    recordLedgerCapture(ledger, capture({ foregroundBundleId: 'com.apple.springboard' }));
    expect(evaluateLedgerEvidence(ledger, ['a'.repeat(64)])).toMatchObject({
      counts: false,
      reason: /com\.apple\.springboard in the foreground/,
    });
  });

  it('marks every capture after an unannounced pid change as post-relaunch, until the next launch', () => {
    const ledger = createCaptureLedger(APP);
    recordLedgerLaunch(ledger, 100);
    recordLedgerCapture(ledger, capture({ name: 'before', sha256: '1'.repeat(64) }));
    recordLedgerCapture(ledger, capture({ name: 'relaunched', sha256: '2'.repeat(64), pid: 200, activated: true }));
    recordLedgerCapture(ledger, capture({ name: 'later', sha256: '3'.repeat(64), pid: 200 }));
    expect(evaluateLedgerEvidence(ledger, ['1'.repeat(64)])).toMatchObject({ counts: true });
    expect(evaluateLedgerEvidence(ledger, ['2'.repeat(64)])).toMatchObject({ counts: false, reason: /relaunched/ });
    expect(evaluateLedgerEvidence(ledger, ['3'.repeat(64)])).toMatchObject({ counts: false, reason: /relaunched/ });
    // A deliberate mobile-launch re-pins, and its captures count again.
    recordLedgerLaunch(ledger, 300);
    recordLedgerCapture(ledger, capture({ name: 'restarted', sha256: '4'.repeat(64), pid: 300 }));
    expect(evaluateLedgerEvidence(ledger, ['4'.repeat(64)])).toMatchObject({ counts: true });
    expect(ledgerPin(ledger)).toBe(300);
  });

  it('does not count a capture before any launch, or one missing the app block', () => {
    const ledger = createCaptureLedger(APP);
    recordLedgerCapture(ledger, capture({ sha256: '5'.repeat(64) }));
    recordLedgerLaunch(ledger, 100);
    recordLedgerCapture(ledger, capture({ sha256: '6'.repeat(64), pid: null }));
    expect(evaluateLedgerEvidence(ledger, ['5'.repeat(64)])).toMatchObject({ counts: false, reason: /precedes/ });
    expect(evaluateLedgerEvidence(ledger, ['6'.repeat(64)])).toMatchObject({ counts: false, reason: /no hierarchy block/ });
    // A missing block is not a relaunch: a later capture of the pinned pid still counts.
    recordLedgerCapture(ledger, capture({ sha256: '7'.repeat(64) }));
    expect(evaluateLedgerEvidence(ledger, ['7'.repeat(64)])).toMatchObject({ counts: true });
  });

  it('counts when ANY cited screenshot qualifies', () => {
    const ledger = createCaptureLedger(APP);
    recordLedgerLaunch(ledger, 100);
    recordLedgerCapture(ledger, capture({ sha256: '8'.repeat(64), foregroundBundleId: null }));
    recordLedgerCapture(ledger, capture({ sha256: '9'.repeat(64) }));
    expect(evaluateLedgerEvidence(ledger, ['8'.repeat(64), '9'.repeat(64)])).toMatchObject({ counts: true });
  });
});
