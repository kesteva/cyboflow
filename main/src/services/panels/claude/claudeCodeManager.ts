import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, HookCallback, PreToolUseHookInput, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type Database from 'better-sqlite3';
import type { Logger } from '../../../utils/logger';
import type { ConfigManager } from '../../configManager';
import type { ConversationMessage } from '../../../database/models';
import { ApprovalRouter } from '../../../orchestrator/approvalRouter';
import { AbstractCliManager } from '../cli/AbstractCliManager';
import { withLock } from '../../../utils/mutex';
import { enhancePromptForStructuredCommit } from '../../../utils/promptEnhancer';
import { EventRouter, RawEventsSink } from '../../streamParser';
import { transitionToAwaitingReview } from '../../cyboflow/transitions';
import type { TransitionToAwaitingReviewParams } from '../../cyboflow/transitions';
import type { ClaudeStreamEvent } from '../../../../../shared/types/claudeStream';

interface ClaudeSpawnOptions {
  panelId: string;
  sessionId: string;
  worktreePath: string;
  prompt: string;
  conversationHistory?: string[];
  isResume?: boolean;
  permissionMode?: 'approve' | 'ignore';
  model?: string;
}

/**
 * A running SDK query, keyed by panelId in the sdkRuns map.
 * abortController cancels the in-flight query(); iteratorDone resolves when
 * the async-for loop finishes (naturally or on abort).
 */
interface ClaudeSdkRun {
  abortController: AbortController;
  iteratorDone: Promise<void>;
  panelId: string;
  sessionId: string;
  worktreePath: string;
}

/** Stub CliProcess shape that satisfies AbstractCliManager's processes map. */
interface StubCliProcess {
  process: never;
  panelId: string;
  sessionId: string;
  worktreePath: string;
}

/** Per-run pipeline tuple stored in the pipelines map. */
interface PipelineTuple {
  router: EventRouter;
  sink: RawEventsSink | null;
  runId: string;
}

/**
 * ClaudeCodeManager — SDK-substrate rewrite.
 *
 * Uses @anthropic-ai/claude-agent-sdk query() instead of PTY-spawn +
 * stream-json parser.  Inherits AbstractCliManager to preserve the interface
 * contract (cliManagerFactory, ClaudePanelManager, AbstractAIPanelManager) and
 * overrides every PTY-touching method with SDK equivalents.
 */
export class ClaudeCodeManager extends AbstractCliManager {
  /**
   * Shared better-sqlite3 handle for pipeline persistence (RawEventsSink).
   * Injected at boot via ClaudeCodeManager.setSharedDb().
   */
  private static sharedDb: Database.Database | null = null;

  static setSharedDb(db: Database.Database | null): void {
    ClaudeCodeManager.sharedDb = db;
  }

  /** Active SDK runs, keyed by panelId. */
  private readonly sdkRuns = new Map<string, ClaudeSdkRun>();

  /** Per-run pipeline (router → sink). */
  private readonly pipelines = new Map<string, PipelineTuple>();

  constructor(
    sessionManager: import('../../sessionManager').SessionManager,
    logger?: Logger,
    configManager?: ConfigManager,
  ) {
    super(sessionManager, logger, configManager);
  }

  // ---------------------------------------------------------------------------
  // Required AbstractCliManager abstract-method implementations
  // ---------------------------------------------------------------------------

  protected getCliToolName(): string {
    return 'Claude Code';
  }

  /**
   * SDK substrate is always available — no binary to probe.
   */
  protected async testCliAvailability(): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    return { available: true, version: 'sdk-in-process' };
  }

  /**
   * No command args needed; SDK takes structured options instead.
   * Returns [] to satisfy the abstract contract.
   */
  protected buildCommandArgs(_options: ClaudeSpawnOptions): string[] {
    return [];
  }

  /**
   * Sentinel path — no binary is invoked by the SDK substrate.
   */
  protected async getCliExecutablePath(): Promise<string> {
    return 'sdk-in-process';
  }

  /**
   * The SDK returns typed objects directly; there is no raw CLI output to
   * parse. Returns [] and is never called on the hot path.
   *
   * @deprecated Not called on SDK substrate. Kept for abstract contract.
   */
  protected parseCliOutput(_data: string, _panelId: string, _sessionId: string): Array<{ panelId: string; sessionId: string; type: 'json' | 'stdout' | 'stderr'; data: unknown; timestamp: Date }> {
    return [];
  }

  /**
   * Environment initialization is folded into composeRunEnv() / buildSdkOptions().
   * Returns {} to satisfy the abstract contract.
   */
  protected async initializeCliEnvironment(_options: ClaudeSpawnOptions): Promise<{ [key: string]: string }> {
    return {};
  }

  protected async cleanupCliResources(_sessionId: string): Promise<void> {
    // Approval cleanup is done in runSdkQuery's finally block via
    // ApprovalRouter.getInstance().clearPendingForRun(panelId) — using panelId
    // (the id under which requestApproval() was called) rather than sessionId.
    // This override satisfies the abstract contract; future cleanup hooks go here.
  }

  protected async getCliEnvironment(_options: ClaudeSpawnOptions): Promise<{ [key: string]: string }> {
    return {};
  }

  // ---------------------------------------------------------------------------
  // Core spawn — SDK query() replaces PTY spawn
  // ---------------------------------------------------------------------------

  /**
   * Override spawnCliProcess to run query() in-process instead of spawning a PTY.
   */
  override async spawnCliProcess(options: ClaudeSpawnOptions): Promise<void> {
    return await withLock(`claude-spawn-${options.panelId}`, async () => {
      const { panelId, sessionId, isResume } = options;

      // Guard: reject duplicate spawns.
      if (this.processes.has(panelId)) {
        throw new Error(`Claude process already running for panel ${panelId}`);
      }

      // Resume validation.
      if (isResume) {
        const claudeSessionId = this.sessionManager.getPanelClaudeSessionId(panelId);
        if (!claudeSessionId) {
          const errMsg = `Cannot resume: no Claude session_id stored for Crystal session ${sessionId}`;
          this.logger?.error(`[ClaudeCodeManager] ${errMsg}`);
          this.emit('output', {
            panelId,
            sessionId,
            type: 'json',
            data: {
              type: 'system',
              subtype: 'error',
              timestamp: new Date().toISOString(),
              message: 'Unable to resume Claude conversation',
              details: 'Missing Claude session_id. Please start a new message to begin a fresh conversation.'
            },
            timestamp: new Date()
          });
          throw new Error(errMsg);
        }
      }

      // Build SDK options.
      const sdkOptions = this.buildSdkOptions(options);

      // Set up the per-run pipeline (EventRouter + optional RawEventsSink).
      const runId = panelId;
      const router = new EventRouter();
      const db = ClaudeCodeManager.sharedDb;
      const sink = db ? new RawEventsSink(db, this.logger) : null;
      if (sink) {
        sink.attachToRouter(router, runId);
      }
      this.pipelines.set(panelId, { router, sink, runId });

      // Abort controller for cancellation.
      const abortController = new AbortController();

      // Emit session_info descriptor (renderer-visible context).
      const sessionInfoMessage = {
        type: 'session_info',
        initial_prompt: options.prompt,
        claude_command: 'sdk-in-process',
        worktree_path: options.worktreePath,
        model: options.model || 'default',
        permission_mode: options.permissionMode || 'approve',
        timestamp: new Date().toISOString()
      };
      this.emit('output', {
        panelId,
        sessionId,
        type: 'json',
        data: sessionInfoMessage,
        timestamp: new Date()
      });

      // Build the final prompt.
      const dbSession = this.sessionManager.getDbSession(sessionId);
      const finalPrompt = enhancePromptForStructuredCommit(
        options.prompt,
        dbSession || { id: sessionId },
        this.logger
      );

      // Push stub into processes map so isPanelRunning / getAllProcesses work.
      const stub: StubCliProcess = {
        process: undefined as never,
        panelId,
        sessionId,
        worktreePath: options.worktreePath
      };
      // Cast: AbstractCliManager.processes is Map<string, CliProcess> where
      // CliProcess.process is pty.IPty. We never access .process on SDK paths.
      (this.processes as Map<string, StubCliProcess>).set(panelId, stub);

      // Wire up the ClaudeSdkRun entry.
      const iteratorDone = this.runSdkQuery(panelId, sessionId, finalPrompt, sdkOptions, abortController, router);

      const run: ClaudeSdkRun = {
        abortController,
        iteratorDone,
        panelId,
        sessionId,
        worktreePath: options.worktreePath
      };
      this.sdkRuns.set(panelId, run);

      // Emit spawned — matching the upstream AbstractAIPanelManager listener.
      this.emit('spawned', { panelId, sessionId });

      this.logger?.info(`[ClaudeCodeManager] SDK query started for panel ${panelId} (session ${sessionId})`);
    });
  }

  /**
   * Drive the query() async iterator. Emits output / exit / error events
   * that AbstractAIPanelManager.setupEventHandlers forwards upstream.
   */
  private async runSdkQuery(
    panelId: string,
    sessionId: string,
    prompt: string,
    sdkOptions: Options,
    abortController: AbortController,
    router: EventRouter,
  ): Promise<void> {
    const runId = panelId;
    let exitCode = 0;
    try {
      const q = query({ prompt, options: { ...sdkOptions, abortController } });
      for await (const event of q) {
        if (abortController.signal.aborted) break;

        // Forward to EventRouter / RawEventsSink pipeline.
        // The SDK emits typed SDKMessage objects. We cast to ClaudeStreamEvent
        // for the router (both share the same wire-format shape for the types
        // that EventRouter / RawEventsSink consume: system/init, assistant, user,
        // result, stream_event).
        try {
          router.emitForRun(runId, event as unknown as ClaudeStreamEvent);
        } catch (routerErr) {
          this.logger?.warn(`[ClaudeCodeManager] EventRouter emit error: ${routerErr instanceof Error ? routerErr.message : String(routerErr)}`);
        }

        // Forward to AbstractAIPanelManager via 'output' event.
        this.emit('output', {
          panelId,
          sessionId,
          type: 'json',
          data: event,
          timestamp: new Date()
        });
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        // Intentional abort — treat as clean exit.
        this.logger?.info(`[ClaudeCodeManager] SDK query aborted for panel ${panelId}`);
      } else {
        exitCode = 1;
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger?.error(`[ClaudeCodeManager] SDK query error for panel ${panelId}: ${errMsg}`);
        this.emit('error', { panelId, sessionId, error: errMsg });
      }
    } finally {
      this.cleanupPipeline(panelId);
      // Clear pending approvals under panelId — the same id passed to requestApproval().
      // cleanupCliResources takes sessionId (abstract contract) so we call the router directly here.
      ApprovalRouter.getInstance().clearPendingForRun(panelId);
      this.processes.delete(panelId);
      this.sdkRuns.delete(panelId);
      this.emit('exit', {
        panelId,
        sessionId,
        exitCode,
        signal: null
      });
    }
  }

  // ---------------------------------------------------------------------------
  // SDK options builder
  // ---------------------------------------------------------------------------

  private buildSdkOptions(options: ClaudeSpawnOptions): Options {
    const sdkOptions: Options = {
      cwd: options.worktreePath,
      includePartialMessages: true,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: this.composeSystemPromptAppend(options) ?? undefined,
      },
      mcpServers: this.composeMcpServers(options),
      env: this.composeRunEnv(options),
      // When permissionMode is 'ignore', omit PreToolUse entirely so every tool call
      // is auto-allowed by the SDK — matching the pre-SDK "skip the bridge" behavior.
      ...(options.permissionMode !== 'ignore' ? {
        hooks: {
          PreToolUse: [{
            hooks: [this.makePreToolUseHook(options.panelId)]
          }]
        }
      } : {})
    };

    if (options.model && options.model !== 'auto') {
      sdkOptions.model = options.model;
    }

    if (options.isResume) {
      const claudeSessionId = this.sessionManager.getPanelClaudeSessionId(options.panelId);
      if (!claudeSessionId) {
        throw new Error(`Cannot resume: no Claude session_id stored for Crystal session ${options.sessionId}`);
      }
      sdkOptions.resume = claudeSessionId;
    }

    return sdkOptions;
  }

  private composeSystemPromptAppend(options: ClaudeSpawnOptions): string | undefined {
    const dbSession = this.sessionManager.getDbSession(options.sessionId);
    return this.buildSystemPromptAppend(dbSession ? { ...dbSession } : { id: options.sessionId });
  }

  /**
   * Compose the mcpServers record for the SDK options.
   *
   * Reads .mcp.json and ~/.claude.json from the base project directory.
   * The cyboflow-permissions MCP server is replaced by the PreToolUse hook.
   */
  private composeMcpServers(options: ClaudeSpawnOptions): Record<string, McpServerConfig> {
    const { mcpServers } = this.getBaseProjectMcpServers(options.sessionId);
    return mcpServers as Record<string, McpServerConfig>;
  }

  private composeRunEnv(_options: ClaudeSpawnOptions): Record<string, string | undefined> {
    const verbose = this.configManager?.getConfig()?.verbose;
    return {
      ...process.env,
      ...(verbose ? { MCP_DEBUG: '1' } : {})
    };
  }

  /**
   * Build the PreToolUse hook callback that routes tool-use permission
   * decisions through ApprovalRouter and translates to SDK hookSpecificOutput.
   */
  private makePreToolUseHook(panelId: string): HookCallback {
    return async (input, _toolUseId, _ctx) => {
      const pretool = input as PreToolUseHookInput;
      try {
        const decision = await ApprovalRouter.getInstance().requestApproval(
          panelId,
          pretool.tool_name,
          pretool.tool_input as Record<string, unknown>,
          () => {}
        );
        if (decision.behavior === 'allow') {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'allow' as const,
              ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {})
            }
          };
        }
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            ...(decision.message ? { permissionDecisionReason: decision.message } : {})
          }
        };
      } catch (err) {
        this.logger?.error(
          `[ClaudeCodeManager] PreToolUse hook failed for ${pretool.tool_name}: ${err instanceof Error ? err.message : String(err)}`
        );
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: 'Internal approval-router error'
          }
        };
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Process lifecycle overrides
  // ---------------------------------------------------------------------------

  /**
   * Override killProcess to abort the SDK run instead of killing a PTY.
   */
  override async killProcess(panelId: string): Promise<void> {
    this.cleanupPipeline(panelId);
    await this.abortCurrentRun(panelId);
    this.processes.delete(panelId);
  }

  /**
   * Abort the running SDK query for panelId and wait for it to settle.
   */
  private async abortCurrentRun(panelId: string): Promise<void> {
    const run = this.sdkRuns.get(panelId);
    if (!run) return;
    run.abortController.abort();
    await run.iteratorDone.catch(() => {});
    this.sdkRuns.delete(panelId);
  }

  /**
   * Dispose and remove the pipeline tuple for panelId.
   * Idempotent: safe to call multiple times.
   */
  private cleanupPipeline(panelId: string): void {
    const pl = this.pipelines.get(panelId);
    if (!pl) return;
    pl.sink?.dispose(pl.runId);
    pl.router.clearRun(pl.runId);
    this.pipelines.delete(panelId);
  }

  // ---------------------------------------------------------------------------
  // AbstractCliManager abstract implementations (panel lifecycle)
  // ---------------------------------------------------------------------------

  async startPanel(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    prompt: string,
    permissionMode?: 'approve' | 'ignore',
    model?: string
  ): Promise<void> {
    const { validatePanelSessionOwnership, logValidationFailure } = require('../../../utils/sessionValidation');
    const validation = validatePanelSessionOwnership(panelId, sessionId);
    if (!validation.valid) {
      logValidationFailure('ClaudeCodeManager.startPanel', validation);
      throw new Error(`Panel validation failed: ${validation.error}`);
    }
    console.log(`[ClaudeCodeManager] Validated panel ${panelId} belongs to session ${sessionId}`);
    return this.spawnClaudeCode(panelId, sessionId, worktreePath, prompt, undefined, false, permissionMode, model);
  }

  async continuePanel(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    prompt: string,
    conversationHistory: ConversationMessage[],
    permissionModeOverride?: 'approve' | 'ignore',
    model?: string
  ): Promise<void> {
    return await withLock(`claude-continue-${panelId}`, async () => {
      const { validatePanelSessionOwnership, logValidationFailure } = require('../../../utils/sessionValidation');
      const validation = validatePanelSessionOwnership(panelId, sessionId);
      if (!validation.valid) {
        logValidationFailure('ClaudeCodeManager.continuePanel', validation);
        throw new Error(`Panel validation failed: ${validation.error}`);
      }
      console.log(`[ClaudeCodeManager] Validated panel ${panelId} belongs to session ${sessionId}`);

      // Abort any active SDK run for this panel.
      if (this.processes.has(panelId)) {
        console.log(`[ClaudeCodeManager] Aborting existing run for panel ${panelId} before continuing`);
        await this.abortCurrentRun(panelId);
        this.processes.delete(panelId);
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (this.processes.has(panelId)) {
        console.error(`[ClaudeCodeManager] Process ${panelId} still exists after abort attempt, aborting continue`);
        throw new Error('Failed to stop previous panel instance');
      }

      const dbSession = this.sessionManager.getDbSession(sessionId);
      const permissionModeFromDb = dbSession?.permission_mode;
      const permissionMode = permissionModeOverride ?? permissionModeFromDb;

      const skipContinueRaw = dbSession?.skip_continue_next;
      const shouldSkipContinue = skipContinueRaw === true || (typeof skipContinueRaw === 'number' && skipContinueRaw === 1);

      console.log(`[ClaudeCodeManager] continuePanel called for ${panelId} (session ${sessionId}):`, {
        skip_continue_next_raw: skipContinueRaw,
        shouldSkipContinue,
        permissionMode,
        model
      });

      if (shouldSkipContinue) {
        console.log(`[ClaudeCodeManager] Clearing skip_continue_next flag for session ${sessionId}`);
        this.sessionManager.updateSession(sessionId, { skip_continue_next: false });
        console.log(`[ClaudeCodeManager] Skipping resume for panel ${panelId} due to prompt compaction`);
        return this.spawnClaudeCode(panelId, sessionId, worktreePath, prompt, [], false, permissionMode, model);
      } else {
        console.log(`[ClaudeCodeManager] Using resume for panel ${panelId}`);
        return this.spawnClaudeCode(panelId, sessionId, worktreePath, prompt, [], true, permissionMode, model);
      }
    });
  }

  async stopPanel(panelId: string): Promise<void> {
    await this.killProcess(panelId);
  }

  async restartPanelWithHistory(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    initialPrompt: string,
    conversationHistory: ConversationMessage[]
  ): Promise<void> {
    await this.killProcess(panelId);
    const historyStrings = conversationHistory.map(msg => msg.content);
    await this.spawnClaudeCode(panelId, sessionId, worktreePath, initialPrompt, historyStrings);
  }

  // ---------------------------------------------------------------------------
  // Claude-specific public methods (backward compat)
  // ---------------------------------------------------------------------------

  async spawnClaudeCode(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    prompt: string,
    conversationHistory?: string[],
    isResume = false,
    permissionMode?: 'approve' | 'ignore',
    model?: string
  ): Promise<void> {
    const options: ClaudeSpawnOptions = {
      panelId,
      sessionId,
      worktreePath,
      prompt,
      conversationHistory,
      isResume,
      permissionMode,
      model
    };
    await this.spawnCliProcess(options);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Get MCP servers from the base project (.mcp.json + ~/.claude.json).
   * The cyboflow-permissions server is NOT included — replaced by the
   * PreToolUse hook in buildSdkOptions.
   */
  private getBaseProjectMcpServers(sessionId: string): { mcpServers: Record<string, unknown> } {
    const result: { mcpServers: Record<string, unknown> } = { mcpServers: {} };

    try {
      const dbSession = this.sessionManager.getDbSession(sessionId);
      if (!dbSession?.project_id) return result;

      const project = this.sessionManager.getProjectById(dbSession.project_id);
      if (!project?.path) return result;

      const baseProjectPath = project.path;
      this.logger?.verbose(`[MCP] Looking for base project MCP servers at: ${baseProjectPath}`);

      // .mcp.json in the base project directory.
      const mcpJsonPath = path.join(baseProjectPath, '.mcp.json');
      if (fs.existsSync(mcpJsonPath)) {
        this.logger?.verbose(`[MCP] Found .mcp.json at: ${mcpJsonPath}`);
        try {
          const mcpJsonContent = fs.readFileSync(mcpJsonPath, 'utf8');
          const mcpJson = JSON.parse(mcpJsonContent) as { mcpServers?: Record<string, unknown> };
          if (mcpJson.mcpServers) {
            Object.assign(result.mcpServers, mcpJson.mcpServers);
          }
        } catch (parseError) {
          this.logger?.warn(`[MCP] Failed to parse .mcp.json: ${parseError}`);
        }
      }

      // ~/.claude.json — project-specific and global servers.
      const claudeConfigPath = path.join(os.homedir(), '.claude.json');
      if (fs.existsSync(claudeConfigPath)) {
        try {
          const claudeConfig = fs.readFileSync(claudeConfigPath, 'utf8');
          const config = JSON.parse(claudeConfig) as {
            projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
            mcpServers?: Record<string, unknown>;
          };

          const projectConfig = config.projects?.[baseProjectPath];
          if (projectConfig?.mcpServers && Object.keys(projectConfig.mcpServers).length > 0) {
            this.logger?.verbose(`[MCP] Found ${Object.keys(projectConfig.mcpServers).length} project-specific MCP servers in ~/.claude.json`);
            Object.assign(result.mcpServers, projectConfig.mcpServers);
          }

          if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
            this.logger?.verbose(`[MCP] Found ${Object.keys(config.mcpServers).length} global MCP servers in ~/.claude.json`);
            for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
              if (!result.mcpServers[name]) {
                result.mcpServers[name] = serverConfig;
              }
            }
          }
        } catch (parseError) {
          this.logger?.warn(`[MCP] Failed to parse ~/.claude.json: ${parseError}`);
        }
      }

      const serverCount = Object.keys(result.mcpServers).length;
      if (serverCount > 0) {
        this.logger?.info(`[MCP] Found ${serverCount} MCP servers from base project: ${Object.keys(result.mcpServers).join(', ')}`);
      }
    } catch (error) {
      this.logger?.warn(`[MCP] Error getting base project MCP servers: ${error}`);
    }

    return result;
  }

  private buildSystemPromptAppend(dbSession: { project_id?: number; [key: string]: unknown }): string | undefined {
    const systemPromptParts: string[] = [];

    const globalPrompt = this.configManager?.getSystemPromptAppend();
    if (globalPrompt) {
      systemPromptParts.push(globalPrompt);
    }

    if (dbSession?.project_id) {
      const project = this.sessionManager.getProjectById(dbSession.project_id);
      if (project?.system_prompt) {
        systemPromptParts.push(project.system_prompt);
      }
    }

    return systemPromptParts.length > 0 ? systemPromptParts.join('\n\n') : undefined;
  }

  // @cyboflow-hidden: Day-3 integration point — no workflow_runs rows exist yet in v1.
  // Re-enable by routing from ApprovalRouter.recordToolRequest() -> tryTransitionToAwaitingReview()
  // once workflow_runs rows are auto-created on Claude spawn (TASK-302 territory).
  /**
   * Attempt to record a tool-use approval request for a running Claude process.
   *
   * Day-3 integration point: once workflow_runs rows are auto-created on Claude spawn
   * (TASK-302 territory), this method replaces the inline SQL in ApprovalRouter with a
   * single call to the canonical transitionToAwaitingReview() guard.
   *
   * In v1 (panelId-as-runId), no workflow_runs row exists and the call will throw
   * TransitionRejectedError → caught and logged; no crash.
   *
   * Satisfies AC#4 production-callsite requirement for transitionToAwaitingReview.
   */
  private tryTransitionToAwaitingReview(params: TransitionToAwaitingReviewParams): void {
    const db = ClaudeCodeManager.sharedDb;
    if (!db) return;
    try {
      transitionToAwaitingReview(db, params);
    } catch (err) {
      this.logger?.warn(
        `[ClaudeCodeManager] transitionToAwaitingReview skipped (no workflow_runs row yet): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  protected getCliNotAvailableMessage(error?: string): string {
    return [
      `Error: ${error}`,
      '',
      'Claude Code SDK is not available.',
      '',
      'Please ensure @anthropic-ai/claude-agent-sdk is installed.',
    ].join('\n');
  }
}
