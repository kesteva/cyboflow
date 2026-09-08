/**
 * ompRpcClient — the stdio transport for an `omp --mode rpc` child.
 *
 * Structurally this is the OMP twin of `CodexAppServerClient`: spawn-agnostic
 * (an injected `spawn` lets tests drive `PassThrough` pipes), one state machine,
 * id-correlated requests, an event subscription, and a SIGTERM→SIGKILL stop
 * escalation that signals the whole process group.
 *
 * Three things differ from the Codex transport, all forced by OMP's protocol:
 *
 *  1. THE COMMAND NAME IS THE `type` FIELD (`{"type":"prompt","id":"…"}`).
 *     A wrapped `{type:"command",command:…}` envelope is rejected outright.
 *
 *  2. RESPONSES MAY ARRIVE WITHOUT THE REQUEST ID. An unknown command answers
 *     with `id` ABSENT while echoing `command` (rpc-mode.ts:1447 —
 *     `error(undefined, unknownCommand.type, …)`, reproduced against the real
 *     binary), and a malformed line answers `command:"parse"` with no id
 *     (rpc-mode.ts:383). Correlating on id alone would leave such a request
 *     pending forever, so an id-less FAILURE is matched back by command name
 *     when exactly one request of that command is in flight.
 *
 *  3. `prompt` IS ONLY AN ACK, NOT A TURN. The turn ends at the first
 *     `agent_end` with `isTerminal !== false` (rpc.md:545-556) — or never, if
 *     the prompt resolved locally (`data.agentInvoked:false` / a later
 *     `prompt_result`), which is why both paths settle a turn here.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { signalTree } from '../../../../utils/platformProcess';
import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { assertAgentProviderAllowed } from '../../../../../../shared/agents/agentProviderGuard';
import {
  OMP_MAX_FRAME_BYTES,
  OMP_RPC_MODE_ARGS,
  OMP_RPC_PROTOCOL_VERSION,
  OMP_RPC_PROTOCOL_VERSION_V2,
  isOmpReadyFrame,
  isOmpRpcResponse,
  isTerminalAgentEnd,
  normalizeOmpEvent,
  type OmpAgentEndEvent,
  type OmpExtensionUiResponse,
  type OmpLastAssistantText,
  type OmpModel,
  type OmpPromptAck,
  type OmpReadyFrame,
  type OmpRpcCommand,
  type OmpRpcEvent,
  type OmpRpcResponse,
  type OmpSessionState,
  type OmpSessionStats,
  type OmpStreamingBehavior,
  type OmpThinkingLevel,
} from './ompContract';
import { OmpChunkReassembler, OmpFrameError, OmpLineDecoder } from './ompFrameDecoder';

const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 1_000;

export interface OmpRpcProcess extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /**
   * PID of the spawned `omp`. When present (a real child) it leads its own
   * process group — see `defaultSpawn`'s `detached: true` — so teardown reaps
   * the whole tree rather than orphaning the MCP servers OMP spawns beneath it.
   */
  readonly pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface OmpRpcSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type SpawnOmpRpcProcess = (
  command: string,
  args: readonly string[],
  options: OmpRpcSpawnOptions,
) => OmpRpcProcess;

export type OmpRpcClientState = 'idle' | 'running' | 'stopping' | 'failed' | 'exited';

export interface OmpRpcClientOptions extends OmpRpcSpawnOptions {
  /** Path to the `omp` binary; the sibling availability module resolves it. */
  command?: string;
  /**
   * The argv that selects the RPC mode. Defaults to {@link OMP_RPC_MODE_ARGS}
   * (`--mode rpc`); a session that must answer OMP's own approval dialogs passes
   * {@link OMP_RPC_UI_MODE_ARGS} — see that constant for why the distinction is
   * load-bearing rather than cosmetic.
   */
  modeArgs?: readonly string[];
  /** Extra argv AFTER the mode args (approval mode, model, session dir, …). */
  args?: readonly string[];
  spawn?: SpawnOmpRpcProcess;
  maxFrameBytes?: number;
  stopTimeoutMs?: number;
  forceKillTimeoutMs?: number;
  /**
   * Negotiate protocol v2 when the ready frame advertises it. v2 only changes
   * how OVERSIZED frames travel (lossless chunking instead of v1's lossy
   * shrink), so it is on by default and safe to switch off.
   */
  negotiateProtocolV2?: boolean;
  onEvent?: (event: OmpRpcEvent) => void;
  onStderr?: (chunk: string) => void;
  onExit?: (exit: OmpRpcExit) => void;
  onError?: (error: Error) => void;
}

export interface OmpRpcExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface OmpHandshake {
  readonly ready: OmpReadyFrame;
  /** The framing version in force after negotiation. */
  readonly protocolVersion: number;
}

/** How a logical turn settled. */
export type OmpTurnCompletion =
  /** A terminal `agent_end` closed the turn. */
  | 'agent_end'
  /** The prompt resolved locally (a slash command); no agent turn ever ran. */
  | 'local';

export interface OmpTurnOutcome {
  readonly completion: OmpTurnCompletion;
  readonly agentEnd?: OmpAgentEndEvent;
}

export interface OmpRunTurnOptions {
  /** Required by OMP when a turn is already streaming (rpc.md:559-564). */
  readonly streamingBehavior?: OmpStreamingBehavior;
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

export class OmpRpcTransportError extends Error {
  override readonly name: string = 'OmpRpcTransportError';
}

export class OmpRpcProtocolError extends OmpRpcTransportError {
  override readonly name: string = 'OmpRpcProtocolError';
}

/** A `success: false` response for a command we issued. */
export class OmpRpcCommandError extends OmpRpcTransportError {
  override readonly name: string = 'OmpRpcCommandError';

  constructor(
    readonly command: string,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class OmpRpcExitedError extends OmpRpcTransportError {
  override readonly name: string = 'OmpRpcExitedError';

  constructor(
    readonly code: number | null,
    readonly signal: NodeJS.Signals | null,
  ) {
    super(`omp --mode rpc exited (code=${String(code)}, signal=${String(signal)})`);
  }
}

// ---------------------------------------------------------------------------

const defaultSpawn: SpawnOmpRpcProcess = (command, args, options) => {
  return nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Lead a fresh process group so teardown reaps OMP's own children (MCP
    // servers, tool subprocesses) instead of orphaning them. On Windows the
    // group does not exist (teardown is `taskkill /T`) and `detached`'s
    // DETACHED_PROCESS makes the console-less app server allocate its own
    // VISIBLE console — the black window flash — so the flag is
    // win32-conditional (mirrors codex appServer/client.ts).
    ...(process.platform === 'win32' ? {} : { detached: true }),
    windowsHide: true,
  });
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface PendingRequest {
  readonly command: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface ActiveTurn {
  readonly promptId: string;
  resolve(outcome: OmpTurnOutcome): void;
  reject(error: Error): void;
}

export class OmpRpcClient {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly spawnProcess: SpawnOmpRpcProcess;
  private readonly maxFrameBytes: number;
  private readonly stopTimeoutMs: number;
  private readonly forceKillTimeoutMs: number;
  private readonly negotiateV2: boolean;

  private readonly stderrDecoder = new StringDecoder('utf8');
  private readonly reassembler = new OmpChunkReassembler();
  private readonly lineDecoder: OmpLineDecoder;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<(event: OmpRpcEvent) => void>();
  private readonly exitWaiters = new Set<() => void>();

  private child: OmpRpcProcess | null = null;
  private currentState: OmpRpcClientState = 'idle';
  private nextRequestId = 1;
  private negotiatedVersion = OMP_RPC_PROTOCOL_VERSION;
  private readyFrame: OmpReadyFrame | null = null;
  private readyWaiters: Array<{
    resolve(frame: OmpReadyFrame): void;
    reject(error: Error): void;
  }> = [];
  private handshakePromise: Promise<OmpHandshake> | null = null;
  private activeTurn: ActiveTurn | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(private readonly options: OmpRpcClientOptions = {}) {
    this.command = options.command ?? 'omp';
    this.args = [...(options.modeArgs ?? OMP_RPC_MODE_ARGS), ...(options.args ?? [])];
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.maxFrameBytes = options.maxFrameBytes ?? OMP_MAX_FRAME_BYTES;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.forceKillTimeoutMs = options.forceKillTimeoutMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS;
    this.negotiateV2 = options.negotiateProtocolV2 ?? true;
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes <= 0) {
      throw new OmpRpcTransportError('maxFrameBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.stopTimeoutMs) || this.stopTimeoutMs < 0) {
      throw new OmpRpcTransportError('stopTimeoutMs must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(this.forceKillTimeoutMs) || this.forceKillTimeoutMs < 0) {
      throw new OmpRpcTransportError('forceKillTimeoutMs must be a non-negative safe integer');
    }
    if (options.onEvent) this.eventListeners.add(options.onEvent);
    this.lineDecoder = new OmpLineDecoder({
      maxFrameBytes: this.maxFrameBytes,
      // OMP's own loop tolerates malformed lines rather than dying (rpc.md:781);
      // a stray non-JSON stdout write must not take the transport down either.
      onUnparseableLine: (line, error) => {
        this.reportError(new OmpRpcProtocolError(
          `Ignoring unparseable omp rpc line (${error.message}): ${line.slice(0, 200)}`,
        ));
      },
    });
  }

  get state(): OmpRpcClientState {
    return this.currentState;
  }

  /** The ready frame, once seen. */
  get ready(): OmpReadyFrame | null {
    return this.readyFrame;
  }

  /** The framing version in force (1 until a v2 negotiation succeeds). */
  get protocolVersion(): number {
    return this.negotiatedVersion;
  }

  start(): void {
    // Provider-access gate (Settings → Integrations), asserted at the spawn seam
    // exactly as the Codex app-server client does: every OMP SDK turn reaches a
    // vendor through this one process, so guarding here covers them all.
    assertAgentProviderAllowed('omp', 'the OMP RPC session');
    if (this.currentState !== 'idle') {
      throw new OmpRpcTransportError(`Cannot start omp rpc from ${this.currentState} state`);
    }

    try {
      this.child = this.spawnProcess(this.command, this.args, {
        cwd: this.options.cwd,
        env: this.options.env,
      });
      this.currentState = 'running';
      this.bindProcess(this.child);
    } catch (error) {
      const transportError = new OmpRpcTransportError(
        `Failed to spawn omp --mode rpc: ${toError(error).message}`,
        { cause: error },
      );
      this.fail(transportError);
      throw transportError;
    }
  }

  /**
   * Await the ready frame and settle the protocol version. Idempotent — the
   * handshake runs once and every caller shares its result.
   */
  handshake(): Promise<OmpHandshake> {
    this.handshakePromise ??= this.performHandshake();
    return this.handshakePromise;
  }

  private async performHandshake(): Promise<OmpHandshake> {
    const ready = await this.awaitReady();

    // Refuse a server that cannot speak the version our framing assumes.
    if (!ready.supportedProtocolVersions.includes(OMP_RPC_PROTOCOL_VERSION)) {
      const error = new OmpRpcProtocolError(
        `omp rpc ready frame does not support protocol v${OMP_RPC_PROTOCOL_VERSION} `
        + `(advertised: [${ready.supportedProtocolVersions.join(', ')}])`,
      );
      this.fail(error);
      throw error;
    }

    if (this.negotiateV2 && ready.supportedProtocolVersions.includes(OMP_RPC_PROTOCOL_VERSION_V2)) {
      try {
        await this.send({
          type: 'negotiate_protocol',
          protocolVersion: OMP_RPC_PROTOCOL_VERSION_V2,
        });
        this.negotiatedVersion = OMP_RPC_PROTOCOL_VERSION_V2;
      } catch (error) {
        // Negotiation is an optimization: staying on v1 costs only fidelity on
        // oversized frames (which v1 shrinks rather than drops), so a refusal
        // is reported and the session continues.
        this.reportError(new OmpRpcProtocolError(
          `omp rpc protocol v2 negotiation failed, staying on v1: ${toError(error).message}`,
          { cause: error },
        ));
      }
    }

    return { ready, protocolVersion: this.negotiatedVersion };
  }

  private awaitReady(): Promise<OmpReadyFrame> {
    if (this.readyFrame) return Promise.resolve(this.readyFrame);
    if (this.currentState !== 'running') {
      return Promise.reject(new OmpRpcTransportError(
        `omp rpc transport is not running (state=${this.currentState})`,
      ));
    }
    return new Promise<OmpReadyFrame>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  // -------------------------------------------------------------------------
  // Events.
  // -------------------------------------------------------------------------

  /** Subscribe to typed events; returns an unsubscribe function. */
  onEvent(listener: (event: OmpRpcEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Commands.
  // -------------------------------------------------------------------------

  /**
   * Send a command and resolve with its response `data`. Every command carries a
   * generated id; see the class comment for why an id-less failure still lands
   * on the right request.
   */
  send(command: OmpRpcCommand): Promise<unknown> {
    this.assertRunning();
    const id = command.id ?? `cyboflow-${this.nextRequestId++}`;
    return new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { command: command.type, resolve, reject });
      try {
        this.writeFrame({ ...command, id });
      } catch (error) {
        if (this.pendingRequests.delete(id)) reject(toError(error));
      }
    });
  }

  /**
   * Issue a prompt and resolve when the LOGICAL TURN ends — not when the prompt
   * is acknowledged. Events keep flowing to `onEvent` throughout; anything that
   * arrives after the turn settles (a maintenance `agent_end`, late widget
   * requests) is delivered to listeners but can no longer settle this turn.
   */
  runTurn(message: string, options: OmpRunTurnOptions = {}): Promise<OmpTurnOutcome> {
    this.assertRunning();
    if (this.activeTurn) {
      return Promise.reject(new OmpRpcProtocolError(
        'An omp turn is already in flight; use steer/follow_up or abort first',
      ));
    }

    const promptId = `cyboflow-turn-${this.nextRequestId++}`;
    return new Promise<OmpTurnOutcome>((resolve, reject) => {
      const turn: ActiveTurn = {
        promptId,
        resolve: (outcome) => {
          if (this.activeTurn === turn) this.activeTurn = null;
          resolve(outcome);
        },
        reject: (error) => {
          if (this.activeTurn === turn) this.activeTurn = null;
          reject(error);
        },
      };
      this.activeTurn = turn;

      // Register the turn BEFORE prompting: OMP may emit agent lifecycle events
      // either side of the prompt response (rpc.md:223), so a turn that ends
      // before its own ack must still be caught.
      this.send({
        type: 'prompt',
        id: promptId,
        message,
        ...(options.streamingBehavior !== undefined
          ? { streamingBehavior: options.streamingBehavior }
          : {}),
      }).then(
        (data) => {
          // A late ack must never settle a LATER turn, so act only while this
          // turn is still the live one.
          if (this.activeTurn !== turn) return;
          const ack: OmpPromptAck = isRecord(data) ? data : {};
          // `agentInvoked:false` means the prompt completed locally and no
          // `agent_end` will ever arrive — settle now or wait forever.
          if (ack.agentInvoked === false) turn.resolve({ completion: 'local' });
        },
        (error: unknown) => {
          if (this.activeTurn === turn) turn.reject(toError(error));
        },
      );
    });
  }

  /**
   * Answer a blocking `extension_ui_request`.
   *
   * Deliberately NOT routed through {@link send}: an `extension_ui_response` is a
   * side-channel control frame OMP consumes without replying
   * (`dispatchRpcControlFrame`, rpc-mode.ts:278-284), so a pending-request entry
   * registered for it would never settle. It also carries the id OMP minted for
   * the REQUEST, which `send`'s own id generation would fight over.
   *
   * Fire-and-forget by design: an id OMP no longer has pending (a dialog it
   * already abandoned) is simply dropped by that same dispatcher.
   */
  respondToExtensionUi(response: OmpExtensionUiResponse): void {
    this.writeFrame(response);
  }

  steer(message: string): Promise<unknown> {
    return this.send({ type: 'steer', message });
  }

  followUp(message: string): Promise<unknown> {
    return this.send({ type: 'follow_up', message });
  }

  abort(): Promise<unknown> {
    return this.send({ type: 'abort' });
  }

  newSession(parentSession?: string): Promise<unknown> {
    return this.send({
      type: 'new_session',
      ...(parentSession !== undefined ? { parentSession } : {}),
    });
  }

  switchSession(sessionPath: string): Promise<unknown> {
    return this.send({ type: 'switch_session', sessionPath });
  }

  /** OMP takes provider and model id SEPARATELY (rpc.md:138), not one string. */
  setModel(provider: string, modelId: string): Promise<unknown> {
    return this.send({ type: 'set_model', provider, modelId });
  }

  setThinkingLevel(level: OmpThinkingLevel): Promise<unknown> {
    return this.send({ type: 'set_thinking_level', level });
  }

  /**
   * The model catalogue. Rows are rebuilt field by field rather than cast: only
   * the fields this contract declares are carried, and a row missing the
   * `id`/`provider` pair the catalog projection composes `<provider>/<id>` from
   * is dropped rather than surfaced half-formed.
   */
  async getAvailableModels(): Promise<readonly OmpModel[]> {
    const data = await this.send({ type: 'get_available_models' });
    if (!isRecord(data) || !Array.isArray(data.models)) {
      throw new OmpRpcProtocolError('omp get_available_models returned no models array');
    }
    return data.models.filter(isRecord).flatMap((row) => {
      if (typeof row.id !== 'string' || typeof row.provider !== 'string') return [];
      return [{
        id: row.id,
        provider: row.provider,
        ...(typeof row.name === 'string' ? { name: row.name } : {}),
        ...(typeof row.api === 'string' ? { api: row.api } : {}),
        ...(typeof row.reasoning === 'boolean' ? { reasoning: row.reasoning } : {}),
        ...(typeof row.contextWindow === 'number' ? { contextWindow: row.contextWindow } : {}),
        ...(typeof row.maxTokens === 'number' ? { maxTokens: row.maxTokens } : {}),
      }];
    });
  }

  async getState(): Promise<OmpSessionState> {
    const data = await this.send({ type: 'get_state' });
    if (!isRecord(data)) throw new OmpRpcProtocolError('omp get_state returned no payload');
    const model = isRecord(data.model)
      && typeof data.model.id === 'string'
      && typeof data.model.provider === 'string'
      ? { id: data.model.id, provider: data.model.provider }
      : undefined;
    return {
      ...(model !== undefined ? { model } : {}),
      ...(typeof data.thinkingLevel === 'string' ? { thinkingLevel: data.thinkingLevel } : {}),
      ...(typeof data.isStreaming === 'boolean' ? { isStreaming: data.isStreaming } : {}),
      ...(typeof data.isCompacting === 'boolean' ? { isCompacting: data.isCompacting } : {}),
      ...(typeof data.sessionId === 'string' ? { sessionId: data.sessionId } : {}),
      // `--no-session` omits both of these entirely (probe-verified), so the
      // resume path must treat an absent sessionFile as "nothing to resume".
      ...(typeof data.sessionFile === 'string' ? { sessionFile: data.sessionFile } : {}),
      ...(typeof data.sessionName === 'string' ? { sessionName: data.sessionName } : {}),
      ...(typeof data.messageCount === 'number' ? { messageCount: data.messageCount } : {}),
      ...(typeof data.queuedMessageCount === 'number'
        ? { queuedMessageCount: data.queuedMessageCount }
        : {}),
    };
  }

  /**
   * CUMULATIVE session totals. Never the basis for a turn's usage or cost — the
   * per-turn delta comes from `OmpTurnUsageAccumulator`; this is a cross-check
   * and log line only (proposal §5.1).
   */
  async getSessionStats(): Promise<OmpSessionStats> {
    const data = await this.send({ type: 'get_session_stats' });
    if (!isRecord(data) || !isRecord(data.tokens)) {
      throw new OmpRpcProtocolError('omp get_session_stats returned a malformed payload');
    }
    const tokens = data.tokens;
    return {
      ...(typeof data.sessionId === 'string' ? { sessionId: data.sessionId } : {}),
      userMessages: numberOrZero(data.userMessages),
      assistantMessages: numberOrZero(data.assistantMessages),
      totalMessages: numberOrZero(data.totalMessages),
      tokens: {
        input: numberOrZero(tokens.input),
        output: numberOrZero(tokens.output),
        reasoning: numberOrZero(tokens.reasoning),
        cacheRead: numberOrZero(tokens.cacheRead),
        cacheWrite: numberOrZero(tokens.cacheWrite),
        total: numberOrZero(tokens.total),
      },
      // A FLAT rollup here, unlike the per-message `usage.cost` breakdown.
      cost: numberOrZero(data.cost),
    };
  }

  async getLastAssistantText(): Promise<string | null> {
    const data = await this.send({ type: 'get_last_assistant_text' });
    // The key is ABSENT (not null) on an empty session — probe-verified.
    const payload: OmpLastAssistantText = isRecord(data) ? data : {};
    return typeof payload.text === 'string' ? payload.text : null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle.
  // -------------------------------------------------------------------------

  /**
   * Close stdin (OMP drains accepted commands and exits 0 on stdin close,
   * rpc.md:29), then escalate SIGTERM → SIGKILL if it lingers.
   */
  stop(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    this.stopPromise ??= this.stopProcess(signal);
    return this.stopPromise;
  }

  private async stopProcess(signal: NodeJS.Signals): Promise<void> {
    if (this.currentState === 'idle') {
      this.currentState = 'exited';
      return;
    }
    if (this.currentState === 'exited') return;
    if (this.currentState === 'stopping') {
      await this.waitForExit(this.stopTimeoutMs);
      return;
    }
    if (this.currentState === 'failed') {
      try {
        this.killChild('SIGKILL');
      } catch (cause) {
        this.reportError(new OmpRpcTransportError(
          `Failed to force-kill failed omp rpc process: ${toError(cause).message}`,
          { cause },
        ));
        return;
      }
      await this.waitForExit(this.forceKillTimeoutMs);
      return;
    }

    this.currentState = 'stopping';
    const error = new OmpRpcTransportError('omp rpc transport stopped');
    this.settleAllPending(error);

    // Graceful first: stdin close is OMP's documented clean-shutdown path.
    try {
      this.child?.stdin.end();
    } catch (cause) {
      this.reportError(new OmpRpcTransportError(
        `Failed to close omp rpc stdin: ${toError(cause).message}`,
        { cause },
      ));
    }
    if (await this.waitForExit(this.stopTimeoutMs)) return;

    try {
      this.killChild(signal);
    } catch (cause) {
      this.currentState = 'failed';
      this.reportError(new OmpRpcTransportError(
        `Failed to stop omp rpc process: ${toError(cause).message}`,
        { cause },
      ));
      return;
    }
    if (await this.waitForExit(this.stopTimeoutMs)) return;

    try {
      this.killChild('SIGKILL');
    } catch (cause) {
      this.currentState = 'failed';
      this.reportError(new OmpRpcTransportError(
        `Failed to force-kill omp rpc process: ${toError(cause).message}`,
        { cause },
      ));
      return;
    }
    await this.waitForExit(this.forceKillTimeoutMs);
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.currentState === 'exited') return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const onExit = (): void => {
        clearTimeout(timeout);
        this.exitWaiters.delete(onExit);
        resolve(true);
      };
      this.exitWaiters.add(onExit);
      const timeout = setTimeout(() => {
        this.exitWaiters.delete(onExit);
        resolve(false);
      }, timeoutMs);
    });
  }

  // -------------------------------------------------------------------------
  // Stream plumbing.
  // -------------------------------------------------------------------------

  private bindProcess(child: OmpRpcProcess): void {
    child.stdout.on('data', (chunk: Buffer | string) => this.handleStdoutData(chunk));
    child.stdout.on('end', () => this.handleStdoutEnd());
    child.stdout.on('error', (error: Error) => {
      this.fail(new OmpRpcTransportError(`omp rpc stdout failed: ${error.message}`, { cause: error }));
    });
    child.stdin.on('error', (error: Error) => {
      this.fail(new OmpRpcTransportError(`omp rpc stdin failed: ${error.message}`, { cause: error }));
    });
    child.stderr.on('data', (chunk: Buffer | string) => this.handleStderrData(chunk));
    child.stderr.on('end', () => this.handleStderrEnd());
    child.stderr.on('error', (error: Error) => {
      this.fail(new OmpRpcTransportError(`omp rpc stderr failed: ${error.message}`, { cause: error }));
    });
    child.on('error', (error: Error) => {
      this.fail(new OmpRpcTransportError(`omp rpc process failed: ${error.message}`, { cause: error }));
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.handleExit(code, signal);
    });
  }

  private handleStdoutData(chunk: Buffer | string): void {
    if (this.currentState !== 'running') return;

    let values: unknown[];
    try {
      values = this.lineDecoder.push(chunk);
    } catch (error) {
      this.fail(error instanceof OmpFrameError
        ? new OmpRpcProtocolError(error.message, { cause: error })
        : new OmpRpcTransportError(`omp rpc stdout decoding failed: ${toError(error).message}`,
          { cause: error }));
      return;
    }

    for (const value of values) {
      if (this.currentState !== 'running') return;
      let frame: Record<string, unknown> | undefined;
      try {
        frame = this.reassembler.push(value);
      } catch (error) {
        this.fail(new OmpRpcProtocolError(toError(error).message, { cause: error }));
        return;
      }
      if (frame === undefined) continue; // mid-chunk-run
      try {
        this.handleFrame(frame);
      } catch (error) {
        this.fail(new OmpRpcTransportError(
          `omp rpc frame handling failed: ${toError(error).message}`,
          { cause: error },
        ));
        return;
      }
    }
  }

  private handleStdoutEnd(): void {
    if (this.currentState !== 'running') return;
    const remainder = this.lineDecoder.end();
    if (remainder.length > 0) {
      this.fail(new OmpRpcProtocolError('omp rpc stdout ended with an incomplete frame'));
      return;
    }
    this.fail(new OmpRpcTransportError('omp rpc stdout ended before the process exited'));
  }

  private handleStderrData(chunk: Buffer | string): void {
    const decoded = this.stderrDecoder.write(
      typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
    );
    if (decoded.length > 0) this.reportStderr(decoded);
  }

  private handleStderrEnd(): void {
    const decoded = this.stderrDecoder.end();
    if (decoded.length > 0) this.reportStderr(decoded);
  }

  private handleFrame(frame: Record<string, unknown>): void {
    if (isOmpReadyFrame(frame)) {
      this.handleReady(frame);
      return;
    }
    if (frame.type === 'response') {
      if (!isOmpRpcResponse(frame)) {
        this.reportError(new OmpRpcProtocolError('omp rpc emitted a malformed response frame'));
        return;
      }
      this.handleResponse(frame);
      return;
    }
    this.handleEvent(normalizeOmpEvent(frame));
  }

  private handleReady(frame: OmpReadyFrame): void {
    if (this.readyFrame) {
      this.reportError(new OmpRpcProtocolError('omp rpc emitted a second ready frame'));
      return;
    }
    this.readyFrame = frame;
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter.resolve(frame);
  }

  private handleResponse(response: OmpRpcResponse): void {
    const pending = this.takePendingFor(response);
    if (!pending) {
      // Tolerated by design: `prompt` may emit a LATE error response reusing an
      // id we already settled (rpc.md:103), and an id we never sent is simply
      // not ours to act on. Neither is a transport fault.
      this.reportError(new OmpRpcProtocolError(
        `Ignoring omp rpc response with no matching request (command=${response.command}`
        + `${response.id !== undefined ? `, id=${response.id}` : ''})`,
      ));
      return;
    }
    if (response.success) {
      pending.resolve(response.data);
      return;
    }
    pending.reject(new OmpRpcCommandError(response.command, response.error, response.code));
  }

  /**
   * Resolve a response back to its request. Prefers the echoed id; falls back to
   * a UNIQUE in-flight command of the same name when the id is missing, which is
   * the only way an unknown-command failure can reach its caller.
   */
  private takePendingFor(response: OmpRpcResponse): PendingRequest | undefined {
    if (response.id !== undefined) {
      const byId = this.pendingRequests.get(response.id);
      if (byId) {
        this.pendingRequests.delete(response.id);
        return byId;
      }
      return undefined;
    }
    if (response.success) return undefined; // an id-less SUCCESS is not correlatable
    const matches = [...this.pendingRequests.entries()]
      .filter(([, pending]) => pending.command === response.command);
    if (matches.length !== 1) return undefined;
    const [id, pending] = matches[0];
    this.pendingRequests.delete(id);
    return pending;
  }

  private handleEvent(event: OmpRpcEvent): void {
    // Deliver to subscribers FIRST so a listener sees the terminal `agent_end`
    // that settles the turn before the awaiting caller resumes.
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event);
      } catch (error) {
        this.reportError(new OmpRpcTransportError(
          `omp rpc event listener failed: ${toError(error).message}`,
          { cause: error },
        ));
      }
    }

    const turn = this.activeTurn;
    if (!turn) return;
    if (event.type === 'agent_end' && isTerminalAgentEnd(event)) {
      turn.resolve({ completion: 'agent_end', agentEnd: event });
      return;
    }
    // A prompt accepted immediately that later resolved local-only never
    // produces `agent_end` (rpc.md:225-231).
    if (event.type === 'prompt_result' && !event.agentInvoked && event.id === turn.promptId) {
      turn.resolve({ completion: 'local' });
    }
  }

  private writeFrame(frame: object): void {
    this.assertRunning();
    let encoded: string;
    try {
      encoded = `${JSON.stringify(frame)}\n`;
    } catch (error) {
      const protocolError = new OmpRpcProtocolError('Failed to encode an omp rpc frame', { cause: error });
      this.fail(protocolError);
      throw protocolError;
    }

    // Inbound commands are always ONE unchunked line (rpc.md:34) — there is no
    // outbound chunking to fall back on, so an oversized command is refused
    // loudly rather than truncated into a frame OMP would misparse.
    const byteLength = Buffer.byteLength(encoded, 'utf8');
    if (byteLength > this.maxFrameBytes) {
      throw new OmpRpcProtocolError(
        `omp rpc command exceeds the ${this.maxFrameBytes}-byte frame limit (${byteLength} bytes)`,
      );
    }

    try {
      this.child!.stdin.write(encoded, 'utf8', (error?: Error | null) => {
        if (error) {
          this.fail(new OmpRpcTransportError(
            `Failed to write to omp rpc stdin: ${error.message}`,
            { cause: error },
          ));
        }
      });
    } catch (error) {
      const transportError = new OmpRpcTransportError(
        `Failed to write to omp rpc stdin: ${toError(error).message}`,
        { cause: error },
      );
      this.fail(transportError);
      throw transportError;
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.currentState === 'idle' || this.currentState === 'exited') return;
    const expectedStop = this.currentState === 'stopping';
    const error = new OmpRpcExitedError(code, signal);
    if (expectedStop) {
      this.currentState = 'exited';
    } else if (this.currentState !== 'failed') {
      this.currentState = 'exited';
      this.settleAllPending(error);
      this.reportError(error);
    }
    try {
      this.options.onExit?.({ code, signal });
    } catch (callbackError) {
      this.reportError(toError(callbackError));
    }
    for (const resolve of [...this.exitWaiters]) resolve();
  }

  private fail(error: Error): void {
    if (
      this.currentState === 'stopping'
      || this.currentState === 'failed'
      || this.currentState === 'exited'
    ) return;
    this.currentState = 'failed';
    this.settleAllPending(error);
    this.reportError(error);
    try {
      this.killChild('SIGTERM');
    } catch {
      // The transport already failed; a kill error has no recovery path.
    }
  }

  /**
   * Signal the child's whole tree, so OMP's own children are reaped rather
   * than orphaned. The platform split lives in utils/platformProcess
   * (signalTree). Falls back to a direct signal when there is no pid (tests)
   * or the tree signal was rejected.
   */
  private killChild(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child) return;
    const pid = child.pid;
    if (typeof pid === 'number' && pid > 0) {
      // 'failed' is the only outcome with anything left to try: 'gone' means
      // the group was already reaped.
      if (signalTree(pid, signal) !== 'failed') return;
    }
    child.kill(signal);
  }

  /** Reject everything still awaiting a reply: requests, the turn, the ready gate. */
  private settleAllPending(error: Error): void {
    const requests = [...this.pendingRequests.values()];
    this.pendingRequests.clear();
    for (const request of requests) request.reject(error);

    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter.reject(error);

    this.activeTurn?.reject(error);
    this.reassembler.reset();
  }

  private reportStderr(chunk: string): void {
    try {
      this.options.onStderr?.(chunk);
    } catch (error) {
      this.reportError(toError(error));
    }
  }

  private reportError(error: Error): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Diagnostics must not recursively destabilize the state machine.
    }
  }

  private assertRunning(): void {
    if (this.currentState !== 'running' || !this.child) {
      throw new OmpRpcTransportError(`omp rpc transport is not running (state=${this.currentState})`);
    }
  }
}
