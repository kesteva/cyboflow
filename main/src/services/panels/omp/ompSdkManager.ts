import type Database from 'better-sqlite3';
import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentProvider } from '../../../../../shared/types/agentRuntime';
import type { OmpModelCatalog } from '../../../../../shared/types/agentModels';
import type { PermissionMode } from '../../../../../shared/types/workflows';
import { isPermissionMode } from '../../../../../shared/types/workflows';
import { managedTestConcurrencyEnv } from '../../../../../shared/types/testConcurrency';
import type {
  AgentInitEvent,
  AgentResultEvent,
  AgentSessionInfoEvent,
  AgentStreamEvent,
} from '../../../../../shared/types/agentStream';
import type { CliSpawnOutcome } from '../../../../../shared/types/cliPanels';
import type { ConversationMessage } from '../../../database/models';
import { AgentInvocationStore } from '../../../orchestrator/agentInvocationStore';
import type { EffectiveAgent } from '../../../orchestrator/agents/effectiveAgents';
import { makeLoggerLike } from '../../../orchestrator/loggerAdapter';
import { loadMergedPermissionRules } from '../../../orchestrator/permissionRules';
import type { ClaudeSpawnerOptions } from '../../../orchestrator/runExecutor';
import { getCyboflowSubdirectory } from '../../../utils/cyboflowDirectory';
import type { Logger } from '../../../utils/logger';
import { getShellPath } from '../../../utils/shellPath';
import { orchTokenEnv } from '../../../orchestrator/orchAuthToken';
import type { ConfigManager } from '../../configManager';
import { perfBump } from '../../perfTracer';
import type { SessionManager } from '../../sessionManager';
import { agentStreamEventToClaudeStreamEvent, EventRouter, RawEventsSink } from '../../../../../shared/streamParser';
import { resolveAgentModelAlias } from '../agentModelContext';
import { resolveRunDeployableAgents } from '../claude/agentOverlayWriter';
import { AbstractCliManager } from '../cli/AbstractCliManager';
import { resolveOmpGateExtensionPath } from './gate/ompGatePath';
import type { OmpGateConfig, OmpGateSentinel } from './gate/ompGateTypes';
import { renderOmpAgentMarkdown, toOmpThinkingLevel, writeOmpAgentFiles } from './ompAgentWriter';
import { OmpApprovalBridge } from './ompApprovalBridge';
import {
  OmpQuestionBridge,
  type OmpQuestionRouterPort,
} from './ompQuestionBridge';
import { detectOmpAvailability } from './ompAvailability';
import { buildOmpGateConfig } from './ompGateConfigBuilder';
import {
  composePiConfigFiles,
  ensureHandlerTimeoutOverlay,
  OMP_HANDLER_TIMEOUT_MS,
  OMP_RAISED_DECISION_BUDGET_MS,
} from './ompHandlerTimeoutOverlay';
import { writeOmpMcpConfig } from './ompMcpConfigWriter';
import { getSharedOmpModelCatalogProbe, type OmpModelCatalogProbe } from './ompModelCatalog';
import { assertOmpRequiredSpawnFlags, ompApprovalModeForMode } from './ompPtyManager';
import { OmpRawEventSink } from './ompRawEventSink';
import { supportsConfigurableHandlerTimeout } from './ompVersions';
import {
  lastAssistantTextIn,
  OMP_RPC_UI_MODE_ARGS,
  OmpRpcClient,
  OmpTurnProjector,
  type OmpExtensionUiRequestEvent,
  type OmpExtensionUiResponse,
  type OmpHandshake,
  type OmpRpcClientOptions,
  type OmpRpcEvent,
  type OmpSessionState,
  type OmpThinkingLevel,
  type OmpTurnOutcome,
} from './rpc';

/**
 * OmpSdkManager — one persistent `omp --mode rpc-ui` child per panel, driven over
 * the NDJSON RPC transport (proposal §5.1).
 *
 * `CodexSdkManager` is the structural blueprint and the resemblance is
 * deliberate: warm entries keyed by spawnKey with a 15-minute idle TTL, a
 * fingerprint over every spawn-baked input, per-LOGICAL-TURN `spawned`/
 * session-info/`exit` emissions, a fresh `agent_invocations` row per turn, and
 * one raw-event sink for the process lifetime. Four things are genuinely
 * different, and each is a consequence of OMP's protocol rather than taste:
 *
 *  1. THE TURN IS AN AWAIT, NOT A DEFERRED. `runTurn` already resolves at the
 *     first terminal `agent_end` (`rpc/ompRpcClient.ts`), so there is no
 *     turn-completion notification to reconcile against a deferred — but there
 *     is also no timeout inside it, which is why one lives here.
 *  2. INTERRUPT IS AN RPC CALL. OMP has a first-class `abort` command, so an
 *     interrupted turn does not have to kill the process.
 *  3. THE GATE MUST BE PROVEN LOADED. OMP starts a session even when an
 *     extension fails to load (`loader.ts:437-443`), and a session whose gate
 *     did not load is an UNGATED session. The spawn therefore refuses to prompt
 *     until the gate's load sentinel is on disk — see {@link verifyGateSentinel}.
 *  4. OMP RAISES ITS OWN APPROVAL DIALOGS. They are answered by
 *     `OmpApprovalBridge`, which is bound for the entry's whole lifetime rather
 *     than per turn: fire-and-forget UI frames (`setWidget`) arrive while the
 *     entry is parked, with no turn context to dispatch through.
 */

/** Idle time a parked warm OMP session is kept alive (SDK/Codex parity). */
const OMP_WARM_SESSION_TTL_MS = 15 * 60_000;

/**
 * v1 rollback lever: `CYBOFLOW_DISABLE_OMP_WARM=1` tears the child down after
 * every turn instead of parking it. Read per turn so it flips without a restart.
 */
function ompWarmDisabled(): boolean {
  return process.env.CYBOFLOW_DISABLE_OMP_WARM === '1';
}

/**
 * Wall-clock ceiling on ONE logical turn.
 *
 * `OmpRpcClient.runTurn` deliberately has none — it resolves at `agent_end` or
 * not at all — so the ceiling belongs to the caller that owns the panel. 30
 * minutes is generous by design: an agent turn that genuinely runs a build or a
 * test suite must not be guillotined, and the cases this protects against (a
 * dropped `agent_end`, a dialog nothing answered) are hangs, not slow work.
 */
export const OMP_TURN_TIMEOUT_MS = 30 * 60_000;

/**
 * After the turn ceiling fires we `abort` and give OMP this long to emit its own
 * aborted `agent_end` before failing the turn outright, so the transcript ends
 * with the provider's own record rather than only ours.
 */
const OMP_TURN_ABORT_GRACE_MS = 10_000;

/**
 * What the model and the transcript are told when the turn ceiling stopped the
 * turn. Shared by the aborted-`agent_end` rewrite and the outright failure, so
 * the two paths cannot drift into describing the same event differently.
 *
 * Says WAITING COUNTS, because it does: the ceiling is wall clock, and a turn
 * parked on a human approval ages it exactly as fast as one doing work.
 */
function describeTurnCeilingAbort(): string {
  return (
    `cyboflow stopped this turn: it exceeded the ${Math.round(OMP_TURN_TIMEOUT_MS / 60_000)}-minute ` +
    'ceiling. This was NOT a user interrupt. The ceiling is wall clock, so time spent waiting on ' +
    'human tool approvals counts against it. Start a new turn to continue.'
  );
}

/** Budget for the RPC handshake (ready frame + optional v2 negotiation). */
const OMP_HANDSHAKE_TIMEOUT_MS = 20_000;

/** Budget for a small state/stats request. */
const OMP_REQUEST_TIMEOUT_MS = 15_000;

/** Budget for the `abort` sent while tearing an entry down. */
const OMP_ABORT_TIMEOUT_MS = 2_000;

/**
 * How long to wait for the gate's load sentinel before refusing the session.
 *
 * The gate writes it from its factory body, which runs at extension IMPORT time
 * (`docs/extensions.md:38-44`) — during session construction, before RPC mode is
 * entered and therefore before the ready frame this wait starts from. In
 * practice the file is already there on the first check; this window exists for
 * filesystem latency, not for a race.
 */
const OMP_GATE_SENTINEL_WAIT_MS = 2_000;
const OMP_GATE_SENTINEL_POLL_MS = 25;

interface StubCliProcess {
  process: never;
  panelId: string;
  sessionId: string;
  worktreePath: string;
}

/** The subset of {@link OmpRpcClient} this manager drives; fakeable in tests. */
export interface OmpRpcClientLike {
  start(): void;
  handshake(): Promise<OmpHandshake>;
  onEvent(listener: (event: OmpRpcEvent) => void): () => void;
  runTurn(message: string): Promise<OmpTurnOutcome>;
  abort(): Promise<unknown>;
  getState(): Promise<OmpSessionState>;
  getSessionStats(): Promise<{ readonly cost: number; readonly tokens: { readonly total: number } }>;
  /**
   * The RPC fallback for {@link CliSpawnOutcome.resultText} when the terminal
   * `agent_end` carried no assistant text of its own. Optional so an older fake
   * (and any caller that only drives turns) still satisfies the interface — an
   * absent implementation simply means no fallback, never a thrown turn.
   */
  getLastAssistantText?(): Promise<string | null>;
  respondToExtensionUi(response: OmpExtensionUiResponse): void;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

export type OmpRpcClientFactory = (options: OmpRpcClientOptions) => OmpRpcClientLike;

/** Where the `cyboflow` MCP server lives for a spawn (Codex's runtime-config twin). */
export interface OmpMcpRuntimeConfig {
  orchSocketPath: string;
  bridgeScriptPath: string;
  nodeExecutablePath: string;
}

export interface ResolvedOmpExecutable {
  executablePath: string;
  version: string;
}

interface ActiveOmpRun {
  abortController: AbortController;
  cancel(): Promise<void>;
  panelId: string;
  sessionId: string;
  worktreePath: string;
}

/**
 * Per-LOGICAL-TURN mutable state. The entry's event subscription is bound once
 * at cold spawn and dispatches through this object, which is null while the
 * entry is parked between turns.
 */
interface OmpTurnContext {
  runId: string;
  displayPanelId: string;
  sessionId: string;
  agentInvocationId: string;
  abortController: AbortController;
  router: EventRouter<AgentStreamEvent>;
  sink: RawEventsSink<AgentStreamEvent>;
  /** Rebuilt once the cold handshake resolves the session id (see runOneTurn). */
  projector: OmpTurnProjector;
  startedAt: number;
  terminalResultEmitted: boolean;
  completedCleanly: boolean;
  /** Set when the turn's terminal result was an error, so the await can throw. */
  turnError: string | null;
  /** Accurate replacement for OMP's generic "Interrupted by user" after bridge failure. */
  questionBridgeError: string | null;
  /**
   * Set when {@link OMP_TURN_TIMEOUT_MS} expired and WE aborted the turn.
   *
   * The ceiling stops the turn through OMP's `abort` command — the same command
   * a real user interrupt uses — so without this the turn reports OMP's generic
   * "Interrupted by user" and blames the human for a stop they did not make.
   * Observed live on 2026-08-23: a run whose only visible failure was that
   * phrase, 30 minutes to the second after the turn began.
   */
  turnCeilingAborted: boolean;
}

/** A warm (persistent) `omp --mode rpc-ui` child parked between turns. */
interface WarmOmpEntry {
  client: OmpRpcClientLike;
  rawEventSink: OmpRawEventSink;
  approvalBridge: OmpApprovalBridge;
  questionBridge: OmpQuestionBridge;
  unsubscribe: (() => void) | null;
  command: string;
  /** The OMP session FILE PATH — the external session id and the resume target. */
  sessionFilePath: string | null;
  /** `--session-dir` for this panel; the init event's fallback identity. */
  sessionDir: string;
  sentinelPath: string;
  gateVerified: boolean;
  fingerprint: string;
  runId: string;
  panelId: string;
  sessionId: string;
  /** false for lane/disabled spawns — those always close, never park. */
  warmEligible: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
  teardownPromise: Promise<void> | null;
  currentContext: OmpTurnContext | null;
}

/** SHA-1 hex of a string — a bounded, stable fingerprint digest (not for crypto). */
function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

/**
 * Recursively sort object keys and drop functions so structurally-equal values
 * serialize identically regardless of key insertion order.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' ? null : value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (typeof record[key] === 'function') continue;
    out[key] = canonicalize(record[key]);
  }
  return out;
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${description} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Union two PATH strings, `shellPath` first, dropping empties and duplicates.
 * Verbatim in intent from `codex/appServer/runConfig.ts`: a packaged app
 * launched from Finder inherits only launchd's restricted PATH, which lacks
 * node/pnpm/homebrew — and `omp` plus everything its bash tool shells out to
 * inherits this env.
 */
function mergePathValue(
  shellPath: string,
  existingPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  const delimiter = platform === 'win32' ? ';' : ':';
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const part of `${shellPath}${delimiter}${existingPath ?? ''}`.split(delimiter)) {
    const trimmed = part.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    merged.push(trimmed);
  }
  return merged.join(delimiter);
}

/**
 * Every flag an `omp-sdk` spawn must carry, on top of
 * {@link assertOmpRequiredSpawnFlags}'s `--approval-mode` / `--no-extensions` /
 * `--no-skills`.
 *
 * `-e` is the whole gate: without it OMP starts a session governed by nothing but
 * its own approval mode. `--session-dir` keeps cyboflow's sessions out of the
 * user's personal `~/.omp` list and makes the resume target a path we chose.
 */
const OMP_SDK_REQUIRED_SPAWN_FLAGS = ['-e', '--session-dir'] as const;

/**
 * Throws if `args` is missing a required flag. Exported so the invariant can be
 * unit-tested directly rather than only through `buildSpawnArgs`.
 */
export function assertOmpSdkSpawnFlags(args: readonly string[]): void {
  assertOmpRequiredSpawnFlags(args);
  const missing = OMP_SDK_REQUIRED_SPAWN_FLAGS.filter((flag) => !args.includes(flag));
  if (missing.length > 0) {
    throw new Error(
      `[OMP] refusing to spawn: the omp-sdk argv dropped required flag(s) ${missing.join(', ')}. ` +
        '`-e` loads cyboflow\'s gating extension — the SOLE policy engine for an OMP session ' +
        '(docs/proposals/omp-provider-integration.md §5.3) — and `--session-dir` scopes the ' +
        'session files cyboflow owns. A refactor must not silently ship without them.',
    );
  }
}

export interface OmpSdkManagerDeps {
  /** Builds the RPC transport; a fake in tests. */
  createClient?: OmpRpcClientFactory;
  /** Resolves the `omp` binary + version. */
  resolveExecutable?: () => Promise<ResolvedOmpExecutable>;
  /** Absolute path of the gating extension for `-e`. */
  resolveGateExtensionPath?: () => string;
  /** Root the per-panel `--session-dir` hangs off. */
  sessionDirRoot?: () => string;
  /** Shared catalogue probe; overridden in tests to avoid the singleton. */
  modelCatalogProbe?: OmpModelCatalogProbe;
  /** Sentinel wait budget; shortened in tests. */
  sentinelWaitMs?: number;
}

export class OmpSdkManager extends AbstractCliManager {
  private readonly activeRuns = new Map<string, ActiveOmpRun>();
  private readonly spawnKeysByPanelId = new Map<string, Set<string>>();
  private readonly spawnKeysByRunId = new Map<string, Set<string>>();
  private readonly reservedSpawnKeys = new Set<string>();
  /** Warm children parked between turns, keyed by spawnKey. Not in `this.processes`. */
  private readonly warmOmpRuns = new Map<string, WarmOmpEntry>();

  private readonly createClient: OmpRpcClientFactory;
  private readonly resolveExecutable: () => Promise<ResolvedOmpExecutable>;
  private readonly resolveGatePath: () => string;
  private readonly sessionDirRoot: () => string;
  private readonly modelCatalogProbe: OmpModelCatalogProbe;
  private readonly sentinelWaitMs: number;

  private cyboflowMcpRuntimeConfig: OmpMcpRuntimeConfig | null = null;
  private questionRouterProvider: (() => OmpQuestionRouterPort) | null = null;
  private resolvedExecutable: ResolvedOmpExecutable | null = null;

  constructor(
    sessionManager: SessionManager,
    logger: Logger | undefined,
    configManager: ConfigManager | undefined,
    private readonly db: Database.Database,
    deps: OmpSdkManagerDeps = {},
  ) {
    super(sessionManager, logger, configManager);
    if (db == null) {
      throw new TypeError(
        '[OmpSdkManager] db argument is required; RawEventsSink cannot operate without a database handle.',
      );
    }
    this.createClient = deps.createClient ?? ((options) => new OmpRpcClient(options));
    this.resolveExecutable = deps.resolveExecutable ?? (() => this.detectExecutable());
    this.resolveGatePath =
      deps.resolveGateExtensionPath ??
      (() =>
        resolveOmpGateExtensionPath({
          isPackaged: app?.isPackaged === true,
          ...(process.resourcesPath ? { resourcesPath: process.resourcesPath } : {}),
        }));
    this.sessionDirRoot = deps.sessionDirRoot ?? (() => getCyboflowSubdirectory('omp-sessions'));
    this.modelCatalogProbe = deps.modelCatalogProbe ?? getSharedOmpModelCatalogProbe();
    this.sentinelWaitMs = deps.sentinelWaitMs ?? OMP_GATE_SENTINEL_WAIT_MS;
  }

  protected getCliToolName(): string {
    return 'OMP RPC';
  }

  /** Vendor for the provider-access guard (Settings → Integrations). */
  protected getAgentProvider(): AgentProvider {
    return 'omp';
  }

  setCyboflowMcpRuntimeConfig(config: OmpMcpRuntimeConfig): void {
    this.cyboflowMcpRuntimeConfig = config;
  }

  setQuestionRouterProvider(provider: () => OmpQuestionRouterPort): void {
    this.questionRouterProvider = provider;
  }

  /** The model picker's catalogue, served from the shared 5-minute cache. */
  async getOmpModelCatalog(): Promise<OmpModelCatalog> {
    return this.modelCatalogProbe.getCatalog();
  }

  // -------------------------------------------------------------------------
  // AbstractCliManager contract. The PTY-shaped members are inert here: this
  // manager owns its own transport, exactly as CodexSdkManager does.
  // -------------------------------------------------------------------------

  protected async testCliAvailability(
    customPath?: string,
  ): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    const availability = await detectOmpAvailability(customPath);
    if (availability.state !== 'detected' || !availability.binaryPath) {
      return {
        available: false,
        error: availability.version
          ? `omp ${availability.version} is not usable by this integration`
          : 'omp executable not found in PATH',
        ...(availability.version ? { version: availability.version } : {}),
        ...(availability.binaryPath ? { path: availability.binaryPath } : {}),
      };
    }
    return {
      available: true,
      ...(availability.version ? { version: availability.version } : {}),
      path: availability.binaryPath,
    };
  }

  protected buildCommandArgs(_options: ClaudeSpawnerOptions): string[] {
    return [];
  }

  protected async getCliExecutablePath(): Promise<string> {
    return (await this.getResolvedExecutable()).executablePath;
  }

  protected parseCliOutput(): Array<{
    panelId: string;
    sessionId: string;
    type: 'json' | 'stdout' | 'stderr';
    data: unknown;
    timestamp: Date;
  }> {
    return [];
  }

  protected async initializeCliEnvironment(): Promise<{ [key: string]: string }> {
    return {};
  }

  protected async cleanupCliResources(_panelId: string, _sessionId: string): Promise<void> {
    return;
  }

  protected async getCliEnvironment(): Promise<{ [key: string]: string }> {
    return {};
  }

  async startPanel(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    prompt: string,
    _permissionMode?: unknown,
    model?: unknown,
  ): Promise<void> {
    await this.spawnCliProcess({
      panelId,
      sessionId,
      worktreePath,
      prompt,
      ...(typeof model === 'string' ? { model } : {}),
    });
  }

  async continuePanel(
    _panelId: string,
    _sessionId: string,
    _worktreePath: string,
    _prompt: string,
    _conversationHistory: ConversationMessage[],
  ): Promise<void> {
    throw new Error('OMP RPC panel continuation is workflow-only in this build');
  }

  async stopPanel(panelId: string): Promise<void> {
    await this.killProcess(panelId);
  }

  async restartPanelWithHistory(
    _panelId: string,
    _sessionId: string,
    _worktreePath: string,
    _initialPrompt: string,
    _conversationHistory: ConversationMessage[],
  ): Promise<void> {
    throw new Error('OMP RPC panel restart is workflow-only in this build');
  }

  // -------------------------------------------------------------------------
  // Spawn
  // -------------------------------------------------------------------------

  /**
   * Resolves the turn's {@link CliSpawnOutcome} — the typed step-output channel
   * the programmatic controller parses (`spawnStepRunner.ts` → `resultText`).
   * `omp-sdk` is the first NON-CLAUDE runtime to carry it: codex-sdk resolves
   * `void`, which is why the controller's verdict/fence paths are dead on Codex
   * and live here. See {@link resolveTurnResultText}.
   */
  override async spawnCliProcess(options: ClaudeSpawnerOptions): Promise<CliSpawnOutcome> {
    // Provider-access gate (Settings → Integrations) — a switched-off provider
    // must refuse BEFORE any spawn bookkeeping or availability probe.
    this.assertProviderEnabled(options);
    const spawnKey = options.spawnKey ?? options.panelId;
    if (this.processes.has(spawnKey) || this.reservedSpawnKeys.has(spawnKey)) {
      throw new Error(`OMP RPC session already running for spawn ${spawnKey}`);
    }
    this.reservedSpawnKeys.add(spawnKey);
    try {
      return await this.spawnTrackedProcess(options, spawnKey);
    } finally {
      this.reservedSpawnKeys.delete(spawnKey);
    }
  }

  private async spawnTrackedProcess(
    options: ClaudeSpawnerOptions,
    spawnKey: string,
  ): Promise<CliSpawnOutcome> {
    const runId = options.runId ?? options.panelId;
    // A lane spawn (fan-out step: spawnKey !== panelId) is a single-shot turn of
    // a fresh conversation — it never parks warm. Same when the switch is set.
    const isLaneSpawn = options.spawnKey !== undefined && options.spawnKey !== options.panelId;
    const warmEligible = !isLaneSpawn && !ompWarmDisabled();

    const executable = await this.getResolvedExecutable();
    const plan = this.buildSpawnPlan(options, runId, spawnKey, executable);

    if (warmEligible) {
      const existing = this.warmOmpRuns.get(spawnKey);
      if (existing) {
        if (this.evaluateWarmReuse(existing, options, plan.fingerprint)) {
          this.clearWarmIdleTimer(existing);
          return await this.runOneTurnGuarded(existing, options, spawnKey, false);
        }
        await this.closeWarmEntry(spawnKey, existing, false);
      }
    }

    const entry = this.buildColdEntry(options, runId, executable, plan, warmEligible);
    if (warmEligible) this.warmOmpRuns.set(spawnKey, entry);
    return await this.runOneTurnGuarded(entry, options, spawnKey, true);
  }

  /**
   * A throw BEFORE the turn context is bound (e.g. a missing MCP runtime config
   * on the warm-reuse path, after the idle timer was cleared) would otherwise
   * strand a live parked child with no timer and no teardown. `runOneTurn`'s own
   * finally covers every failure after the bind.
   */
  private async runOneTurnGuarded(
    entry: WarmOmpEntry,
    options: ClaudeSpawnerOptions,
    spawnKey: string,
    cold: boolean,
  ): Promise<CliSpawnOutcome> {
    try {
      return await this.runOneTurn(entry, options, spawnKey, cold);
    } catch (error) {
      if (
        this.warmOmpRuns.get(spawnKey) === entry &&
        entry.currentContext === null &&
        !entry.teardownPromise
      ) {
        await this.closeWarmEntry(spawnKey, entry, false);
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Spawn plan (argv, env, gate config, fingerprint)
  // -------------------------------------------------------------------------

  private buildSpawnPlan(
    options: ClaudeSpawnerOptions,
    runId: string,
    spawnKey: string,
    executable: ResolvedOmpExecutable,
  ): OmpSpawnPlan {
    const runtimeConfig = this.requireMcpRuntimeConfig();
    const permissionMode = this.resolvePermissionMode(options);
    // Keyed on the SPAWN KEY, not the panel id. They are the same string for
    // every non-fan-out spawn (the caller defaults spawnKey to panelId), so a
    // chat panel's session dir — and therefore its resume target — is unchanged.
    // A T1 sprint fan-out is the case that differs: its lanes share ONE panel id
    // and run CONCURRENTLY, so a panel-keyed dir would put several live `omp`
    // children in the same `--session-dir`, and `get_state`'s `sessionFile` is
    // the only thing telling their session files apart.
    const sessionDir = path.join(this.sessionDirRoot(), sanitizeDirSegment(spawnKey));
    const sentinelPath = path.join(
      os.tmpdir(),
      `cyboflow-omp-gate-${randomUUID()}.json`,
    );
    // The raised human-decision budget and the config overlay that makes it
    // legal are ONE change: the overlay tells OMP to allow a longer handler,
    // the budget tells the gate to use it. `overlayPath === null` means either
    // this binary ignores the setting or the file could not be written, and
    // BOTH halves then stay at their defaults (30s cap, ~25s budget) — never
    // one without the other.
    const overlayPath = this.resolveHandlerTimeoutOverlay(executable.version);
    const gateConfig = buildOmpGateConfig({
      permissionMode,
      ...(options.disallowedTools ? { disallowedTools: options.disallowedTools } : {}),
      allowRules: loadMergedPermissionRules(options.worktreePath).allow,
      cyboflowMcpAvailable: !this.isInPlaceSession(options.sessionId),
      ...(overlayPath !== null
        ? { humanDecisionBudgetMs: OMP_RAISED_DECISION_BUDGET_MS }
        : {}),
    });
    const model = resolveAgentModelAlias('omp', options.model);
    const thinking = this.resolveThinkingLevel(options);
    // OMP takes a system-prompt suffix natively, so the run's
    // `systemPromptAppend` rides the flag rather than being prepended to the
    // prompt body the way a runtime without one would force. Empty/whitespace is
    // dropped so a run that appends nothing spawns byte-identically.
    //
    // OMP's own help reads "Append text OR FILE CONTENTS", so a value that
    // happens to be a readable path would be read from disk instead of used
    // verbatim. Harmless for every caller in-tree — the value is multi-line
    // prose from a workflow's markdown, never a bare path — but a future caller
    // that passes a short single-token suffix should know.
    const systemPromptAppend = options.systemPromptAppend?.trim();
    const agents = this.resolveDeployableAgents(options, runId);

    // The fingerprint deliberately sees the argv WITHOUT `--resume`: the resume
    // target changes between the first turn and its continuations, and treating
    // that as a config change would cold-respawn every follow-up. Everything
    // else baked into the spawn IS here — including `--append-system-prompt`,
    // which a warm entry could otherwise silently keep from an earlier turn.
    const baseArgs = [
      '--approval-mode',
      ompApprovalModeForMode(permissionMode),
      '--no-extensions',
      '--no-skills',
      '--no-title',
      '-e',
      this.resolveGatePath(),
      '--session-dir',
      sessionDir,
      ...(model ? ['--model', model] : []),
      ...(thinking ? ['--thinking', thinking] : []),
      ...(systemPromptAppend ? ['--append-system-prompt', systemPromptAppend] : []),
    ];
    assertOmpSdkSpawnFlags(baseArgs);

    const env = this.buildSpawnEnvironment(runId, sentinelPath, gateConfig, runtimeConfig, overlayPath);
    const fingerprint = sha1(
      stableSerialize({
        executablePath: executable.executablePath,
        executableVersion: executable.version,
        cwd: options.worktreePath,
        args: baseArgs,
        // The sentinel path is unique per spawn and must not participate.
        env: { ...env, CYBOFLOW_OMP_GATE_SENTINEL: '<per-spawn>' },
        gateConfig,
        sessionDir,
        // The role files are spawn-baked too: OMP may read `.omp/agents/` once
        // at process start, and only the COLD path rewrites them, so a changed
        // role prompt must force a cold respawn rather than let a parked child
        // keep delegating to the old one.
        agents: digestOmpAgentFiles(agents),
      }),
    );

    return {
      baseArgs,
      env,
      gateConfig,
      sessionDir,
      sentinelPath,
      fingerprint,
      permissionMode,
      model,
      agents,
    };
  }

  /**
   * The run's roles to register as OMP project agents — the ones its frozen
   * definition binds (`resolveRunDeployableAgents`), `[]` when it binds none.
   *
   * Nothing for an in-place session: same policy as `.omp/mcp.json` (see
   * {@link ensureMcpConfig}) — writing `.omp/` into the user's real repo is
   * intrusive. Fail-soft: the resolver already degrades every bad layer, and
   * anything it still throws costs this spawn its roles, never the spawn.
   */
  private resolveDeployableAgents(options: ClaudeSpawnerOptions, runId: string): EffectiveAgent[] {
    if (this.isInPlaceSession(options.sessionId)) return [];
    try {
      return resolveRunDeployableAgents(
        this.db,
        runId,
        this.logger ? makeLoggerLike(this.logger) : undefined,
      );
    } catch (error) {
      this.logger?.warn(
        `[OmpSdkManager] could not resolve the roles for run ${runId}; no cyboflow roles are ` +
          `registered for this OMP session: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /**
   * The spawn environment.
   *
   * `ELECTRON_RUN_AS_NODE` is deliberately NOT set here even though the MCP
   * bridge needs it: `.omp/mcp.json`'s `cyboflow` entry already bakes it in
   * (`ompMcpConfigWriter.buildOmpCyboflowMcpServerEntry`), and OMP's own env is
   * inherited by EVERY subprocess the agent spawns — putting the flag there
   * would change how an unrelated `electron` invocation behaves. Codex scopes it
   * the same way (`runConfig.ts` sets it on the MCP server's env, not the
   * app-server's).
   */
  private buildSpawnEnvironment(
    runId: string,
    sentinelPath: string,
    gateConfig: OmpGateConfig,
    runtimeConfig: OmpMcpRuntimeConfig,
    overlayPath: string | null,
  ): NodeJS.ProcessEnv {
    const inherited = process.env;
    const pathKey = Object.keys(inherited).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    return {
      ...inherited,
      [pathKey]: mergePathValue(getShellPath(), inherited[pathKey]),
      CYBOFLOW_RUN_ID: runId,
      CYBOFLOW_ORCH_SOCKET: runtimeConfig.orchSocketPath,
      // Bearer token for `runId` (orchAuthToken.ts). `.omp/mcp.json` names this
      // var rather than carrying its value (OMP's bare-name indirection), so
      // the secret is resolved from THIS process env at spawn and never written
      // into that shared, on-disk config file.
      ...orchTokenEnv(runId),
      // Per-run artifacts dir — the omission codex-sdk shipped with and the
      // proposal explicitly says not to repeat (§5.4). Keyed by the same runId as
      // CYBOFLOW_RUN_ID so cyboflow_report_artifact and the artifact resolvers
      // agree on one subtree (interactiveClaudeManager does the same).
      CYBOFLOW_RUN_ARTIFACTS_DIR: getCyboflowSubdirectory('artifacts', 'runs', runId),
      CYBOFLOW_OMP_GATE_CONFIG: JSON.stringify(gateConfig),
      CYBOFLOW_OMP_GATE_SENTINEL: sentinelPath,
      // Raises OMP's tool_call handler cap so a human approval is not forced
      // to be answered in ~25s (ompHandlerTimeoutOverlay.ts). The user's own
      // PI_CONFIG_FILES entries are preserved and ours appended last, so a
      // project that configures OMP itself keeps doing so. Absent when the
      // raise is not in effect — an unset var is exactly OMP's default.
      ...(overlayPath !== null
        ? { PI_CONFIG_FILES: composePiConfigFiles(inherited['PI_CONFIG_FILES'], overlayPath) }
        : {}),
      // Every command the OMP agent shells out to — including a project gate —
      // inherits this, which is what makes an OMP lane self-govern its vitest
      // fork pool.
      ...managedTestConcurrencyEnv(),
    };
  }

  /**
   * Resolve the config overlay that raises OMP's extension-handler cap, or
   * `null` to leave this spawn on OMP's 30s default.
   *
   * Two independent reasons to answer `null`, both non-fatal:
   *  - the binary predates `extensionHandlers.toolCallTimeoutMs` (17.3.5), so
   *    the setting would be read and ignored while our gate waited past the
   *    cap OMP still enforces;
   *  - the file could not be written, in which case naming it anyway would
   *    take the whole spawn down (OMP throws "Config overlay not found"
   *    BEFORE starting the session — see ompHandlerTimeoutOverlay.ts).
   *
   * The path is stable rather than per-spawn deliberately: it rides in the env
   * that feeds the warm-session fingerprint, and a fresh temp path per spawn
   * would make every turn look like a config change and cold-respawn.
   */
  private resolveHandlerTimeoutOverlay(version: string): string | null {
    if (!supportsConfigurableHandlerTimeout(version)) {
      this.logger?.info(
        `[OmpSdkManager] omp ${version} predates configurable extension-handler timeouts; ` +
          'OMP approvals for this session must be answered within ~25s or the gate hangs up ' +
          'and asks the model to retry',
      );
      return null;
    }
    return ensureHandlerTimeoutOverlay(
      getCyboflowSubdirectory('omp'),
      OMP_HANDLER_TIMEOUT_MS,
      this.logger,
    );
  }

  private resolvePermissionMode(options: ClaudeSpawnerOptions): PermissionMode {
    if (options.agentPermissionMode) return options.agentPermissionMode;
    const stored = this.sessionManager.getDbSession(options.sessionId)?.agent_permission_mode;
    if (isPermissionMode(stored)) return stored;
    return this.configManager?.getDefaultAgentPermissionMode() ?? 'default';
  }

  /**
   * Per-turn reasoning effort as OMP's `--thinking` level. Re-guarded against
   * OMP's own scale here (as Codex's turn options are) so a caller that skipped
   * `normalizeEffortSelection` cannot push an unaccepted value onto the argv.
   * Shares its normalizer with the role files' `thinkingLevel`
   * (`ompAgentWriter.toOmpThinkingLevel`), so the two cannot drift.
   */
  private resolveThinkingLevel(options: ClaudeSpawnerOptions): OmpThinkingLevel | undefined {
    return toOmpThinkingLevel(options.reasoningEffort);
  }

  /**
   * In-place sessions get no cyboflow MCP in v1: writing `.omp/` into the user's
   * real repo is intrusive and OMP has no `--mcp-config <path>` flag to point
   * elsewhere (proposal §5.4). Logged rather than silent — an agent that cannot
   * call `cyboflow_*` behaves very differently, and the reason should be in the
   * log when someone asks why.
   */
  private ensureMcpConfig(options: ClaudeSpawnerOptions): void {
    const runtimeConfig = this.requireMcpRuntimeConfig();
    if (this.isInPlaceSession(options.sessionId)) {
      this.logger?.info(
        `[OmpSdkManager] in-place session ${options.sessionId}: skipping .omp/mcp.json, so the ` +
          'cyboflow MCP tools are unavailable to this OMP session (v1 limitation, proposal §5.4)',
      );
      return;
    }
    // The writer appends `.omp/` to the worktree-local git exclude on every
    // call, so the config never reaches the session diff rail.
    writeOmpMcpConfig({
      worktreeRoot: options.worktreePath,
      nodeExecutablePath: runtimeConfig.nodeExecutablePath,
      bridgeScriptPath: runtimeConfig.bridgeScriptPath,
      ...(this.logger ? { logger: this.logger } : {}),
    });
  }

  /**
   * Register the run's roles as OMP project agents (`.omp/agents/`) — the cold
   * path only, beside `.omp/mcp.json`: a warm reuse already matched the
   * fingerprint, which covers every role file's rendered content. Skipped in
   * place for the same reason as {@link ensureMcpConfig}, and logged for the
   * same reason: an orchestrator whose `cyboflow-*` delegations fall through to
   * OMP's defaults behaves very differently.
   */
  private ensureAgentFiles(options: ClaudeSpawnerOptions, plan: OmpSpawnPlan): void {
    if (this.isInPlaceSession(options.sessionId)) {
      this.logger?.info(
        `[OmpSdkManager] in-place session ${options.sessionId}: skipping .omp/agents, so the ` +
          "run's cyboflow roles are not registered as OMP agents (same policy as .omp/mcp.json)",
      );
      return;
    }
    // Never throws; it also puts `.omp/` in the worktree-local git exclude
    // before it creates anything.
    writeOmpAgentFiles({
      worktreeRoot: options.worktreePath,
      agents: plan.agents,
      ...(this.logger ? { logger: this.logger } : {}),
    });
  }

  private isInPlaceSession(sessionId: string): boolean {
    return this.sessionManager.getDbSession(sessionId)?.in_place === true;
  }

  /**
   * A parked entry may absorb the incoming spawn only when it is a
   * resume-continuation of the SAME conversation (`resumeSessionId` === the
   * parked session file) AND every spawn-baked input is unchanged. `spawnKey ===
   * panelId` alone is NOT conversation identity — sequential programmatic steps
   * share the panel key.
   */
  private evaluateWarmReuse(
    entry: WarmOmpEntry,
    options: ClaudeSpawnerOptions,
    fingerprint: string,
  ): boolean {
    if (entry.closing || ompWarmDisabled()) return false;
    if (entry.currentContext !== null) return false;
    if (entry.sessionFilePath === null) return false;
    if (typeof options.resumeSessionId !== 'string') return false;
    if (options.resumeSessionId !== entry.sessionFilePath) return false;
    return entry.fingerprint === fingerprint;
  }

  /**
   * Build a cold entry: the transport plus the process-lifetime listeners
   * (raw-event sink, approval bridge, projection) that dispatch through the
   * entry's mutable `currentContext`.
   */
  private buildColdEntry(
    options: ClaudeSpawnerOptions,
    runId: string,
    executable: ResolvedOmpExecutable,
    plan: OmpSpawnPlan,
    warmEligible: boolean,
  ): WarmOmpEntry {
    this.ensureMcpConfig(options);
    this.ensureAgentFiles(options, plan);
    fs.mkdirSync(plan.sessionDir, { recursive: true });

    const entry: WarmOmpEntry = {
      client: undefined as unknown as OmpRpcClientLike,
      rawEventSink: new OmpRawEventSink(this.db, this.logger),
      approvalBridge: undefined as unknown as OmpApprovalBridge,
      questionBridge: undefined as unknown as OmpQuestionBridge,
      unsubscribe: null,
      command: executable.executablePath,
      sessionFilePath: options.resumeSessionId ?? null,
      sessionDir: plan.sessionDir,
      sentinelPath: plan.sentinelPath,
      gateVerified: false,
      fingerprint: plan.fingerprint,
      runId,
      panelId: options.panelId,
      sessionId: options.sessionId,
      warmEligible,
      idleTimer: null,
      closing: false,
      teardownPromise: null,
      currentContext: null,
    };

    entry.questionBridge = new OmpQuestionBridge({
      getRunId: () => entry.currentContext?.runId ?? null,
      getQuestionRouter: () => this.requireQuestionRouter(),
      respond: (response) => entry.client.respondToExtensionUi(response),
      onError: (error) => this.handleQuestionBridgeError(entry, error),
      ...(this.logger ? { logger: this.logger } : {}),
    });
    entry.approvalBridge = new OmpApprovalBridge({
      respond: (response) => entry.client.respondToExtensionUi(response),
      isGateVerified: () => entry.gateVerified,
      onSurfacedError: (message) => this.surfaceError(entry, message),
      onQuestionRequest: (event) => entry.questionBridge.handleUiRequest(event),
      ...(this.logger ? { logger: this.logger } : {}),
    });

    perfBump('omp.rpc.spawn');
    const client = this.createClient({
      command: executable.executablePath,
      cwd: options.worktreePath,
      // OMP's own approval dialogs only exist under the UI-bearing RPC mode; see
      // OMP_RPC_UI_MODE_ARGS for why a plain `--mode rpc` always-ask session can
      // never run a write-tier tool at all.
      modeArgs: OMP_RPC_UI_MODE_ARGS,
      args: [
        ...plan.baseArgs,
        ...(options.resumeSessionId ? ['--resume', options.resumeSessionId] : []),
      ],
      env: plan.env,
      onStderr: (chunk) => this.logger?.warn(`[omp rpc stderr] ${chunk.trimEnd()}`),
      onError: (error) => this.handleClientFailure(entry, error),
      onExit: ({ code, signal }) =>
        this.handleClientFailure(
          entry,
          new Error(`omp rpc exited (code=${String(code)}, signal=${String(signal)})`),
          true,
        ),
    });
    entry.client = client;
    entry.unsubscribe = client.onEvent((event) => this.handleRpcEvent(entry, event));
    return entry;
  }

  // -------------------------------------------------------------------------
  // The turn
  // -------------------------------------------------------------------------

  private async runOneTurn(
    entry: WarmOmpEntry,
    options: ClaudeSpawnerOptions,
    spawnKey: string,
    cold: boolean,
  ): Promise<CliSpawnOutcome> {
    const displayPanelId = options.panelId;
    const runId = options.runId ?? options.panelId;
    const agentInvocationId = randomUUID();
    const abortController = new AbortController();
    const router = new EventRouter<AgentStreamEvent>();
    // OmpRawEventSink already persists every RPC event verbatim — skip the
    // generic 'agent_unknown' wrap so an unmodeled frame is not written twice.
    const sink = new RawEventsSink<AgentStreamEvent>(this.db, this.logger, {
      skipEventTypes: ['agent_unknown'],
    });
    sink.attachToRouter(router, runId);

    const ctx: OmpTurnContext = {
      runId,
      displayPanelId,
      sessionId: options.sessionId,
      agentInvocationId,
      abortController,
      router,
      sink,
      projector: this.buildProjector(options, entry),
      startedAt: Date.now(),
      terminalResultEmitted: false,
      completedCleanly: false,
      turnError: null,
      questionBridgeError: null,
      turnCeilingAborted: false,
    };
    entry.currentContext = ctx;

    let exitCode = 0;
    let resultText: string | null = null;
    const activeRun: ActiveOmpRun = {
      abortController,
      cancel: async () => {
        abortController.abort();
        await this.closeWarmEntry(spawnKey, entry, true);
      },
      panelId: displayPanelId,
      sessionId: options.sessionId,
      worktreePath: options.worktreePath,
    };
    const stub: StubCliProcess = {
      process: undefined as never,
      panelId: displayPanelId,
      sessionId: options.sessionId,
      worktreePath: options.worktreePath,
    };
    (this.processes as Map<string, StubCliProcess>).set(spawnKey, stub);
    this.activeRuns.set(spawnKey, activeRun);
    this.recordSpawnKey(this.spawnKeysByPanelId, displayPanelId, spawnKey);
    this.recordSpawnKey(this.spawnKeysByRunId, runId, spawnKey);

    try {
      this.emitProjected(
        router,
        runId,
        displayPanelId,
        options.sessionId,
        this.buildSessionInfo(options, entry.command),
      );
      this.emit('spawned', { panelId: displayPanelId, sessionId: options.sessionId });

      if (cold) {
        entry.client.start();
        await withTimeout(entry.client.handshake(), OMP_HANDSHAKE_TIMEOUT_MS, 'omp rpc handshake');
        // FAIL CLOSED, BEFORE THE FIRST PROMPT. OMP starts a session even when an
        // extension fails to load, so "the process is alive" says nothing about
        // whether cyboflow's policy is being applied.
        await this.verifyGateSentinel(entry);
        await this.captureSessionFilePath(entry);
      }

      new AgentInvocationStore(this.db).createInvocation({
        agentInvocationId,
        runId,
        stepId: options.agentInvocationStepId,
        provider: 'omp',
        runtime: 'omp-sdk',
        model: resolveAgentModelAlias('omp', options.model),
        // Stamps the owning chat panel so a per-panel resume lookup can tell this
        // panel's OMP session from a sibling chat panel's.
        panelId: displayPanelId,
      });
      if (entry.sessionFilePath) {
        this.captureExternalSessionId(runId, agentInvocationId, entry.sessionFilePath);
      }
      this.emitProjected(
        router,
        runId,
        displayPanelId,
        options.sessionId,
        this.buildSystemInitEvent(options, entry),
      );

      // A cold spawn only learns its session file during the handshake above, so
      // rebuild the projector now that the id exists — otherwise the FIRST turn's
      // events are the only ones in the session missing it.
      ctx.projector = this.buildProjector(options, entry);
      ctx.projector.beginTurn();
      const outcome = await this.runTurnWithTimeout(entry, options.prompt);

      // A prompt that resolved locally (a slash command) never produces an
      // `agent_end`, so nothing has closed the turn on the chat surface. Emit the
      // terminal result ourselves rather than leaving the panel spinning.
      if (outcome.completion === 'local' && !ctx.terminalResultEmitted) {
        ctx.terminalResultEmitted = true;
        ctx.completedCleanly = true;
        this.emitProjected(
          router,
          runId,
          displayPanelId,
          options.sessionId,
          this.buildLocalResult(ctx, entry),
        );
      }
      if (ctx.turnError !== null) throw new Error(ctx.turnError);

      // The typed step-output channel. Resolved only on the SUCCESS path: a
      // failed turn throws above, and a controller that read a half-finished
      // agent's last words as a verdict would be worse than reading nothing.
      resultText = await this.resolveTurnResultText(entry, outcome);

      // The session file only exists once OMP has written one; a first turn on a
      // brand-new session may not have had it at handshake time.
      if (entry.sessionFilePath === null) {
        await this.captureSessionFilePath(entry);
        if (entry.sessionFilePath) {
          this.captureExternalSessionId(runId, agentInvocationId, entry.sessionFilePath);
        }
      }
      this.logSessionStats(entry);
    } catch (error) {
      if (abortController.signal.aborted) {
        this.logger?.info(`[OmpSdkManager] OMP RPC run aborted for panel ${displayPanelId}`);
      } else {
        exitCode = 1;
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.error(`[OmpSdkManager] OMP RPC run error for panel ${displayPanelId}: ${message}`);
        // Same guard as surfaceError: an unlistened 'error' throws and would
        // pre-empt the failure-result projection below.
        if (message !== ctx.questionBridgeError && this.listenerCount('error') > 0) {
          this.emit('error', { panelId: displayPanelId, sessionId: options.sessionId, error: message });
        }
        if (!ctx.terminalResultEmitted) {
          ctx.terminalResultEmitted = true;
          this.emitProjected(
            router,
            runId,
            displayPanelId,
            options.sessionId,
            this.buildFailureResult(message, Date.now() - ctx.startedAt, ctx, entry),
          );
        }
        throw error;
      }
    } finally {
      entry.currentContext = null;
      const canPark =
        entry.warmEligible &&
        ctx.completedCleanly &&
        !abortController.signal.aborted &&
        !entry.closing &&
        !ompWarmDisabled();
      if (canPark) {
        this.armWarmIdleTimer(entry, spawnKey);
      } else {
        await this.closeWarmEntry(spawnKey, entry, abortController.signal.aborted);
      }
      sink.dispose(runId);
      this.processes.delete(spawnKey);
      this.activeRuns.delete(spawnKey);
      this.forgetSpawnKey(this.spawnKeysByPanelId, displayPanelId, spawnKey);
      this.forgetSpawnKey(this.spawnKeysByRunId, runId, spawnKey);
      this.emit('exit', {
        panelId: displayPanelId,
        sessionId: options.sessionId,
        exitCode,
        signal: null,
      });
    }
    return { resultText };
  }

  /**
   * The turn's final assistant text, for {@link CliSpawnOutcome.resultText}.
   *
   * Primary source is the terminal `agent_end` the turn resolved on — it carries
   * the whole message list, so no extra round trip is needed and the value can
   * never belong to a LATER turn. The RPC `get_last_assistant_text` is the
   * fallback for the shapes the frame cannot answer: a locally-resolved prompt
   * (a slash command, which produces no `agent_end` at all) and an `agent_end`
   * whose final assistant message is tool calls with no text of its own.
   *
   * The fallback is session-scoped, not turn-scoped, so it is consulted ONLY
   * when the frame yielded nothing; preferring it would risk handing back the
   * previous turn's answer on a warm session. A failing fallback degrades to
   * null rather than failing the turn — losing a verdict costs a loopback, while
   * throwing here would fail work the agent actually completed.
   */
  private async resolveTurnResultText(
    entry: WarmOmpEntry,
    outcome: OmpTurnOutcome,
  ): Promise<string | null> {
    const fromFrame = outcome.agentEnd ? lastAssistantTextIn(outcome.agentEnd) : null;
    if (fromFrame !== null) return fromFrame;
    if (!entry.client.getLastAssistantText) return null;
    try {
      const text = await withTimeout(
        entry.client.getLastAssistantText(),
        OMP_REQUEST_TIMEOUT_MS,
        'omp get_last_assistant_text',
      );
      return text !== null && text.length > 0 ? text : null;
    } catch (error) {
      this.logger?.warn(
        `[OmpSdkManager] could not read the last assistant text for run ${entry.runId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Run one turn under the wall-clock ceiling.
   *
   * On expiry the turn is ABORTED rather than abandoned — OMP's `abort` is a real
   * command — and OMP is given a grace window to emit its own aborted
   * `agent_end`, which settles `runTurn` normally and leaves a truthful
   * transcript. Only if that never arrives does the turn fail outright.
   */
  private async runTurnWithTimeout(entry: WarmOmpEntry, prompt: string): Promise<OmpTurnOutcome> {
    let ceiling: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      ceiling = setTimeout(() => {
        this.logger?.warn(
          `[OmpSdkManager] turn exceeded ${OMP_TURN_TIMEOUT_MS}ms — aborting run ${entry.runId}`,
        );
        // Recorded BEFORE the abort: OMP's aborted `agent_end` is what carries
        // the misleading "Interrupted by user", and it can arrive as soon as
        // the abort lands.
        if (entry.currentContext) entry.currentContext.turnCeilingAborted = true;
        void entry.client.abort().catch(() => undefined);
        grace = setTimeout(
          () =>
            reject(
              new Error(
                `${describeTurnCeilingAbort()} (OMP did not stop within ` +
                  `${OMP_TURN_ABORT_GRACE_MS}ms of the abort.)`,
              ),
            ),
          OMP_TURN_ABORT_GRACE_MS,
        );
        grace.unref?.();
      }, OMP_TURN_TIMEOUT_MS);
      ceiling.unref?.();
    });
    try {
      return await Promise.race([entry.client.runTurn(prompt), expiry]);
    } finally {
      if (ceiling) clearTimeout(ceiling);
      if (grace) clearTimeout(grace);
    }
  }

  /**
   * Poll for the gate's load sentinel and validate it, killing the child and
   * failing the spawn when it is absent or does not describe THIS session.
   *
   * The absence of the file is the entire signal: OMP's loader records an
   * extension load failure and starts the session anyway
   * (`gate/ompGateExtension.ts`, layer 3), so an ungated OMP session is
   * indistinguishable from a gated one at the protocol level.
   */
  private async verifyGateSentinel(entry: WarmOmpEntry): Promise<void> {
    const deadline = Date.now() + this.sentinelWaitMs;
    for (;;) {
      const sentinel = readGateSentinel(entry.sentinelPath);
      if (sentinel && sentinel.runId === entry.runId) {
        entry.gateVerified = true;
        this.logger?.verbose(
          `[OmpSdkManager] gate sentinel verified for run ${entry.runId} (omp pid ${sentinel.pid})`,
        );
        return;
      }
      if (Date.now() >= deadline) {
        const detail =
          sentinel === null
            ? `no sentinel was written to ${entry.sentinelPath}`
            : `the sentinel at ${entry.sentinelPath} names run ${sentinel.runId}, not ${entry.runId}`;
        await entry.client.stop().catch(() => undefined);
        throw new Error(
          `cyboflow's OMP gate failed to load: ${detail}. OMP starts a session even when an ` +
            'extension fails to load, so continuing would run an UNGATED agent — refusing an ' +
            'ungated session.',
        );
      }
      await delay(OMP_GATE_SENTINEL_POLL_MS);
    }
  }

  /** The OMP session file path — the external session id and the resume target. */
  private async captureSessionFilePath(entry: WarmOmpEntry): Promise<void> {
    try {
      const state = await withTimeout(
        entry.client.getState(),
        OMP_REQUEST_TIMEOUT_MS,
        'omp get_state',
      );
      if (typeof state.sessionFile === 'string' && state.sessionFile.length > 0) {
        entry.sessionFilePath = state.sessionFile;
      }
    } catch (error) {
      // A missing session file costs resume, not the turn: log and continue.
      this.logger?.warn(
        `[OmpSdkManager] could not read the OMP session state for run ${entry.runId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Cross-check only. `get_session_stats` is CUMULATIVE for the whole session —
   * emitting it as a turn's usage would be re-summed downstream into A + (A+B) +
   * (A+B+C) across a warm session (proposal §5.1). The per-turn delta the result
   * event carries comes from the projector's accumulator.
   */
  private logSessionStats(entry: WarmOmpEntry): void {
    void entry.client
      .getSessionStats()
      .then((stats) => {
        this.logger?.verbose(
          `[OmpSdkManager] run ${entry.runId} cumulative session stats: ` +
            `${stats.tokens.total} tokens, $${stats.cost.toFixed(6)} (cross-check only)`,
        );
      })
      .catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private handleRpcEvent(entry: WarmOmpEntry, event: OmpRpcEvent): void {
    // Persist for the process lifetime, including inter-turn frames that arrive
    // while parked, under the entry's stable runId.
    entry.rawEventSink.persist(entry.runId, event);

    if (event.type === 'extension_ui_request') {
      // Answered whether or not a turn is in flight: an unanswered blocking
      // dialog is exactly what hangs a turn, and OMP raises fire-and-forget
      // widget frames while parked.
      entry.approvalBridge.handleUiRequest(event as OmpExtensionUiRequestEvent);
      return;
    }

    const ctx = entry.currentContext;
    if (!ctx) return; // stray event while parked

    for (const projected of ctx.projector.project(event)) {
      // OMP reports every abort as "Interrupted by user", including the ones we
      // caused. Name the real cause when we know it — a bridge failure first,
      // since it is the more specific diagnosis, then our own turn ceiling.
      const trueCause =
        ctx.questionBridgeError ??
        (ctx.turnCeilingAborted ? describeTurnCeilingAbort() : null);
      const effective =
        projected.type === 'agent_result' &&
        projected.is_error &&
        projected.result === 'Interrupted by user' &&
        trueCause !== null
          ? { ...projected, result: trueCause }
          : projected;
      if (effective.type === 'agent_result') {
        if (ctx.terminalResultEmitted) continue;
        ctx.terminalResultEmitted = true;
      }
      this.emitProjected(ctx.router, ctx.runId, ctx.displayPanelId, ctx.sessionId, effective);
      if (effective.type === 'agent_result') {
        if (effective.is_error) {
          // Recorded rather than thrown: `runTurn` still resolves on this same
          // `agent_end`, and the awaiting turn converts it into the failure.
          ctx.turnError = effective.result ?? 'OMP turn failed';
        } else {
          ctx.completedCleanly = true;
        }
      }
    }
  }

  /**
   * The transport reported a failure or an exit. With a turn in flight the
   * awaiting `runTurn` already rejects (the client settles it), so this only has
   * to handle the PARKED case — where a dead (or merely detached-and-broken)
   * child must be stopped, not just forgotten, or its process group is orphaned.
   */
  private handleClientFailure(entry: WarmOmpEntry, error: Error, expected = false): void {
    if (entry.currentContext !== null) {
      if (!expected) {
        this.logger?.warn(`[OmpSdkManager] omp rpc transport error: ${error.message}`);
      }
      return;
    }
    if (entry.closing || entry.teardownPromise) return;
    this.logger?.warn(
      `[OmpSdkManager] parked OMP session for panel ${entry.panelId} died (${error.message}) — evicting`,
    );
    this.evictDeadWarmEntry(entry);
  }

  private surfaceError(entry: WarmOmpEntry, message: string): void {
    // EventEmitter throws on an unlistened 'error'; a UI-bridge diagnostic must
    // never be the thing that takes the manager down.
    if (this.listenerCount('error') === 0) {
      this.logger?.error(`[OmpSdkManager] ${message}`);
      return;
    }
    this.emit('error', {
      panelId: entry.currentContext?.displayPanelId ?? entry.panelId,
      sessionId: entry.currentContext?.sessionId ?? entry.sessionId,
      error: message,
    });
  }

  private handleQuestionBridgeError(entry: WarmOmpEntry, error: Error): void {
    const detail = error.cause instanceof Error ? `: ${error.cause.message}` : '';
    const message = `${error.message}${detail}`;
    if (entry.currentContext) entry.currentContext.questionBridgeError = message;
    this.surfaceError(entry, message);
  }

  private requireQuestionRouter(): OmpQuestionRouterPort {
    if (!this.questionRouterProvider) {
      throw new Error('OMP question router provider is not configured');
    }
    return this.questionRouterProvider();
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /** Close + evict a warm entry (idempotent via `teardownPromise`). */
  private closeWarmEntry(spawnKey: string, entry: WarmOmpEntry, interrupt: boolean): Promise<void> {
    if (entry.teardownPromise) return entry.teardownPromise;
    entry.closing = true;
    this.clearWarmIdleTimer(entry);
    if (this.warmOmpRuns.get(spawnKey) === entry) this.warmOmpRuns.delete(spawnKey);
    entry.teardownPromise = (async () => {
      entry.questionBridge.teardown();
      if (interrupt) {
        // A first-class RPC abort, not a signal: it lets OMP stop the turn
        // cleanly and flush its own aborted `agent_end`.
        try {
          await withTimeout(entry.client.abort(), OMP_ABORT_TIMEOUT_MS, 'omp abort');
        } catch (error) {
          this.logger?.warn(
            `[OmpSdkManager] failed to abort run ${entry.runId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      entry.unsubscribe?.();
      entry.unsubscribe = null;
      await entry.client.stop();
      removeGateSentinel(entry.sentinelPath, this.logger);
    })();
    return entry.teardownPromise;
  }

  private evictDeadWarmEntry(entry: WarmOmpEntry): void {
    for (const [key, value] of this.warmOmpRuns) {
      if (value === entry) {
        void this.closeWarmEntry(key, entry, false);
        return;
      }
    }
    if (!entry.teardownPromise) {
      entry.closing = true;
      this.clearWarmIdleTimer(entry);
      entry.teardownPromise = entry.client
        .stop()
        .then(() => removeGateSentinel(entry.sentinelPath, this.logger))
        .catch((error: unknown) => {
          this.logger?.warn(
            `[OmpSdkManager] warm entry eviction teardown failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }
  }

  private clearWarmIdleTimer(entry: WarmOmpEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private armWarmIdleTimer(entry: WarmOmpEntry, spawnKey: string): void {
    this.clearWarmIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      this.logger?.info(
        `[OmpSdkManager] warm OMP session idle ${OMP_WARM_SESSION_TTL_MS}ms — closing (spawn ${spawnKey})`,
      );
      void this.closeWarmEntry(spawnKey, entry, false);
    }, OMP_WARM_SESSION_TTL_MS);
    entry.idleTimer.unref?.();
  }

  /**
   * An `activeRuns` entry exists exactly for the duration of a logical turn, so
   * its presence for the session IS the in-flight-turn signal. A parked entry has
   * none and correctly reports false.
   */
  override hasTurnInFlightForSession(sessionId: string): boolean {
    for (const run of this.activeRuns.values()) {
      if (run.sessionId === sessionId) return true;
    }
    return false;
  }

  override async killProcess(identity: string): Promise<void> {
    const keys = new Set<string>([
      ...(this.spawnKeysByPanelId.get(identity) ?? []),
      ...(this.spawnKeysByRunId.get(identity) ?? []),
    ]);
    if (keys.size === 0) keys.add(identity);
    await Promise.all(
      [...keys].map(async (spawnKey) => {
        const active = this.activeRuns.get(spawnKey);
        if (active) {
          await active.cancel();
          return;
        }
        const warm = this.warmOmpRuns.get(spawnKey);
        if (warm) await this.closeWarmEntry(spawnKey, warm, false);
      }),
    );
    // Defensive: a parked entry whose spawnKey was already forgotten from the
    // indexes but whose panelId/runId matches.
    for (const [spawnKey, entry] of [...this.warmOmpRuns]) {
      if (entry.panelId === identity || entry.runId === identity || spawnKey === identity) {
        await this.closeWarmEntry(spawnKey, entry, false);
      }
    }
  }

  override async killAllProcesses(): Promise<void> {
    // Parked children are not in `this.processes` (deleted per logical turn), so
    // the base sweep would orphan them; the catalogue probe's client is not
    // tracked anywhere else at all.
    const warm = [...this.warmOmpRuns];
    this.warmOmpRuns.clear();
    await Promise.all([
      super.killAllProcesses(),
      this.modelCatalogProbe.shutdown(),
      ...warm.map(async ([spawnKey, entry]) => {
        await this.closeWarmEntry(spawnKey, entry, true);
      }),
    ]);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private requireMcpRuntimeConfig(): OmpMcpRuntimeConfig {
    if (!this.cyboflowMcpRuntimeConfig) {
      throw new Error('OMP RPC manager missing Cyboflow MCP runtime config');
    }
    return this.cyboflowMcpRuntimeConfig;
  }

  private async getResolvedExecutable(): Promise<ResolvedOmpExecutable> {
    this.resolvedExecutable ??= await this.resolveExecutable();
    return this.resolvedExecutable;
  }

  private async detectExecutable(): Promise<ResolvedOmpExecutable> {
    const availability = await detectOmpAvailability();
    if (availability.state !== 'detected' || !availability.binaryPath) {
      throw new Error(
        `OMP CLI not available: ${availability.version ? `omp ${availability.version} is below the supported floor` : 'no `omp` executable found in PATH'}`,
      );
    }
    return {
      executablePath: availability.binaryPath,
      version: availability.version ?? 'unknown',
    };
  }

  private buildProjector(options: ClaudeSpawnerOptions, entry: WarmOmpEntry): OmpTurnProjector {
    return new OmpTurnProjector({
      model: this.displayModel(options.model),
      ...(entry.sessionFilePath ? { externalSessionId: entry.sessionFilePath } : {}),
      ...(options.hidePromptFromTranscript !== undefined
        ? { hideUserMessage: options.hidePromptFromTranscript }
        : {}),
    });
  }

  private buildSessionInfo(options: ClaudeSpawnerOptions, command: string): AgentSessionInfoEvent {
    return {
      type: 'agent_session_info',
      provider: 'omp',
      runtime: 'omp-sdk',
      initial_prompt: options.prompt,
      command,
      worktree_path: options.worktreePath,
      model: this.displayModel(options.model),
      permission_mode: options.agentPermissionMode ?? 'default',
      timestamp: new Date().toISOString(),
    };
  }

  private buildSystemInitEvent(
    options: ClaudeSpawnerOptions,
    entry: WarmOmpEntry,
  ): AgentInitEvent {
    return {
      type: 'agent_init',
      provider: 'omp',
      runtime: 'omp-sdk',
      // The session FILE is the real identity, but OMP has not necessarily
      // written one by the first init (a brand-new session names its file lazily).
      // The panel's session DIRECTORY is the stable stand-in — display-only, and
      // never a resume target: only a real `sessionFile` reaches
      // `captureExternalSessionId`.
      external_session_id: entry.sessionFilePath ?? entry.sessionDir,
      cwd: options.worktreePath,
      model: this.displayModel(options.model),
      tools: [],
      // An in-place session gets no `.omp/mcp.json`, so claiming the server is
      // configured would be a lie the panel shows the user.
      mcp_servers: this.isInPlaceSession(options.sessionId)
        ? []
        : [{ name: 'cyboflow', status: 'configured' }],
      permission_mode: options.agentPermissionMode ?? 'default',
      sdk_version: `omp ${entry.command}`,
    };
  }

  private buildLocalResult(ctx: OmpTurnContext, entry: WarmOmpEntry): AgentResultEvent {
    return {
      type: 'agent_result',
      provider: 'omp',
      runtime: 'omp-sdk',
      subtype: 'success',
      is_error: false,
      duration_ms: Date.now() - ctx.startedAt,
      num_turns: 1,
      ...(ctx.projector.turnUsage() !== undefined ? { usage: ctx.projector.turnUsage() } : {}),
      // cost_usd for existing consumers; total_cost_usd is the SDK-raw key
      // insightsQueries' run-cost rollup scans (this event persists verbatim
      // into raw_events, unlike Claude's manager which stores the native
      // ClaudeStreamEvent that already carries total_cost_usd).
      ...(ctx.projector.turnCostUsd() !== undefined
        ? { cost_usd: ctx.projector.turnCostUsd(), total_cost_usd: ctx.projector.turnCostUsd() }
        : {}),
      ...(entry.sessionFilePath ? { external_session_id: entry.sessionFilePath } : {}),
    };
  }

  private buildFailureResult(
    message: string,
    durationMs: number,
    ctx: OmpTurnContext,
    entry: WarmOmpEntry,
  ): AgentResultEvent {
    return {
      type: 'agent_result',
      provider: 'omp',
      runtime: 'omp-sdk',
      subtype: 'error_during_execution',
      is_error: true,
      duration_ms: durationMs,
      num_turns: 1,
      result: message,
      ...(ctx.projector.turnUsage() !== undefined ? { usage: ctx.projector.turnUsage() } : {}),
      // See buildLocalResult: raw_events persists this event verbatim, so both
      // keys must be set for the cost to reach insightsQueries' rollup.
      ...(ctx.projector.turnCostUsd() !== undefined
        ? { cost_usd: ctx.projector.turnCostUsd(), total_cost_usd: ctx.projector.turnCostUsd() }
        : {}),
      ...(entry.sessionFilePath ? { external_session_id: entry.sessionFilePath } : {}),
    };
  }

  private emitProjected(
    router: EventRouter<AgentStreamEvent>,
    runId: string,
    panelId: string,
    sessionId: string,
    data: AgentStreamEvent,
  ): void {
    router.emitForRun(runId, data);
    this.emit('output', {
      panelId,
      sessionId,
      type: 'json',
      data: agentStreamEventToClaudeStreamEvent(data),
      timestamp: new Date(),
    });
  }

  private captureExternalSessionId(
    runId: string,
    agentInvocationId: string,
    sessionFilePath: string,
  ): void {
    try {
      new AgentInvocationStore(this.db).captureExternalSessionId(
        runId,
        agentInvocationId,
        sessionFilePath,
      );
    } catch (error) {
      this.logger?.warn(
        `[OmpSdkManager] failed to capture the OMP session file for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private displayModel(model: string | null | undefined): string {
    return resolveAgentModelAlias('omp', model) ?? 'omp-default';
  }

  private recordSpawnKey(
    index: Map<string, Set<string>>,
    identity: string,
    spawnKey: string,
  ): void {
    const keys = index.get(identity) ?? new Set<string>();
    keys.add(spawnKey);
    index.set(identity, keys);
  }

  private forgetSpawnKey(
    index: Map<string, Set<string>>,
    identity: string,
    spawnKey: string,
  ): void {
    const keys = index.get(identity);
    if (!keys) return;
    keys.delete(spawnKey);
    if (keys.size === 0) index.delete(identity);
  }
}

interface OmpSpawnPlan {
  /** argv WITHOUT `--resume` — what the warm fingerprint is taken over. */
  baseArgs: string[];
  env: NodeJS.ProcessEnv;
  gateConfig: OmpGateConfig;
  sessionDir: string;
  sentinelPath: string;
  fingerprint: string;
  permissionMode: PermissionMode;
  model: string | undefined;
  /** The roles the cold path registers under `.omp/agents/`; `[]` in place. */
  agents: readonly EffectiveAgent[];
}

/**
 * A stable digest of the role files a spawn registers: each role's RENDERED
 * file (so anything that changes what OMP reads changes the digest), sorted by
 * key so resolution order cannot perturb it. A render failure digests as the
 * error — still stable, and `writeOmpAgentFiles` skips that role the same way.
 */
function digestOmpAgentFiles(agents: readonly EffectiveAgent[]): string {
  const rendered = [...agents]
    .sort((a, b) => (a.agentKey < b.agentKey ? -1 : a.agentKey > b.agentKey ? 1 : 0))
    .map((agent) => {
      try {
        return [agent.agentKey, renderOmpAgentMarkdown(agent)];
      } catch (error) {
        return [agent.agentKey, `<unrenderable: ${error instanceof Error ? error.message : String(error)}>`];
      }
    });
  return sha1(stableSerialize(rendered));
}

/** Keep a panel id usable as one path segment. */
function sanitizeDirSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  return sanitized.length > 0 ? sanitized : 'panel';
}

function readGateSentinel(sentinelPath: string): OmpGateSentinel | null {
  let raw: string;
  try {
    raw = fs.readFileSync(sentinelPath, 'utf8');
  } catch {
    return null; // not written yet, or never will be
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.loadedAt !== 'string' ||
      typeof record.runId !== 'string' ||
      typeof record.pid !== 'number'
    ) {
      return null;
    }
    return { loadedAt: record.loadedAt, runId: record.runId, pid: record.pid };
  } catch {
    // A half-written file re-reads cleanly on the next poll; a malformed one
    // simply never verifies, which is the fail-closed direction.
    return null;
  }
}

function removeGateSentinel(sentinelPath: string, logger?: Logger): void {
  try {
    fs.rmSync(sentinelPath, { force: true });
  } catch (error) {
    logger?.warn(
      `[OmpSdkManager] could not remove the gate sentinel ${sentinelPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
