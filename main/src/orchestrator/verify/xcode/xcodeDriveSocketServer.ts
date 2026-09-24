/**
 * xcodeDriveSocketServer — the per-request unix socket between the
 * verification driver's mobile verbs and the runner that owns the Xcode
 * DeviceInteraction session, plus the capture ledger that socket feeds
 * (docs/proposals/runbook-optional-verification.md §B4.3–§B4.5, §B5).
 *
 * WHY A SOCKET: the runner — not the agent, not the driver — spawns
 * `xcrun mcpbridge` and holds the session key. The driver (a plain-node child of
 * the `$VERIFY_DRIVER` wrapper) reaches the session only through verbs sent
 * here, and everything a verb captures is recorded runner-side in the ledger.
 *
 * THREAT MODEL, stated honestly (the same framing as orchAuthToken.ts): this
 * socket is an ERGONOMICS, AUDIT AND LEDGER boundary, NOT a security boundary.
 * Every agent cyboflow hosts can exec the approved binary and reach Xcode's
 * tools directly while a grant is live (§B4 threat model). The 0700 directory
 * and the per-request bearer token only stop accidental cross-request reach —
 * a stray driver from another request, or anything that merely knows a path.
 * Evidence integrity rests on the runner-held ledger plus `bundle-identity`.
 *
 * PATH RULES (the orch-socket convention, §B4.3):
 *  - `<dataDir>/sockets/xd-<16 hex>.sock` inside a 0700 directory; when that
 *    would exceed {@link MAX_SOCKET_PATH_BYTES} (macOS `sun_path` is 104 bytes
 *    with its NUL, and the kernel TRUNCATES silently rather than failing), a
 *    0700 `mkdtemp` under a short tmpdir instead. The length is asserted, never
 *    hoped for.
 *  - NEVER pre-unlink, and fail on EADDRINUSE: a random 64-bit name that is
 *    already bound is someone else's socket, and unlinking it is the clobber the
 *    2026-07-28 orch.sock outage taught this repo to fear.
 *  - The process umask is never touched; the directory mode does the work and
 *    the socket file is tightened to 0600 after bind.
 *  - libuv unlinks a unix socket BY PATH inside `close()`. That is safe here
 *    only because every path is unique to one request — a path must never be
 *    shared or reused.
 *
 * PROTOCOL: newline-delimited JSON. The driver sends `{token, verb, args}`; the
 * runner's handler answers `{ok, exit, applicationState?, screenshot?,
 * hierarchy?, pid?, message?}`. The verb set is the HANDLER's business — this
 * module only frames, authenticates, serialises and whitelists. Frames are
 * handled ONE AT A TIME across all connections: one request owns one session,
 * and two Synthesize calls interleaving on it would race each other's captures.
 *
 * No electron, no services: standalone-extractable.
 */
import * as net from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { LoggerLike } from '../../types';

/** Env var carrying the drive socket path into the verification agent's env (§B4.4). */
export const VERIFY_XCODE_DRIVE_SOCKET_ENV = 'VERIFY_XCODE_DRIVE_SOCKET';
/** Env var carrying the per-request bearer token (§B4.3). */
export const VERIFY_XCODE_DRIVE_TOKEN_ENV = 'VERIFY_XCODE_DRIVE_TOKEN';

/** Socket basename prefix; the boot sweep keys on it. */
export const DRIVE_SOCKET_PREFIX = 'xd-';
const DRIVE_SOCKET_SUFFIX = '.sock';
const DRIVE_SOCKET_NAME = /^xd-[0-9a-f]{16}\.sock$/;
const FALLBACK_DIR_PREFIX = 'cfxd-';

/** `sun_path` is 104 bytes on macOS including the terminating NUL (108 on Linux); the stricter bound wins. */
export const MAX_SOCKET_PATH_BYTES = 103;

/**
 * The exit code for every refusal this layer produces itself (bad token,
 * malformed or oversized frame, a handler that threw). Equals the driver's
 * `MOBILE_EXIT_REFUSED`: a verb that could not run is `not_testable`, never a
 * deliverable verdict.
 */
export const DRIVE_EXIT_REFUSED = 2;

const DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;
/** A frame is a verb and a few arguments; 64 KiB is generous and bounds a hostile writer. */
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
/** A response may carry a path or two; this bounds what the driver will buffer. */
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MIN_TOKEN_LENGTH = 32;

/** What the handler answers for one verb. Only these fields ever reach the driver. */
export interface DriveResponse {
  ok: boolean;
  /** The process exit code the driver verb should use. */
  exit: number;
  applicationState?: string;
  /** Path (or artifacts-dir basename) of the screenshot copy the runner recorded. */
  screenshot?: string;
  /** Path of the hierarchy copy the runner recorded. */
  hierarchy?: string;
  pid?: number;
  message?: string;
}

/** One authenticated frame, as the handler sees it. The token never reaches the handler. */
export interface DriveRequest {
  verb: string;
  args: Record<string, unknown>;
}

export type DriveHandler = (request: DriveRequest) => Promise<DriveResponse> | DriveResponse;

export interface CreateDriveSocketOptions {
  /** The cyboflow data dir; the socket lives in its `sockets/` subdir. */
  dataDir: string;
  /** The per-request bearer token ({@link mintDriveToken}). Held in memory only. */
  token: string;
  handler: DriveHandler;
  /** Root for the long-path fallback `mkdtemp`. Defaults to `/tmp`. */
  shortTmpDir?: string;
  maxFrameBytes?: number;
  logger?: LoggerLike;
  /** Test seam: the 16 hex characters of the socket name. Defaults to 8 random bytes. */
  randomHex?: () => string;
}

export interface DriveSocket {
  readonly socketPath: string;
  /** The per-request `mkdtemp` dir when the long-path fallback was taken, else `null`. */
  readonly fallbackDir: string | null;
  /** Destroy connections, stop listening, unlink the socket, remove the fallback dir. Idempotent; never throws. */
  close(): Promise<void>;
}

/** Why {@link sendDriveFrame} could not deliver a frame and read its answer. */
export type DriveTransportFailure = 'connect' | 'timeout' | 'closed' | 'malformed-response' | 'oversized-response';

export class DriveTransportError extends Error {
  constructor(
    readonly reason: DriveTransportFailure,
    message: string,
  ) {
    super(message);
    this.name = 'DriveTransportError';
  }
}

/** 32 random bytes, hex-encoded — the same strength as orchAuthToken's per-run tokens. */
export function mintDriveToken(): string {
  return randomBytes(32).toString('hex');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function digest(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** Constant-time token check; hashing first keeps a length mismatch from being an oracle. */
function tokenMatches(expected: Buffer, presented: unknown): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  return timingSafeEqual(expected, digest(presented));
}

/**
 * Narrow an arbitrary value to a {@link DriveResponse}, keeping ONLY the known
 * fields. The whitelist is load-bearing: a handler that accidentally returned
 * its whole session state would otherwise hand the session key to the driver.
 */
function whitelistResponse(value: unknown): DriveResponse | null {
  const record = asRecord(value);
  if (record === null || typeof record.ok !== 'boolean') return null;
  const exit = record.exit;
  if (typeof exit !== 'number' || !Number.isInteger(exit) || exit < 0 || exit > 255) return null;
  const response: DriveResponse = { ok: record.ok, exit };
  for (const key of ['applicationState', 'screenshot', 'hierarchy', 'message'] as const) {
    const field = record[key];
    if (typeof field === 'string') response[key] = field;
  }
  if (typeof record.pid === 'number' && Number.isInteger(record.pid) && record.pid > 0) response.pid = record.pid;
  return response;
}

/** Parse one response line as the driver receives it. Exported for the driver side's tests. */
export function parseDriveResponse(line: string): DriveResponse | null {
  try {
    return whitelistResponse(JSON.parse(line));
  } catch {
    return null;
  }
}

function refusal(message: string): DriveResponse {
  return { ok: false, exit: DRIVE_EXIT_REFUSED, message };
}

/**
 * Create (or verify) a private directory: 0700, a real directory (not a
 * symlink), owned by this uid. An existing dir with group/other bits is
 * tightened — `<dataDir>/sockets` is shared with orch.sock, which wants 0700
 * too.
 */
async function ensurePrivateDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });
  const info = await fsp.lstat(dir);
  if (!info.isDirectory()) throw new Error(`drive socket dir ${dir} is not a directory`);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`drive socket dir ${dir} is not owned by this user`);
  }
  if ((info.mode & 0o077) !== 0) await fsp.chmod(dir, DIR_MODE);
}

function assertSocketPathLength(socketPath: string): void {
  const bytes = Buffer.byteLength(socketPath, 'utf8');
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `drive socket path is ${bytes} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte sun_path bound: ${socketPath}`,
    );
  }
}

/**
 * Stand up one request's drive socket. Rejects — never retries, never unlinks —
 * when the path is already bound (EADDRINUSE) or cannot be made short enough.
 */
export async function createDriveSocket(options: CreateDriveSocketOptions): Promise<DriveSocket> {
  if (options.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`drive socket token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const hex = (options.randomHex ?? (() => randomBytes(8).toString('hex')))();
  if (!/^[0-9a-f]{16}$/.test(hex)) throw new Error('drive socket name must be 16 lowercase hex characters');
  const name = `${DRIVE_SOCKET_PREFIX}${hex}${DRIVE_SOCKET_SUFFIX}`;
  const logger = options.logger;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const expectedToken = digest(options.token);

  let fallbackDir: string | null = null;
  const socketsDir = path.join(options.dataDir, 'sockets');
  let socketPath = path.join(socketsDir, name);
  if (Buffer.byteLength(socketPath, 'utf8') <= MAX_SOCKET_PATH_BYTES) {
    await ensurePrivateDir(socketsDir);
  } else {
    // mkdtemp creates the dir 0700; the chmod is a belt for exotic umask-ignoring filesystems.
    fallbackDir = await fsp.mkdtemp(path.join(options.shortTmpDir ?? '/tmp', FALLBACK_DIR_PREFIX));
    await fsp.chmod(fallbackDir, DIR_MODE);
    socketPath = path.join(fallbackDir, name);
  }
  try {
    assertSocketPathLength(socketPath);
  } catch (err) {
    if (fallbackDir !== null) await fsp.rmdir(fallbackDir).catch(() => undefined);
    throw err;
  }

  const connections = new Set<net.Socket>();
  /** The serialisation chain: every frame's handler runs after the previous one settles. */
  let chain: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | null = null;

  const invoke = async (request: DriveRequest): Promise<DriveResponse> => {
    try {
      const raw = await options.handler(request);
      return whitelistResponse(raw) ?? refusal(`drive handler returned an invalid response for ${request.verb}`);
    } catch (err) {
      logger?.warn('[xcodeDriveSocket] drive handler threw', { verb: request.verb, error: errorText(err) });
      return refusal(`drive handler failed: ${errorText(err)}`);
    }
  };

  const onConnection = (socket: net.Socket): void => {
    if (closing !== null) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let refused = false;

    const reply = (response: DriveResponse): void => {
      if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(response)}\n`);
    };
    const refuse = (message: string): void => {
      refused = true;
      buffer = '';
      reply(refusal(message));
      socket.end();
    };

    const handleLine = (line: string): void => {
      let frame: Record<string, unknown> | null;
      try {
        frame = asRecord(JSON.parse(line));
      } catch {
        refuse('malformed frame: not JSON');
        return;
      }
      if (frame === null) {
        refuse('malformed frame: not a JSON object');
        return;
      }
      // Authenticate BEFORE any other validation, so an unauthenticated writer
      // learns nothing about the frame grammar.
      if (!tokenMatches(expectedToken, frame.token)) {
        logger?.warn('[xcodeDriveSocket] refused a frame with a missing or wrong token');
        refuse('unauthorized');
        return;
      }
      const verb = frame.verb;
      if (typeof verb !== 'string' || verb.length === 0) {
        refuse('malformed frame: verb must be a non-empty string');
        return;
      }
      const args = frame.args === undefined ? {} : asRecord(frame.args);
      if (args === null) {
        refuse('malformed frame: args must be a JSON object');
        return;
      }
      const run = chain.then(() => invoke({ verb, args }));
      chain = run;
      void run.then(reply);
    };

    socket.on('data', (chunk: string) => {
      if (refused) return;
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0 && !refused) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line, 'utf8') > maxFrameBytes) {
          refuse('frame too large');
          return;
        }
        if (line.trim().length > 0) handleLine(line);
        newline = buffer.indexOf('\n');
      }
      if (!refused && Buffer.byteLength(buffer, 'utf8') > maxFrameBytes) refuse('frame too large');
    });
    socket.on('error', (err) => {
      logger?.debug('[xcodeDriveSocket] connection error', { error: errorText(err) });
    });
    socket.on('close', () => {
      connections.delete(socket);
    });
  };

  const server = net.createServer(onConnection);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        server.on('error', (err: Error) => {
          logger?.error('[xcodeDriveSocket] server error', { error: errorText(err) });
        });
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(socketPath);
    });
  } catch (err) {
    // Deliberately NO server.close() and NO unlink: a failed bind owns nothing,
    // and on EADDRINUSE the node at this path belongs to someone else.
    if (fallbackDir !== null) await fsp.rmdir(fallbackDir).catch(() => undefined);
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      code === 'EADDRINUSE'
        ? `drive socket path is already bound (EADDRINUSE), refusing to clobber it: ${socketPath}`
        : `drive socket could not listen on ${socketPath}: ${errorText(err)}`,
    );
  }

  let boundInode: number | null = null;
  try {
    await fsp.chmod(socketPath, SOCKET_MODE);
  } catch (err) {
    // Best-effort, as in OrchSocketServer: the 0700 dir and the token are the enforcement.
    logger?.warn('[xcodeDriveSocket] could not tighten the socket file mode', { error: errorText(err) });
  }
  try {
    boundInode = (await fsp.lstat(socketPath)).ino;
  } catch {
    boundInode = null;
  }
  logger?.info('[xcodeDriveSocket] listening', { socketPath, fallback: fallbackDir !== null });

  return {
    socketPath,
    fallbackDir,
    close: () => {
      if (closing !== null) return closing;
      closing = (async () => {
        for (const socket of connections) socket.destroy();
        connections.clear();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        // close() has already unlinked the path (libuv does it by path). This
        // sweep only removes a node that is still OUR inode, so it can never
        // take out a socket someone else later bound at the same path.
        try {
          const info = await fsp.lstat(socketPath);
          if (boundInode !== null && info.ino === boundInode) await fsp.rm(socketPath, { force: true });
        } catch {
          // Already gone — the normal case.
        }
        if (fallbackDir !== null) {
          await fsp.rmdir(fallbackDir).catch((err: unknown) => {
            logger?.warn('[xcodeDriveSocket] could not remove the fallback dir', { error: errorText(err) });
          });
        }
      })();
      return closing;
    },
  };
}

/**
 * The driver side: send one frame and read its one-line answer.
 *
 * Resolves with the whitelisted {@link DriveResponse} — including a refusal the
 * runner produced, which is still an answer. REJECTS with a
 * {@link DriveTransportError} only when no answer could be had: the socket is
 * unreachable, closed early, too slow, or answered garbage. `timeoutMs` must
 * cover the verb itself (a Synthesize takes seconds), not just the round trip.
 */
export function sendDriveFrame(
  socketPath: string,
  token: string,
  verb: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  opts: { maxResponseBytes?: number } = {},
): Promise<DriveResponse> {
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  return new Promise<DriveResponse>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    let buffer = '';
    let connected = false;
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      settle();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new DriveTransportError('timeout', `drive verb ${verb} got no answer within ${timeoutMs} ms`)));
    }, timeoutMs);

    socket.once('connect', () => {
      connected = true;
      socket.write(`${JSON.stringify({ token, verb, args })}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        if (Buffer.byteLength(buffer, 'utf8') > maxResponseBytes) {
          finish(() =>
            reject(new DriveTransportError('oversized-response', `drive answer exceeded ${maxResponseBytes} bytes`)),
          );
        }
        return;
      }
      const response = parseDriveResponse(buffer.slice(0, newline));
      finish(() =>
        response === null
          ? reject(new DriveTransportError('malformed-response', 'drive socket answered with a malformed response'))
          : resolve(response),
      );
    });
    socket.once('error', (err) => {
      finish(() =>
        reject(
          new DriveTransportError(
            connected ? 'closed' : 'connect',
            `drive socket ${connected ? 'failed' : 'unreachable'}: ${errorText(err)}`,
          ),
        ),
      );
    });
    socket.once('close', () => {
      finish(() => reject(new DriveTransportError('closed', 'drive socket closed before answering')));
    });
  });
}

/**
 * Boot sweep of leftover `xd-*.sock` files under `<dataDir>/sockets` (§B4.9) —
 * what a hard-killed cyboflow leaves behind. A file is removed only when no live
 * listener answers a connect probe, so a socket another live instance owns is
 * never touched. Returns the removed paths; never throws.
 */
export async function sweepStaleDriveSockets(
  dataDir: string,
  logger?: LoggerLike,
  probeTimeoutMs = 500,
): Promise<string[]> {
  const socketsDir = path.join(dataDir, 'sockets');
  let names: string[];
  try {
    names = await fsp.readdir(socketsDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!DRIVE_SOCKET_NAME.test(name)) continue;
    const candidate = path.join(socketsDir, name);
    try {
      const info = await fsp.lstat(candidate);
      if (!info.isSocket()) continue;
      if (await isListening(candidate, probeTimeoutMs)) continue;
      await fsp.rm(candidate, { force: true });
      removed.push(candidate);
    } catch (err) {
      logger?.debug('[xcodeDriveSocket] stale-socket sweep skipped an entry', { name, error: errorText(err) });
    }
  }
  if (removed.length > 0) logger?.info('[xcodeDriveSocket] swept stale drive sockets', { count: removed.length });
  return removed;
}

function isListening(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = net.createConnection(socketPath);
    let settled = false;
    const done = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
  });
}

// ---------------------------------------------------------------------------
// Capture ledger (§B5)
// ---------------------------------------------------------------------------

/**
 * One capture the runner took through Synthesize and copied into the
 * artifacts dir. Recorded runner-side, so the agent cannot forge it.
 */
export interface CaptureLedgerCapture {
  kind: 'capture';
  /** Monotonic position in the ledger. */
  seq: number;
  /** The capture's name — `mobile-capture <name>`'s argument, or the verb's own label. */
  name: string;
  /** The driver verb that took it (`mobile-capture`, `mobile-tap`, …). */
  verb: string;
  /** sha256 (hex) of the screenshot COPY in the artifacts dir; `null` when the copy failed. */
  sha256: string | null;
  /** Basename of that copy, the way a report cites it; `null` with `sha256`. */
  file: string | null;
  /** Synthesize's `applicationState` (`Running`, `Crashed`, `RunningInBackground`, …). */
  applicationState: string;
  /** The hierarchy's foreground app (deviceHierarchy.foregroundBundleId); `null` when unreadable. */
  foregroundBundleId: string | null;
  /** The app under test's pid from its own block; `null` when that block was absent. */
  pid: number | null;
  /** Whether this Synthesize passed `activationBundleId` (only `mobile-activate` does). */
  activated: boolean;
  /** ISO-8601 time the capture was recorded. */
  at: string;
}

/** A `mobile-launch` the runner pinned: the parsed `simctl launch` pid (§B4.6). */
export interface CaptureLedgerLaunch {
  kind: 'launch';
  seq: number;
  pid: number;
  at: string;
}

export type CaptureLedgerEntry = CaptureLedgerCapture | CaptureLedgerLaunch;

/** The per-request ledger, persisted verbatim as `provenance.captureLedger`. Plain JSON. */
export interface CaptureLedger {
  version: 1;
  /** `VERIFY_APP_BUNDLE_ID` — the app whose foreground captures can count as pass evidence. */
  appBundleId: string;
  entries: CaptureLedgerEntry[];
}

export type LedgerCaptureInput = Omit<CaptureLedgerCapture, 'kind' | 'seq' | 'at'>;

export function createCaptureLedger(appBundleId: string): CaptureLedger {
  return { version: 1, appBundleId, entries: [] };
}

export function recordLedgerCapture(
  ledger: CaptureLedger,
  input: LedgerCaptureInput,
  now: Date = new Date(),
): CaptureLedgerCapture {
  const entry: CaptureLedgerCapture = { kind: 'capture', seq: ledger.entries.length, ...input, at: now.toISOString() };
  ledger.entries.push(entry);
  return entry;
}

export function recordLedgerLaunch(ledger: CaptureLedger, pid: number, now: Date = new Date()): CaptureLedgerLaunch {
  const entry: CaptureLedgerLaunch = { kind: 'launch', seq: ledger.entries.length, pid, at: now.toISOString() };
  ledger.entries.push(entry);
  return entry;
}

/** The current pin: the pid of the most recent `launch`, or `null` before any. */
export function ledgerPin(ledger: CaptureLedger): number | null {
  for (let i = ledger.entries.length - 1; i >= 0; i -= 1) {
    const entry = ledger.entries[i] as CaptureLedgerEntry;
    if (entry.kind === 'launch') return entry.pid;
  }
  return null;
}

/** Why a capture does or does not count as pass evidence. */
type CaptureStanding = 'counts' | 'foreground' | 'post-relaunch' | 'no-launch' | 'no-pid';

/**
 * Walk the ledger in order and classify every capture. A capture COUNTS when a
 * launch pinned a pid before it, its own pid equals that pin, no capture since
 * the pin has shown a different pid (the review's rule: a pid change with no
 * launch event before it marks every later capture as post-relaunch), and the
 * app under test was in the foreground.
 */
function classifyCaptures(ledger: CaptureLedger): Map<CaptureLedgerCapture, CaptureStanding> {
  const standing = new Map<CaptureLedgerCapture, CaptureStanding>();
  let pin: number | null = null;
  let relaunched = false;
  for (const entry of ledger.entries) {
    if (entry.kind === 'launch') {
      pin = entry.pid;
      relaunched = false;
      continue;
    }
    if (pin !== null && entry.pid !== null && entry.pid !== pin) relaunched = true;
    if (pin === null) standing.set(entry, 'no-launch');
    else if (relaunched) standing.set(entry, 'post-relaunch');
    else if (entry.pid === null) standing.set(entry, 'no-pid');
    else if (entry.foregroundBundleId !== ledger.appBundleId) standing.set(entry, 'foreground');
    else standing.set(entry, 'counts');
  }
  return standing;
}

export type LedgerEvidenceVerdict =
  | { counts: true; capture: CaptureLedgerCapture }
  | { counts: false; reason: string };

/**
 * Does a `pass` behaviour's cited evidence stand (§B5)? It does when at least
 * one cited screenshot sha256 is a ledger capture that COUNTS (see
 * {@link classifyCaptures}). Otherwise the caller caps the behaviour at
 * `low_confidence` with the returned reason.
 */
export function evaluateLedgerEvidence(
  ledger: CaptureLedger,
  citedSha256s: readonly string[],
): LedgerEvidenceVerdict {
  if (citedSha256s.length === 0) return { counts: false, reason: 'the behaviour cites no screenshot' };
  const standing = classifyCaptures(ledger);
  const cited = new Set(citedSha256s.map((sha) => sha.toLowerCase()));
  const matches = [...standing.entries()].filter(
    ([capture]) => capture.sha256 !== null && cited.has(capture.sha256.toLowerCase()),
  );
  const counting = matches.find(([, state]) => state === 'counts');
  if (counting !== undefined) return { counts: true, capture: counting[0] };
  if (matches.length === 0) {
    return { counts: false, reason: 'no cited screenshot is a harness capture recorded in the ledger' };
  }
  const [capture, state] = matches[0] as [CaptureLedgerCapture, CaptureStanding];
  const reasons: Record<Exclude<CaptureStanding, 'counts'>, string> = {
    foreground: `the cited capture "${capture.name}" shows ${capture.foregroundBundleId ?? 'no identifiable app'} in the foreground, not ${ledger.appBundleId}`,
    'post-relaunch': `the cited capture "${capture.name}" was taken after the app relaunched (its pid no longer matches the pinned launch)`,
    'no-launch': `the cited capture "${capture.name}" precedes any pinned mobile-launch`,
    'no-pid': `the cited capture "${capture.name}" has no hierarchy block for ${ledger.appBundleId}`,
  };
  return { counts: false, reason: reasons[state as Exclude<CaptureStanding, 'counts'>] };
}
