import type Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../../../utils/logger';
import type { ConfigManager } from '../../configManager';
import type { SessionManager } from '../../sessionManager';
import type { ConversationMessage } from '../../../database/models';
import type { ClaudeSpawnerOptions } from '../../../orchestrator/runExecutor';
import { AgentInvocationStore } from '../../../orchestrator/agentInvocationStore';
import { agentStreamEventToClaudeStreamEvent, EventRouter, RawEventsSink } from '../../streamParser';
import type {
  AgentInitEvent,
  AgentResultEvent,
  AgentSessionInfoEvent,
  AgentStreamEvent,
} from '../../../../../shared/types/agentStream';
import type { CodexDetectionResult } from '../../../../../shared/types/onboarding';
import type { CodexModelCatalog } from '../../../../../shared/types/agentModels';
import { AbstractCliManager } from '../cli/AbstractCliManager';
import { resolveAgentModelAlias } from '../agentModelContext';
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
import {
  CodexChatGptAuthRequiredError,
  requireCodexChatGptAccount,
} from './appServer/account';
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
} from './appServer/client';
import { projectTurnSessionEvent } from './appServer/eventProjector';
import {
  buildCodexAppServerEnvironment,
  buildCodexAppServerThreadResumeParams,
  buildCodexAppServerThreadStartParams,
  buildCodexAppServerTurnOptions,
  type CodexAppServerMcpRuntimeConfig,
} from './appServer/runConfig';
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

  protected async cleanupCliResources(_sessionId: string): Promise<void> {
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

  override async spawnCliProcess(options: ClaudeSpawnerOptions): Promise<void> {
    const spawnKey = options.spawnKey ?? options.panelId;
    if (this.processes.has(spawnKey) || this.reservedSpawnKeys.has(spawnKey)) {
      throw new Error(`Codex app-server process already running for spawn ${spawnKey}`);
    }
    this.reservedSpawnKeys.add(spawnKey);
    try {
      await this.spawnTrackedProcess(options, spawnKey);
    } finally {
      this.reservedSpawnKeys.delete(spawnKey);
    }
  }

  private async spawnTrackedProcess(
    options: ClaudeSpawnerOptions,
    spawnKey: string,
  ): Promise<void> {
    const displayPanelId = options.panelId;
    const runId = options.runId ?? options.panelId;

    const runtimeConfig = this.requireMcpRuntimeConfig();
    const approvalRouter = this.requireApprovalRouter();
    const questionRouter = this.requireQuestionRouter();
    const executable = this.getResolvedExecutable();
    const agentInvocationId = randomUUID();
    const command = executable.executablePath;
    const abortController = new AbortController();
    const terminal = createDeferred<void>();
    // App-server callbacks can reject before startup reaches the terminal await.
    // Observe immediately while preserving rejection for the later await.
    void terminal.promise.catch(() => undefined);
    const router = new EventRouter<AgentStreamEvent>();
    const sink = new RawEventsSink<AgentStreamEvent>(this.db, this.logger);
    const rawNotificationSink = new CodexRawNotificationSink(this.db, this.logger);
    sink.attachToRouter(router, runId);

    let exitCode = 0;
    let terminalResultEmitted = false;
    let threadId = options.resumeSessionId ?? null;
    let initializeResponse: AppServerInitializeResponse | null = null;
    const startedAt = Date.now();
    const usageAccumulator = new CodexTurnUsageAccumulator();
    const turnSessionRef: { current: CodexAppServerTurnSession | null } = { current: null };

    const approvalBridge = new CodexAppServerApprovalBridge({
      runId,
      approvalRouter,
      source: `${CODEX_APP_SERVER_APPROVAL_SOURCE}:${agentInvocationId}`,
      onError: (error) => this.logger?.error(`[CodexSdkManager] ${error.message}`),
    });
    const questionBridge = new CodexAppServerQuestionBridge({
      runId,
      questionRouter,
      onError: (error) => this.logger?.error(`[CodexSdkManager] ${error.message}`),
    });

    const handleTurnEvent = (event: TurnSessionEvent): void => {
      if (event.type === 'thread.started') threadId = event.threadId;
      if (event.type === 'thread.tokenUsage.updated') {
        usageAccumulator.addLastUsage(event.tokenUsage.last);
      }
      if (event.type === 'item.started' || event.type === 'item.completed') {
        approvalBridge.observeItem(event.item);
      }
      if (
        abortController.signal.aborted
        && event.type === 'turn.completed'
        && event.status === 'interrupted'
      ) {
        terminal.resolve();
        return;
      }

      const projectedEvents = projectTurnSessionEvent(event, {
        model: this.displayModel(options.model),
        durationMs: Date.now() - startedAt,
        usage: usageAccumulator.snapshot(),
        hideUserMessage: options.hidePromptFromTranscript,
      });
      for (const projected of projectedEvents) {
        if (projected.type === 'agent_result') {
          if (terminalResultEmitted) continue;
          terminalResultEmitted = true;
        }
        this.emitProjected(router, runId, displayPanelId, options.sessionId, projected);
        if (projected.type === 'agent_result') {
          if (projected.is_error) {
            terminal.reject(new Error(projected.result ?? 'Codex turn failed'));
          } else {
            terminal.resolve();
          }
        }
      }
    };

    const client = this.createAppServerClient({
      command,
      cwd: options.worktreePath,
      env: prependCodexPathToEnvironment(
        buildCodexAppServerEnvironment(runId, runtimeConfig),
        executable.pathDir,
      ),
      onServerRequest: (request) => request.method === 'item/tool/requestUserInput'
        ? questionBridge.handleServerRequest(request)
        : approvalBridge.handleServerRequest(request),
      onNotification: (notification) => {
        rawNotificationSink.persist(runId, notification);
        turnSessionRef.current?.handleNotification(notification);
      },
      onStderr: (chunk) => this.logger?.warn(`[Codex app-server stderr] ${chunk.trimEnd()}`),
      onError: (error) => {
        if (!abortController.signal.aborted) terminal.reject(error);
      },
      onExit: ({ code, signal }) => {
        if (!abortController.signal.aborted && !terminal.settled) {
          terminal.reject(new Error(
            `Codex app-server exited before the turn completed (code=${String(code)}, signal=${String(signal)})`,
          ));
        }
      },
    });
    const turnSession = new CodexAppServerTurnSession(client, { onEvent: handleTurnEvent });
    turnSessionRef.current = turnSession;

    let teardownPromise: Promise<void> | null = null;
    const teardown = (interrupt: boolean): Promise<void> => {
      if (teardownPromise) return teardownPromise;
      teardownPromise = (async () => {
        if (interrupt && turnSession.isInitialized && turnSession.activeTurnId) {
          try {
            await withTimeout(
              turnSession.interruptTurn(),
              APP_SERVER_INTERRUPT_TIMEOUT_MS,
              'Codex app-server turn interruption',
            );
          } catch (error) {
            this.logger?.warn(
              `[CodexSdkManager] failed to interrupt run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        questionBridge.teardown();
        approvalBridge.teardown();
        await client.stop();
      })();
      return teardownPromise;
    };

    const activeRun: ActiveCodexRun = {
      abortController,
      cancel: async () => {
        abortController.abort();
        terminal.resolve();
        await teardown(true);
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
        this.buildSessionInfo(options, command),
      );
      this.emit('spawned', { panelId: displayPanelId, sessionId: options.sessionId });

      client.start();
      initializeResponse = await withTimeout(
        turnSession.initialize(initializeParams(this.clientVersion)),
        APP_SERVER_REQUEST_TIMEOUT_MS,
        'Codex app-server initialization',
      );
      if (!initializeResponse.userAgent.includes(CODEX_EXECUTABLE_VERSION)) {
        throw new Error(
          `Codex app-server protocol mismatch: expected ${CODEX_EXECUTABLE_VERSION}, got ${initializeResponse.userAgent}`,
        );
      }
      const accountResponse = await withTimeout(
        client.sendRequest<unknown, { refreshToken: false }>(
          'account/read',
          { refreshToken: false },
        ),
        APP_SERVER_REQUEST_TIMEOUT_MS,
        'Codex ChatGPT account check',
      );
      requireCodexChatGptAccount(accountResponse);
      const thread = options.resumeSessionId
        ? await withTimeout(
            turnSession.resumeThread(buildCodexAppServerThreadResumeParams(
              runId,
              options.resumeSessionId,
              options,
              runtimeConfig,
            )),
            APP_SERVER_REQUEST_TIMEOUT_MS,
            'Codex app-server thread resume',
          )
        : await withTimeout(
            turnSession.startThread(buildCodexAppServerThreadStartParams(runId, options, runtimeConfig)),
            APP_SERVER_REQUEST_TIMEOUT_MS,
            'Codex app-server thread start',
          );
      threadId = thread.threadId;
      new AgentInvocationStore(this.db).createInvocation({
        agentInvocationId,
        runId,
        stepId: options.agentInvocationStepId,
        provider: 'codex',
        runtime: 'codex-sdk',
        model: resolveAgentModelAlias('codex', options.model),
      });
      this.captureInvocationCodexThreadId(runId, agentInvocationId, thread.threadId);
      this.emitProjected(
        router,
        runId,
        displayPanelId,
        options.sessionId,
        this.buildSystemInitEvent(options, thread.threadId, initializeResponse),
      );

      await withTimeout(
        turnSession.startTurn(options.prompt, buildCodexAppServerTurnOptions(options)),
        APP_SERVER_REQUEST_TIMEOUT_MS,
        'Codex app-server turn start',
      );
      await terminal.promise;
    } catch (error) {
      if (abortController.signal.aborted) {
        this.logger?.info(`[CodexSdkManager] Codex app-server run aborted for panel ${displayPanelId}`);
      } else {
        exitCode = 1;
        const message = error instanceof Error ? error.message : String(error);
        this.logger?.error(`[CodexSdkManager] Codex app-server run error for panel ${displayPanelId}: ${message}`);
        this.emit('error', { panelId: displayPanelId, sessionId: options.sessionId, error: message });
        if (!terminalResultEmitted) {
          terminalResultEmitted = true;
          this.emitProjected(
            router,
            runId,
            displayPanelId,
            options.sessionId,
            this.buildFailureResult(
              message,
              Date.now() - startedAt,
              threadId,
              usageAccumulator.snapshot(),
            ),
          );
        }
        throw error;
      }
    } finally {
      await teardown(false);
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
  }

  override async killProcess(identity: string): Promise<void> {
    const keys = new Set<string>([
      ...(this.spawnKeysByPanelId.get(identity) ?? []),
      ...(this.spawnKeysByRunId.get(identity) ?? []),
    ]);
    if (keys.size === 0) keys.add(identity);
    await Promise.all([...keys].map(async (spawnKey) => {
      await this.activeRuns.get(spawnKey)?.cancel();
    }));
  }

  override async killAllProcesses(): Promise<void> {
    // Reap tracked probe app-servers (onboarding detection + model discovery)
    // alongside the run-scoped processes — they are not in `this.processes`, so
    // the base sweep would otherwise orphan any probe that is mid-flight when the
    // app quits.
    const probes = [...this.probeClients];
    this.probeClients.clear();
    await Promise.all([
      super.killAllProcesses(),
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
