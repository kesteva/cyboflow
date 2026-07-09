import type Database from 'better-sqlite3';
import type {
  ApprovalMode,
  CodexOptions,
  SandboxMode,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  Usage,
} from '@openai/codex-sdk';
import type { Logger } from '../../../utils/logger';
import type { ConfigManager } from '../../configManager';
import type { SessionManager } from '../../sessionManager';
import type { ConversationMessage } from '../../../database/models';
import type { ClaudeSpawnerOptions } from '../../../orchestrator/runExecutor';
import { agentStreamEventToClaudeStreamEvent, EventRouter, RawEventsSink } from '../../streamParser';
import type {
  AgentAssistantMessageEvent,
  AgentInitEvent,
  AgentResultEvent,
  AgentSessionInfoEvent,
  AgentStreamEvent,
  AgentUserMessageEvent,
} from '../../../../../shared/types/agentStream';
import { AbstractCliManager } from '../cli/AbstractCliManager';
import { codexPermissionFlagsForMode } from './codexPtyManager';

interface StubCliProcess {
  process: never;
  panelId: string;
  sessionId: string;
  worktreePath: string;
}

interface CodexStreamedTurnLike {
  events: AsyncGenerator<ThreadEvent>;
}

export interface CodexThreadLike {
  readonly id: string | null;
  runStreamed(input: string, turnOptions?: { signal?: AbortSignal }): Promise<CodexStreamedTurnLike>;
}

export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

export type CodexClientFactory = (options?: CodexOptions) => CodexClientLike | Promise<CodexClientLike>;

export interface CodexMcpRuntimeConfig {
  orchSocketPath: string;
  bridgeScriptPath: string;
  nodeExecutablePath: string;
}

interface ActiveCodexRun {
  abortController: AbortController;
  panelId: string;
  sessionId: string;
  worktreePath: string;
}

type CodexSdkModule = typeof import('@openai/codex-sdk');

const importCodexSdk = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<CodexSdkModule>;

async function defaultCodexClientFactory(options?: CodexOptions): Promise<CodexClientLike> {
  // @openai/codex-sdk is ESM-only while Electron main is compiled as CommonJS.
  // Use native dynamic import through Function so TypeScript does not lower it
  // into require(), which would fail at runtime with ERR_REQUIRE_ESM.
  const { Codex } = await importCodexSdk('@openai/codex-sdk');
  return new Codex(options);
}

function isCodexThreadEvent(value: unknown): value is ThreadEvent {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function usageInputTokens(usage: Usage | null): number {
  if (!usage) return 0;
  return usage.input_tokens + usage.cached_input_tokens;
}

function usageOutputTokens(usage: Usage | null): number {
  if (!usage) return 0;
  return usage.output_tokens + usage.reasoning_output_tokens;
}

function codexThreadOptions(
  options: ClaudeSpawnerOptions,
): ThreadOptions {
  const permissionMode = options.agentPermissionMode ?? 'default';
  const permissionFlags = codexPermissionFlagsForMode(permissionMode);
  const threadOptions: ThreadOptions = {
    workingDirectory: options.worktreePath,
    sandboxMode: permissionFlags.sandbox as SandboxMode,
    approvalPolicy: permissionFlags.approval as ApprovalMode,
  };

  if (options.model && options.model !== 'auto' && options.model !== 'default') {
    threadOptions.model = options.model;
  }

  return threadOptions;
}

function buildCyboflowMcpCodexConfig(
  runId: string,
  runtimeConfig: CodexMcpRuntimeConfig,
): NonNullable<CodexOptions['config']> {
  return {
    mcp_servers: {
      cyboflow: {
        command: runtimeConfig.nodeExecutablePath,
        args: [runtimeConfig.bridgeScriptPath],
        env: {
          CYBOFLOW_RUN_ID: runId,
          CYBOFLOW_ORCH_SOCKET: runtimeConfig.orchSocketPath,
        },
        required: true,
        default_tools_approval_mode: 'approve',
      },
    },
  };
}

export class CodexSdkManager extends AbstractCliManager {
  private readonly activeRuns = new Map<string, ActiveCodexRun>();
  private readonly spawnKeysByPanelId = new Map<string, Set<string>>();
  private cyboflowMcpRuntimeConfig: CodexMcpRuntimeConfig | null = null;

  constructor(
    sessionManager: SessionManager,
    logger: Logger | undefined,
    configManager: ConfigManager | undefined,
    private readonly db: Database.Database,
    private readonly createCodexClient: CodexClientFactory = defaultCodexClientFactory,
  ) {
    super(sessionManager, logger, configManager);
    if (db == null) {
      throw new TypeError('[CodexSdkManager] db argument is required; RawEventsSink cannot operate without a database handle.');
    }
  }

  protected getCliToolName(): string {
    return 'Codex SDK';
  }

  setCyboflowMcpRuntimeConfig(config: CodexMcpRuntimeConfig): void {
    this.cyboflowMcpRuntimeConfig = config;
  }

  protected async testCliAvailability(): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    return { available: true, version: '@openai/codex-sdk', path: '@openai/codex-sdk' };
  }

  protected buildCommandArgs(_options: ClaudeSpawnerOptions): string[] {
    return [];
  }

  protected async getCliExecutablePath(): Promise<string> {
    return 'codex-sdk-in-process';
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
    throw new Error('Codex SDK panel continuation is workflow-only in this build');
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
    throw new Error('Codex SDK panel restart is workflow-only in this build');
  }

  override async spawnCliProcess(options: ClaudeSpawnerOptions): Promise<void> {
    const spawnKey = options.spawnKey ?? options.panelId;
    const displayPanelId = options.panelId;
    const runId = options.runId ?? options.panelId;

    if (this.processes.has(spawnKey)) {
      throw new Error(`Codex SDK process already running for spawn ${spawnKey}`);
    }

    const abortController = new AbortController();
    const stub: StubCliProcess = {
      process: undefined as never,
      panelId: displayPanelId,
      sessionId: options.sessionId,
      worktreePath: options.worktreePath,
    };
    (this.processes as Map<string, StubCliProcess>).set(spawnKey, stub);
    this.activeRuns.set(spawnKey, {
      abortController,
      panelId: displayPanelId,
      sessionId: options.sessionId,
      worktreePath: options.worktreePath,
    });
    this.recordSpawnKey(displayPanelId, spawnKey);

    const router = new EventRouter();
    const sink = new RawEventsSink(this.db, this.logger);
    sink.attachToRouter(router, runId);

    let exitCode = 0;
    let terminalError: string | null = null;
    let terminalResultEmitted = false;
    let threadId = options.resumeSessionId ?? null;
    let systemInitEmitted = false;
    const startedAt = Date.now();
    const threadOptions = codexThreadOptions(options);

    try {
      this.emitProjected(router, runId, displayPanelId, options.sessionId, this.buildSessionInfo(options));
      this.emit('spawned', { panelId: displayPanelId, sessionId: options.sessionId });

      const client = await this.createCodexClient(this.buildCodexOptions(runId));
      const thread = options.resumeSessionId
        ? client.resumeThread(options.resumeSessionId, threadOptions)
        : client.startThread(threadOptions);

      if (options.resumeSessionId) {
        systemInitEmitted = true;
        this.emitProjected(
          router,
          runId,
          displayPanelId,
          options.sessionId,
          this.buildSystemInitEvent(options, options.resumeSessionId, threadOptions),
        );
      }

      const streamed = await thread.runStreamed(options.prompt, { signal: abortController.signal });
      for await (const rawEvent of streamed.events) {
        if (abortController.signal.aborted) break;
        if (!isCodexThreadEvent(rawEvent)) continue;

        const projectedEvents = this.projectThreadEvent(rawEvent, {
          options,
          threadOptions,
          threadId,
          systemInitEmitted,
          durationMs: Date.now() - startedAt,
        });

        if (rawEvent.type === 'thread.started') {
          threadId = rawEvent.thread_id;
          systemInitEmitted = true;
          this.captureRunCodexThreadId(runId, rawEvent.thread_id);
        }

        for (const projected of projectedEvents) {
          this.emitProjected(router, runId, displayPanelId, options.sessionId, projected);
          const resultError = this.resultTerminalError(projected);
          if (resultError) {
            terminalError = resultError;
            terminalResultEmitted = true;
          }
        }

        if (rawEvent.type === 'turn.failed') {
          terminalError = rawEvent.error.message;
          break;
        }
        if (rawEvent.type === 'error') {
          terminalError = rawEvent.message;
          break;
        }
      }

      if (terminalError !== null) {
        exitCode = 1;
        throw new Error(terminalError);
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        this.logger?.info(`[CodexSdkManager] Codex SDK run aborted for panel ${displayPanelId}`);
      } else {
        exitCode = 1;
        terminalError = err instanceof Error ? err.message : String(err);
        this.logger?.error(`[CodexSdkManager] Codex SDK run error for panel ${displayPanelId}: ${terminalError}`);
        this.emit('error', { panelId: displayPanelId, sessionId: options.sessionId, error: terminalError });
        if (!terminalResultEmitted) {
          this.emitProjected(
            router,
            runId,
            displayPanelId,
            options.sessionId,
            this.buildResultEvent({
              subtype: 'error_during_execution',
              isError: true,
              result: terminalError,
              usage: null,
              durationMs: Date.now() - startedAt,
              threadId,
            }),
          );
        }
        throw err;
      }
    } finally {
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
    for (const spawnKey of keys) {
      this.activeRuns.get(spawnKey)?.abortController.abort();
    }
  }

  private projectThreadEvent(
    event: ThreadEvent,
    context: {
      options: ClaudeSpawnerOptions;
      threadOptions: ThreadOptions;
      threadId: string | null;
      systemInitEmitted: boolean;
      durationMs: number;
    },
  ): AgentStreamEvent[] {
    switch (event.type) {
      case 'thread.started':
        return context.systemInitEmitted
          ? []
          : [this.buildSystemInitEvent(context.options, event.thread_id, context.threadOptions)];
      case 'turn.started':
        return [];
      case 'item.started':
      case 'item.updated':
        return [];
      case 'item.completed':
        return this.projectCompletedItem(event.item, context.options, context.threadId);
      case 'turn.completed':
        return [
          this.buildResultEvent({
            subtype: 'success',
            isError: false,
            usage: event.usage,
            durationMs: context.durationMs,
            threadId: context.threadId,
          }),
        ];
      case 'turn.failed':
        return [
          this.buildResultEvent({
            subtype: 'error_during_execution',
            isError: true,
            result: event.error.message,
            usage: null,
            durationMs: context.durationMs,
            threadId: context.threadId,
          }),
        ];
      case 'error':
        return [
          this.buildResultEvent({
            subtype: 'error_during_execution',
            isError: true,
            result: event.message,
            usage: null,
            durationMs: context.durationMs,
            threadId: context.threadId,
          }),
        ];
      default: {
        const _exhaustive: never = event;
        return [{ type: 'agent_unknown', raw: stringifyUnknown(_exhaustive) ? { raw: stringifyUnknown(_exhaustive) } : {} }];
      }
    }
  }

  private projectCompletedItem(
    item: ThreadItem,
    options: ClaudeSpawnerOptions,
    threadId: string | null,
  ): AgentStreamEvent[] {
    switch (item.type) {
      case 'agent_message':
        if (item.text.trim().length === 0) return [];
        return [this.buildAssistantTextEvent(item.id, item.text, options, threadId)];
      case 'reasoning':
        if (item.text.trim().length === 0) return [];
        return [this.buildAssistantThinkingEvent(item.id, item.text, options, threadId)];
      case 'command_execution':
        return this.buildToolProjection({
          id: item.id,
          name: 'Bash',
          input: { command: item.command },
          result: item.aggregated_output,
          isError: item.status === 'failed' || (item.exit_code !== undefined && item.exit_code !== 0),
          options,
          threadId,
        });
      case 'mcp_tool_call':
        return this.buildToolProjection({
          id: item.id,
          name: item.tool,
          input: { server: item.server, arguments: item.arguments },
          result: item.error?.message ?? stringifyUnknown(item.result?.structured_content ?? item.result?.content ?? ''),
          isError: item.status === 'failed',
          options,
          threadId,
        });
      case 'file_change':
        return [this.buildAssistantTextEvent(item.id, this.describeFileChange(item), options, threadId)];
      case 'web_search':
        return this.buildToolProjection({
          id: item.id,
          name: 'WebSearch',
          input: { query: item.query },
          result: `Searched for ${item.query}`,
          isError: false,
          options,
          threadId,
        });
      case 'todo_list':
        return [this.buildAssistantThinkingEvent(item.id, this.describeTodoList(item), options, threadId)];
      case 'error':
        return [
          this.buildResultEvent({
            subtype: 'error_during_execution',
            isError: true,
            result: item.message,
            usage: null,
            durationMs: 0,
            threadId,
          }),
        ];
      default: {
        const _exhaustive: never = item;
        return [{ type: 'agent_unknown', raw: { raw: stringifyUnknown(_exhaustive) } }];
      }
    }
  }

  private buildSessionInfo(options: ClaudeSpawnerOptions): AgentSessionInfoEvent {
    return {
      type: 'agent_session_info',
      provider: 'codex',
      runtime: 'codex-sdk',
      initial_prompt: options.prompt,
      command: 'codex-sdk-in-process',
      worktree_path: options.worktreePath,
      model: this.displayModel(options.model),
      permission_mode: options.agentPermissionMode ?? 'default',
      timestamp: new Date().toISOString(),
    };
  }

  private buildSystemInitEvent(
    options: ClaudeSpawnerOptions,
    threadId: string,
    threadOptions: ThreadOptions,
  ): AgentInitEvent {
    return {
      type: 'agent_init',
      provider: 'codex',
      runtime: 'codex-sdk',
      external_session_id: threadId,
      cwd: options.worktreePath,
      model: this.displayModel(threadOptions.model),
      tools: [],
      mcp_servers: [{ name: 'cyboflow', status: 'connected' }],
      permission_mode: options.agentPermissionMode ?? 'default',
      sdk_version: '@openai/codex-sdk',
    };
  }

  private buildCodexOptions(runId: string): CodexOptions {
    if (!this.cyboflowMcpRuntimeConfig) {
      throw new Error('Codex SDK manager missing Cyboflow MCP runtime config');
    }

    return {
      config: buildCyboflowMcpCodexConfig(runId, this.cyboflowMcpRuntimeConfig),
    };
  }

  private buildAssistantTextEvent(
    id: string,
    text: string,
    options: ClaudeSpawnerOptions,
    threadId: string | null,
  ): AgentAssistantMessageEvent {
    return {
      type: 'agent_message',
      role: 'assistant',
      id,
      model: this.displayModel(options.model),
      content: [{ type: 'text', text }],
      external_session_id: threadId ?? undefined,
    };
  }

  private buildAssistantThinkingEvent(
    id: string,
    text: string,
    options: ClaudeSpawnerOptions,
    threadId: string | null,
  ): AgentAssistantMessageEvent {
    return {
      type: 'agent_message',
      role: 'assistant',
      id,
      model: this.displayModel(options.model),
      content: [{ type: 'thinking', text }],
      external_session_id: threadId ?? undefined,
    };
  }

  private buildToolProjection(input: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    result: string;
    isError: boolean;
    options: ClaudeSpawnerOptions;
    threadId: string | null;
  }): [AgentAssistantMessageEvent, AgentUserMessageEvent] {
    return [
      {
        type: 'agent_message',
        role: 'assistant',
        id: `${input.id}:call`,
        model: this.displayModel(input.options.model),
        content: [{ type: 'tool_call', id: input.id, name: input.name, input: input.input }],
        external_session_id: input.threadId ?? undefined,
      },
      {
        type: 'agent_message',
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_call_id: input.id,
          content: input.result,
          is_error: input.isError,
        }],
        external_session_id: input.threadId ?? undefined,
      },
    ];
  }

  private buildResultEvent(input: {
    subtype: AgentResultEvent['subtype'];
    isError: boolean;
    result?: string;
    usage: Usage | null;
    durationMs: number;
    threadId: string | null;
  }): AgentResultEvent {
    return {
      type: 'agent_result',
      subtype: input.subtype,
      is_error: input.isError,
      duration_ms: input.durationMs,
      num_turns: 1,
      ...(input.result ? { result: input.result } : {}),
      usage: {
        input_tokens: usageInputTokens(input.usage),
        output_tokens: usageOutputTokens(input.usage),
      },
      external_session_id: input.threadId ?? undefined,
    };
  }

  private emitProjected(
    router: EventRouter,
    runId: string,
    panelId: string,
    sessionId: string,
    data: AgentStreamEvent,
  ): void {
    const legacyEvent = agentStreamEventToClaudeStreamEvent(data);
    router.emitForRun(runId, legacyEvent);
    this.emit('output', {
      panelId,
      sessionId,
      type: 'json',
      data: legacyEvent,
      timestamp: new Date(),
    });
  }

  private captureRunCodexThreadId(runId: string, threadId: string): void {
    try {
      this.db
        .prepare(
          `UPDATE workflow_runs
              SET claude_session_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND claude_session_id IS NULL`,
        )
        .run(threadId, runId);
    } catch (err) {
      this.logger?.warn(
        `[CodexSdkManager] failed to capture Codex thread id for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private resultTerminalError(event: AgentStreamEvent): string | null {
    if (event.type !== 'agent_result' || !event.is_error) return null;
    return event.result ?? 'Codex turn failed';
  }

  private displayModel(model: string | null | undefined): string {
    if (!model || model === 'auto' || model === 'default') return 'codex-default';
    return model;
  }

  private describeFileChange(
    item: Extract<ThreadItem, { type: 'file_change' }>,
  ): string {
    const files = item.changes.map((change) => `${change.kind} ${change.path}`).join('\n');
    return item.status === 'failed'
      ? `Failed to apply file changes:\n${files}`
      : `Applied file changes:\n${files}`;
  }

  private describeTodoList(
    item: Extract<ThreadItem, { type: 'todo_list' }>,
  ): string {
    return item.items
      .map((todo) => `${todo.completed ? '[x]' : '[ ]'} ${todo.text}`)
      .join('\n');
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
    if (keys.size === 0) {
      this.spawnKeysByPanelId.delete(panelId);
    }
  }
}
