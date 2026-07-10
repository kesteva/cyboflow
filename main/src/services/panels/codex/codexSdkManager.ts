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
import { requireCodexChatGptAccount } from './appServer/account';
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
} from './appServer/client';
import { projectTurnSessionEvent } from './appServer/eventProjector';
import {
  buildCodexAppServerEnvironment,
  buildCodexAppServerThreadResumeParams,
  buildCodexAppServerThreadStartParams,
  type CodexAppServerMcpRuntimeConfig,
} from './appServer/runConfig';
import type {
  AppServerInitializeParams,
  AppServerInitializeResponse,
} from './appServer/protocol';
import {
  CodexAppServerTurnSession,
  type TurnSessionClient,
  type TurnSessionEvent,
} from './appServer/turnSession';
import { CodexTurnUsageAccumulator } from './appServer/usageAccumulator';

const APP_SERVER_REQUEST_TIMEOUT_MS = 15_000;
const APP_SERVER_INTERRUPT_TIMEOUT_MS = 2_000;

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

function initializeParams(): AppServerInitializeParams {
  return {
    clientInfo: {
      name: 'cyboflow',
      title: 'Cyboflow',
      version: '0.1.20',
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      mcpServerOpenaiFormElicitation: true,
    },
  };
}

export class CodexSdkManager extends AbstractCliManager {
  private readonly activeRuns = new Map<string, ActiveCodexRun>();
  private readonly spawnKeysByPanelId = new Map<string, Set<string>>();
  private cyboflowMcpRuntimeConfig: CodexMcpRuntimeConfig | null = null;
  private approvalRouterProvider: (() => ApprovalRouterPort) | null = null;
  private questionRouterProvider: (() => QuestionRouterPort) | null = null;
  private resolvedExecutable: ResolvedCodexExecutable | null = null;

  constructor(
    sessionManager: SessionManager,
    logger: Logger | undefined,
    configManager: ConfigManager | undefined,
    private readonly db: Database.Database,
    private readonly createAppServerClient: CodexAppServerClientFactory = defaultCodexAppServerClientFactory,
    private readonly resolveExecutable: CodexExecutableResolver = resolveCodexExecutablePath,
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
    const displayPanelId = options.panelId;
    const runId = options.runId ?? options.panelId;

    if (this.processes.has(spawnKey)) {
      throw new Error(`Codex app-server process already running for spawn ${spawnKey}`);
    }

    const runtimeConfig = this.requireMcpRuntimeConfig();
    const approvalRouter = this.requireApprovalRouter();
    const questionRouter = this.requireQuestionRouter();
    const executable = this.getResolvedExecutable();
    const agentInvocationId = randomUUID();
    const command = executable.executablePath;
    const abortController = new AbortController();
    const terminal = createDeferred<void>();
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
    this.recordSpawnKey(displayPanelId, spawnKey);

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
        turnSession.initialize(initializeParams()),
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
        turnSession.startTurn(options.prompt, {
          model: resolveAgentModelAlias('codex', options.model),
        }),
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
      this.forgetSpawnKey(displayPanelId, spawnKey);
      this.emit('exit', {
        panelId: displayPanelId,
        sessionId: options.sessionId,
        exitCode,
        signal: null,
      });
    }
  }

  override async killProcess(panelId: string): Promise<void> {
    const keys = this.spawnKeysByPanelId.get(panelId) ?? new Set([panelId]);
    await Promise.all([...keys].map(async (spawnKey) => {
      await this.activeRuns.get(spawnKey)?.cancel();
    }));
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

  private recordSpawnKey(panelId: string, spawnKey: string): void {
    const keys = this.spawnKeysByPanelId.get(panelId) ?? new Set<string>();
    keys.add(spawnKey);
    this.spawnKeysByPanelId.set(panelId, keys);
  }

  private forgetSpawnKey(panelId: string, spawnKey: string): void {
    const keys = this.spawnKeysByPanelId.get(panelId);
    if (!keys) return;
    keys.delete(spawnKey);
    if (keys.size === 0) this.spawnKeysByPanelId.delete(panelId);
  }
}
