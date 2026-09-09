import type Database from 'better-sqlite3';
import type { AgentProvider } from '../../../../../shared/types/agentRuntime';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { Logger } from '../../../utils/logger';
import type { ConfigManager } from '../../configManager';
import type { SessionManager } from '../../sessionManager';
import type { ConversationMessage } from '../../../database/models';
import type { ClaudeSpawnerOptions } from '../../../orchestrator/runExecutor';
import type { CliSpawnOutcome } from '../../../../../shared/types/cliPanels';
import { AgentInvocationStore } from '../../../orchestrator/agentInvocationStore';
import { agentStreamEventToClaudeStreamEvent, EventRouter, RawEventsSink } from '../../../../../shared/streamParser';
import type {
  AgentInitEvent,
  AgentResultEvent,
  AgentSessionInfoEvent,
  AgentStreamEvent,
} from '../../../../../shared/types/agentStream';
import type { CodexDetectionResult } from '../../../../../shared/types/onboarding';
import type { CodexModelCatalog } from '../../../../../shared/types/agentModels';
import type { ReasoningEffort } from '../../../../../shared/types/reasoningEffort';
import { AbstractCliManager } from '../cli/AbstractCliManager';
import { resolveAgentModelAlias } from '../agentModelContext';
import { perfBump } from '../../perfTracer';
import { observeCodexNotification } from '../../providerUsage/codexUsageObserver';
import {
  CODEX_EXECUTABLE_VERSION,
  prependCodexPathToEnvironment,
  resolveCodexExecutablePath,
  type ResolvedCodexExecutable,
} from './codexExecutablePath';
import {
  CODEX_APP_SERVER_APPROVAL_SOURCE,
  CodexAppServerApprovalBridge,
  type ApprovalRouterPort,
} from './appServer/approvalBridge';
import {
  CodexAppServerQuestionBridge,
  type QuestionRouterPort,
} from './appServer/questionBridge';
import { CodexRawNotificationSink } from './appServer/rawNotificationSink';
import { handleIsolationRequest } from './appServer/isolationRequestPolicy';
import {
  CodexChatGptAuthRequiredError,
  requireCodexChatGptAccount,
} from './appServer/account';
import {
  AppServerProtocolError,
  CodexAppServerClient,
  type CodexAppServerClientOptions,
} from './appServer/client';
import { projectTurnSessionEvent } from './appServer/eventProjector';
import {
  buildCodexAppServerEnvironment,
  buildCodexAppServerThreadConfiguration,
  buildCodexAppServerThreadResumeParams,
  buildCodexAppServerThreadStartParams,
  buildCodexAppServerTurnOptions,
  type CodexAppServerMcpRuntimeConfig,
  type CodexIsolationConfig,
} from './appServer/runConfig';
import { readUserMcpServerNames } from './appServer/userMcpServers';
import type {
  AppServerInitializeParams,
  AppServerInitializeResponse,
  AppServerModelListParams,
  AppServerModelListResponse,
} from './appServer/protocol';
import {
  CodexAppServerTurnSession,
  type TurnSessionClient,
  type TurnSessionEvent,
} from './appServer/turnSession';
import { CodexTurnUsageAccumulator } from './appServer/usageAccumulator';

const APP_SERVER_REQUEST_TIMEOUT_MS = 15_000;
const APP_SERVER_INTERRUPT_TIMEOUT_MS = 2_000;
const MODEL_CATALOG_CACHE_TTL_MS = 5 * 60_000;

interface StubCliProcess {
  process: never;
  panelId: string;
  sessionId: string;
  worktreePath: string;
}

export interface CodexAppServerClientLike extends TurnSessionClient {
  start(): void;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

export type CodexAppServerClientFactory = (
  options: CodexAppServerClientOptions,
) => CodexAppServerClientLike;

export type CodexExecutableResolver = () => ResolvedCodexExecutable;

export type CodexMcpRuntimeConfig = CodexAppServerMcpRuntimeConfig;

interface ActiveCodexRun {
  abortController: AbortController;
  cancel(): Promise<void>;
  panelId: string;
  sessionId: string;
  worktreePath: string;
}

/**
 * The only member the turn lifecycle calls on its events sink. Both the built-in
 * {@link RawEventsSink} and an injected {@link SpawnEventsSink} (global-agent
 * thread) satisfy it, so the two paths share one field.
 */
interface TurnEventsSink {
  dispose(runId?: string): void;
}

/**
 * Per-LOGICAL-TURN mutable state. The client callbacks and the turnSession
 * `onEvent` are baked once at cold spawn, so every one dispatches through the
 * warm entry's `currentContext` (this object) — bound before `startTurn`, cleared
 * after the terminal cleanup. Null while the entry is parked idle between turns.
 */
interface CodexTurnContext {
  runId: string;
  displayPanelId: string;
  sessionId: string;
  agentInvocationId: string;
  abortController: AbortController;
  terminal: Deferred<void>;
  router: EventRouter<AgentStreamEvent>;
  /**
   * The per-turn events sink. Either the built-in run-keyed
   * {@link RawEventsSink} or, for a hermetic global-agent spawn, the injected
   * {@link ClaudeSpawnerOptions.eventsSink} — narrowed to the only member this
   * context uses so both shapes bind here.
   */
  sink: TurnEventsSink;
  usageAccumulator: CodexTurnUsageAccumulator;
  approvalBridge: CodexAppServerApprovalBridge;
  questionBridge: CodexAppServerQuestionBridge;
  startedAt: number;
  model: string | null | undefined;
  hidePromptFromTranscript: boolean | undefined;
  terminalResultEmitted: boolean;
  completedCleanly: boolean;
  /**
   * F1 / RC1: the LAST SUBSTANTIVE `item.completed` `agentMessage.text` of THIS
   * turn — the turn's typed step output ({@link CliSpawnOutcome}). Per-turn,
   * because the context is rebuilt for every logical turn, so a warm entry's
   * turn B can never inherit turn A's text. Never a blank/whitespace-only string:
   * `handleTurnEvent` skips those, so `null` here means "no text this turn" and
   * downstream never sees a non-null, substance-less result.
   */
  lastAgentMessageText: string | null;
}

/**
 * A warm (persistent) Codex app-server kept alive across resume-continuation
 * turns of ONE conversation. Cold-only transport/session/thread state lives here;
 * `currentContext` holds the in-flight turn (null while parked). Keyed in
 * `warmCodexRuns` by spawnKey; also reachable by panelId/runId for kill.
 */
interface WarmCodexEntry {
  client: CodexAppServerClientLike;
  turnSession: CodexAppServerTurnSession;
  // Process-lifetime raw-notification sink (stateless per call, keyed by the
  // entry's stable runId) — persists every frame, including inter-turn frames
  // that arrive while parked (currentContext is null).
  rawNotificationSink: CodexRawNotificationSink;
  /**
   * false for a hermetic global-agent spawn. `rawNotificationSink` writes
   * `raw_events` keyed by the entry's runId, which for that spawn is the
   * run-less `agent:<threadId>`: with `foreign_keys=ON` every INSERT fails the
   * FK to `workflow_runs` and is fail-soft dropped WITH a WARN — dozens per
   * turn. The transcript for those spawns is owned by the injected eventsSink
   * (thread-keyed), so the cold-entry sink is skipped entirely.
   */
  persistRawNotifications: boolean;
  /** The isolation inputs this entry's thread was (or will be) opened with; undefined for a run-scoped spawn. */
  isolationConfig: CodexIsolationConfig | undefined;
  command: string;
  threadId: string | null;
  initializeResponse: AppServerInitializeResponse | null;
  fingerprint: string;
  runId: string;
  panelId: string;
  /** false for lane/disabled spawns — those always close, never park. */
  warmEligible: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closing: boolean;
  teardownPromise: Promise<void> | null;
  currentContext: CodexTurnContext | null;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
  readonly settled: boolean;
}

function createDeferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
    get settled() {
      return settled;
    },
  };
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${description} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Idle time a WARM Codex app-server is kept alive between resume-continuation
 * turns of one conversation before it is closed (mirrors the SDK warm TTL).
 */
const CODEX_WARM_SESSION_TTL_MS = 15 * 60_000;

/**
 * v1 rollback lever: when `CYBOFLOW_DISABLE_CODEX_WARM=1`, every Codex turn tears
 * down its app-server instead of parking it warm. Read per turn so it can be
 * flipped without a restart.
 */
function codexWarmDisabled(): boolean {
  return process.env.CYBOFLOW_DISABLE_CODEX_WARM === '1';
}

/** SHA-1 hex of a string — a bounded, stable fingerprint digest (not for crypto). */
function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

/**
 * Recursively sort object keys and drop functions so structurally-equal values
 * serialize identically regardless of key insertion order — the warm-reuse
 * fingerprint input.
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

function defaultCodexAppServerClientFactory(
  options: CodexAppServerClientOptions,
): CodexAppServerClientLike {
  return new CodexAppServerClient(options);
}

function initializeParams(clientVersion: string): AppServerInitializeParams {
  return {
    clientInfo: {
      name: 'cyboflow',
      title: 'Cyboflow',
      version: clientVersion,
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      mcpServerOpenaiFormElicitation: true,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireModelListResponse(value: unknown): AppServerModelListResponse {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('Codex model/list returned an invalid response');
  }
  const nextCursor = value.nextCursor;
  if (nextCursor !== null && typeof nextCursor !== 'string') {
    throw new Error('Codex model/list returned an invalid cursor');
  }
  for (const model of value.data) {
    if (!isRecord(model)
      || typeof model.id !== 'string'
      || typeof model.model !== 'string'
      || typeof model.displayName !== 'string'
      || typeof model.description !== 'string'
      || typeof model.hidden !== 'boolean'
      || typeof model.isDefault !== 'boolean') {
      throw new Error('Codex model/list returned an invalid model entry');
    }
  }
  return value as unknown as AppServerModelListResponse;
}

function cloneModelCatalog(catalog: CodexModelCatalog): CodexModelCatalog {
  return {
    models: catalog.models.map((model) => ({ ...model })),
    defaultModel: catalog.defaultModel,
  };
}

export class CodexSdkManager extends AbstractCliManager {
  private readonly activeRuns = new Map<string, ActiveCodexRun>();
  private readonly spawnKeysByPanelId = new Map<string, Set<string>>();
  private readonly spawnKeysByRunId = new Map<string, Set<string>>();
  private readonly reservedSpawnKeys = new Set<string>();
  // Warm (persistent) app-servers parked between resume-continuation turns of one
  // conversation, keyed by spawnKey. A parked entry is NOT in `this.processes`
  // (deleted per logical turn); killAllProcesses/killProcess sweep this map too.
  private readonly warmCodexRuns = new Map<string, WarmCodexEntry>();
  // Short-lived probe app-servers (onboarding detection + model discovery) that
  // are not tracked in `this.processes`. Tracked here so shutdown reaps any that
  // are mid-flight; each self-removes in its own try/finally on resolve/reject.
  private readonly probeClients = new Set<CodexAppServerClientLike>();
  private cyboflowMcpRuntimeConfig: CodexMcpRuntimeConfig | null = null;
  private approvalRouterProvider: (() => ApprovalRouterPort) | null = null;
  private questionRouterProvider: (() => QuestionRouterPort) | null = null;
  private resolvedExecutable: ResolvedCodexExecutable | null = null;
  private modelCatalog: CodexModelCatalog | null = null;
  private modelCatalogFetchedAt = 0;
  private modelCatalogRequest: Promise<CodexModelCatalog> | null = null;

  constructor(
    sessionManager: SessionManager,
    logger: Logger | undefined,
    configManager: ConfigManager | undefined,
    private readonly db: Database.Database,
    private readonly createAppServerClient: CodexAppServerClientFactory = defaultCodexAppServerClientFactory,
    private readonly resolveExecutable: CodexExecutableResolver = resolveCodexExecutablePath,
    private readonly clientVersion: string = 'development',
  ) {
    super(sessionManager, logger, configManager);
    if (db == null) {
      throw new TypeError('[CodexSdkManager] db argument is required; RawEventsSink cannot operate without a database handle.');
    }
  }

  protected getCliToolName(): string {
    return 'Codex app-server';
  }

  /** Vendor for the provider-access guard (Settings → Integrations). */
  protected getAgentProvider(): AgentProvider {
    return 'codex';
  }

  setCyboflowMcpRuntimeConfig(config: CodexMcpRuntimeConfig): void {
    this.cyboflowMcpRuntimeConfig = config;
  }

  setApprovalRouterProvider(provider: () => ApprovalRouterPort): void {
    this.approvalRouterProvider = provider;
  }

  setQuestionRouterProvider(provider: () => QuestionRouterPort): void {
    this.questionRouterProvider = provider;
  }

  /**
   * Probe the bundled Codex runtime and ChatGPT login without starting a thread.
   * The temporary app-server is always stopped before this method resolves.
   */
  async detectChatGptAccount(): Promise<CodexDetectionResult> {
    let executable: ResolvedCodexExecutable;
    try {
      executable = this.getResolvedExecutable();
    } catch (error) {
      this.logger?.warn(
        `[CodexSdkManager] onboarding runtime detection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        runtime: { found: false, path: null, version: null },
        account: { found: false, email: null, planType: null },
        state: 'unavailable',
      };
    }

    const runtime = {
      found: true,
      path: executable.executablePath,
      version: executable.version,
    };
    perfBump('codex.probe.spawn');
    const client = this.createAppServerClient({
      command: executable.executablePath,
      env: prependCodexPathToEnvironment(process.env, executable.pathDir),
      onStderr: (chunk) => this.logger?.warn(`[Codex app-server detection stderr] ${chunk.trimEnd()}`),
    });
    this.probeClients.add(client);

    try {
      client.start();
      const initialized = await withTimeout(
        client.initialize(initializeParams(this.clientVersion)),
        APP_SERVER_REQUEST_TIMEOUT_MS,
        'Codex app-server onboarding initialization',
      );
      if (!initialized.userAgent.includes(CODEX_EXECUTABLE_VERSION)) {
        throw new Error(
          `Codex app-server protocol mismatch: expected ${CODEX_EXECUTABLE_VERSION}, got ${initialized.userAgent}`,
        );
      }
      const response = await withTimeout(
        client.sendRequest<unknown, { refreshToken: false }>(
          'account/read',
          { refreshToken: false },
        ),
        APP_SERVER_REQUEST_TIMEOUT_MS,
        'Codex ChatGPT onboarding account check',
      );
      const account = requireCodexChatGptAccount(response).account;
      return {
        runtime,
        account: {
          found: true,
          email: account.email,
          planType: account.planType,
        },
        state: 'detected',
      };
    } catch (error) {
      if (!(error instanceof CodexChatGptAuthRequiredError)) {
        this.logger?.warn(
          `[CodexSdkManager] onboarding account detection failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {
        runtime,
        account: { found: false, email: null, planType: null },
        state: error instanceof CodexChatGptAuthRequiredError ? 'loggedOut' : 'unavailable',
      };
    } finally {
      this.probeClients.delete(client);
      await client.stop().catch((error: unknown) => {
        this.logger?.warn(
          `[CodexSdkManager] onboarding detection teardown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  async getCodexModelCatalog(): Promise<CodexModelCatalog> {
    if (this.modelCatalog && Date.now() - this.modelCatalogFetchedAt < MODEL_CATALOG_CACHE_TTL_MS) {
      return cloneModelCatalog(this.modelCatalog);
    }
    this.modelCatalogRequest ??= this.fetchCodexModelCatalog();
    try {
      const catalog = await this.modelCatalogRequest;
      this.modelCatalog = catalog;
      this.modelCatalogFetchedAt = Date.now();
      return cloneModelCatalog(catalog);
    } finally {
      this.modelCatalogRequest = null;
    }
  }

  protected async testCliAvailability(): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    try {
      const executable = this.getResolvedExecutable();
      const version = execFileSync(executable.executablePath, ['--version'], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      }).trim();
      if (!version.includes(CODEX_EXECUTABLE_VERSION)) {
        return {
          available: false,
          error: `Codex version mismatch: expected ${CODEX_EXECUTABLE_VERSION}, got ${version}`,
          version,
          path: executable.executablePath,
        };
      }
      return { available: true, version, path: executable.executablePath };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  protected buildCommandArgs(_options: ClaudeSpawnerOptions): string[] {
    return [];
  }

  protected async getCliExecutablePath(): Promise<string> {
    return this.getResolvedExecutable().executablePath;
  }

  protected parseCliOutput(
    _data: string,
    _panelId: string,
    _sessionId: string,
  ): Array<{ panelId: string; sessionId: string; type: 'json' | 'stdout' | 'stderr'; data: unknown; timestamp: Date }> {
    return [];
  }

  protected async initializeCliEnvironment(_options: ClaudeSpawnerOptions): Promise<{ [key: string]: string }> {
    return {};
  }

  protected async cleanupCliResources(_panelId: string, _sessionId: string): Promise<void> {
    return;
  }

  protected async getCliEnvironment(_options: ClaudeSpawnerOptions): Promise<{ [key: string]: string }> {
    return {};
  }

  async startPanel(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    prompt: string,
    _permissionMode?: unknown,
    model?: unknown,
    _fastMode?: unknown,
    reasoningEffort?: ReasoningEffort,
  ): Promise<void> {
    await this.spawnCliProcess({
      panelId,
      sessionId,
      worktreePath,
      prompt,
      ...(typeof model === 'string' ? { model } : {}),
      reasoningEffort,
    });
  }

  async continuePanel(
    _panelId: string,
    _sessionId: string,
    _worktreePath: string,
    _prompt: string,
    _conversationHistory: ConversationMessage[],
  ): Promise<void> {
    throw new Error('Codex app-server panel continuation is workflow-only in this build');
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
    throw new Error('Codex app-server panel restart is workflow-only in this build');
  }

  /**
   * Resolves the turn's typed step-output ({@link CliSpawnOutcome}) — F1 / RC1.
   * `resultText` is the LAST completed `agentMessage.text` of the turn that had
   * any substance, or `null` when a cleanly-completed turn produced no agent
   * message (or only blank ones — never `''`). An aborted,
   * interrupted, or errored turn resolves `void` (rejecting turns still reject),
   * which the programmatic step runner reads as "no channel".
   */
  override async spawnCliProcess(options: ClaudeSpawnerOptions): Promise<CliSpawnOutcome | void> {
    // Provider-access gate (Settings → Integrations) — a switched-off provider
    // must refuse BEFORE any spawn bookkeeping, availability probe, or lock.
    this.assertProviderEnabled(options);
    const spawnKey = options.spawnKey ?? options.panelId;
    if (this.processes.has(spawnKey) || this.reservedSpawnKeys.has(spawnKey)) {
      throw new Error(`Codex app-server process already running for spawn ${spawnKey}`);
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
  ): Promise<CliSpawnOutcome | void> {
    const runId = options.runId ?? options.panelId;
    // A lane spawn (fan-out step: spawnKey !== panelId) is a single-shot turn of a
    // fresh conversation — it never parks warm. Same when the kill-switch is set.
    const isLaneSpawn = options.spawnKey !== undefined && options.spawnKey !== options.panelId;
    const warmEligible = !isLaneSpawn && !codexWarmDisabled();

    const runtimeConfig = this.requireMcpRuntimeConfig();
    const executable = this.getResolvedExecutable();
    // HERMETIC spawn only: the user's own MCP servers, read fresh each spawn so
    // an edit to config.toml is honoured (and busts a parked entry via the
    // fingerprint) without a restart.
    const isolationConfig: CodexIsolationConfig | undefined =
      options.isolation === 'agent' ? { disabledMcpServers: readUserMcpServerNames() } : undefined;
    const fingerprint = this.computeWarmFingerprint(runId, options, runtimeConfig, executable, isolationConfig);

    // Warm reuse: a parked entry for this key whose thread + fingerprint match the
    // incoming resume-continuation absorbs the turn with NO cold app-server spawn.
    if (warmEligible) {
      const existing = this.warmCodexRuns.get(spawnKey);
      if (existing) {
        if (this.evaluateCodexWarmReuse(existing, options, fingerprint)) {
          this.clearWarmIdleTimer(existing);
          // Warm reuse returns the turn's own outcome — turn B's text, never A's.
          return await this.runOneTurnGuarded(existing, options, spawnKey, false);
        }
        // Ineligible (fresh conversation / changed config / closing): drop the
        // parked process and cold-respawn below.
        await this.closeWarmEntry(spawnKey, existing, false);
      }
    }

    const entry = this.buildColdEntry(options, runId, runtimeConfig, executable, fingerprint, warmEligible, isolationConfig);
    if (warmEligible) this.warmCodexRuns.set(spawnKey, entry);
    return await this.runOneTurnGuarded(entry, options, spawnKey, true);
  }

  /**
   * runOneTurn's own try/finally parks-or-closes any failure that occurs AFTER the
   * turn context is bound. A throw BEFORE that (e.g. a missing router provider on
   * the warm-reuse path, after the idle timer was cleared) would otherwise strand a
   * parked LIVE process in `warmCodexRuns` with no idle timer and no teardown — so
   * close it here. The guard fires only on that narrow pre-bind window: an in-`try`
   * failure already deleted the entry (or set teardownPromise) in the finally.
   */
  private async runOneTurnGuarded(
    entry: WarmCodexEntry,
    options: ClaudeSpawnerOptions,
    spawnKey: string,
    cold: boolean,
  ): Promise<CliSpawnOutcome | void> {
    try {
      return await this.runOneTurn(entry, options, spawnKey, cold);
    } catch (error) {
      if (
        this.warmCodexRuns.get(spawnKey) === entry
        && entry.currentContext === null
        && !entry.teardownPromise
      ) {
        await this.closeWarmEntry(spawnKey, entry, false);
      }
      throw error;
    }
  }

  /**
   * Fingerprint the spawn-baked inputs (serialized env + thread configuration —
   * incl. `developerInstructions`, model, sandbox, and the runId-bearing MCP
   * bridge env — plus executable path/version and client init version). A warm
   * turn whose fingerprint changed forces a cold respawn instead of splicing a
   * mismatched conversation onto the live thread. runId is baked into the env, so
   * a cross-run reuse self-invalidates.
   */
  private computeWarmFingerprint(
    runId: string,
    options: ClaudeSpawnerOptions,
    runtimeConfig: CodexMcpRuntimeConfig,
    executable: ResolvedCodexExecutable,
    isolationConfig: CodexIsolationConfig | undefined,
  ): string {
    return sha1(stableSerialize({
      env: buildCodexAppServerEnvironment(runId, runtimeConfig),
      thread: buildCodexAppServerThreadConfiguration(runId, options, runtimeConfig, isolationConfig),
      executablePath: executable.executablePath,
      executableVersion: executable.version,
      clientVersion: this.clientVersion,
    }));
  }

  /**
   * A parked warm entry may absorb the incoming spawn only when it is a
   * resume-continuation of the SAME conversation (resumeSessionId === the parked
   * thread) AND every spawn-baked input is unchanged (fingerprint). `spawnKey ===
   * panelId` alone is NOT conversation identity — unrelated sequential programmatic
   * steps share the panel key, so an id gate is mandatory.
   */
  private evaluateCodexWarmReuse(
    entry: WarmCodexEntry,
    options: ClaudeSpawnerOptions,
    fingerprint: string,
  ): boolean {
    if (entry.closing || codexWarmDisabled()) return false;
    if (entry.currentContext !== null) return false;      // a turn is in flight — not idle
    if (entry.threadId === null) return false;
    if (typeof options.resumeSessionId !== 'string') return false;
    if (options.resumeSessionId !== entry.threadId) return false;
    return entry.fingerprint === fingerprint;
  }

  /**
   * Build a cold entry: the app-server client + turnSession whose callbacks all
   * dispatch through the entry's mutable `currentContext` (bound per turn in
   * runOneTurn), so one live process serves N sequential turns. `perfBump` fires
   * here only — warm reuse does none of this.
   */
  private buildColdEntry(
    options: ClaudeSpawnerOptions,
    runId: string,
    runtimeConfig: CodexMcpRuntimeConfig,
    executable: ResolvedCodexExecutable,
    fingerprint: string,
    warmEligible: boolean,
    isolationConfig: CodexIsolationConfig | undefined,
  ): WarmCodexEntry {
    // HERMETIC global-agent spawn. `options.isolation` is the ONE discriminator —
    // never an `agent:` id-prefix sniff. The client callbacks below are baked once
    // per cold entry, and the thread configuration (which differs for isolation)
    // is part of the warm fingerprint, so a parked entry can never serve a spawn
    // of the other kind.
    const isolationSpawn = options.isolation === 'agent';
    const entry: WarmCodexEntry = {
      client: undefined as unknown as CodexAppServerClientLike,
      turnSession: undefined as unknown as CodexAppServerTurnSession,
      rawNotificationSink: new CodexRawNotificationSink(this.db, this.logger),
      persistRawNotifications: !isolationSpawn,
      isolationConfig,
      command: executable.executablePath,
      threadId: options.resumeSessionId ?? null,
      initializeResponse: null,
      fingerprint,
      runId,
      panelId: options.panelId,
      warmEligible,
      idleTimer: null,
      closing: false,
      teardownPromise: null,
      currentContext: null,
    };

    perfBump('codex.appserver.spawn');
    const client = this.createAppServerClient({
      command: executable.executablePath,
      cwd: options.worktreePath,
      env: prependCodexPathToEnvironment(
        buildCodexAppServerEnvironment(runId, runtimeConfig),
        executable.pathDir,
      ),
      onServerRequest: (request) => {
        if (isolationSpawn) {
          // Fail-closed and LOCAL: never the approval/question routers, which
          // need a running `workflow_runs` row this identity has no row in (they
          // would answer decline anyway, silently). Answered even while parked —
          // a hanging request is worse than a refused one.
          const decision = handleIsolationRequest(request);
          if (decision.warning) this.logger?.warn(`[CodexSdkManager] ${decision.warning}`);
          return;
        }
        const ctx = entry.currentContext;
        if (!ctx) {
          // A server request with no active turn cannot be routed to a bridge —
          // reject so the app-server is not left hanging on it while parked.
          return Promise.reject(
            new AppServerProtocolError('Codex app-server request arrived with no active turn'),
          );
        }
        return request.method === 'item/tool/requestUserInput'
          ? ctx.questionBridge.handleServerRequest(request)
          : ctx.approvalBridge.handleServerRequest(request);
      },
      onNotification: (notification) => {
        // Persist every notification for the process lifetime — including
        // inter-turn frames that arrive while parked (currentContext null) —
        // under the entry's stable runId, mirroring pre-warm behavior.
        if (entry.persistRawNotifications) {
          entry.rawNotificationSink.persist(entry.runId, notification);
        }
        entry.turnSession.handleNotification(notification);
        // Usage telemetry LAST, and never allowed to throw: an exception
        // escaping this handler reaches CodexAppServerClient.fail(), which
        // SIGTERMs the app-server's whole process group mid-turn.
        try {
          observeCodexNotification(notification.method, notification.params);
        } catch {
          // Unreachable in practice — observeCodexNotification is itself
          // catch-all — but a usage meter must never be able to kill a turn.
        }
      },
      onStderr: (chunk) => this.logger?.warn(`[Codex app-server stderr] ${chunk.trimEnd()}`),
      onError: (error) => {
        const ctx = entry.currentContext;
        if (ctx) {
          if (!ctx.abortController.signal.aborted) ctx.terminal.reject(error);
        } else {
          // Parked-process death: evict so the next spawn cold-starts.
          this.evictDeadWarmEntry(entry);
        }
      },
      onExit: ({ code, signal }) => {
        const ctx = entry.currentContext;
        if (ctx) {
          if (!ctx.abortController.signal.aborted && !ctx.terminal.settled) {
            ctx.terminal.reject(new Error(
              `Codex app-server exited before the turn completed (code=${String(code)}, signal=${String(signal)})`,
            ));
          }
        } else {
          this.evictDeadWarmEntry(entry);
        }
      },
    });
    entry.client = client;
    entry.turnSession = new CodexAppServerTurnSession(client, {
      onEvent: (event) => this.handleTurnEvent(entry, event),
    });
    return entry;
  }

  /**
   * Run exactly ONE logical turn on an entry. Binds a fresh per-turn context
   * (terminal/abort/router/sink/bridges/usage + a fresh agentInvocationId), does
   * the cold handshake (initialize/account/thread) only when `cold`, mints the
   * per-turn invocation + init records, starts the turn, and on the finally either
   * PARKS the live process (clean completion) or closes it. Emits `spawned`/`exit`
   * per logical turn so the events layer is unchanged.
   *
   * Resolves the turn's typed step-output (F1 / RC1): `{ resultText }` on a clean,
   * un-aborted completion, `void` on an abort/interrupt (the error path throws).
   */
  private async runOneTurn(
    entry: WarmCodexEntry,
    options: ClaudeSpawnerOptions,
    spawnKey: string,
    cold: boolean,
  ): Promise<CliSpawnOutcome | void> {
    const displayPanelId = options.panelId;
    const runId = options.runId ?? options.panelId;
    // HERMETIC global-agent spawn — see buildColdEntry. `options.isolation` is
    // the ONE discriminator; the run-less `agent:<threadId>` identity is never
    // sniffed from the id.
    const isolationSpawn = options.isolation === 'agent';
    const agentInvocationId = randomUUID();
    const abortController = new AbortController();
    const terminal = createDeferred<void>();
    // App-server callbacks can reject before startup reaches the terminal await.
    // Observe immediately while preserving rejection for the later await.
    void terminal.promise.catch(() => undefined);
    const router = new EventRouter<AgentStreamEvent>();
    // A caller-injected sink REPLACES the built-in one (single-writer contract):
    // the global-agent thread persists this same narrowed stream thread-keyed
    // into `agent_thread_events`, because `raw_events.run_id` is FK'd to
    // `workflow_runs` and its `agent:<threadId>` identity has no row there.
    // Absent ⇒ the built-in run-keyed sink, byte-identical to before.
    // (CodexRawNotificationSink already persists the raw app-server notification
    // payload verbatim, so the built-in sink skips the generic 'agent_unknown'
    // wrap to kill the double-write.)
    let sink: TurnEventsSink;
    if (options.eventsSink) {
      options.eventsSink.attachToRouter(router, runId);
      sink = options.eventsSink;
    } else {
      const rawSink = new RawEventsSink<AgentStreamEvent>(this.db, this.logger, {
        skipEventTypes: ['agent_unknown'],
      });
      rawSink.attachToRouter(router, runId);
      sink = rawSink;
    }
    const usageAccumulator = new CodexTurnUsageAccumulator();

    const approvalBridge = new CodexAppServerApprovalBridge({
      runId,
      approvalRouter: this.requireApprovalRouter(),
      source: `${CODEX_APP_SERVER_APPROVAL_SOURCE}:${agentInvocationId}`,
      onError: (error) => this.logger?.error(`[CodexSdkManager] ${error.message}`),
    });
    const questionBridge = new CodexAppServerQuestionBridge({
      runId,
      questionRouter: this.requireQuestionRouter(),
      onError: (error) => this.logger?.error(`[CodexSdkManager] ${error.message}`),
    });

    const ctx: CodexTurnContext = {
      runId,
      displayPanelId,
      sessionId: options.sessionId,
      agentInvocationId,
      abortController,
      terminal,
      router,
      sink,
      usageAccumulator,
      approvalBridge,
      questionBridge,
      startedAt: Date.now(),
      model: options.model,
      hidePromptFromTranscript: options.hidePromptFromTranscript,
      terminalResultEmitted: false,
      completedCleanly: false,
      lastAgentMessageText: null,
    };
    entry.currentContext = ctx;

    let exitCode = 0;
    // F1 / RC1: captured INSIDE the try, off this turn's own ctx, before the
    // finally nulls `entry.currentContext` — so the value can never be read from
    // (or leak into) a sibling turn. Stays undefined on the abort path, which the
    // step runner reads as "no channel". Declared `| undefined` (not `| void`) so
    // TS's definite-assignment analysis accepts the unassigned abort path.
    let outcome: CliSpawnOutcome | undefined;

    const activeRun: ActiveCodexRun = {
      abortController,
      cancel: async () => {
        abortController.abort();
        terminal.resolve();
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
        const initializeResponse = await withTimeout(
          entry.turnSession.initialize(initializeParams(this.clientVersion)),
          APP_SERVER_REQUEST_TIMEOUT_MS,
          'Codex app-server initialization',
        );
        if (!initializeResponse.userAgent.includes(CODEX_EXECUTABLE_VERSION)) {
          throw new Error(
            `Codex app-server protocol mismatch: expected ${CODEX_EXECUTABLE_VERSION}, got ${initializeResponse.userAgent}`,
          );
        }
        entry.initializeResponse = initializeResponse;
        const accountResponse = await withTimeout(
          entry.client.sendRequest<unknown, { refreshToken: false }>(
            'account/read',
            { refreshToken: false },
          ),
          APP_SERVER_REQUEST_TIMEOUT_MS,
          'Codex ChatGPT account check',
        );
        requireCodexChatGptAccount(accountResponse);
        const runtimeConfig = this.requireMcpRuntimeConfig();
        const thread = options.resumeSessionId
          ? await withTimeout(
              entry.turnSession.resumeThread(buildCodexAppServerThreadResumeParams(
                runId,
                options.resumeSessionId,
                options,
                runtimeConfig,
                entry.isolationConfig,
              )),
              APP_SERVER_REQUEST_TIMEOUT_MS,
              'Codex app-server thread resume',
            )
          : await withTimeout(
              entry.turnSession.startThread(
                buildCodexAppServerThreadStartParams(runId, options, runtimeConfig, entry.isolationConfig),
              ),
              APP_SERVER_REQUEST_TIMEOUT_MS,
              'Codex app-server thread start',
            );
        entry.threadId = thread.threadId;
      }

      if (entry.threadId === null || entry.initializeResponse === null) {
        throw new Error('Codex warm entry missing thread/init state before turn start');
      }

      // A hermetic global-agent spawn has NO `workflow_runs` row: `createInvocation`
      // INSERTs an FK to it and THROWS for the run-less `agent:<threadId>` id,
      // killing the spawn. Nothing reads an invocation row for that identity
      // (the thread's own store owns its transcript and resume id), so both this
      // and the thread-id capture below are skipped outright.
      if (!isolationSpawn) {
        new AgentInvocationStore(this.db).createInvocation({
          agentInvocationId,
          runId,
          stepId: options.agentInvocationStepId,
          provider: 'codex',
          runtime: 'codex-sdk',
          model: resolveAgentModelAlias('codex', options.model),
          // Stamp the owning chat panel so a per-panel resume lookup can tell this
          // panel's Codex thread from a sibling chat panel's. For workflow runs
          // panelId === runId, so this is redundant-but-harmless there; for a quick
          // session the runId is the SESSION-shared chat sentinel and this column
          // is the only thing that distinguishes two chats (TASK-103 Add-chat).
          panelId: displayPanelId,
        });
        this.captureInvocationCodexThreadId(runId, agentInvocationId, entry.threadId);
      }
      this.emitProjected(
        router,
        runId,
        displayPanelId,
        options.sessionId,
        this.buildSystemInitEvent(options, entry.threadId, entry.initializeResponse),
      );

      await withTimeout(
        entry.turnSession.startTurn(options.prompt, buildCodexAppServerTurnOptions(options)),
        APP_SERVER_REQUEST_TIMEOUT_MS,
        'Codex app-server turn start',
      );
      await terminal.promise;
      // A clean, un-aborted turn is the ONLY path with a result to hand back; a
      // turn with no substantive agent message still resolves the shape, with
      // `resultText: null` (F1 / RC1 — the latch never stores blank text, so this
      // is never a non-null, substance-less string; see handleTurnEvent).
      if (ctx.completedCleanly && !abortController.signal.aborted) {
        outcome = { resultText: ctx.lastAgentMessageText };
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        this.logger?.info(`[CodexSdkManager] Codex app-server run aborted for panel ${displayPanelId}`);
      } else {
        exitCode = 1;
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.error(`[CodexSdkManager] Codex app-server run error for panel ${displayPanelId}: ${message}`);
        this.emit('error', { panelId: displayPanelId, sessionId: options.sessionId, error: message });
        if (!ctx.terminalResultEmitted) {
          ctx.terminalResultEmitted = true;
          this.emitProjected(
            router,
            runId,
            displayPanelId,
            options.sessionId,
            this.buildFailureResult(
              message,
              Date.now() - ctx.startedAt,
              entry.threadId,
              usageAccumulator.snapshot(),
            ),
          );
        }
        throw error;
      }
    } finally {
      entry.currentContext = null;
      // Park ONLY on a clean turn.completed (activeTurnId cleared by finishTurn).
      // Any error / interrupt / abort / kill-switch closes the process instead —
      // a turn.error never clears the active turn, so a reused turnSession would
      // reject the next startTurn.
      const canPark =
        entry.warmEligible
        && ctx.completedCleanly
        && !abortController.signal.aborted
        && !entry.closing
        && !codexWarmDisabled()
        && entry.turnSession.activeTurnId === null;
      // This turn's bridges are per-turn (a fresh approval `source` per invocation);
      // tear them down regardless of park/close. The live client is retained on park.
      questionBridge.teardown();
      approvalBridge.teardown();
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
    return outcome;
  }

  /** Turn-event handler bound to a warm entry — dispatches through its current turn. */
  private handleTurnEvent(entry: WarmCodexEntry, event: TurnSessionEvent): void {
    const ctx = entry.currentContext;
    if (!ctx) return; // stray event while parked — ignore
    if (event.type === 'thread.started') entry.threadId = event.threadId;
    if (event.type === 'thread.tokenUsage.updated') {
      ctx.usageAccumulator.addLastUsage(event.tokenUsage.last);
    }
    if (event.type === 'item.started' || event.type === 'item.completed') {
      ctx.approvalBridge.observeItem(event.item);
    }
    // F1 / RC1: latch this turn's final agent text for the typed step-output
    // channel (§5.3). LAST SUBSTANTIVE completed agentMessage wins — the same
    // event the eval jury latches off this stream (codexEvalJudgeQuery.ts:263).
    // Without it spawnCliProcess resolved `void`, spawnStepRunner mapped that to
    // `resultText: null`, and workflowController dropped task-verify's composed
    // visual-verification task as "channel unavailable" — along with its
    // `VERDICT: FAIL` loopback and Codex code-review's `## Blocking` sections.
    //
    // The blank guard is load-bearing, not hygiene: a whitespace-only message is
    // not a message in this protocol (the projector drops it outright —
    // appServer/eventProjector.ts:227 — the eval jury rejects the turn on it,
    // codexEvalJudgeQuery.ts:271, and piSdkManager.ts:400 refuses to latch it).
    // Latching `''` would resolve a NON-null, substance-less `resultText`, which
    // workflowController.ts:1565 reads as a real verdict channel: it parses no
    // `## Visual verification task` fence, treats that as a contract defect, and
    // a second such turn FAILS the lane — turning today's fail-OPEN skip into a
    // hard lane failure. Skipping the latch (rather than nulling the outcome)
    // also keeps a substantive earlier message when a turn merely trails off.
    if (
      event.type === 'item.completed'
      && event.item.type === 'agentMessage'
      && event.item.text.trim().length > 0
    ) {
      ctx.lastAgentMessageText = event.item.text;
    }
    if (
      ctx.abortController.signal.aborted
      && event.type === 'turn.completed'
      && event.status === 'interrupted'
    ) {
      ctx.terminal.resolve();
      return;
    }

    const projectedEvents = projectTurnSessionEvent(event, {
      model: this.displayModel(ctx.model),
      durationMs: Date.now() - ctx.startedAt,
      usage: ctx.usageAccumulator.snapshot(),
      hideUserMessage: ctx.hidePromptFromTranscript,
    });
    for (const projected of projectedEvents) {
      if (projected.type === 'agent_result') {
        if (ctx.terminalResultEmitted) continue;
        ctx.terminalResultEmitted = true;
      }
      this.emitProjected(ctx.router, ctx.runId, ctx.displayPanelId, ctx.sessionId, projected);
      if (projected.type === 'agent_result') {
        if (projected.is_error) {
          ctx.terminal.reject(new Error(projected.result ?? 'Codex turn failed'));
        } else {
          ctx.completedCleanly = true;
          ctx.terminal.resolve();
        }
      }
    }
  }

  /** Close + evict a warm entry (idempotent via `teardownPromise`). */
  private closeWarmEntry(spawnKey: string, entry: WarmCodexEntry, interrupt: boolean): Promise<void> {
    if (entry.teardownPromise) return entry.teardownPromise;
    entry.closing = true;
    this.clearWarmIdleTimer(entry);
    if (this.warmCodexRuns.get(spawnKey) === entry) this.warmCodexRuns.delete(spawnKey);
    entry.teardownPromise = (async () => {
      if (interrupt && entry.turnSession.isInitialized && entry.turnSession.activeTurnId) {
        try {
          await withTimeout(
            entry.turnSession.interruptTurn(),
            APP_SERVER_INTERRUPT_TIMEOUT_MS,
            'Codex app-server turn interruption',
          );
        } catch (error) {
          this.logger?.warn(
            `[CodexSdkManager] failed to interrupt run ${entry.runId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      await entry.client.stop();
    })();
    return entry.teardownPromise;
  }

  /**
   * A parked entry's client reported onError/onExit with no active turn. The
   * trigger may be a genuine process exit OR a handler-level error (client
   * `reportError`) where the app-server is STILL ALIVE and detached — so this
   * MUST stop the client, not just drop the map entry, or the live process group
   * would be orphaned (reachable by neither killProcess nor killAllProcesses).
   * `client.stop()` is idempotent and no-ops on an already-exited client.
   */
  private evictDeadWarmEntry(entry: WarmCodexEntry): void {
    for (const [key, value] of this.warmCodexRuns) {
      if (value === entry) {
        void this.closeWarmEntry(key, entry, false);
        return;
      }
    }
    // Already unmapped (e.g. a concurrent close) — ensure the client is stopped.
    if (!entry.teardownPromise) {
      entry.closing = true;
      this.clearWarmIdleTimer(entry);
      entry.teardownPromise = entry.client.stop().catch((error: unknown) => {
        this.logger?.warn(
          `[CodexSdkManager] warm entry eviction teardown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  private clearWarmIdleTimer(entry: WarmCodexEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  /** Arm the warm-idle TTL: after CODEX_WARM_SESSION_TTL_MS idle, close the entry. */
  private armWarmIdleTimer(entry: WarmCodexEntry, spawnKey: string): void {
    this.clearWarmIdleTimer(entry);
    entry.idleTimer = setTimeout(() => {
      this.logger?.info(
        `[CodexSdkManager] warm Codex app-server idle ${CODEX_WARM_SESSION_TTL_MS}ms — closing (spawn ${spawnKey})`,
      );
      void this.closeWarmEntry(spawnKey, entry, false);
    }, CODEX_WARM_SESSION_TTL_MS);
  }

  /**
   * Codex-SDK override: an `activeRuns` entry exists exactly for the duration of
   * a logical turn (set before startTurn, deleted in the drive loop's finally),
   * so its presence for the session IS the in-flight-turn signal. A warm entry
   * parked between turns has no activeRuns entry and correctly reports `false`.
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
    await Promise.all([...keys].map(async (spawnKey) => {
      const active = this.activeRuns.get(spawnKey);
      if (active) {
        await active.cancel();
        return;
      }
      // A PARKED warm entry has no active run (no turn in flight) — close it directly.
      const warm = this.warmCodexRuns.get(spawnKey);
      if (warm) await this.closeWarmEntry(spawnKey, warm, false);
    }));
    // Defensive: a parked entry whose spawnKey was already forgotten from the
    // indexes but whose panelId/runId matches the requested identity.
    for (const [spawnKey, entry] of [...this.warmCodexRuns]) {
      if (entry.panelId === identity || entry.runId === identity || spawnKey === identity) {
        await this.closeWarmEntry(spawnKey, entry, false);
      }
    }
  }

  override async killAllProcesses(): Promise<void> {
    // Reap tracked probe app-servers (onboarding detection + model discovery)
    // alongside the run-scoped processes — they are not in `this.processes`, so
    // the base sweep would otherwise orphan any probe that is mid-flight when the
    // app quits.
    const probes = [...this.probeClients];
    this.probeClients.clear();
    // Warm parked app-servers are not in `this.processes` (deleted per logical
    // turn), so the base sweep would orphan them — close them alongside probes.
    const warm = [...this.warmCodexRuns];
    this.warmCodexRuns.clear();
    await Promise.all([
      super.killAllProcesses(),
      ...warm.map(async ([spawnKey, entry]) => {
        await this.closeWarmEntry(spawnKey, entry, true);
      }),
      ...probes.map(async (client) => {
        await client.stop().catch((error: unknown) => {
          this.logger?.warn(
            `[CodexSdkManager] probe app-server shutdown teardown failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }),
    ]);
  }

  private requireMcpRuntimeConfig(): CodexMcpRuntimeConfig {
    if (!this.cyboflowMcpRuntimeConfig) {
      throw new Error('Codex app-server manager missing Cyboflow MCP runtime config');
    }
    return this.cyboflowMcpRuntimeConfig;
  }

  private getResolvedExecutable(): ResolvedCodexExecutable {
    this.resolvedExecutable ??= this.resolveExecutable();
    return this.resolvedExecutable;
  }

  private async fetchCodexModelCatalog(): Promise<CodexModelCatalog> {
    const executable = this.getResolvedExecutable();
    perfBump('codex.probe.spawn');
    const client = this.createAppServerClient({
      command: executable.executablePath,
      env: prependCodexPathToEnvironment(process.env, executable.pathDir),
      onStderr: (chunk) => this.logger?.warn(`[Codex app-server model discovery stderr] ${chunk.trimEnd()}`),
    });
    this.probeClients.add(client);

    try {
      client.start();
      const initialized = await withTimeout(
        client.initialize(initializeParams(this.clientVersion)),
        APP_SERVER_REQUEST_TIMEOUT_MS,
        'Codex app-server model discovery initialization',
      );
      if (!initialized.userAgent.includes(CODEX_EXECUTABLE_VERSION)) {
        throw new Error(
          `Codex app-server protocol mismatch: expected ${CODEX_EXECUTABLE_VERSION}, got ${initialized.userAgent}`,
        );
      }

      const models = new Map<string, CodexModelCatalog['models'][number]>();
      let cursor: string | null | undefined;
      do {
        const params: AppServerModelListParams = { includeHidden: false };
        if (cursor) params.cursor = cursor;
        const response = requireModelListResponse(await withTimeout(
          client.sendRequest<unknown, AppServerModelListParams>('model/list', params),
          APP_SERVER_REQUEST_TIMEOUT_MS,
          'Codex model discovery',
        ));
        for (const model of response.data) {
          if (model.hidden) continue;
          models.set(model.model, {
            id: model.model,
            label: model.displayName,
            description: model.description,
            isDefault: model.isDefault,
          });
        }
        cursor = response.nextCursor;
      } while (cursor);

      if (models.size === 0) {
        throw new Error('Codex model/list returned no visible models');
      }
      const visibleModels = [...models.values()];
      return {
        models: visibleModels,
        defaultModel: visibleModels.find((model) => model.isDefault)?.id ?? null,
      };
    } finally {
      this.probeClients.delete(client);
      await client.stop().catch((error: unknown) => {
        this.logger?.warn(
          `[CodexSdkManager] model discovery teardown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  private requireApprovalRouter(): ApprovalRouterPort {
    if (!this.approvalRouterProvider) {
      throw new Error('Codex app-server manager missing approval router provider');
    }
    return this.approvalRouterProvider();
  }

  private requireQuestionRouter(): QuestionRouterPort {
    if (!this.questionRouterProvider) {
      throw new Error('Codex app-server manager missing question router provider');
    }
    return this.questionRouterProvider();
  }

  private buildSessionInfo(
    options: ClaudeSpawnerOptions,
    command: string,
  ): AgentSessionInfoEvent {
    return {
      type: 'agent_session_info',
      provider: 'codex',
      runtime: 'codex-sdk',
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
    threadId: string,
    initializeResponse: AppServerInitializeResponse,
  ): AgentInitEvent {
    return {
      type: 'agent_init',
      provider: 'codex',
      runtime: 'codex-sdk',
      external_session_id: threadId,
      cwd: options.worktreePath,
      model: this.displayModel(options.model),
      tools: [],
      mcp_servers: [{ name: 'cyboflow', status: 'configured' }],
      permission_mode: options.agentPermissionMode ?? 'default',
      sdk_version: initializeResponse.userAgent,
    };
  }

  private buildFailureResult(
    message: string,
    durationMs: number,
    threadId: string | null,
    usage?: AgentResultEvent['usage'],
  ): AgentResultEvent {
    return {
      type: 'agent_result',
      provider: 'codex',
      runtime: 'codex-sdk',
      subtype: 'error_during_execution',
      is_error: true,
      duration_ms: durationMs,
      num_turns: 1,
      result: message,
      ...(usage !== undefined ? { usage } : {}),
      external_session_id: threadId ?? undefined,
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

  private captureInvocationCodexThreadId(
    runId: string,
    agentInvocationId: string,
    threadId: string,
  ): void {
    try {
      new AgentInvocationStore(this.db).captureExternalSessionId(runId, agentInvocationId, threadId);
    } catch (error) {
      this.logger?.warn(
        `[CodexSdkManager] failed to capture Codex thread id for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private displayModel(model: string | null | undefined): string {
    return resolveAgentModelAlias('codex', model) ?? 'codex-default';
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
