/**
 * xcodeDriveSession — the runner's side of the Xcode 27 DeviceInteraction
 * drive/observe rung for ONE `mobile` verification request
 * (docs/proposals/runbook-optional-verification.md §B4, §B5).
 *
 * The three standalone modules built before this one — the bridge client, the
 * hierarchy parser and the drive socket — each prove one seam. This module is
 * the LIFECYCLE that strings them together, and the verb handler the socket
 * dispatches to. The runner calls {@link openXcodeDriveSession} right after the
 * simulator is acquired and {@link XcodeDriveSession.close} in its `finally`;
 * everything in between happens here, runner-side, where the agent cannot
 * reach it except through the socket's verbs.
 *
 * OPEN (§B4.2–§B4.4), in this order and no other:
 *  1. mint the session identifier (128 random bits; it IS the session key) and
 *     keep it in memory — logs carry only {@link sessionKeyFingerprint};
 *  2. write it into the request's `owner.json` BEFORE StartSession, so a
 *     hard-killed cyboflow leaves the boot sweep a key to end (sessions outlive
 *     the bridge process, §B0) — a failed write means no session is started;
 *  3. spawn ONE bridge (the resolved `xcrun` with `['mcpbridge']`, no shell)
 *     and `DeviceInteractionStartSession` on the leased udid;
 *  4. require `deviceUUID` to BE that udid — the tool fuzzy-matches anything,
 *     so a mismatch ends the session and degrades rather than driving some
 *     other device;
 *  5. stand up the per-request drive socket with a per-request bearer token.
 * Any failure DEGRADES (the caller falls to Maestro or none) — it never skips.
 *
 * CLOSE (§B4.8): EndSession → bridge SIGTERM/SIGKILL → socket close+unlink.
 * Each step is independent (a throw or a hang in one never skips the next),
 * bounded by its own timer (~10 s), and deliberately NOT bound to the runner's
 * `controller.signal`, which the `finally` aborts before teardown begins — a
 * teardown bound to it would be cancelled before it started.
 *
 * PID PINNING (§B4.6, B-5). DeviceInteraction activation LAUNCHES a
 * not-running app, so a crash followed by any activation would look like a
 * healthy app. Under this rung `mobile-launch` reports its `simctl launch` pid
 * over the socket and that pid becomes the pin (a `launch` ledger event). Every
 * Synthesize is bracketed: the pin must be alive BEFORE it, and AFTER it the
 * app's own hierarchy block must exist and carry the pinned pid. Otherwise the
 * verb fails WITHOUT retrying or activating: exit
 * {@link MOBILE_EXIT_APP_EXITED}, `app-exited pid=<pin> state=<s>` plus the
 * console-log tail.
 *
 * DEVIATION FROM §B4.6 AS DRAFTED (measured, B0 probe transcripts): in a
 * NON-workspace session `applicationState` describes the workspace's "run
 * application", which does not exist — it reads `NotRun` even while the
 * driven app is on screen. "State must be Running" would therefore fail every
 * verb. The pin rests on the block's pid plus `isProcessAlive` instead, and
 * the state only counts when it is a POSITIVE crash (`Crashed`). And one verb
 * is exempt from "the block must exist": `mobile-press home`, whose whole
 * purpose is to background the app (the next verb must be `mobile-activate`,
 * whose own post-check is strict again — a relaunch there is a pid change).
 *
 * THE LEDGER (§B5). Every Synthesize this module performs is copied into the
 * artifacts dir and recorded — sha256 of the COPY, `applicationState`, the
 * hierarchy's foreground bundle, the app's pid, whether it activated — so a
 * `pass` can later be required to cite a harness capture of the app under
 * test, taken since the pinned launch. The agent never writes this ledger.
 *
 * THE GRAMMAR (§B0). Only `t x y` (tap) and `type <text>` were exercised live.
 * The swipe (`s x1 y1 x2 y2 dur`) and home-button (`b home`) spellings come
 * from the skill text compiled into IDEDeviceInteraction.framework, whose
 * command keywords are Swift small-string immediates the `strings` dump drops —
 * they are single-letter tokens recovered from the disassembly, and are
 * UNMEASURED until the live smoke. They live in the builders below and nowhere
 * else, so a correction is a one-line change.
 *
 * No electron, no services: standalone-extractable like the rest of
 * orchestrator/verify.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { LoggerLike } from '../../types';
import {
  MOBILE_EXIT_APP_EXITED,
  MOBILE_EXIT_OK,
  MOBILE_EXIT_REFUSED,
  MOBILE_EXIT_TARGET_UNRESOLVED,
} from '../driver/mobileCommands';
import {
  blockFor,
  foregroundBundleId,
  parseDeviceHierarchy,
  resolveTap,
  swipePoints,
  windowFrame,
  type ApplicationBlock,
  type HierarchyPoint,
  type HierarchySwipeDirection,
  type ParsedHierarchy,
} from './deviceHierarchy';
import type { XcodeDegradeReason } from './driveEngineSelection';
import {
  createCaptureLedger,
  createDriveSocket,
  ledgerPin,
  mintDriveToken,
  recordLedgerCapture,
  recordLedgerLaunch,
  VERIFY_XCODE_DRIVE_SOCKET_ENV,
  VERIFY_XCODE_DRIVE_TOKEN_ENV,
  type CaptureLedger,
  type DriveRequest,
  type DriveResponse,
  type DriveSocket,
} from './xcodeDriveSocketServer';
import {
  createXcodeMcpBridgeClient,
  isSessionMissingMessage,
  mintSessionIdentifier as defaultMintSessionIdentifier,
  sessionKeyFingerprint,
  type BridgeFailureKind,
  type SynthesizeResult,
  type XcodeMcpBridgeClient,
  type XcodeMcpBridgeClientOptions,
} from './xcodeMcpBridgeClient';

/** `VERIFY_MOBILE_DRIVE`'s value on this rung (§B4.4). */
export const VERIFY_MOBILE_DRIVE_XCODE = 'xcode';

/** Each teardown step's own bound (§B4.8: "bounded, ~10 s"). */
export const XCODE_TEARDOWN_STEP_TIMEOUT_MS = 10_000;

/** The sweep's EndSession budget (§B4.9: "short timeout"). */
const SWEEP_END_SESSION_TIMEOUT_MS = 5_000;
const SWEEP_INIT_TIMEOUT_MS = 10_000;

/** Seconds a mapped `mobile-swipe` takes; the skill's own examples use 0.3. */
export const XCODE_SWIPE_DURATION_S = 0.3;

/** Bound on the console-log tail an app-exited refusal quotes. */
const LOG_TAIL_CHARS = 1_500;

/** The one `applicationState` that is positive evidence of a crash (see the module doc's deviation note). */
const CRASHED_STATE = 'Crashed';

// ---------------------------------------------------------------------------
// The interaction grammar (§B0) — the ONLY place its spellings live
// ---------------------------------------------------------------------------

function coord(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** `t x y` — a tap at a hierarchy point (measured live: `t 201 437`). */
export function tapCommand(x: number, y: number): string {
  return `t ${coord(x)} ${coord(y)}`;
}

/** `s x1 y1 x2 y2 dur` — a swipe (UNMEASURED spelling, see the module doc). */
export function swipeCommand(from: HierarchyPoint, to: HierarchyPoint, durationS = XCODE_SWIPE_DURATION_S): string {
  return `s ${coord(from.x)} ${coord(from.y)} ${coord(to.x)} ${coord(to.y)} ${durationS}`;
}

/** The hardware home button (UNMEASURED spelling, see the module doc). */
export const HOME_BUTTON_COMMAND = 'b home';

/** `type <text>` — must be the LAST command in a chain; everything after `type ` is verbatim. */
export function typeCommand(text: string): string {
  return `type ${text}`;
}

/** Return/enter: `type` with the grammar's own `\u{000A}` escape (a literal backslash sequence). */
export const RETURN_KEY_COMMAND = 'type \\u{000A}';

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** The filesystem the session touches: copying captures into the artifacts dir and reading the tool's outputs. */
export interface XcodeDriveFs {
  copyFile(from: string, to: string): Promise<void>;
  readText(filePath: string): Promise<string>;
  readBytes(filePath: string): Promise<Buffer>;
  mkdir(dirPath: string): Promise<void>;
}

const NODE_FS: XcodeDriveFs = {
  copyFile: (from, to) => fsp.copyFile(from, to),
  readText: (filePath) => fsp.readFile(filePath, 'utf8'),
  readBytes: (filePath) => fsp.readFile(filePath),
  mkdir: async (dirPath) => {
    await fsp.mkdir(dirPath, { recursive: true });
  },
};

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface OpenXcodeDriveSessionOptions {
  requestId: string;
  /** The LEASED simulator's udid — the only device this session may drive. */
  udid: string;
  /** `VERIFY_APP_BUNDLE_ID` — the app whose block the pin is read from. */
  appBundleId: string;
  /** The cyboflow data dir: the socket lives in its `sockets/` subdir. */
  dataDir: string;
  /** `VERIFY_ARTIFACTS_DIR` — where every capture is copied, by name. */
  artifactsDir: string;
  /** Stamp the key into `owner.json` (MobileSimulatorHandle.recordXcodeSessionKey). */
  recordSessionKey: (key: string) => Promise<void>;
  /** The resolved `xcrun`. Defaults to the client's own `/usr/bin/xcrun`. */
  xcrunPath?: string;
  /** The bridge's environment. Defaults to `process.env`. */
  bridgeEnv?: NodeJS.ProcessEnv;
  /** Test seam over {@link createXcodeMcpBridgeClient}. */
  createClient?: (options: XcodeMcpBridgeClientOptions) => XcodeMcpBridgeClient;
  isProcessAlive?: (pid: number) => boolean;
  fs?: XcodeDriveFs;
  mintSessionIdentifier?: () => string;
  mintToken?: () => string;
  /** Root for the socket's long-path fallback `mkdtemp`. */
  shortTmpDir?: string;
  teardownStepTimeoutMs?: number;
  logger?: LoggerLike;
}

/** One teardown step's outcome — logged, and returned for the lifecycle tests. */
export interface XcodeTeardownStep {
  step: 'end-session' | 'bridge' | 'socket';
  ok: boolean;
  detail: string;
}

export interface XcodeDriveSession {
  /** `VERIFY_MOBILE_DRIVE=xcode` plus the socket path and token (§B4.4). */
  readonly env: Readonly<Record<string, string>>;
  /** The live, runner-held capture ledger (§B5). */
  readonly ledger: CaptureLedger;
  /** The loggable stand-in for the session key. */
  readonly keyFingerprint: string;
  /** EndSession → bridge → socket; each bounded and independent. Idempotent; never throws. */
  close(): Promise<XcodeTeardownStep[]>;
}

export type OpenXcodeDriveSessionResult =
  | { ok: true; session: XcodeDriveSession }
  | { ok: false; degradeReason: XcodeDegradeReason; detail: string };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run `fn`, settle within `timeoutMs` whatever it does, and never throw. */
async function boundedStep(
  step: XcodeTeardownStep['step'],
  timeoutMs: number,
  fn: () => Promise<string>,
): Promise<XcodeTeardownStep> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<XcodeTeardownStep>((resolve) => {
    timer = setTimeout(() => resolve({ step, ok: false, detail: `did not finish within ${timeoutMs} ms` }), timeoutMs);
  });
  const run = (async (): Promise<XcodeTeardownStep> => {
    try {
      return { step, ok: true, detail: await fn() };
    } catch (err) {
      return { step, ok: false, detail: errorText(err) };
    }
  })();
  try {
    return await Promise.race([run, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** How a bridge failure kind degrades the rung at open time. */
function degradeFor(kind: BridgeFailureKind): XcodeDegradeReason {
  return kind === 'not-approved' ? 'xcode-approval-missing' : 'xcode-session-failed';
}

/**
 * Open one request's xcode drive session. Never throws: every failure is a
 * `{ ok: false, degradeReason }` with anything it had started already torn
 * down, so the caller only has to fall to the next rung.
 */
export async function openXcodeDriveSession(options: OpenXcodeDriveSessionOptions): Promise<OpenXcodeDriveSessionResult> {
  const logger = options.logger;
  const stepTimeoutMs = options.teardownStepTimeoutMs ?? XCODE_TEARDOWN_STEP_TIMEOUT_MS;
  const sessionIdentifier = (options.mintSessionIdentifier ?? defaultMintSessionIdentifier)();
  const keyFingerprint = sessionKeyFingerprint(sessionIdentifier);
  const logContext = { requestId: options.requestId, session: keyFingerprint };

  // (2) The marker write comes FIRST: a session nothing recorded is one no
  // sweep can ever end.
  try {
    await options.recordSessionKey(sessionIdentifier);
  } catch (err) {
    return {
      ok: false,
      degradeReason: 'xcode-session-failed',
      detail: `could not record the session key in the owner marker: ${errorText(err)}`,
    };
  }

  // (3) One bridge, argv-only.
  const createClient = options.createClient ?? createXcodeMcpBridgeClient;
  let client: XcodeMcpBridgeClient;
  try {
    client = createClient({
      ...(options.xcrunPath !== undefined ? { xcrunPath: options.xcrunPath } : {}),
      ...(options.bridgeEnv !== undefined ? { env: options.bridgeEnv } : {}),
      ...(logger !== undefined ? { logger } : {}),
    });
  } catch (err) {
    return { ok: false, degradeReason: 'xcode-session-failed', detail: `could not build the bridge client: ${errorText(err)}` };
  }
  const connected = await client.connect();
  if (!connected.ok) {
    await client.close();
    logger?.info('[xcodeDriveSession] bridge handshake failed; degrading', { ...logContext, kind: connected.kind });
    return { ok: false, degradeReason: degradeFor(connected.kind), detail: `xcrun mcpbridge: ${connected.message}` };
  }
  const started = await client.startSession({ deviceIdentifier: options.udid, sessionIdentifier });
  if (!started.ok) {
    await client.close();
    logger?.info('[xcodeDriveSession] StartSession failed; degrading', { ...logContext, kind: started.kind });
    return {
      ok: false,
      degradeReason: degradeFor(started.kind),
      detail: `DeviceInteractionStartSession: ${started.message}`,
    };
  }
  const sessionKey = started.structured.interactionSessionKey;

  const endAndClose = async (): Promise<void> => {
    await boundedStep('end-session', stepTimeoutMs, async () => {
      const ended = await client.endSession({ interactionSessionKey: sessionKey }, stepTimeoutMs);
      return ended.ok ? ended.structured.userMessage : ended.message;
    });
    await boundedStep('bridge', stepTimeoutMs, async () => {
      await client.close();
      return 'closed';
    });
  };

  // (4) The tool fuzzy-matches `deviceIdentifier`; only the leased udid will do.
  // Compared case-insensitively: a UUID's case is presentation, not identity.
  if (started.structured.deviceUUID.toUpperCase() !== options.udid.toUpperCase()) {
    await endAndClose();
    logger?.warn('[xcodeDriveSession] StartSession bound a different device; degrading', logContext);
    return {
      ok: false,
      degradeReason: 'xcode-session-failed',
      detail: `DeviceInteractionStartSession bound device ${started.structured.deviceUUID}, not the leased simulator ${options.udid}`,
    };
  }

  // (5) The socket, with the verb handler bound to this session.
  const token = (options.mintToken ?? mintDriveToken)();
  const handler = createXcodeVerbHandler({
    client,
    sessionKey,
    appBundleId: options.appBundleId,
    artifactsDir: options.artifactsDir,
    isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
    fs: options.fs ?? NODE_FS,
    ...(logger !== undefined ? { logger } : {}),
  });
  let socket: DriveSocket;
  try {
    socket = await createDriveSocket({
      dataDir: options.dataDir,
      token,
      handler: handler.handle,
      ...(options.shortTmpDir !== undefined ? { shortTmpDir: options.shortTmpDir } : {}),
      ...(logger !== undefined ? { logger } : {}),
    });
  } catch (err) {
    await endAndClose();
    return { ok: false, degradeReason: 'xcode-session-failed', detail: `drive socket: ${errorText(err)}` };
  }
  logger?.info('[xcodeDriveSession] session open', { ...logContext, socket: socket.socketPath });

  let closing: Promise<XcodeTeardownStep[]> | null = null;
  return {
    ok: true,
    session: {
      env: {
        VERIFY_MOBILE_DRIVE: VERIFY_MOBILE_DRIVE_XCODE,
        [VERIFY_XCODE_DRIVE_SOCKET_ENV]: socket.socketPath,
        [VERIFY_XCODE_DRIVE_TOKEN_ENV]: token,
      },
      ledger: handler.ledger,
      keyFingerprint,
      close: () => {
        if (closing !== null) return closing;
        closing = (async () => {
          // Three INDEPENDENT steps, in the §B4.8 order. None awaits the
          // runner's abort signal; each has its own clock.
          const steps: XcodeTeardownStep[] = [];
          steps.push(
            await boundedStep('end-session', stepTimeoutMs, async () => {
              const ended = await client.endSession({ interactionSessionKey: sessionKey }, stepTimeoutMs);
              if (ended.ok) return ended.structured.userMessage;
              throw new Error(`${ended.kind}: ${ended.message}`);
            }),
          );
          steps.push(
            await boundedStep('bridge', stepTimeoutMs, async () => {
              await client.close();
              return 'bridge closed';
            }),
          );
          steps.push(
            await boundedStep('socket', stepTimeoutMs, async () => {
              await socket.close();
              return 'socket closed';
            }),
          );
          for (const step of steps) {
            if (!step.ok) logger?.warn('[xcodeDriveSession] teardown step did not complete', { ...logContext, ...step });
          }
          return steps;
        })();
        return closing;
      },
    },
  };
}

/**
 * The §B4.9 sweep's best-effort `EndSession(key)` for a dead owner's marker:
 * one short-lived bridge, a short timeout, and "doesn't exist" / "isn't
 * approved" ignored (they are the expected answers for a session the device
 * deletion already ended, or a grant that lapsed). NEVER throws.
 */
export async function endXcodeSessionBestEffort(
  sessionKey: string,
  options: {
    xcrunPath?: string;
    bridgeEnv?: NodeJS.ProcessEnv;
    createClient?: (options: XcodeMcpBridgeClientOptions) => XcodeMcpBridgeClient;
    logger?: LoggerLike;
  } = {},
): Promise<void> {
  const logger = options.logger;
  let client: XcodeMcpBridgeClient | null = null;
  try {
    client = (options.createClient ?? createXcodeMcpBridgeClient)({
      ...(options.xcrunPath !== undefined ? { xcrunPath: options.xcrunPath } : {}),
      ...(options.bridgeEnv !== undefined ? { env: options.bridgeEnv } : {}),
      ...(logger !== undefined ? { logger } : {}),
      initTimeoutMs: SWEEP_INIT_TIMEOUT_MS,
    });
    const connected = await client.connect();
    if (!connected.ok) {
      logger?.info('[xcodeDriveSession] sweep could not reach the bridge; leaving the session to expire', {
        session: sessionKeyFingerprint(sessionKey),
        kind: connected.kind,
      });
      return;
    }
    const ended = await client.endSession({ interactionSessionKey: sessionKey }, SWEEP_END_SESSION_TIMEOUT_MS);
    logger?.info('[xcodeDriveSession] sweep ended a stale Xcode session', {
      session: sessionKeyFingerprint(sessionKey),
      ok: ended.ok,
      ...(ended.ok ? { message: ended.structured.userMessage } : { kind: ended.kind }),
    });
  } catch (err) {
    logger?.info('[xcodeDriveSession] sweep EndSession threw (ignored)', { error: errorText(err) });
  } finally {
    if (client !== null) await client.close();
  }
}

// ---------------------------------------------------------------------------
// The verb handler (§B4.5)
// ---------------------------------------------------------------------------

interface VerbHandlerDeps {
  client: XcodeMcpBridgeClient;
  sessionKey: string;
  appBundleId: string;
  artifactsDir: string;
  isProcessAlive: (pid: number) => boolean;
  fs: XcodeDriveFs;
  logger?: LoggerLike;
}

/** One Synthesize, recorded: the response for the driver plus the parsed hierarchy for the verb's next step. */
interface SynthOutcome {
  response: DriveResponse;
  hierarchy: ParsedHierarchy | null;
}

function refused(message: string, exit: number = MOBILE_EXIT_REFUSED): DriveResponse {
  return { ok: false, exit, message };
}

/** A bare screenshot basename, `.png`-suffixed; `null` when unusable (mirrors the driver's own sanitiser). */
function captureName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (name.length === 0 || name.includes('/') || name.includes('\\') || name.includes('..') || name.startsWith('.')) {
    return null;
  }
  return /\.png$/i.test(name) ? name : `${name}.png`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function point(value: unknown): HierarchyPoint | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const x = finiteNumber(value[0]);
  const y = finiteNumber(value[1]);
  return x === null || y === null ? null : { x, y };
}

function isSwipeDirection(value: unknown): value is HierarchySwipeDirection {
  return value === 'up' || value === 'down' || value === 'left' || value === 'right';
}

export function createXcodeVerbHandler(deps: VerbHandlerDeps): {
  handle: (request: DriveRequest) => Promise<DriveResponse>;
  ledger: CaptureLedger;
} {
  const ledger = createCaptureLedger(deps.appBundleId);
  const hierarchyDir = path.join(deps.artifactsDir, 'xcode-hierarchy');
  let autoSeq = 0;
  const autoName = (label: string): string => {
    autoSeq += 1;
    return `xcode-${String(autoSeq).padStart(3, '0')}-${label}.png`;
  };

  const logTail = async (logsPath: string | null): Promise<string> => {
    if (logsPath === null) return '';
    try {
      const text = (await deps.fs.readText(logsPath)).trim();
      return text.length <= LOG_TAIL_CHARS ? text : `…${text.slice(-LOG_TAIL_CHARS)}`;
    } catch {
      return '';
    }
  };

  const appExited = async (pin: number, state: string, logsPath: string | null, why: string): Promise<DriveResponse> => {
    const tail = await logTail(logsPath);
    deps.logger?.info('[xcodeDriveSession] app exited under the pin', { pin, state, why });
    return {
      ok: false,
      exit: MOBILE_EXIT_APP_EXITED,
      message: `app-exited pid=${pin} state=${state} (${why})${tail.length > 0 ? `\n${tail}` : ''}`,
    };
  };

  /** Copy + hash the screenshot, read + parse + copy the hierarchy, record the ledger entry. */
  const record = async (
    result: SynthesizeResult,
    name: string,
    verb: string,
    activated: boolean,
  ): Promise<{ file: string | null; hierarchy: ParsedHierarchy | null; hierarchyCopy: string | null; pid: number | null }> => {
    let file: string | null = null;
    let sha256: string | null = null;
    try {
      await deps.fs.mkdir(deps.artifactsDir);
      const dest = path.join(deps.artifactsDir, name);
      await deps.fs.copyFile(result.screenshotPath, dest);
      sha256 = createHash('sha256').update(await deps.fs.readBytes(dest)).digest('hex');
      file = name;
    } catch (err) {
      deps.logger?.warn('[xcodeDriveSession] could not copy a capture into the artifacts dir', {
        name,
        error: errorText(err),
      });
    }
    let hierarchy: ParsedHierarchy | null = null;
    let hierarchyCopy: string | null = null;
    if (result.hierarchyPath !== null) {
      try {
        const text = await deps.fs.readText(result.hierarchyPath);
        hierarchy = parseDeviceHierarchy(text);
        try {
          await deps.fs.mkdir(hierarchyDir);
          hierarchyCopy = path.join(hierarchyDir, name.replace(/\.png$/i, '.txt'));
          await deps.fs.copyFile(result.hierarchyPath, hierarchyCopy);
        } catch {
          hierarchyCopy = null;
        }
      } catch (err) {
        deps.logger?.info('[xcodeDriveSession] hierarchy unreadable', { name, error: errorText(err) });
      }
    }
    const pid = hierarchy === null ? null : (blockFor(hierarchy, deps.appBundleId)?.pid ?? null);
    recordLedgerCapture(ledger, {
      name,
      verb,
      sha256,
      file,
      applicationState: result.applicationState,
      foregroundBundleId: hierarchy === null ? null : foregroundBundleId(hierarchy),
      pid,
      activated,
    });
    return { file, hierarchy, hierarchyCopy, pid };
  };

  /**
   * One pinned Synthesize. `allowBackground` is `mobile-press home` alone: the
   * app leaving the foreground is that verb's purpose, so a missing block is
   * expected there — its pid still has to be alive.
   */
  const synth = async (opts: {
    name: string;
    verb: string;
    command?: string;
    activate?: boolean;
    allowBackground?: boolean;
  }): Promise<SynthOutcome> => {
    const pin = ledgerPin(ledger);
    if (pin !== null && !deps.isProcessAlive(pin)) {
      return { response: await appExited(pin, 'gone', null, 'the pinned pid is not running'), hierarchy: null };
    }
    const call = async (withCommand: boolean) =>
      deps.client.synthesize({
        interactSessionKey: deps.sessionKey,
        ...(withCommand && opts.command !== undefined ? { interactionCommand: opts.command } : {}),
        ...(withCommand && opts.activate === true ? { activationBundleId: deps.appBundleId } : {}),
      });
    const result = await call(true);
    if (!result.ok) {
      // §B4.7: a session that vanished, a device that changed under it, a
      // lapsed grant, a dead bridge — every one is a verb that could not run
      // (not_testable), never a deliverable verdict.
      const hint = isSessionMissingMessage(result.message) ? ' (the DeviceInteraction session is gone)' : '';
      return { response: refused(`xcode drive failed [${result.kind}]${hint}: ${result.message}`), hierarchy: null };
    }
    let recorded = await record(result.structured, opts.name, opts.verb, opts.activate === true);
    let state = result.structured.applicationState;
    let logsPath = result.structured.logsPath;
    if (recorded.hierarchy === null) {
      // The tool's own contract: a missing hierarchy "might be AX transient,
      // retry". One capture-only retry — never re-sending the command.
      const again = await call(false);
      if (again.ok) {
        recorded = await record(again.structured, autoName(`${opts.verb.replace(/^mobile-/, '')}-recapture`), opts.verb, false);
        state = again.structured.applicationState;
        logsPath = again.structured.logsPath;
      }
    }
    if (pin !== null) {
      if (!deps.isProcessAlive(pin)) {
        return { response: await appExited(pin, state, logsPath, 'the pinned pid died'), hierarchy: recorded.hierarchy };
      }
      if (state === CRASHED_STATE) {
        return { response: await appExited(pin, state, logsPath, 'the app reports Crashed'), hierarchy: recorded.hierarchy };
      }
      const block = recorded.hierarchy === null ? null : blockFor(recorded.hierarchy, deps.appBundleId);
      if (block === null && opts.allowBackground !== true) {
        return {
          response: await appExited(pin, state, logsPath, `no hierarchy block for ${deps.appBundleId}`),
          hierarchy: recorded.hierarchy,
        };
      }
      if (block !== null && block.pid !== pin) {
        return {
          response: await appExited(
            pin,
            state,
            logsPath,
            block.pid === null ? 'the app block carries no pid' : `the app now runs as pid ${block.pid} (relaunched)`,
          ),
          hierarchy: recorded.hierarchy,
        };
      }
    }
    return {
      response: {
        ok: true,
        exit: MOBILE_EXIT_OK,
        applicationState: state,
        ...(recorded.file !== null ? { screenshot: recorded.file } : {}),
        ...(recorded.hierarchyCopy !== null ? { hierarchy: recorded.hierarchyCopy } : {}),
        ...(recorded.pid !== null ? { pid: recorded.pid } : {}),
      },
      hierarchy: recorded.hierarchy,
    };
  };

  /** Capture, then take the app's block from that FRESH hierarchy — the basis every coordinate is resolved against. */
  const freshBlock = async (
    verb: string,
    label: string,
  ): Promise<{ ok: false; error: DriveResponse } | { ok: true; block: ApplicationBlock }> => {
    const pre = await synth({ name: autoName(label), verb });
    if (pre.response.exit !== MOBILE_EXIT_OK) return { ok: false, error: pre.response };
    const block = pre.hierarchy === null ? null : blockFor(pre.hierarchy, deps.appBundleId);
    if (block === null) {
      return {
        ok: false,
        error: refused(
          `${deps.appBundleId} has no block in the fresh hierarchy (it is not on screen) — run mobile-launch or mobile-activate first`,
          MOBILE_EXIT_TARGET_UNRESOLVED,
        ),
      };
    }
    return { ok: true, block };
  };

  const withMessage = (response: DriveResponse, message: string): DriveResponse =>
    response.ok ? { ...response, message } : response;

  const handle = async (request: DriveRequest): Promise<DriveResponse> => {
    const { verb, args } = request;
    switch (verb) {
      case 'launch': {
        const pid = args.pid;
        if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return refused('launch needs a positive integer pid');
        recordLedgerLaunch(ledger, pid);
        return { ok: true, exit: MOBILE_EXIT_OK, pid, message: `pinned pid=${pid}` };
      }
      case 'capture':
      case 'screenshot': {
        const name = captureName(args.name);
        if (name === null) return refused(`invalid capture name: ${String(args.name)}`);
        const out = await synth({ name, verb: `mobile-${verb}` });
        return withMessage(out.response, `ok: captured ${name}`);
      }
      case 'tap': {
        const x = finiteNumber(args.x);
        const y = finiteNumber(args.y);
        if (x !== null && y !== null) {
          const out = await synth({ name: autoName('tap'), verb: 'mobile-tap', command: tapCommand(x, y) });
          return withMessage(out.response, `ok: tapped (${coord(x)}, ${coord(y)})`);
        }
        const target = args.target;
        if (typeof target !== 'string' || target.trim().length === 0) {
          return refused('mobile-tap needs a <text-or-id> or --at <x> <y>');
        }
        const fresh = await freshBlock('mobile-tap', 'tap-target');
        if (!fresh.ok) return fresh.error;
        const resolution = resolveTap(fresh.block, target);
        if ('none' in resolution) {
          return refused(
            `no tappable element is labelled or identified "${target}"; on screen: ${resolution.none.map((n) => JSON.stringify(n)).join(', ') || '(nothing tappable)'}`,
            MOBILE_EXIT_TARGET_UNRESOLVED,
          );
        }
        if ('ambiguous' in resolution) {
          const candidates = resolution.ambiguous
            .map((e) => `${e.role} ${JSON.stringify(e.label ?? e.identifier ?? '')} at (${coord(e.hitPoint?.x ?? 0)}, ${coord(e.hitPoint?.y ?? 0)})`)
            .join('; ');
          return refused(
            `"${target}" matches ${resolution.ambiguous.length} distinct elements — name one by identifier or use mobile-tap --at: ${candidates}`,
            MOBILE_EXIT_TARGET_UNRESOLVED,
          );
        }
        if (resolution.activationBundleId !== undefined) {
          return refused(
            `"${target}" belongs to ${resolution.activationBundleId}, which must be activated first — run mobile-activate (it activates ${deps.appBundleId} only)`,
          );
        }
        const out = await synth({ name: autoName('tap'), verb: 'mobile-tap', command: tapCommand(resolution.x, resolution.y) });
        return withMessage(out.response, `ok: tapped "${target}" at (${coord(resolution.x)}, ${coord(resolution.y)})`);
      }
      case 'swipe': {
        const from = point(args.from);
        const to = point(args.to);
        if (from !== null && to !== null) {
          const duration = finiteNumber(args.duration);
          const out = await synth({
            name: autoName('swipe'),
            verb: 'mobile-swipe',
            command: swipeCommand(from, to, duration !== null && duration > 0 ? duration : XCODE_SWIPE_DURATION_S),
          });
          return withMessage(out.response, 'ok: swiped');
        }
        if (!isSwipeDirection(args.direction)) return refused('mobile-swipe needs <up|down|left|right> or --from/--to');
        const fresh = await freshBlock('mobile-swipe', 'swipe-frame');
        if (!fresh.ok) return fresh.error;
        const frame = windowFrame(fresh.block);
        if (frame === null) return refused(`${deps.appBundleId}'s block carries no frame to swipe across`);
        const points = swipePoints(frame, args.direction);
        const out = await synth({ name: autoName('swipe'), verb: 'mobile-swipe', command: swipeCommand(points.from, points.to) });
        return withMessage(out.response, `ok: swiped ${args.direction}`);
      }
      case 'type': {
        const text = args.text;
        if (typeof text !== 'string' || text.length === 0) return refused('mobile-type needs non-empty text');
        const out = await synth({ name: autoName('type'), verb: 'mobile-type', command: typeCommand(text) });
        return withMessage(out.response, 'ok: typed');
      }
      case 'press': {
        if (args.key === 'home') {
          const out = await synth({ name: autoName('home'), verb: 'mobile-press', command: HOME_BUTTON_COMMAND, allowBackground: true });
          return withMessage(out.response, 'ok: pressed home — run mobile-activate before driving the app again');
        }
        if (args.key === 'enter') {
          const out = await synth({ name: autoName('enter'), verb: 'mobile-press', command: RETURN_KEY_COMMAND });
          return withMessage(out.response, 'ok: pressed enter');
        }
        return refused('mobile-press back is refused: iOS has no back button — tap the on-screen back control instead');
      }
      case 'interact': {
        const command = args.command;
        if (typeof command !== 'string' || command.trim().length === 0) return refused('mobile-interact needs a raw command');
        const out = await synth({ name: autoName('interact'), verb: 'mobile-interact', command });
        return withMessage(out.response, 'ok: interacted');
      }
      case 'activate': {
        const out = await synth({ name: autoName('activate'), verb: 'mobile-activate', activate: true });
        return withMessage(out.response, `ok: activated ${deps.appBundleId}`);
      }
      default:
        return refused(`unknown xcode drive verb "${verb}"`);
    }
  };

  return { handle, ledger };
}
