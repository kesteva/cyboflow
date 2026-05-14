import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import type Database from 'better-sqlite3';
import type { Logger } from '../../../utils/logger';
import type { ConfigManager } from '../../configManager';
import type { ConversationMessage } from '../../../database/models';
import { testClaudeCodeAvailability, testClaudeCodeInDirectory } from '../../../utils/claudeCodeTest';
import { findExecutableInPath } from '../../../utils/shellPath';
import { ApprovalRouter } from '../../../orchestrator/approvalRouter';
import { getCrystalDirectory } from '../../../utils/crystalDirectory';
import { findNodeExecutable } from '../../../utils/nodeFinder';
import { AbstractCliManager } from '../cli/AbstractCliManager';
import { withLock } from '../../../utils/mutex';
import { enhancePromptForStructuredCommit } from '../../../utils/promptEnhancer';
import { ClaudeStreamParser, EventRouter, RawEventsSink, CompletionDetector } from '../../streamParser';
import type { CompletionPayload, ForcedPayload } from '../../streamParser';
import { assertTransitionAllowed } from '../../cyboflow/stateMachine';
import { transitionToAwaitingReview } from '../../cyboflow/transitions';
import type { TransitionToAwaitingReviewParams } from '../../cyboflow/transitions';

// Extend global object for MCP configuration storage  
interface GlobalMcpStorage {
  [key: string]: string | undefined;
}
declare const globalThis: GlobalMcpStorage;

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

interface ClaudeCodeProcess {
  process: import('@homebridge/node-pty-prebuilt-multiarch').IPty;
  panelId: string;
  sessionId: string;
  worktreePath: string;
}

/** Per-run pipeline tuple stored in the pipelines map. */
interface PipelineTuple {
  parser: ClaudeStreamParser;
  router: EventRouter;
  sink: RawEventsSink | null;
  detector: CompletionDetector;
  runId: string;
}

/**
 * ClaudeCodeManager - Manages Claude Code CLI processes
 * Extends AbstractCliManager for common CLI functionality
 */
export class ClaudeCodeManager extends AbstractCliManager {
  /**
   * Shared better-sqlite3 handle for pipeline persistence (RawEventsSink).
   * Injected at boot via ClaudeCodeManager.setSharedDb() from the IPC handler
   * once DatabaseService is initialized.  Null until injection; RawEventsSink
   * is silently skipped when null (no raw_events rows written, safe degraded mode).
   */
  private static sharedDb: Database.Database | null = null;

  /**
   * Wire the shared DB handle.  Called once per app lifecycle from claudePanel.ts
   * after DatabaseService.initialize() completes.
   */
  static setSharedDb(db: Database.Database | null): void {
    ClaudeCodeManager.sharedDb = db;
  }

  /** Per-spawned-run parser→router→sink→detector pipeline, keyed by panelId. */
  private readonly pipelines = new Map<string, PipelineTuple>();

  constructor(
    sessionManager: import('../../sessionManager').SessionManager,
    logger?: Logger,
    configManager?: ConfigManager,
    private permissionIpcPath?: string | null
  ) {
    super(sessionManager, logger, configManager);
  }

  // Abstract method implementations

  protected getCliToolName(): string {
    return 'Claude Code';
  }

  protected async testCliAvailability(customPath?: string): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    return await testClaudeCodeAvailability(customPath);
  }

  protected buildCommandArgs(options: ClaudeSpawnOptions & { mcpConfigPath?: string | null }): string[] {
    const { sessionId, prompt, isResume, permissionMode, model, mcpConfigPath } = options;
    
    // Get session data for Claude-specific features
    const dbSession = this.sessionManager.getDbSession(sessionId);
    
    // Build base arguments
    const args = ['--verbose', '--output-format', 'stream-json'];

    // Add model argument if specified and not 'auto'
    if (model && model !== 'auto') {
      args.push('--model', model);
      this.logger?.verbose(`Using model: ${model}`);
    } else if (model === 'auto') {
      this.logger?.verbose(`Using auto model selection (Claude Code's default)`);
    }

    // Log commit mode for debugging (but don't pass to Claude Code)
    if (dbSession?.commit_mode) {
      this.logger?.verbose(`Session uses commit mode: ${dbSession.commit_mode}`);
    }

    // Handle permission mode
    const defaultMode = this.configManager?.getConfig()?.defaultPermissionMode || 'approve';
    const effectiveMode = permissionMode || defaultMode;

    if (effectiveMode === 'ignore') {
      // Cyboflow mandates approve mode — ignore mode disables the review queue.
      throw new Error('[ClaudeCodeManager] Cyboflow runs require approve mode; --dangerously-skip-permissions is not allowed.');
    } else if (effectiveMode === 'approve' && this.permissionIpcPath) {
      // If MCP config path is provided, we'll add the MCP args
      // Otherwise just log that MCP will be set up
      if (!mcpConfigPath) {
        this.logger?.verbose(`Will set up MCP for permission approval mode`);
      }
    } else {
      // approve mode was requested but permissionIpcPath is not configured — hard error.
      throw new Error('[ClaudeCodeManager] approve mode requested but permissionIpcPath is not configured; cannot spawn Claude.');
    }

    // Handle resume and prompt logic
    if (isResume) {
      // Get Claude's session ID for this panel if available
      const claudeSessionId = this.sessionManager.getPanelClaudeSessionId(options.panelId);

      if (claudeSessionId) {
        // Use --resume flag with Claude's actual session ID
        args.push('--resume', claudeSessionId);
        console.log(`[ClaudeCodeManager] Resuming Claude session ${claudeSessionId} for Crystal session ${sessionId}`);
      } else {
        // Do not resume without explicit ID; this will be handled as an error
        throw new Error(`Cannot resume: no Claude session_id stored for Crystal session ${sessionId}`);
      }
      // If a new prompt is provided, add it
      if (prompt && prompt.trim()) {
        const finalPrompt = enhancePromptForStructuredCommit(prompt, dbSession || { id: sessionId }, this.logger);
        args.push('-p', finalPrompt);
      }
    } else {
      // Initial prompt for new session
      let finalPrompt = enhancePromptForStructuredCommit(prompt, dbSession || { id: sessionId }, this.logger);

      // Add system prompts for new sessions
      const systemPromptAppend = this.buildSystemPromptAppend(dbSession ? { ...dbSession, project_id: dbSession.project_id } : { id: sessionId });
      if (systemPromptAppend) {
        finalPrompt = `${finalPrompt}\n\n${systemPromptAppend}`;
      }

      args.push('-p', finalPrompt);
    }

    // Add MCP configuration if provided
    if (mcpConfigPath) {
      args.push('--mcp-config', mcpConfigPath);

      // Only add permission-specific flags if Crystal's permission server is included
      // (which happens when permission mode is 'approve')
      const defaultMode = this.configManager?.getConfig()?.defaultPermissionMode || 'approve';
      const effectiveMode = permissionMode || defaultMode;
      if (effectiveMode === 'approve' && this.permissionIpcPath) {
        args.push('--permission-prompt-tool', 'mcp__cyboflow-permissions__approve_permission', '--allowedTools', 'mcp__cyboflow-permissions__approve_permission');
      }
    }

    return args;
  }

  protected async getCliExecutablePath(): Promise<string> {
    // Use custom claude path if configured, otherwise find it in PATH
    let claudeCommand = this.configManager?.getConfig()?.claudeExecutablePath;
    if (claudeCommand) {
      this.logger?.info(`[ClaudeManager] Using custom Claude executable path: ${claudeCommand}`);
      return claudeCommand;
    } else {
      this.logger?.verbose(`[ClaudeManager] No custom Claude path configured, searching in PATH...`);
      const foundPath = findExecutableInPath('claude');
      if (!foundPath) {
        throw new Error('Claude Code CLI not found in PATH. Please ensure claude is installed and in your PATH.');
      }
      return foundPath;
    }
  }

  protected parseCliOutput(data: string, panelId: string, sessionId: string): Array<{ panelId: string; sessionId: string; type: 'json' | 'stdout' | 'stderr'; data: unknown; timestamp: Date }> {
    const events: Array<{ panelId: string; sessionId: string; type: 'json' | 'stdout' | 'stderr'; data: unknown; timestamp: Date }> = [];

    // Feed the raw line through the pipeline parser (non-destructive: also feeds EventRouter/RawEventsSink).
    // The existing emit-as-json path below is preserved in parallel until Day-3 migrates the
    // renderer to consume from EventRouter via tRPC.
    const pipeline = this.pipelines.get(panelId);
    if (pipeline) {
      pipeline.parser.feed(data);
    }

    try {
      const jsonMessage = JSON.parse(data.trim());
      this.logger?.verbose(`JSON message from panel ${panelId} (session ${sessionId}): ${JSON.stringify(jsonMessage)}`);

      // Check for system init message with available slash commands
      if (jsonMessage.type === 'system' && jsonMessage.subtype === 'init') {
        // Check if SlashCommand tool is available
        if (jsonMessage.tools && Array.isArray(jsonMessage.tools)) {
          const hasSlashCommandTool = jsonMessage.tools.includes('SlashCommand');
          console.log(`[slash-debug] SlashCommand tool ${hasSlashCommandTool ? 'IS' : 'IS NOT'} available in this session`);
        }

        // Log available slash commands
        if (jsonMessage.slash_commands) {
          const slashCommands = jsonMessage.slash_commands;
          console.log(`[slash-debug] Claude Code initialized with slash commands:`, slashCommands);
          console.log(`[slash-debug] Available commands: ${Array.isArray(slashCommands) ? slashCommands.join(', ') : 'none'}`);
        }
      }

      // Check for SlashCommand tool usage in assistant messages
      if (jsonMessage.type === 'assistant' && jsonMessage.message?.content) {
        const content = jsonMessage.message.content;
        if (Array.isArray(content)) {
          const slashCommandTools = content.filter((item: { type?: string; name?: string; input?: { command?: string } }) =>
            item.type === 'tool_use' && item.name === 'SlashCommand'
          );

          if (slashCommandTools.length > 0) {
            slashCommandTools.forEach((tool: { input?: { command?: string } }) => {
              const command = tool.input?.command || 'unknown';
              console.log(`[slash-debug] Detected SlashCommand in assistant message: ${command}`);
              console.log(`[slash-debug] Full tool data:`, JSON.stringify(tool, null, 2));
            });
          }
        }
      }

      // Emit JSON message - terminal formatting will be done on the fly
      events.push({
        panelId,
        sessionId,
        type: 'json',
        data: jsonMessage,
        timestamp: new Date()
      });
    } catch (error) {
      // If not valid JSON, treat as regular output
      this.logger?.verbose(`Raw output from panel ${panelId} (session ${sessionId}): ${data.substring(0, 200)}`);

      // Check if this looks like an error message
      const isError = data.includes('ERROR') ||
                    data.includes('Error:') ||
                    data.includes('error:') ||
                    data.includes('Command failed:') ||
                    data.includes('aborted') ||
                    data.includes('fatal:');

      events.push({
        panelId,
        sessionId,
        type: isError ? 'stderr' : 'stdout',
        data,
        timestamp: new Date()
      });
    }

    return events;
  }

  /**
   * Override setupProcessHandlers to wire the per-run pipeline (parser→router→sink→detector).
   *
   * After registering the base-class handlers (which process the PTY buffer and call
   * parseCliOutput on each line), we attach a second onExit listener that fires the three
   * CompletionDetector gates in the correct order:
   *
   *   1. parser.flush()              — drain any partial trailing line
   *   2. detector.signalStdoutEof()  — stdout stream has ended
   *   3. detector.signalParserDrained() — parser queue is empty
   *   4. detector.signalChildExited() — process is gone
   *
   * The CompletionDetector then emits 'complete' (all gates) or 'forced' (watchdog timeout),
   * triggering cleanupPipeline().
   */
  protected override setupProcessHandlers(
    ptyProcess: import('@homebridge/node-pty-prebuilt-multiarch').IPty,
    panelId: string,
    sessionId: string,
  ): void {
    // --- Create the pipeline for this run ---
    // Use panelId as the runId placeholder (Day-3 will backfill with the real workflow_runs.id).
    const runId = panelId;
    const router = new EventRouter();
    const parser = new ClaudeStreamParser(runId, router, this.logger);
    const db = ClaudeCodeManager.sharedDb;
    const sink = db ? new RawEventsSink(db, this.logger) : null;
    if (sink) {
      sink.attachToRouter(router, runId);
    }
    const detector = new CompletionDetector(runId, 30_000, this.logger);

    this.pipelines.set(panelId, { parser, router, sink, detector, runId });

    // --- Base-class handlers (calls parseCliOutput on each buffered line, handles exit) ---
    super.setupProcessHandlers(ptyProcess, panelId, sessionId);

    // --- Secondary exit handler: fire CompletionDetector gates after buffer is flushed ---
    // The base-class handler has already drained the PTY buffer via parseCliOutput by the
    // time this secondary handler executes (node-pty fires handlers in registration order).
    ptyProcess.onExit(() => {
      const pl = this.pipelines.get(panelId);
      if (!pl) return;
      pl.parser.flush();              // drain any partial trailing line
      pl.detector.signalStdoutEof();  // buffer + stdout are exhausted
      pl.detector.signalParserDrained(); // parser queue is now empty
      pl.detector.signalChildExited(); // process has exited
    });

    // --- Completion/forced listeners ---
    detector.on('complete', (payload: CompletionPayload) => {
      // Pre-flight: verify the 'running -> completed' transition is legal before cleanup.
      // Fail-soft: no workflow_runs row exists yet (panelId placeholder), so we catch any error.
      try {
        assertTransitionAllowed('running', 'completed', payload.runId);
      } catch (err) {
        this.logger?.warn(
          `[ClaudeCodeManager] assertTransitionAllowed check failed for run ${payload.runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.cleanupPipeline(panelId);
    });

    detector.on('forced', (_payload: ForcedPayload) => {
      this.cleanupPipeline(panelId);
    });
  }

  /**
   * Dispose and remove the pipeline tuple for a given panelId.
   *
   * Called on CompletionDetector 'complete', 'forced', and killProcess.
   * Idempotent: safe to call multiple times.
   */
  private cleanupPipeline(panelId: string): void {
    const pl = this.pipelines.get(panelId);
    if (!pl) return;
    pl.sink?.dispose(pl.runId);
    pl.router.clearRun(pl.runId);
    pl.detector.dispose();
    this.pipelines.delete(panelId);
  }

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
        `[ClaudeCodeManager] transitionToAwaitingReview skipped (no workflow_runs row yet): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  protected async initializeCliEnvironment(options: ClaudeSpawnOptions): Promise<{ [key: string]: string }> {
    const { sessionId, permissionMode } = options;
    
    // Get basic system environment
    const systemEnv = await this.getSystemEnvironment();
    
    // Initialize environment with MCP-specific variables
    // Socket path is passed via argv[3] to the bridge, not env vars (see cyboflowPermissionBridge.ts argv parsing).
    const env: { [key: string]: string } = {
      // Add debug mode for MCP if verbose logging is enabled
      ...(this.configManager?.getConfig()?.verbose ? { MCP_DEBUG: '1' } : {})
    };

    // Set up MCP configuration if permission approval is requested
    const defaultMode = this.configManager?.getConfig()?.defaultPermissionMode || 'approve';
    const effectiveMode = permissionMode || defaultMode;

    if (effectiveMode === 'approve' && this.permissionIpcPath) {
      await this.setupMcpConfiguration(sessionId, env);
    }

    return env;
  }

  protected async cleanupCliResources(sessionId: string): Promise<void> {
    // Clear any pending approvals for this run.
    // Full body (deny in-flight approvals, write DB rows, close sockets) lands in TASK-304.
    ApprovalRouter.getInstance().clearPendingForRun(sessionId);

    // Clean up MCP config file if it exists
    const mcpConfigPath = globalThis[`mcp_config_${sessionId}`];
    if (mcpConfigPath && fs.existsSync(mcpConfigPath)) {
      setTimeout(() => {
        try {
          if (fs.existsSync(mcpConfigPath)) {
            fs.unlinkSync(mcpConfigPath);
            this.logger?.verbose(`[MCP] Cleaned up config file: ${mcpConfigPath}`);
          }
          delete globalThis[`mcp_config_${sessionId}`];
        } catch (error) {
          this.logger?.error(`Failed to delete MCP config file:`, error instanceof Error ? error : undefined);
        }
      }, 5000); // 5 second delay
    }

    // Clean up base project MCP config file if it exists (not .mcp.json from project)
    const baseConfigPath = globalThis[`mcp_base_config_${sessionId}`];
    if (baseConfigPath && fs.existsSync(baseConfigPath)) {
      setTimeout(() => {
        try {
          if (fs.existsSync(baseConfigPath)) {
            fs.unlinkSync(baseConfigPath);
            this.logger?.verbose(`[MCP] Cleaned up base project config file: ${baseConfigPath}`);
          }
          delete globalThis[`mcp_base_config_${sessionId}`];
        } catch (error) {
          this.logger?.error(`Failed to delete base project MCP config file:`, error instanceof Error ? error : undefined);
        }
      }, 5000); // 5 second delay
    }

    // Clean up temporary MCP script file if it exists
    const mcpScriptPath = globalThis[`mcp_script_${sessionId}`];
    if (mcpScriptPath && fs.existsSync(mcpScriptPath)) {
      setTimeout(() => {
        try {
          if (fs.existsSync(mcpScriptPath)) {
            fs.unlinkSync(mcpScriptPath);
            this.logger?.verbose(`[MCP] Cleaned up script file: ${mcpScriptPath}`);
          }
          delete globalThis[`mcp_script_${sessionId}`];
        } catch (error) {
          this.logger?.error(`Failed to delete temporary MCP script file:`, error instanceof Error ? error : undefined);
        }
      }, 5000); // 5 second delay
    }
  }

  protected async getCliEnvironment(options: ClaudeSpawnOptions): Promise<{ [key: string]: string }> {
    // This is handled in initializeCliEnvironment for Claude
    return {};
  }

  protected getCliNotAvailableMessage(error?: string): string {
    return [
      `Error: ${error}`,
      '',
      'Claude Code is not installed or not found in your PATH.',
      '',
      'Please install Claude Code:',
      '1. Visit: https://docs.anthropic.com/en/docs/claude-code/overview',
      '2. Follow the installation instructions for your platform',
      '3. Verify installation by running "claude --version" in your terminal',
      '',
      'If Claude is installed but not in your PATH:',
      '- Add the Claude installation directory to your PATH environment variable',
      '- Or set a custom Claude executable path in Cyboflow Settings',
      '',
      `Current PATH: ${process.env.PATH}`,
      `Attempted command: claude --version`
    ].join('\n');
  }

  // Override spawn method to handle resume validation and MCP setup
  async spawnCliProcess(options: ClaudeSpawnOptions): Promise<void> {
    return await withLock(`claude-spawn-${options.panelId}`, async () => {
      const { panelId, sessionId, isResume, permissionMode } = options;

      // Check if a process is already running for this panel
      if (this.processes.has(panelId)) {
        throw new Error(`Claude process already running for panel ${panelId}`);
      }

      // Handle resume validation before calling parent
      if (isResume) {
        const claudeSessionId = this.sessionManager.getPanelClaudeSessionId(panelId);
        
        if (!claudeSessionId) {
          const errMsg = `Cannot resume: no Claude session_id stored for Crystal session ${sessionId}`;
          this.logger?.error(`[ClaudeCodeManager] ${errMsg}`);
          
          const errorMessage = {
            type: 'system',
            subtype: 'error',
            timestamp: new Date().toISOString(),
            message: 'Unable to resume Claude conversation',
            details: 'Missing Claude session_id. Please start a new message to begin a fresh conversation.'
          };
          
          this.emit('output', {
            panelId,
            sessionId,
            type: 'json',
            data: errorMessage,
            timestamp: new Date()
          });
          
          throw new Error(errMsg);
        }
      }

      // Optional: Test claude in the target directory (skip on Linux for performance)
      const skipDirTest = os.platform() === 'linux';
      if (!skipDirTest) {
        const customClaudePath = this.configManager?.getConfig()?.claudeExecutablePath;
        const directoryTest = await testClaudeCodeInDirectory(options.worktreePath, customClaudePath);
        if (!directoryTest.success) {
          this.logger?.error(`Claude test failed in directory ${options.worktreePath}: ${directoryTest.error}`);
          if (directoryTest.output) {
            this.logger?.error(`Claude output: ${directoryTest.output}`);
          }
        } else {
          this.logger?.verbose(`Claude works in target directory`);
        }
      } else {
        this.logger?.verbose(`Skipping directory test on Linux for performance`);
      }

      // Set up MCP configuration if needed and add to args
      const defaultMode = this.configManager?.getConfig()?.defaultPermissionMode || 'approve';
      const effectiveMode = permissionMode || defaultMode;

      let mcpConfigPath: string | null = null;
      if (effectiveMode === 'approve' && this.permissionIpcPath) {
        // Full MCP setup with permission server + base project MCP servers
        mcpConfigPath = await this.setupMcpConfigurationSync(sessionId);
      } else {
        // Even in approve mode without a socket, check for base project MCP servers.
        // Note: buildCommandArgs will throw below if approve+nosocket, but we still
        // collect base MCP config to include in the error context.
        mcpConfigPath = await this.setupBaseProjectMcpConfig(sessionId);
      }

      // Store MCP config path in options for buildCommandArgs to use
      const enhancedOptions = {
        ...options,
        mcpConfigPath
      };

      // Emit initial session info message
      const finalArgs = this.buildCommandArgs(enhancedOptions);
      const sessionInfoMessage = {
        type: 'session_info',
        initial_prompt: options.prompt,
        claude_command: `claude ${finalArgs.join(' ')}`,
        worktree_path: options.worktreePath,
        model: options.model || 'default',
        permission_mode: options.permissionMode || 'default',
        timestamp: new Date().toISOString()
      };

      this.emit('output', {
        panelId,
        sessionId,
        type: 'json',
        data: sessionInfoMessage,
        timestamp: new Date()
      });

      // Call parent with enhanced options
      await super.spawnCliProcess(enhancedOptions);
    });
  }

  // Claude now uses the base class spawnPtyProcess with Node.js fallback
  // No override needed - the base class handles everything

  // Implementation of abstract methods from AbstractCliManager

  async startPanel(panelId: string, sessionId: string, worktreePath: string, prompt: string, permissionMode?: 'approve' | 'ignore', model?: string): Promise<void> {
    // Validate panel ownership before starting
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
      // Validate panel ownership before continuing
      const { validatePanelSessionOwnership, logValidationFailure } = require('../../../utils/sessionValidation');
      const validation = validatePanelSessionOwnership(panelId, sessionId);
      if (!validation.valid) {
        logValidationFailure('ClaudeCodeManager.continuePanel', validation);
        throw new Error(`Panel validation failed: ${validation.error}`);
      }

      console.log(`[ClaudeCodeManager] Validated panel ${panelId} belongs to session ${sessionId}`);

      // Kill any existing process for this panel first
      if (this.processes.has(panelId)) {
        console.log(`[ClaudeCodeManager] Killing existing process for panel ${panelId} before continuing`);
        await this.killProcess(panelId);
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (this.processes.has(panelId)) {
        console.error(`[ClaudeCodeManager] Process ${panelId} still exists after kill attempt, aborting continue`);
        throw new Error('Failed to stop previous panel instance');
      }

      // Get the session's permission mode from database
      const dbSession = this.sessionManager.getDbSession(sessionId);
      const permissionModeFromDb = dbSession?.permission_mode;
      const permissionMode = permissionModeOverride ?? permissionModeFromDb;

      // Check if we should skip --resume flag this time (after prompt compaction)
      const skipContinueRaw = dbSession?.skip_continue_next;
      const shouldSkipContinue = skipContinueRaw === true || (typeof skipContinueRaw === 'number' && skipContinueRaw === 1);

      console.log(`[ClaudeCodeManager] continuePanel called for ${panelId} (session ${sessionId}):`, {
        skip_continue_next_raw: skipContinueRaw,
        shouldSkipContinue,
        permissionMode,
        model
      });

      if (shouldSkipContinue) {
        // Clear the flag and start a fresh session without --resume
        console.log(`[ClaudeCodeManager] Clearing skip_continue_next flag for session ${sessionId}`);
        this.sessionManager.updateSession(sessionId, { skip_continue_next: false });
        console.log(`[ClaudeCodeManager] Skipping --resume flag for panel ${panelId} due to prompt compaction`);
        return this.spawnClaudeCode(panelId, sessionId, worktreePath, prompt, [], false, permissionMode, model);
      } else {
        // For continuing a session, we use the --resume flag
        console.log(`[ClaudeCodeManager] Using --resume flag for panel ${panelId}`);
        return this.spawnClaudeCode(panelId, sessionId, worktreePath, prompt, [], true, permissionMode, model);
      }
    });
  }

  async stopPanel(panelId: string): Promise<void> {
    await this.killProcess(panelId);
  }

  /**
   * Override killProcess to also dispose the pipeline for the killed panel.
   *
   * The CompletionDetector will not fire its normal gates when the process is killed
   * externally (no clean exit sequence), so we clean up the pipeline immediately here
   * to prevent the watchdog from firing after the run is gone.
   */
  override async killProcess(panelId: string): Promise<void> {
    // Clean up pipeline before killing so the watchdog timer is cleared.
    this.cleanupPipeline(panelId);
    await super.killProcess(panelId);
  }

  async restartPanelWithHistory(panelId: string, sessionId: string, worktreePath: string, initialPrompt: string, conversationHistory: ConversationMessage[]): Promise<void> {
    // Kill existing process if it exists
    await this.killProcess(panelId);

    // Convert ConversationMessage[] to string[] for backward compatibility
    const historyStrings = conversationHistory.map(msg => msg.content);

    // Restart with conversation history
    await this.spawnClaudeCode(panelId, sessionId, worktreePath, initialPrompt, historyStrings);
  }

  // Claude-specific public methods for backward compatibility

  async spawnClaudeCode(panelId: string, sessionId: string, worktreePath: string, prompt: string, conversationHistory?: string[], isResume: boolean = false, permissionMode?: 'approve' | 'ignore', model?: string): Promise<void> {
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

  // Legacy methods are now inherited from AbstractCliManager

  // Private helper methods

  /**
   * Get MCP servers configured for the base project.
   * Claude Code stores project-specific MCP config in ~/.claude.json under projects[path].mcpServers
   * and project-level config in .mcp.json files.
   *
   * When running in a worktree, Claude doesn't see MCP servers from the base project
   * because it uses the worktree path as the project key.
   */
  private getBaseProjectMcpServers(sessionId: string): { mcpServers: Record<string, unknown>; mcpJsonPath?: string } {
    const result: { mcpServers: Record<string, unknown>; mcpJsonPath?: string } = { mcpServers: {} };

    try {
      // Get the session to find the project
      const dbSession = this.sessionManager.getDbSession(sessionId);
      if (!dbSession?.project_id) {
        return result;
      }

      const project = this.sessionManager.getProjectById(dbSession.project_id);
      if (!project?.path) {
        return result;
      }

      const baseProjectPath = project.path;
      this.logger?.verbose(`[MCP] Looking for base project MCP servers at: ${baseProjectPath}`);

      // Check for .mcp.json in the base project directory
      const mcpJsonPath = path.join(baseProjectPath, '.mcp.json');
      if (fs.existsSync(mcpJsonPath)) {
        this.logger?.verbose(`[MCP] Found .mcp.json at: ${mcpJsonPath}`);
        result.mcpJsonPath = mcpJsonPath;

        // Also parse it to merge with other servers
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

      // Read ~/.claude.json to get project-specific MCP servers
      const claudeConfigPath = path.join(os.homedir(), '.claude.json');
      if (fs.existsSync(claudeConfigPath)) {
        try {
          const claudeConfig = fs.readFileSync(claudeConfigPath, 'utf8');
          const config = JSON.parse(claudeConfig) as {
            projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
            mcpServers?: Record<string, unknown>;
          };

          // Get project-specific MCP servers
          const projectConfig = config.projects?.[baseProjectPath];
          if (projectConfig?.mcpServers && Object.keys(projectConfig.mcpServers).length > 0) {
            this.logger?.verbose(`[MCP] Found ${Object.keys(projectConfig.mcpServers).length} project-specific MCP servers in ~/.claude.json`);
            Object.assign(result.mcpServers, projectConfig.mcpServers);
          }

          // Also include global MCP servers (these apply to all projects)
          if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
            this.logger?.verbose(`[MCP] Found ${Object.keys(config.mcpServers).length} global MCP servers in ~/.claude.json`);
            // Global servers have lower priority, so only add if not already present
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

    // Add global system prompt first
    const globalPrompt = this.configManager?.getSystemPromptAppend();
    if (globalPrompt) {
      systemPromptParts.push(globalPrompt);
    }

    // Add project-specific system prompt
    if (dbSession?.project_id) {
      const project = this.sessionManager.getProjectById(dbSession.project_id);
      if (project?.system_prompt) {
        systemPromptParts.push(project.system_prompt);
      }
    }

    // Combine prompts with double newline separator
    return systemPromptParts.length > 0 ? systemPromptParts.join('\n\n') : undefined;
  }


  private async setupMcpConfigurationSync(sessionId: string): Promise<string> {
    // Create MCP config for permission approval
    let mcpBridgePath = app.isPackaged
      ? path.join(__dirname, 'cyboflowPermissionBridgeStandalone.js')
      : path.join(__dirname, 'cyboflowPermissionBridge.js');

    // Use a directory without spaces for better compatibility
    let tempDir: string;
    try {
      tempDir = getCrystalDirectory();

      // Ensure the directory exists
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
        this.logger?.verbose(`[MCP] Created MCP temp directory: ${tempDir}`);
      }

      // Test write access
      const testFile = path.join(tempDir, '.test');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
    } catch (error) {
      this.logger?.error(`[MCP] Failed to create/access home directory, falling back to system temp: ${error}`);
      tempDir = os.tmpdir();
    }

    // Handle ASAR packaging - copy the script to temp directory since it can't be executed from ASAR
    if (mcpBridgePath.includes('.asar')) {
      this.logger?.verbose(`[MCP] Detected ASAR packaging, extracting script`);

      let scriptContent: string;
      try {
        scriptContent = fs.readFileSync(mcpBridgePath, 'utf8');
      } catch (error) {
        this.logger?.error(`[MCP] Failed to read script from ASAR: ${error}`);
        throw new Error(`Failed to read MCP bridge script from ASAR: ${error}`);
      }

      const tempScriptPath = path.join(tempDir, `cyboflowPermissionBridge-${sessionId}.js`);
      try {
        fs.writeFileSync(tempScriptPath, scriptContent);
        fs.chmodSync(tempScriptPath, 0o755);

        const stats = fs.statSync(tempScriptPath);
        this.logger?.verbose(`[MCP] Script extracted to: ${tempScriptPath}`);

        mcpBridgePath = tempScriptPath;
      } catch (error) {
        this.logger?.error(`[MCP] Failed to write script to temp directory: ${error}`);
        throw new Error(`Failed to extract MCP bridge script: ${error}`);
      }
    } else {
      // Verify the MCP bridge file exists
      if (!fs.existsSync(mcpBridgePath)) {
        this.logger?.error(`MCP permission bridge not found at: ${mcpBridgePath}`);
        throw new Error(`MCP permission bridge file not found. Expected at: ${mcpBridgePath}`);
      }
    }

    const mcpConfigPath = path.join(tempDir, `cyboflow-mcp-${sessionId}.json`);

    // Try to find node executable
    let nodePath = 'node';
    try {
      const nodeInPath = await findExecutableInPath('node');
      if (nodeInPath) {
        nodePath = nodeInPath;
      } else {
        // When running from .dmg, try common node locations
        const commonNodePaths = [
          '/usr/local/bin/node',
          '/opt/homebrew/bin/node',
          '/usr/bin/node',
          '/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc',
          process.execPath
        ];

        for (const tryPath of commonNodePaths) {
          if (fs.existsSync(tryPath)) {
            nodePath = tryPath;
            break;
          }
        }

        if (nodePath === 'node' && app.isPackaged) {
          nodePath = process.execPath;
        }
      }
    } catch (e) {
      this.logger?.warn(`[MCP] Could not find node in PATH: ${e}`);
      if (app.isPackaged) {
        nodePath = process.execPath;
      }
    }

    // Test if the selected node path actually works
    try {
      execSync(`"${nodePath}" --version`, { encoding: 'utf8' });
    } catch (e) {
      this.logger?.error(`[MCP] Node executable test failed: ${e}`);
    }

    // Set up MCP command and args
    let mcpCommand: string = nodePath;
    let mcpArgs: string[] = [mcpBridgePath, sessionId, this.permissionIpcPath!];

    if (nodePath === process.execPath && app.isPackaged) {
      // First, try to find any available node
      const alternateNodes = ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'];
      let foundAlternate = false;

      for (const altNode of alternateNodes) {
        if (fs.existsSync(altNode)) {
          mcpCommand = altNode;
          mcpArgs = [mcpBridgePath, sessionId, this.permissionIpcPath!];
          foundAlternate = true;
          break;
        }
      }

      if (!foundAlternate) {
        mcpCommand = nodePath;
        mcpArgs = ['--require', mcpBridgePath, '--', sessionId, this.permissionIpcPath!];
      }
    }

    // Start with base project MCP servers
    const baseProjectMcp = this.getBaseProjectMcpServers(sessionId);
    const mcpConfig: { mcpServers: Record<string, unknown> } = {
      "mcpServers": {
        // Include base project MCP servers first
        ...baseProjectMcp.mcpServers,
        // Cyboflow's permission server takes precedence (added last)
        "cyboflow-permissions": {
          "command": mcpCommand,
          "args": mcpArgs
        }
      }
    };

    if (Object.keys(baseProjectMcp.mcpServers).length > 0) {
      this.logger?.info(`[MCP] Merged ${Object.keys(baseProjectMcp.mcpServers).length} base project MCP servers into config`);
    }

    this.logger?.verbose(`[MCP] Creating MCP config at: ${mcpConfigPath}`);

    try {
      fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

      if (fs.existsSync(mcpConfigPath)) {
        fs.chmodSync(mcpConfigPath, 0o644);
      } else {
        throw new Error('MCP config file was not created');
      }
    } catch (error) {
      this.logger?.error(`[MCP] Failed to create MCP config file: ${error}`);
      throw new Error(`Failed to create MCP config: ${error}`);
    }

    // Test if the MCP bridge script can be executed
    try {
      const testCmd = `"${nodePath}" "${mcpBridgePath}" --version`;
      execSync(testCmd, { encoding: 'utf8', timeout: 2000 });
    } catch (testError: unknown) {
      const error = testError as { code?: string; message?: string };
      if (error.code === 'EACCES' || (error.message && error.message.includes('EACCES'))) {
        this.logger?.error(`[MCP] Permission denied executing MCP bridge script`);
        throw new Error('MCP bridge script is not executable');
      }
    }

    // Store config path and temp script path for cleanup
    globalThis[`mcp_config_${sessionId}`] = mcpConfigPath;
    if (mcpBridgePath.includes(tempDir)) {
      globalThis[`mcp_script_${sessionId}`] = mcpBridgePath;
    }

    // Add a small delay to ensure file is fully written and accessible
    await new Promise(resolve => setTimeout(resolve, 100));

    // Final check that config file still exists
    if (!fs.existsSync(mcpConfigPath)) {
      throw new Error(`MCP config file disappeared after creation: ${mcpConfigPath}`);
    }

    this.logger?.verbose(`[MCP] MCP configuration complete. Config path: ${mcpConfigPath}`);
    return mcpConfigPath;
  }

  private async setupMcpConfiguration(sessionId: string, env: { [key: string]: string }): Promise<void> {
    // This method is called from initializeCliEnvironment but for Claude we handle MCP in spawnCliProcess
    // Just set up the basic environment variables here
    return;
  }

  /**
   * Set up MCP configuration for base project servers only (without Crystal permission server).
   * Used when permission mode is not 'approve' but we still need to pass base project MCP.
   */
  private async setupBaseProjectMcpConfig(sessionId: string): Promise<string | null> {
    const baseProjectMcp = this.getBaseProjectMcpServers(sessionId);

    // If there's a .mcp.json file in the base project, we can pass it directly
    // This is the most reliable way since Claude will parse it correctly
    if (baseProjectMcp.mcpJsonPath) {
      this.logger?.info(`[MCP] Passing base project .mcp.json: ${baseProjectMcp.mcpJsonPath}`);
      return baseProjectMcp.mcpJsonPath;
    }

    // If there are servers from ~/.claude.json, create a temp config file
    if (Object.keys(baseProjectMcp.mcpServers).length > 0) {
      const tempDir = getCrystalDirectory();
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const mcpConfigPath = path.join(tempDir, `cyboflow-base-mcp-${sessionId}.json`);
      const mcpConfig = { mcpServers: baseProjectMcp.mcpServers };

      try {
        fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
        fs.chmodSync(mcpConfigPath, 0o644);
        this.logger?.info(`[MCP] Created base project MCP config with ${Object.keys(baseProjectMcp.mcpServers).length} servers: ${mcpConfigPath}`);

        // Store for cleanup
        globalThis[`mcp_base_config_${sessionId}`] = mcpConfigPath;

        return mcpConfigPath;
      } catch (error) {
        this.logger?.error(`[MCP] Failed to create base project MCP config: ${error}`);
        return null;
      }
    }

    return null;
  }
}
