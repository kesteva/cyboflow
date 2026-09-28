/**
 * xcodeMcpBridgeClient — a minimal stdio MCP client for `xcrun mcpbridge`, the
 * Xcode 27 tool bridge, narrowed to the three DeviceInteraction tools the
 * mobile drive/observe rung uses (docs/proposals/runbook-optional-verification.md
 * §B0, §B4).
 *
 * WHY HAND-ROLLED, NOT `@modelcontextprotocol/sdk`: the whole exchange is
 * `initialize` → `notifications/initialized` → `tools/call`, newline-delimited
 * JSON-RPC over the child's stdio, and the one behaviour this rung depends on —
 * a DISCRIMINATED failure (not approved vs timed out vs bridge died vs the tool
 * said no) — is exactly what a generic client flattens into thrown errors. The
 * wire shapes below are the ones measured live on the B0 host (the probe
 * scripts and the committed `tools/list` fixture):
 *  - a tool result's typed payload is `result.structuredContent`;
 *  - a tool failure is `result.isError: true` with the message in
 *    `content[0].text`, itself JSON `{"type":"error","data":"<message>"}`;
 *  - an unapproved client is refused with "This agent isn't approved to use
 *    Xcode's tools yet" — classified as `not-approved`, the signal that makes
 *    the runner degrade the rung (§B3) rather than report a deliverable verdict.
 *
 * ARGUMENT KEYS ARE NOT UNIFORM, and a wrong one is silently a different call:
 * `DeviceInteractionSynthesize` takes `interactSessionKey`, while
 * `DeviceInteractionStartSession` RETURNS and `DeviceInteractionEndSession`
 * TAKES `interactionSessionKey`. The typed wrappers are the only place those
 * spellings live; the unit test's fake bridge validates every call against the
 * committed input schemas so a drifted key fails the suite.
 *
 * SPAWN DISCIPLINE: the resolved `xcrun` with argv `['mcpbridge']` through an
 * injected seam, never a shell. Xcode keys its approval on the binary that
 * spawns the bridge (§B0), so WHO calls this matters: only the main-process
 * runner, inside a request (§B2's probe must never spawn one).
 *
 * THE SESSION KEY IS A SECRET the runner holds in memory (§B4.2). This module
 * never logs call arguments — only tool names and timings — and
 * {@link sessionKeyFingerprint} is the loggable stand-in.
 *
 * TEARDOWN: {@link XcodeMcpBridgeClient.close} is bounded (SIGTERM, then
 * SIGKILL) and deliberately takes NO abort signal: the runner's `finally`
 * aborts its controller first (§B4.8), and a teardown bound to that signal
 * would be cancelled before it began.
 *
 * No electron, no services: standalone-extractable like the rest of
 * orchestrator/verify.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { LoggerLike } from '../../types';

/** The MCP protocol revision the bridge was measured speaking (B0 probes). */
export const XCODE_MCP_PROTOCOL_VERSION = '2025-06-18';

/** `xcrun` lives here on every macOS; the runner may pass a resolved alternative. */
export const DEFAULT_XCRUN_PATH = '/usr/bin/xcrun';

export const DEVICE_INTERACTION_START_SESSION = 'DeviceInteractionStartSession';
export const DEVICE_INTERACTION_SYNTHESIZE = 'DeviceInteractionSynthesize';
export const DEVICE_INTERACTION_END_SESSION = 'DeviceInteractionEndSession';

/** Default per-call bounds. StartSession may boot the device; EndSession is a teardown step (§B4.8). */
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_START_SESSION_TIMEOUT_MS = 120_000;
const DEFAULT_SYNTHESIZE_TIMEOUT_MS = 90_000;
const DEFAULT_END_SESSION_TIMEOUT_MS = 10_000;
const DEFAULT_INIT_TIMEOUT_MS = 20_000;
/** Each of the two kill phases waits at most this long for the child to exit. */
const DEFAULT_KILL_GRACE_MS = 5_000;
/** One JSON-RPC line. `tools/list` is ~170 KB; nothing this client calls comes close. */
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Bound on the retained stderr tail quoted in a `bridge-exited` message. */
const STDERR_TAIL_CHARS = 2_000;

/** Why a call did not produce a typed result. */
export type BridgeFailureKind = 'tool-error' | 'not-approved' | 'timeout' | 'bridge-exited' | 'protocol';

export type BridgeResult<T> =
  | { ok: true; structured: T }
  | { ok: false; kind: BridgeFailureKind; message: string };

/**
 * The child-process surface this client drives. Event registration is spelled
 * as plain functions rather than an EventEmitter so a test fake needs no
 * overload gymnastics; {@link nodeBridgeSpawn} adapts a real child.
 */
export interface BridgeChild {
  readonly pid: number | null;
  /** Write to the child's stdin. Must not throw; a broken pipe surfaces via {@link onStdinError}. */
  write(chunk: string): void;
  /** Close the child's stdin. */
  endInput(): void;
  onStdout(listener: (chunk: string) => void): void;
  onStderr(listener: (chunk: string) => void): void;
  onStdinError(listener: (err: Error) => void): void;
  /** Fires once, after the child has exited and its stdout has drained (or a short bound past exit). */
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  /** Fires when the child could not be started at all (ENOENT, EACCES). */
  onSpawnError(listener: (err: Error) => void): void;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

/** Argv-only spawn seam. Implementations MUST NOT route through a shell. */
export type BridgeSpawn = (
  command: string,
  args: readonly string[],
  opts: { env: NodeJS.ProcessEnv },
) => BridgeChild;

/** How long past `exit` the adapter waits for `close` (stdout drained) before reporting exit anyway. */
const EXIT_DRAIN_MS = 250;

/**
 * The real-host {@link BridgeSpawn}: `child_process.spawn` with `shell: false`
 * and piped stdio. Exit is reported on `close` — after stdout has drained, so a
 * response the bridge wrote just before dying is still delivered — or at most
 * {@link EXIT_DRAIN_MS} after `exit`, in case a grandchild holds the pipe open.
 */
export const nodeBridgeSpawn: BridgeSpawn = (command, args, opts) => {
  const child = nodeSpawn(command, [...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: opts.env,
    shell: false,
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return {
    get pid() {
      return child.pid ?? null;
    },
    write: (chunk) => {
      if (child.stdin.writable) child.stdin.write(chunk);
    },
    endInput: () => {
      if (child.stdin.writable) child.stdin.end();
    },
    onStdout: (listener) => {
      child.stdout.on('data', (chunk: string) => listener(chunk));
    },
    onStderr: (listener) => {
      child.stderr.on('data', (chunk: string) => listener(chunk));
    },
    onStdinError: (listener) => {
      child.stdin.on('error', listener);
    },
    onExit: (listener) => {
      let fired = false;
      const fire = (code: number | null, signal: string | null): void => {
        if (fired) return;
        fired = true;
        listener(code, signal);
      };
      child.once('close', (code, signal) => fire(code, signal));
      child.once('exit', (code, signal) => {
        setTimeout(() => fire(code, signal), EXIT_DRAIN_MS).unref();
      });
    },
    onSpawnError: (listener) => {
      // `on`, not `once`: a ChildProcess can emit 'error' more than once (a
      // failed spawn, then a failed kill). A second, UNHANDLED 'error' would
      // throw in the main process that hosts this client. The client's
      // listener is idempotent.
      child.on('error', listener);
    },
    kill: (signal) => {
      try {
        child.kill(signal);
      } catch {
        // Already gone: nothing to signal.
      }
    },
  };
};

export interface XcodeMcpBridgeClientOptions {
  /** Absolute path to `xcrun`. Defaults to {@link DEFAULT_XCRUN_PATH}. */
  xcrunPath?: string;
  spawn?: BridgeSpawn;
  /** The bridge's environment. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  clientInfo?: { name: string; version: string };
  initTimeoutMs?: number;
  killGraceMs?: number;
  maxLineBytes?: number;
  logger?: LoggerLike;
}

/** What the `initialize` handshake reported. */
export interface BridgeHandshake {
  protocolVersion: string | null;
  serverName: string | null;
  serverVersion: string | null;
}

export interface StartSessionArgs {
  /** The simulator UDID. The tool fuzzy-matches anything; the runner passes the exact udid and checks `deviceUUID`. */
  deviceIdentifier: string;
  /** Unique among recent sessions; becomes the session key (§B0). */
  sessionIdentifier: string;
}

export interface StartSessionResult {
  interactionSessionKey: string;
  deviceUUID: string;
  deviceIsSimulator: boolean;
  summary: string | null;
  skillToTrigger: string | null;
}

export interface SynthesizeArgs {
  /** Note the spelling: Synthesize alone says `interact`, not `interaction`. */
  interactSessionKey: string;
  /** Omitted ⇒ a pure capture. */
  interactionCommand?: string;
  /** Omitted ⇒ no activation — observing must never relaunch the app (§B4.5, B-5). */
  activationBundleId?: string;
}

export interface SynthesizeResult {
  screenshotPath: string;
  applicationState: string;
  /**
   * The schema marks these required, but the tool's own description says the
   * hierarchy "may be missing, retry as that might be AX transient issue" — so
   * each is `null` rather than a fabricated path when absent.
   */
  thumbnailScreenshotPath: string | null;
  hierarchyPath: string | null;
  logsPath: string | null;
}

export interface EndSessionArgs {
  interactionSessionKey: string;
}

export interface EndSessionResult {
  /** e.g. "Session stopped", or — NOT an error — "Session doesn't exist anymore". */
  userMessage: string;
}

export interface XcodeMcpBridgeClient {
  /**
   * Spawn the bridge and complete the handshake. Idempotent; concurrent callers
   * share one attempt. A client is SINGLE-USE: a failed connect reaps the
   * child and every later call fails fast — make a new client to retry.
   */
  connect(): Promise<BridgeResult<BridgeHandshake>>;
  /** One `tools/call`. Never throws. Arguments are never logged. */
  call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResult<Record<string, unknown>>>;
  startSession(args: StartSessionArgs, timeoutMs?: number): Promise<BridgeResult<StartSessionResult>>;
  synthesize(args: SynthesizeArgs, timeoutMs?: number): Promise<BridgeResult<SynthesizeResult>>;
  endSession(args: EndSessionArgs, timeoutMs?: number): Promise<BridgeResult<EndSessionResult>>;
  /** SIGTERM, then SIGKILL after a bounded grace. Idempotent, never throws, never bound to an abort signal. */
  close(): Promise<void>;
  /** The bridge child's pid, or `null` before spawn / when the platform reported none. */
  readonly pid: number | null;
  /** Whether the bridge process is still running (spawned and not yet exited). */
  isAlive(): boolean;
}

/** "This agent isn't approved to use Xcode's tools yet" — straight or curly apostrophe. */
const NOT_APPROVED_PATTERN = /\bisn['’]t approved\b|\bis not approved\b|\bnot been approved\b/i;
/** Observed spellings of "that session is gone" (B0 flows 3 and 4). */
const SESSION_MISSING_PATTERN =
  /Session with that key doesn['’]t exist|Session not found|Session doesn['’]t exist/i;
/** "Target device doesn't match the requested session, likely modified by a concurrent agent." */
const DEVICE_MISMATCH_PATTERN = /Target device doesn['’]t match/i;

/** Whether a bridge message is the unapproved-client refusal. */
export function isNotApprovedMessage(message: string): boolean {
  return NOT_APPROVED_PATTERN.test(message);
}

/**
 * Whether a bridge message says the session no longer exists — the mid-run
 * "not_testable" case (§B4.7), and the benign answer the stale-session sweep
 * ignores (§B4.9). Note `EndSession` reports an already-gone session as a
 * SUCCESS whose `userMessage` matches this, not as an error.
 */
export function isSessionMissingMessage(message: string): boolean {
  return SESSION_MISSING_PATTERN.test(message);
}

/** Whether a bridge message says the session's device changed under it (§B4.7). */
export function isDeviceMismatchMessage(message: string): boolean {
  return DEVICE_MISMATCH_PATTERN.test(message);
}

/**
 * Mint a DeviceInteraction `sessionIdentifier` from 128 random bits (§B4.2).
 * Never derived from the request id, which the agent already sees in
 * `VERIFY_SIM_NAME`; unique per ATTEMPT, since the framework refuses an id
 * "currently in use or recently used" and a re-dispatch reuses the request id.
 */
export function mintSessionIdentifier(): string {
  return `Cyboflow Verify ${randomBytes(16).toString('hex')}`;
}

/** A short, one-way stand-in for a session key, safe to log next to a request id. */
export function sessionKeyFingerprint(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The human message inside a tool's error content. The bridge wraps it as JSON
 * `{"type":"error","data":"…"}` in `content[0].text`; a plain-text body is
 * returned as-is.
 */
function toolErrorMessage(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const texts: string[] = [];
  for (const item of content) {
    const text = asNonEmptyString(asRecord(item)?.text);
    if (text !== null) texts.push(text);
  }
  const first = texts[0];
  if (first === undefined) return 'the tool reported an error with no message';
  try {
    const parsed = asRecord(JSON.parse(first));
    const data = parsed?.data;
    if (typeof data === 'string' && data.length > 0) return data;
    const message = parsed?.message;
    if (typeof message === 'string' && message.length > 0) return message;
  } catch {
    // Not JSON: the text is the message.
  }
  return texts.join('\n');
}

/** The typed payload of a successful tool result: `structuredContent`, else JSON in `content[0].text`. */
function structuredPayload(result: Record<string, unknown>): Record<string, unknown> | null {
  const structured = asRecord(result.structuredContent);
  if (structured !== null) return structured;
  const content = Array.isArray(result.content) ? result.content : [];
  const text = asNonEmptyString(asRecord(content[0])?.text);
  if (text === null) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function failure<T>(kind: BridgeFailureKind, message: string): BridgeResult<T> {
  // Any failure whose text is the approval refusal is `not-approved`, whatever
  // path it arrived on (tool error, JSON-RPC error, or a bridge that exited
  // after saying so on stderr): that is the one kind the runner degrades on.
  return { ok: false, kind: isNotApprovedMessage(message) ? 'not-approved' : kind, message };
}

interface PendingCall {
  resolve: (outcome: BridgeResult<Record<string, unknown>>) => void;
  timer: ReturnType<typeof setTimeout> | null;
  tool: string;
}

const HANDSHAKE_ID = 0;

/** Build a bridge client. Nothing is spawned until {@link XcodeMcpBridgeClient.connect}. */
export function createXcodeMcpBridgeClient(options: XcodeMcpBridgeClientOptions = {}): XcodeMcpBridgeClient {
  const xcrunPath = options.xcrunPath ?? DEFAULT_XCRUN_PATH;
  if (!isAbsolute(xcrunPath)) {
    throw new Error(`xcodeMcpBridgeClient: xcrunPath must be absolute, got "${xcrunPath}"`);
  }
  const spawn = options.spawn ?? nodeBridgeSpawn;
  const env = options.env ?? process.env;
  const clientInfo = options.clientInfo ?? { name: 'cyboflow', version: '1' };
  const initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const logger = options.logger;

  let child: BridgeChild | null = null;
  let connecting: Promise<BridgeResult<BridgeHandshake>> | null = null;
  let connected = false;
  let exited = false;
  let exitMessage = 'the bridge is not running';
  let closing: Promise<void> | null = null;
  let resolveExited: () => void = () => {};
  const exitedPromise = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  let nextId = HANDSHAKE_ID + 1;
  let buffer = '';
  let stderrTail = '';
  const pending = new Map<number, PendingCall>();

  const settle = (id: number, outcome: BridgeResult<Record<string, unknown>>): void => {
    const call = pending.get(id);
    if (call === undefined) return;
    pending.delete(id);
    if (call.timer !== null) clearTimeout(call.timer);
    call.resolve(outcome);
  };

  const failAllPending = (kind: BridgeFailureKind, message: string): void => {
    for (const id of [...pending.keys()]) settle(id, failure(kind, message));
  };

  const send = (message: Record<string, unknown>): boolean => {
    if (child === null || exited) return false;
    try {
      child.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch (err) {
      logger?.warn('[xcodeMcpBridge] write to the bridge failed', { error: errorText(err) });
      return false;
    }
  };

  const markExited = (message: string): void => {
    if (exited) return;
    exited = true;
    connected = false;
    exitMessage = message;
    failAllPending('bridge-exited', message);
    resolveExited();
  };

  /** A server→client request (`ping`, or anything else): answer so the bridge never waits on us. */
  const answerServerRequest = (id: unknown, method: string): void => {
    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  };

  const handleMessage = (message: Record<string, unknown>): void => {
    const method = asNonEmptyString(message.method);
    if (method !== null) {
      if (message.id !== undefined && message.id !== null) answerServerRequest(message.id, method);
      // Notifications (progress, logging) are not needed by the rung.
      return;
    }
    const id = message.id;
    if (typeof id !== 'number' || !pending.has(id)) return; // late reply to a timed-out call
    const rpcError = asRecord(message.error);
    if (rpcError !== null) {
      const text = asNonEmptyString(rpcError.message) ?? 'JSON-RPC error with no message';
      settle(id, failure('protocol', text));
      return;
    }
    const result = asRecord(message.result);
    if (result === null) {
      settle(id, failure('protocol', 'response carried neither result nor error'));
      return;
    }
    if (id === HANDSHAKE_ID) {
      settle(id, { ok: true, structured: result });
      return;
    }
    if (result.isError === true) {
      settle(id, failure('tool-error', toolErrorMessage(result)));
      return;
    }
    const structured = structuredPayload(result);
    if (structured === null) {
      settle(id, failure('protocol', 'tool result carried no structured content'));
      return;
    }
    settle(id, { ok: true, structured });
  };

  const onStdout = (chunk: string): void => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = asRecord(JSON.parse(line));
        } catch {
          parsed = null;
        }
        if (parsed === null) {
          logger?.warn('[xcodeMcpBridge] dropped a non-JSON line from the bridge', { length: line.length });
        } else {
          handleMessage(parsed);
        }
      }
      newline = buffer.indexOf('\n');
    }
    if (Buffer.byteLength(buffer, 'utf8') > maxLineBytes) {
      // A line this large is not a response this client asked for; the stream
      // can no longer be trusted to re-synchronise, so the bridge is abandoned.
      buffer = '';
      const message = `the bridge sent a line over ${maxLineBytes} bytes; abandoning it`;
      failAllPending('protocol', message);
      child?.kill('SIGKILL');
    }
  };

  const request = (
    id: number,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    tool: string,
  ): Promise<BridgeResult<Record<string, unknown>>> =>
    new Promise((resolve) => {
      const call: PendingCall = { resolve, timer: null, tool };
      pending.set(id, call);
      call.timer = setTimeout(() => {
        settle(id, failure('timeout', `${tool} did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      if (!send({ jsonrpc: '2.0', id, method, params })) {
        settle(id, failure('bridge-exited', exitMessage));
      }
    });

  /** SIGTERM, then SIGKILL, each phase bounded by `killGraceMs`. Idempotent; never throws. */
  const shutdown = (): Promise<void> => {
    if (closing !== null) return closing;
    closing = (async () => {
      failAllPending('bridge-exited', 'the bridge client was closed');
      const target = child;
      if (target === null || exited) {
        markExited('the bridge client was closed');
        return;
      }
      const waitForExit = (): Promise<boolean> =>
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), killGraceMs);
          void exitedPromise.then(() => {
            clearTimeout(timer);
            resolve(true);
          });
        });
      try {
        target.endInput();
      } catch {
        // A closed stdin is the goal anyway.
      }
      target.kill('SIGTERM');
      if (await waitForExit()) return;
      logger?.warn('[xcodeMcpBridge] bridge ignored SIGTERM; sending SIGKILL', { pid: target.pid });
      target.kill('SIGKILL');
      if (!(await waitForExit())) {
        logger?.warn('[xcodeMcpBridge] bridge did not report exit after SIGKILL', { pid: target.pid });
        markExited('the bridge client was closed');
      }
    })();
    return closing;
  };

  const doConnect = async (): Promise<BridgeResult<BridgeHandshake>> => {
    if (closing !== null) return failure('bridge-exited', 'the bridge client is closed');
    let spawned: BridgeChild;
    try {
      spawned = spawn(xcrunPath, ['mcpbridge'], { env });
    } catch (err) {
      markExited(`could not start \`xcrun mcpbridge\`: ${errorText(err)}`);
      return failure('bridge-exited', exitMessage);
    }
    child = spawned;
    spawned.onStdout(onStdout);
    spawned.onStderr((chunk) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    spawned.onStdinError((err) => {
      logger?.warn('[xcodeMcpBridge] bridge stdin error', { error: errorText(err) });
    });
    spawned.onSpawnError((err) => {
      markExited(`could not start \`xcrun mcpbridge\`: ${errorText(err)}`);
    });
    spawned.onExit((code, signal) => {
      const tail = stderrTail.trim();
      markExited(
        `the bridge exited (${signal !== null ? `signal ${signal}` : `code ${code ?? 'null'}`})${
          tail.length > 0 ? `: ${tail}` : ''
        }`,
      );
    });

    const started = Date.now();
    const init = await request(
      HANDSHAKE_ID,
      'initialize',
      {
        protocolVersion: XCODE_MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo,
      },
      initTimeoutMs,
      'initialize',
    );
    if (!init.ok) {
      logger?.warn('[xcodeMcpBridge] handshake failed', { kind: init.kind, message: init.message });
      // A client is single-use and a failed handshake ends it: reap the child
      // now rather than leaving a live bridge for the caller's close() to find.
      await shutdown();
      return init;
    }
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    connected = true;
    const serverInfo = asRecord(init.structured.serverInfo);
    const handshake: BridgeHandshake = {
      protocolVersion: asNonEmptyString(init.structured.protocolVersion),
      serverName: asNonEmptyString(serverInfo?.name),
      serverVersion: asNonEmptyString(serverInfo?.version),
    };
    logger?.info('[xcodeMcpBridge] connected', {
      pid: spawned.pid,
      ms: Date.now() - started,
      protocolVersion: handshake.protocolVersion,
      server: handshake.serverName,
    });
    return { ok: true, structured: handshake };
  };

  const call = async (
    name: string,
    args: Record<string, unknown>,
    timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  ): Promise<BridgeResult<Record<string, unknown>>> => {
    if (exited) return failure('bridge-exited', exitMessage);
    if (!connected) return failure('protocol', 'the bridge is not connected; call connect() first');
    const id = nextId;
    nextId += 1;
    const started = Date.now();
    const outcome = await request(id, 'tools/call', { name, arguments: args }, timeoutMs, name);
    // Tool name and timing only — `args` can carry the session key.
    logger?.debug('[xcodeMcpBridge] tool call settled', {
      tool: name,
      ms: Date.now() - started,
      ok: outcome.ok,
      ...(outcome.ok ? {} : { kind: outcome.kind }),
    });
    return outcome;
  };

  const typed = async <T>(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    narrow: (structured: Record<string, unknown>) => T | string,
  ): Promise<BridgeResult<T>> => {
    const outcome = await call(name, args, timeoutMs);
    if (!outcome.ok) return outcome;
    const narrowed = narrow(outcome.structured);
    if (typeof narrowed === 'string') return failure('protocol', `${name}: ${narrowed}`);
    return { ok: true, structured: narrowed };
  };

  const client: XcodeMcpBridgeClient = {
    connect: () => {
      if (connecting === null) connecting = doConnect();
      return connecting;
    },
    call,
    startSession: (args, timeoutMs = DEFAULT_START_SESSION_TIMEOUT_MS) =>
      typed(
        DEVICE_INTERACTION_START_SESSION,
        { deviceIdentifier: args.deviceIdentifier, sessionIdentifier: args.sessionIdentifier },
        timeoutMs,
        (structured): StartSessionResult | string => {
          const key = asNonEmptyString(structured.interactionSessionKey);
          const deviceUUID = asNonEmptyString(structured.deviceUUID);
          if (key === null) return 'result carried no interactionSessionKey';
          if (deviceUUID === null) return 'result carried no deviceUUID';
          if (typeof structured.deviceIsSimulator !== 'boolean') return 'result carried no deviceIsSimulator';
          return {
            interactionSessionKey: key,
            deviceUUID,
            deviceIsSimulator: structured.deviceIsSimulator,
            summary: asNonEmptyString(structured.summary),
            skillToTrigger: asNonEmptyString(structured.skillToTrigger),
          };
        },
      ),
    synthesize: (args, timeoutMs = DEFAULT_SYNTHESIZE_TIMEOUT_MS) => {
      const wire: Record<string, unknown> = { interactSessionKey: args.interactSessionKey };
      if (args.interactionCommand !== undefined) wire.interactionCommand = args.interactionCommand;
      if (args.activationBundleId !== undefined) wire.activationBundleId = args.activationBundleId;
      return typed(DEVICE_INTERACTION_SYNTHESIZE, wire, timeoutMs, (structured): SynthesizeResult | string => {
        const screenshotPath = asNonEmptyString(structured.screenshotPath);
        const applicationState = asNonEmptyString(structured.applicationState);
        if (screenshotPath === null) return 'result carried no screenshotPath';
        if (applicationState === null) return 'result carried no applicationState';
        return {
          screenshotPath,
          applicationState,
          thumbnailScreenshotPath: asNonEmptyString(structured.thumbnailScreenshotPath),
          hierarchyPath: asNonEmptyString(structured.hierarchyPath),
          logsPath: asNonEmptyString(structured.logsPath),
        };
      });
    },
    endSession: (args, timeoutMs = DEFAULT_END_SESSION_TIMEOUT_MS) =>
      typed(
        DEVICE_INTERACTION_END_SESSION,
        { interactionSessionKey: args.interactionSessionKey },
        timeoutMs,
        (structured): EndSessionResult | string => {
          const userMessage = asNonEmptyString(structured.userMessage);
          return userMessage === null ? 'result carried no userMessage' : { userMessage };
        },
      ),
    close: shutdown,
    get pid() {
      return child?.pid ?? null;
    },
    isAlive: () => child !== null && !exited,
  };
  return client;
}
