import { EventEmitter } from 'events';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { Logger } from '../../../utils/logger';
import type { ConfigManager } from '../../configManager';
import type { ConversationMessage } from '../../../database/models';
import { getShellPath, findExecutableInPath } from '../../../utils/shellPath';
import { captureSeamError } from '../../telemetry';
import { assertAgentProviderAllowed, isAgentProviderAllowed } from '../../../../../shared/agents/agentProviderGuard';
import type { AgentProvider } from '../../../../../shared/types/agentRuntime';
import { classifyErrorPattern, unclassifiedErrorTags } from '../../../orchestrator/programmatic/systemicError';
import { findNodeExecutable } from '../../../utils/nodeFinder';
import { describeMissingInterpreter } from './cliVersionProbe';
import type { CliSpawnOutcome } from '../../../../../shared/types/cliPanels';
import { managedTestConcurrencyEnv } from '../../../../../shared/types/testConcurrency';
import {
  collectDescendantPidsAsync,
  describeProcesses,
  killTree,
} from '../../../utils/platformProcess';

interface CliProcess {
  process: pty.IPty;
  panelId: string;
  sessionId: string;
  worktreePath: string;
}

/**
 * Signals that mean "someone asked this to stop" rather than "this crashed":
 * SIGHUP (1), SIGINT (2), SIGTERM (15). A shell reports a signal-terminated
 * child as exit code 128+N, and node-pty surfaces either form depending on how
 * the process died, so both are checked.
 *
 * SIGKILL (9 / 137) is deliberately NOT here: we escalate to it in
 * killProcessTree, but it is also what the OOM killer uses, and an
 * out-of-memory kill is a real defect worth reporting.
 */
const DELIBERATE_TERMINATION_SIGNALS: ReadonlySet<number> = new Set([1, 2, 15]);
const DELIBERATE_TERMINATION_EXIT_CODES: ReadonlySet<number> = new Set([129, 130, 143]);

/**
 * Whether a non-zero exit is a deliberate termination rather than a failure.
 *
 * WHY: stopping a session, interrupting a turn, or quitting the app all
 * SIGTERM the CLI, which exits 143. Reporting those to Sentry produced a
 * permanently-recurring "process exited (code 143)" issue with no defect behind
 * it (CYBOFLOW-APP-G) — pure noise that also drowns out genuine non-zero exits.
 */
export function isDeliberateTermination(
  exitCode: number | null,
  signal: number | undefined,
): boolean {
  if (signal !== undefined && DELIBERATE_TERMINATION_SIGNALS.has(signal)) return true;
  return exitCode !== null && DELIBERATE_TERMINATION_EXIT_CODES.has(exitCode);
}

interface AvailabilityCache {
  result: { available: boolean; error?: string; version?: string; path?: string };
  timestamp: number;
}

interface CliSpawnOptions {
  panelId: string;
  sessionId: string;
  worktreePath: string;
  prompt: string;
  isResume?: boolean;
  /**
   * Set ONLY by a seam that showed the user their provider is switched off and
   * got an explicit "do it anyway". See assertProviderEnabled below for why this
   * exists and what it does not license.
   */
  userAcknowledgedProviderDisabled?: boolean;
  [key: string]: unknown; // Allow CLI-specific options
}

interface CliOutputEvent {
  panelId: string;
  sessionId: string;
  type: 'json' | 'stdout' | 'stderr';
  data: unknown;
  timestamp: Date;
}

interface CliExitEvent {
  panelId: string;
  sessionId: string;
  exitCode: number | null;
  signal: number | null;
}

interface CliErrorEvent {
  panelId: string;
  sessionId: string;
  error: string;
}

interface CliSpawnedEvent {
  panelId: string;
  sessionId: string;
}

// Diagnostic tail kept for the exit-time "last output" error message — not a
// scrollback buffer, just enough context to classify the failure.
const LAST_OUTPUT_TAIL_BYTES = 8192;
// Pathological-growth cap for the incomplete-line buffer in
// setupProcessHandlers — a legitimate incomplete trailing line stays well
// under this, so it only trips for a runaway single line / newline-free burst.
const LINE_BUFFER_CAP_BYTES = 1024 * 1024;

/**
 * Abstract base class for managing CLI tool processes in Cyboflow
 * Provides common functionality for spawning, managing, and communicating with CLI tools
 */
export abstract class AbstractCliManager extends EventEmitter {
  protected processes: Map<string, CliProcess> = new Map(); // Keyed by panelId
  /**
   * Panels this manager deliberately killed (see killProcess). Consulted by the
   * exit handler to suppress the failure seam for app-initiated stops, which is
   * more precise than inferring intent from the exit code alone — the flag holds
   * even when the CLI exits some other way while being torn down. Entries are
   * cleared by the exit handler, or by killProcess itself if no exit follows.
   */
  private readonly deliberatelyKilledPanels = new Set<string>();
  protected availabilityCache: AvailabilityCache | null = null;
  protected readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache
  // Wrapped (rather than a bare promisify(exec)) so every kill-ladder call
  // passes windowsHide — a packaged Windows app must never flash a conhost.
  protected readonly execAsync = async (command: string): Promise<{ stdout: string; stderr: string }> =>
    promisify(exec)(command, { windowsHide: true });

  constructor(
    protected sessionManager: import('../../sessionManager').SessionManager,
    protected logger?: Logger,
    protected configManager?: ConfigManager
  ) {
    super();
    // Increase max listeners to prevent warnings when many components listen to events
    this.setMaxListeners(50);
  }

  // Abstract methods that must be implemented by subclasses

  /**
   * Get the CLI tool name (e.g., 'claude', 'aider')
   */
  protected abstract getCliToolName(): string;

  /**
   * The vendor this manager calls. Drives the provider-access guard below (the
   * Settings → Integrations toggles) — distinct from getCliToolName(), which is
   * a display string and from the substrate, which is the transport.
   */
  protected abstract getAgentProvider(): AgentProvider;

  /**
   * Refuse to call a provider the user switched off. Invoked at the top of every
   * spawn entry point — the base one below AND each subclass override, since
   * most overrides do not chain to super. Cold spawns are only half the story:
   * a keystroke relayed into an already-live PTY never respawns, and is guarded
   * separately in ipc/ptyPanelDispatch.
   *
   * `userAcknowledgedProviderDisabled` is the ONE sanctioned bypass, and it is
   * deliberately named for its only legitimate source: a human who was shown the
   * provider is off and chose to proceed anyway. Today that is the interactive
   * (PTY) resume prompt — a lost REPL's conversation is recoverable ONLY by
   * respawning it with `--resume`, and declining costs the user their history
   * permanently, which no later toggle flip can undo. It licenses exactly this
   * spawn; it does not relax the guard for anything else (the composer's next
   * turn is still refused at ipc/session), and it is never set from a default,
   * a config value, or a retry.
   */
  protected assertProviderEnabled(options?: { userAcknowledgedProviderDisabled?: boolean }): void {
    const provider = this.getAgentProvider();
    if (options?.userAcknowledgedProviderDisabled === true) {
      if (!isAgentProviderAllowed(provider)) {
        console.warn(
          `[${this.getCliToolName()}] Spawning a ${provider} process while ${provider} is switched off — the user explicitly acknowledged this.`,
        );
      }
      return;
    }
    assertAgentProviderAllowed(provider, `${this.getCliToolName()} sessions`);
  }

  /**
   * Test if the CLI tool is available and get version/path info
   */
  protected abstract testCliAvailability(customPath?: string): Promise<{ available: boolean; error?: string; version?: string; path?: string }>;

  /**
   * Build command arguments for the CLI tool
   */
  protected abstract buildCommandArgs(options: CliSpawnOptions): string[];

  /**
   * Get the CLI executable path (custom or from PATH)
   */
  protected abstract getCliExecutablePath(): Promise<string>;

  /**
   * Parse and handle CLI output data
   * @param data Raw output data from the CLI
   * @param panelId Panel ID for the output
   * @param sessionId Session ID for the output
   * @returns Array of processed output events
   */
  protected abstract parseCliOutput(data: string, panelId: string, sessionId: string): CliOutputEvent[];

  /**
   * Handle CLI-specific initialization (e.g., setup config files, environment)
   */
  protected abstract initializeCliEnvironment(options: CliSpawnOptions): Promise<{ [key: string]: string }>;

  /**
   * Clean up CLI-specific resources (e.g., config files, temporary files) for
   * the panel that just exited or was killed.
   *
   * Takes BOTH ids: `panelId` for per-panel state (a run record, a tail
   * source, a router entry) — the exiting panel's own resources only, never a
   * still-live sibling's — and `sessionId` for state that is deliberately
   * SHARED across every panel in a session (e.g. the SDK manager's per-session
   * `.claude/commands` bundle, refcounted so the last live lane removes it). A
   * subclass with no session-scoped state can ignore `sessionId`.
   */
  protected abstract cleanupCliResources(panelId: string, sessionId: string): Promise<void>;

  /**
   * Get CLI-specific environment variables
   */
  protected abstract getCliEnvironment(options: CliSpawnOptions): Promise<{ [key: string]: string }>;

  // Common functionality that can be shared across CLI tools

  /**
   * Spawn a CLI process for a specific panel.
   *
   * Return type is widened to `CliSpawnOutcome | void` for the typed step-output
   * channel (§5.3): the SDK subclass ({@link ClaudeCodeManager}) resolves the
   * turn's captured result text, while this interactive/PTY base path resolves
   * `void` (no per-turn result capture) — the union keeps the interactive sibling
   * compiling unchanged.
   */
  async spawnCliProcess(options: CliSpawnOptions): Promise<CliSpawnOutcome | void> {
    // Provider-access gate BEFORE the availability probe: a switched-off provider
    // must read as "turned off", not as "CLI unavailable".
    this.assertProviderEnabled(options);
    try {
      const { panelId, sessionId, worktreePath } = options;
      this.logger?.verbose(`Spawning ${this.getCliToolName()} for panel ${panelId} (session ${sessionId}) in ${worktreePath}`);

      // Test CLI availability (with caching)
      const availability = await this.getCachedAvailability();
      if (!availability.available) {
        // Handled failure — surfaces in the UI but never reaches Sentry's
        // uncaught-exception integrations. Capture explicitly so a tester's
        // missing/broken `claude` install (not found on PATH, --version failed)
        // is visible in error reporting. availability.error may embed a user
        // path; scrub.ts home-path-redacts the message before send.
        captureSeamError(
          'cli-availability',
          new Error(`${this.getCliToolName()} unavailable: ${availability.error ?? 'unknown error'}`),
          { cliTool: this.getCliToolName() },
        );
        await this.handleCliNotAvailable(availability, panelId, sessionId);
        throw new Error(`${this.getCliToolName()} CLI not available: ${availability.error}`);
      }

      this.logger?.verbose(`${this.getCliToolName()} found: ${availability.version || 'version unknown'}`);
      if (availability.path) {
        this.logger?.verbose(`${this.getCliToolName()} executable path: ${availability.path}`);
      }

      // Build command arguments
      const args = this.buildCommandArgs(options);

      // Initialize CLI-specific environment
      const cliEnv = await this.initializeCliEnvironment(options);

      // Get system environment with PATH enhancement
      const systemEnv = await this.getSystemEnvironment();

      // Merge environments
      const env = { ...systemEnv, ...cliEnv };

      // Get CLI executable path
      const cliCommand = await this.getCliExecutablePath();
      
      // Log the exact command being executed
      const fullCommand = `${cliCommand} ${args.join(' ')}`;
      this.logger?.info(`[${this.getCliToolName()}-command] COMMAND: ${fullCommand}`);
      this.logger?.info(`[${this.getCliToolName()}-command] Working directory: ${worktreePath}`);
      this.logger?.info(`[${this.getCliToolName()}-command] Environment vars: ${Object.keys(cliEnv).join(', ')}`);

      // Spawn the process
      const ptyProcess = await this.spawnPtyProcess(cliCommand, args, worktreePath, env);

      // Create process record
      const cliProcess: CliProcess = {
        process: ptyProcess,
        panelId,
        sessionId,
        worktreePath
      };

      this.processes.set(panelId, cliProcess);
      this.logger?.verbose(`${this.getCliToolName()} process created for panel ${panelId} (session ${sessionId})`);

      // Set up process event handlers
      this.setupProcessHandlers(ptyProcess, panelId, sessionId);

      // Emit spawned event
      this.emit('spawned', { panelId, sessionId } as CliSpawnedEvent);

      this.logger?.info(`${this.getCliToolName()} spawned successfully for panel ${panelId} (session ${sessionId})`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.error(`Failed to spawn ${this.getCliToolName()} for panel ${options.panelId} (session ${options.sessionId})`, error instanceof Error ? error : undefined);

      this.emit('error', {
        panelId: options.panelId,
        sessionId: options.sessionId,
        error: errorMessage
      } as CliErrorEvent);
      throw error;
    }
  }

  /**
   * Send input to a CLI process
   */
  sendInput(panelId: string, input: string): void {
    const cliProcess = this.processes.get(panelId);
    if (!cliProcess) {
      throw new Error(`No ${this.getCliToolName()} process found for panel ${panelId}`);
    }

    // Validate that the process matches the expected panel and session context
    if (cliProcess.panelId !== panelId) {
      this.logger?.error(`[${this.getCliToolName()}] Panel ID mismatch: process has ${cliProcess.panelId}, expected ${panelId}`);
      throw new Error(`Panel ID mismatch: process belongs to different panel`);
    }

    this.logger?.verbose(`[${this.getCliToolName()}] Sending input to panel ${panelId} (session ${cliProcess.sessionId})`);
    cliProcess.process.write(input);
  }

  /**
   * Kill a CLI process and clean up resources
   */
  async killProcess(panelId: string): Promise<void> {
    const cliProcess = this.processes.get(panelId);
    if (!cliProcess) {
      return;
    }

    const { sessionId } = cliProcess;
    const pid = cliProcess.process.pid;

    // Mark BEFORE any kill so the exit handler (which may fire synchronously
    // from within killProcessTree) sees the intent and suppresses the failure
    // seam. The exit handler clears it; setupProcessHandlers also clears it when
    // a new process takes over this panel id, so a kill that never produces an
    // exit event cannot leave a stale flag that silences a future real failure.
    this.deliberatelyKilledPanels.add(panelId);

    // Get all child processes before killing
    let killedProcesses: { pid: number; name?: string }[] = [];
    if (pid) {
      const descendantPids = await this.getAllDescendantPids(pid);
      if (descendantPids.length > 0) {
        killedProcesses = await this.getProcessInfo(descendantPids);
        this.logger?.info(`[${this.getCliToolName()}] Found ${descendantPids.length} child processes started by ${this.getCliToolName()} for session ${sessionId}`);
      }
    }

    // Clean up CLI-specific resources — scoped to THIS panel (see the abstract
    // method doc: a sibling panel in the same session must be left alone).
    await this.cleanupCliResources(panelId, sessionId);

    // Kill the process and all its children
    if (pid) {
      const success = await this.killProcessTree(pid, panelId, sessionId);

      // Report what processes were killed
      if (killedProcesses.length > 0) {
        const processReport = killedProcesses.map(p => `${p.name || 'unknown'}(${p.pid})`).join(', ');
        const message = `\n[Process Cleanup] Terminated ${killedProcesses.length} child process${killedProcesses.length > 1 ? 'es' : ''} started by ${this.getCliToolName()}: ${processReport}\n`;
        this.emit('output', {
          panelId,
          sessionId,
          type: 'stdout',
          data: message,
          timestamp: new Date()
        } as CliOutputEvent);
      }

      if (!success) {
        this.logger?.error(`Failed to cleanly terminate all child processes for ${this.getCliToolName()} panel ${panelId} (session ${sessionId})`);
      }
    } else {
      // Fallback to simple kill if no PID
      cliProcess.process.kill();
    }

    this.processes.delete(panelId);
  }

  /**
   * Get a CLI process by panel ID
   */
  getProcess(panelId: string): CliProcess | undefined {
    return this.processes.get(panelId);
  }

  /**
   * Get all active process panel IDs
   */
  getAllProcesses(): string[] {
    return Array.from(this.processes.keys());
  }

  /**
   * Check if a panel is running
   */
  isPanelRunning(panelId: string): boolean {
    return this.processes.has(panelId);
  }

  /**
   * Whether an AGENT TURN is currently in flight for any panel of `sessionId`.
   * Base answer is `false`: a PTY-substrate manager cannot bound a turn from its
   * own state (the user types straight into the live terminal; turn ends arrive
   * via Stop-hook markers only after the fact), so it reports no in-flight turn.
   * SDK-substrate managers override this with their per-turn run records. Used
   * as the settleQuickArm write barrier (experiments router) — best-effort by
   * design: a false negative degrades to the pre-barrier behavior, never blocks.
   */
  hasTurnInFlightForSession(_sessionId: string): boolean {
    return false;
  }

  /**
   * Kill all CLI processes on shutdown
   */
  async killAllProcesses(): Promise<void> {
    const panelIds = Array.from(this.processes.keys());
    this.logger?.info(`[${this.getCliToolName()}] Killing ${panelIds.length} ${this.getCliToolName()} panel processes on shutdown`);

    const killPromises = panelIds.map(panelId => this.killProcess(panelId));
    await Promise.all(killPromises);
  }

  /**
   * Clear the CLI availability cache
   */
  clearAvailabilityCache(): void {
    this.availabilityCache = null;
    this.logger?.verbose(`[${this.getCliToolName()}Manager] Cleared ${this.getCliToolName()} availability cache`);
  }

  // Abstract methods for CLI-specific implementations

  /**
   * Start a CLI panel with the given options
   * This should be implemented by each CLI tool manager
   */
  abstract startPanel(panelId: string, sessionId: string, worktreePath: string, prompt: string, ...args: unknown[]): Promise<void>;

  /**
   * Continue a CLI panel with conversation history
   * This should be implemented by each CLI tool manager
   */
  abstract continuePanel(panelId: string, sessionId: string, worktreePath: string, prompt: string, conversationHistory: ConversationMessage[], ...args: unknown[]): Promise<void>;

  /**
   * Stop a CLI panel
   * This should be implemented by each CLI tool manager
   */
  abstract stopPanel(panelId: string): Promise<void>;

  /**
   * Restart a panel with conversation history
   * This should be implemented by each CLI tool manager
   */
  abstract restartPanelWithHistory(panelId: string, sessionId: string, worktreePath: string, initialPrompt: string, conversationHistory: ConversationMessage[]): Promise<void>;

  // Legacy session-based methods for backward compatibility
  // These provide default implementations that map to panel-based methods

  /**
   * @deprecated Use startPanel with real panel IDs instead
   */
  async startSession(sessionId: string, worktreePath: string, prompt: string, ...args: unknown[]): Promise<void> {
    console.warn(`[${this.getCliToolName()}Manager] DEPRECATED: startSession called with virtual panel ID for session ${sessionId}. Use real panel IDs instead.`);
    const virtualPanelId = `session-${sessionId}`;
    return this.startPanel(virtualPanelId, sessionId, worktreePath, prompt, ...args);
  }

  /**
   * @deprecated Use continuePanel with real panel IDs instead
   */
  async continueSession(sessionId: string, worktreePath: string, prompt: string, conversationHistory: ConversationMessage[], ...args: unknown[]): Promise<void> {
    console.warn(`[${this.getCliToolName()}Manager] DEPRECATED: continueSession called with virtual panel ID for session ${sessionId}. Use real panel IDs instead.`);
    const virtualPanelId = `session-${sessionId}`;
    return this.continuePanel(virtualPanelId, sessionId, worktreePath, prompt, conversationHistory, ...args);
  }

  /**
   * @deprecated Use stopPanel with real panel IDs instead
   */
  async stopSession(sessionId: string): Promise<void> {
    console.warn(`[${this.getCliToolName()}Manager] DEPRECATED: stopSession called with virtual panel ID for session ${sessionId}. Use real panel IDs instead.`);
    const virtualPanelId = `session-${sessionId}`;
    await this.stopPanel(virtualPanelId);
  }

  /**
   * @deprecated Use isPanelRunning with real panel IDs instead
   */
  isSessionRunning(sessionId: string): boolean {
    console.warn(`[${this.getCliToolName()}Manager] DEPRECATED: isSessionRunning called with virtual panel ID for session ${sessionId}. Use real panel IDs instead.`);
    const virtualPanelId = `session-${sessionId}`;
    return this.isPanelRunning(virtualPanelId);
  }

  // Protected utility methods

  /**
   * Find and store tool-specific session ID for resume functionality
   * This is used by CLI tools that have their own session management systems
   * @param panelId The panel ID
   * @param sessionIdPath Path to search for session files
   * @param extractSessionId Function to extract session ID from a session file
   */
  protected async findAndStoreToolSessionId(
    panelId: string,
    sessionIdPath: string,
    extractSessionId: (filePath: string, worktreePath: string) => Promise<string | null>
  ): Promise<void> {
    try {
      const fs = await import('fs').then(m => m.promises);
      const path = await import('path');
      
      // Check if session directory exists
      try {
        await fs.access(sessionIdPath);
      } catch {
        this.logger?.verbose(`[${this.getCliToolName()}] Session directory not found: ${sessionIdPath}`);
        return;
      }

      // Get the worktree path for this panel
      const process = this.processes.get(panelId);
      if (!process) {
        this.logger?.warn(`[${this.getCliToolName()}] No process found for panel ${panelId}`);
        return;
      }

      // Extract session ID
      const sessionId = await extractSessionId(sessionIdPath, process.worktreePath);
      
      if (sessionId) {
        this.logger?.info(`[${this.getCliToolName()}] Found session ID for panel ${panelId}: ${sessionId}`);
        
        // Store the session ID in the panel's custom state
        if (this.sessionManager) {
          // Use panelManager instead of direct database access
          const { panelManager } = await import('../../panelManager');
          const panel = await panelManager.getPanel(panelId);
          if (panel) {
            const currentState = panel.state || {};
            const customState = (currentState.customState as Record<string, unknown>) || {};
            
            // Only update if we don't already have a session ID
            const toolSessionKey = `${this.getCliToolName().toLowerCase()}SessionId`;
            if (!customState[toolSessionKey]) {
              const updatedState = {
                ...currentState,
                customState: { ...customState, [toolSessionKey]: sessionId }
              };
              
              await panelManager.updatePanel(panelId, { state: updatedState });
              this.logger?.verbose(`[${this.getCliToolName()}] Stored session ID in panel ${panelId}: ${sessionId}`);
            }
          }
        }
      } else {
        this.logger?.verbose(`[${this.getCliToolName()}] No session ID found for panel ${panelId}`);
      }
    } catch (error) {
      this.logger?.error(`[${this.getCliToolName()}] Error finding session ID: ${error}`);
    }
  }

  /**
   * Process-global key recording that this CLI's executable is a script whose
   * shebang interpreter is unreachable, so every spawn must go straight to the
   * explicit-Node invocation.
   */
  protected nodeFallbackFlagKey(): string {
    return `${this.getCliToolName().toLowerCase()}NeedsNodeFallback`;
  }

  /**
   * Pin the Node fallback for subsequent spawns.
   *
   * Called by the availability probe when `--version` only succeeded through an
   * explicit Node invocation. Without this the PTY spawn would still try the
   * bare shim first and appear to succeed: node-pty forks before it execs, so
   * the shebang failure happens in the child and never throws on the parent
   * side — the terminal just shows `env: node: No such file or directory` and
   * the process exits, which is NOT one of the errors spawnPtyProcess's own
   * retry can observe.
   */
  protected markNeedsNodeFallback(): void {
    (global as typeof global & Record<string, boolean>)[this.nodeFallbackFlagKey()] = true;
  }

  /**
   * Diagnosis for the "found it, but its interpreter is missing" failure, or
   * null for any other failure.
   *
   * WHY: the generic "install it or check your PATH" text is actively wrong
   * here — the CLI *was* installed and *was* found on PATH. Only its shebang
   * interpreter was missing, and saying so turns a reinstall cycle into a
   * one-line fix.
   */
  protected missingInterpreterAdvice(error?: string): string | null {
    const interpreter = describeMissingInterpreter(error);
    if (!interpreter) return null;
    const toolName = this.getCliToolName();
    return [
      `${toolName} WAS found, but the executable is a script whose interpreter "${interpreter}" is not on the spawn PATH.`,
      `This is typically an npm global shim (#!/usr/bin/env ${interpreter}) combined with a version-manager ${interpreter} (nvm/fnm/volta/asdf) that a GUI-launched app does not inherit.`,
      `Fix by installing a native ${toolName} binary, or by adding the directory containing "${interpreter}" under Settings → Additional paths.`,
    ].join('\n');
  }

  /**
   * Get cached availability result or perform fresh check
   */
  protected async getCachedAvailability(): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    if (this.availabilityCache &&
        (Date.now() - this.availabilityCache.timestamp) < this.CACHE_TTL) {
      this.logger?.verbose(`Using cached ${this.getCliToolName()} availability check`);
      return this.availabilityCache.result;
    }

    // Perform fresh check
    const availability = await this.testCliAvailability();

    // Cache the result
    this.availabilityCache = {
      result: availability,
      timestamp: Date.now()
    };

    return availability;
  }

  /**
   * Handle CLI not available error
   */
  protected async handleCliNotAvailable(availability: { available: boolean; error?: string }, panelId: string, sessionId: string): Promise<void> {
    this.logger?.error(`${this.getCliToolName()} not available: ${availability.error}`);
    this.logger?.error(`Current PATH: ${process.env.PATH}`);
    this.logger?.error(`Enhanced PATH searched: ${getShellPath()}`);

    // Emit error message to show in the UI
    const errorMessage = {
      type: 'session',
      data: {
        status: 'error',
        message: `${this.getCliToolName()} not available`,
        details: this.getCliNotAvailableMessage(availability.error)
      }
    };

    this.emit('output', {
      panelId,
      sessionId,
      type: 'json',
      data: errorMessage,
      timestamp: new Date()
    } as CliOutputEvent);

    // Add dedicated error output. Best-effort: workflow-run panels (the
    // orchestrator / interactive-substrate path) have no Crystal `sessions` row,
    // so this session-scoped INSERT would throw a FOREIGN KEY constraint error
    // and BECOME the run's failure — masking the real "not available" reason.
    // The 'output' emit above already surfaces the error to the orchestrator and
    // renderer, so a failed session write must never crash the run.
    try {
      this.sessionManager.addSessionError(
        sessionId,
        `${this.getCliToolName()} not available`,
        `${availability.error}\n${
          this.missingInterpreterAdvice(availability.error) ??
          `Please install ${this.getCliToolName()} or verify it is in your PATH.`
        }`
      );
    } catch (err) {
      this.logger?.warn(
        `${this.getCliToolName()} not-available session write skipped for ${sessionId} (no sessions row?): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Get CLI not available error message (can be overridden by subclasses)
   */
  protected getCliNotAvailableMessage(error?: string): string {
    const interpreterAdvice = this.missingInterpreterAdvice(error);
    if (interpreterAdvice) {
      return [
        `Error: ${error}`,
        '',
        interpreterAdvice,
        '',
        `Enhanced PATH searched: ${getShellPath()}`,
      ].join('\n');
    }

    return [
      `Error: ${error}`,
      '',
      `${this.getCliToolName()} is not installed or not found in your PATH.`,
      '',
      `Please install ${this.getCliToolName()}:`,
      '1. Follow the installation instructions for your platform',
      `2. Verify installation by running "${this.getCliToolName()} --version" in your terminal`,
      '',
      `If ${this.getCliToolName()} is installed but not in your PATH:`,
      `- Add the ${this.getCliToolName()} installation directory to your PATH environment variable`,
      '- Or set a custom executable path in Cyboflow Settings',
      '',
      `Enhanced PATH searched: ${getShellPath()}`,
      `Attempted command: ${this.getCliToolName()} --version`
    ].join('\n');
  }

  /**
   * Get enhanced system environment with PATH
   * Uses centralized shellPath utility for consistent PATH management
   */
  protected async getSystemEnvironment(): Promise<{ [key: string]: string }> {
    // Get the enhanced PATH from centralized utility
    const shellPath = getShellPath();

    // Find Node.js and ensure it's in the PATH
    const nodePath = await findNodeExecutable();
    const nodeDir = path.dirname(nodePath);

    // Combine Node.js directory with enhanced PATH (':' on POSIX, ';' on Windows)
    const pathWithNode = nodeDir + path.delimiter + shellPath;

    return {
      ...process.env,
      PATH: pathWithNode,
      // Mark the tree as agent-spawned so a project gate run from inside this
      // CLI self-governs its vitest fork pool instead of taking a full
      // one-worker-per-CPU pool per concurrent sprint lane.
      ...managedTestConcurrencyEnv()
    } as { [key: string]: string };
  }


  /**
   * Spawn PTY process with error handling and Node.js fallback
   * This handles the common case where CLI tools are Node.js scripts with shebangs
   * that may not work correctly on all systems
   */
  protected async spawnPtyProcess(command: string, args: string[], cwd: string, env: { [key: string]: string }): Promise<pty.IPty> {
    if (!pty) {
      throw new Error('node-pty not available');
    }

    const fullCommand = `${command} ${args.join(' ')}`;
    this.logger?.verbose(`Executing ${this.getCliToolName()} command: ${fullCommand}`);
    this.logger?.verbose(`Working directory: ${cwd}`);

    let ptyProcess: pty.IPty;
    let spawnAttempt = 0;
    let lastError: unknown;
    const needsNodeFallbackKey = this.nodeFallbackFlagKey();

    // Try normal spawn first, then fallback to Node.js invocation if it fails
    while (spawnAttempt < 2) {
      try {
        const startTime = Date.now();

        if (spawnAttempt === 0 && !(global as typeof global & Record<string, boolean>)[needsNodeFallbackKey]) {
          // First attempt: normal spawn
          ptyProcess = pty.spawn(command, args, {
            name: 'xterm-color',
            cols: 80,
            rows: 30,
            cwd,
            env
          });
        } else {
          // Second attempt or if we know we need Node.js: use Node.js directly
          this.logger?.verbose(`[${this.getCliToolName()}] Using Node.js fallback for execution`);

          // Try to find the CLI script (for npm-installed tools)
          let scriptPath = command;
          
          // For tools installed via npm, the command might be a symlink to a script
          // Try using the nodeFinder utility to locate the actual script
          try {
            // Use dynamic import to avoid circular dependencies
            const { findCliNodeScript } = await import('../../../utils/nodeFinder');
            const foundScript = findCliNodeScript(command);
            if (foundScript) {
              scriptPath = foundScript;
              this.logger?.verbose(`[${this.getCliToolName()}] Found script at: ${scriptPath}`);
            }
          } catch (e) {
            // If we can't find the script helper, just use the command as-is
            this.logger?.verbose(`[${this.getCliToolName()}] Using command directly for Node.js invocation`);
          }

          const nodePath = await findNodeExecutable();
          this.logger?.verbose(`[${this.getCliToolName()}] Using Node.js: ${nodePath}`);

          // Spawn with Node.js directly
          const nodeArgs = scriptPath === command
            ? [command, ...args] // Command might be a direct script path
            : ['--no-warnings', '--enable-source-maps', scriptPath, ...args]; // Found script path

          // Fork-bomb guard: when findNodeExecutable falls back to process.execPath
          // (the packaged Electron/app binary used as a Node runtime), it must be
          // launched with ELECTRON_RUN_AS_NODE=1 so it runs as plain Node instead of
          // re-booting the whole Electron app. Scope this to the execPath branch only;
          // a real external `node` never needs (or wants) this flag.
          const nodeEnv = nodePath === process.execPath
            ? { ...env, ELECTRON_RUN_AS_NODE: '1' }
            : env;

          ptyProcess = pty.spawn(nodePath, nodeArgs, {
            name: 'xterm-color',
            cols: 80,
            rows: 30,
            cwd,
            env: nodeEnv
          });
        }

        const spawnTime = Date.now() - startTime;
        this.logger?.verbose(`${this.getCliToolName()} process spawned successfully in ${spawnTime}ms`);
        return ptyProcess;
      } catch (spawnError) {
        lastError = spawnError;
        spawnAttempt++;

        if (spawnAttempt === 1 && !(global as typeof global & Record<string, boolean>)[needsNodeFallbackKey]) {
          const errorMsg = spawnError instanceof Error ? spawnError.message : String(spawnError);
          this.logger?.error(`First ${this.getCliToolName()} spawn attempt failed: ${errorMsg}`);

          // Check for typical shebang-related errors
          if (errorMsg.includes('No such file or directory') ||
              errorMsg.includes('env: node:') ||
              errorMsg.includes('is not recognized') ||
              errorMsg.includes('ENOENT')) {
            this.logger?.verbose(`Error suggests shebang issue, will try Node.js fallback`);
            (global as typeof global & Record<string, boolean>)[needsNodeFallbackKey] = true;
            continue;
          }
        }
        break;
      }
    }

    // If we failed after all attempts, handle the error
    const errorMsg = lastError instanceof Error ? lastError.message : String(lastError);
    this.logger?.error(`Failed to spawn ${this.getCliToolName()} process after ${spawnAttempt} attempts: ${errorMsg}`);
    // node-pty spawn of the interactive REPL failed after the normal + Node
    // shebang-fallback attempts (ENOENT / 'env: node:' / not recognized). This
    // PTY path is interactive-substrate only (the SDK uses query(), not a PTY).
    // Fixed message + bounded errorClass — errorMsg (which may include a spawn
    // command line / paths) stays in the local logger.error above.
    const spawnErrorClass = classifyErrorPattern(errorMsg);
    captureSeamError('pty-spawn-failed', new Error(`pty spawn failed (${spawnErrorClass})`), {
      substrate: 'interactive',
      cliTool: this.getCliToolName(),
      errorClass: spawnErrorClass,
      ...unclassifiedErrorTags(spawnErrorClass, errorMsg),
    });
    throw new Error(`Failed to spawn ${this.getCliToolName()}: ${errorMsg}`);
  }

  /**
   * Set up event handlers for a PTY process
   */
  protected setupProcessHandlers(ptyProcess: pty.IPty, panelId: string, sessionId: string): void {
    // A fresh process owns this panel id now, so any deliberate-kill flag left
    // by a predecessor that never emitted an exit is stale — drop it rather than
    // let it suppress a genuine failure from THIS process.
    this.deliberatelyKilledPanels.delete(panelId);

    let hasReceivedOutput = false;
    let lastOutput = '';
    let buffer = '';

    ptyProcess.onData((data: string) => {
      hasReceivedOutput = true;
      // lastOutput only backs the exit-time diagnostic tail (see
      // handleProcessRuntimeFailure) — bound it so a long-lived process can't
      // accumulate its entire lifetime of output in memory.
      lastOutput = (lastOutput + data).slice(-LAST_OUTPUT_TAIL_BYTES);
      buffer += data;

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      // Guard against a pathological stretch with no newline (or a single
      // runaway line) growing the incomplete-line remainder without bound.
      // Complete lines above are already split out and emitted regardless,
      // so this only ever trims the still-unterminated trailing portion.
      if (buffer.length > LINE_BUFFER_CAP_BYTES) {
        this.logger?.verbose(`[${this.getCliToolName()}] incomplete-line buffer exceeded ${LINE_BUFFER_CAP_BYTES} bytes for session ${sessionId}; dropping oldest bytes`);
        buffer = buffer.slice(-LINE_BUFFER_CAP_BYTES);
      }

      for (const line of lines) {
        if (line.trim()) {
          const outputEvents = this.parseCliOutput(line + '\n', panelId, sessionId);
          for (const event of outputEvents) {
            this.emit('output', event);
          }
        }
      }
    });

    ptyProcess.onExit(async ({ exitCode, signal }) => {
      // Check for and kill any child processes
      const pid = ptyProcess.pid;
      if (pid) {
        const descendantPids = await this.getAllDescendantPids(pid);
        if (descendantPids.length > 0) {
          const killedProcesses = await this.getProcessInfo(descendantPids);
          this.logger?.info(`[${this.getCliToolName()}] Found ${descendantPids.length} orphaned child processes after ${this.getCliToolName()} exit for session ${sessionId}`);

          await this.killProcessTree(pid, panelId, sessionId);

          const processReport = killedProcesses.map(p => `${p.name || 'unknown'}(${p.pid})`).join(', ');
          const message = `\n[Process Cleanup] Terminated ${killedProcesses.length} orphaned child process${killedProcesses.length > 1 ? 'es' : ''} after ${this.getCliToolName()} exit: ${processReport}\n`;
          this.emit('output', {
            panelId,
            sessionId,
            type: 'stdout',
            data: message,
            timestamp: new Date()
          } as CliOutputEvent);
        }
      }

      // Process any remaining data in the buffer
      if (buffer.trim()) {
        const outputEvents = this.parseCliOutput(buffer, panelId, sessionId);
        for (const event of outputEvents) {
          this.emit('output', event);
        }
      }

      // Was this teardown asked for? Read (and clear) before the branch below so
      // the flag never outlives the process it described.
      const wasDeliberatelyKilled = this.deliberatelyKilledPanels.delete(panelId);

      if (exitCode !== 0) {
        this.logger?.error(`${this.getCliToolName()} process failed for session ${sessionId}. Exit code: ${exitCode}, Signal: ${signal}`);

        // Report the interactive REPL's non-zero exit — the interactive-substrate
        // run-failure chokepoint. The raw PTY tail (lastOutput) is DELIBERATELY
        // kept out of the message: it is unstructured terminal output that can
        // contain user source, prompt text, or secrets, and the Sentry scrub only
        // redacts home paths (not arbitrary content). Instead classifyErrorPattern
        // distills lastOutput into a bounded, non-PII `errorClass` bucket, and
        // exitCode + phase (never-started vs runtime crash) carry the rest.
        //
        // Skipped for deliberate terminations — an app-initiated kill, or a
        // SIGHUP/SIGINT/SIGTERM from anywhere (app quit, OS shutdown). Those are
        // not defects, and capturing them produced a permanently-recurring
        // "process exited (code 143)" Sentry issue that buried the real
        // non-zero exits. The UI failure handling below is intentionally
        // unchanged: only the telemetry is suppressed.
        if (!wasDeliberatelyKilled && !isDeliberateTermination(exitCode, signal)) {
          captureSeamError(
            'interactive-process-exit-failed',
            new Error(`${this.getCliToolName()} process exited (code ${exitCode})`),
            {
              substrate: 'interactive',
              cliTool: this.getCliToolName(),
              exitCode: String(exitCode),
              phase: hasReceivedOutput ? 'runtime' : 'startup',
              errorClass: classifyErrorPattern(lastOutput),
            },
          );
        }

        if (!hasReceivedOutput) {
          await this.handleProcessStartupFailure(exitCode, signal, panelId, sessionId, lastOutput);
        } else {
          await this.handleProcessRuntimeFailure(exitCode, signal, panelId, sessionId, lastOutput);
        }
      } else {
        this.logger?.info(`${this.getCliToolName()} process exited normally for panel ${panelId} (session ${sessionId})`);
      }

      // Clean up CLI-specific resources — scoped to THIS panel.
      await this.cleanupCliResources(panelId, sessionId);

      this.emit('exit', {
        panelId,
        sessionId,
        exitCode,
        signal: signal ?? null
      } as CliExitEvent);
      this.processes.delete(panelId);
    });
  }

  /**
   * Handle process startup failure
   */
  protected async handleProcessStartupFailure(exitCode: number | null, signal: number | undefined, panelId: string, sessionId: string, lastOutput: string): Promise<void> {
    this.logger?.error(`No output received from ${this.getCliToolName()}. This might indicate a startup failure.`);

    const errorMessage = {
      type: 'session',
      data: {
        status: 'error',
        message: `${this.getCliToolName()} failed to start (exit code: ${exitCode})`,
        details: [
          `This usually means ${this.getCliToolName()} is not installed properly or not found in your PATH.`,
          '',
          'Please ensure:',
          `1. ${this.getCliToolName()} is installed`,
          `2. The "${this.getCliToolName()}" command is available in your terminal`,
          '3. Your PATH environment variable includes the installation directory',
          '',
          `Exit code: ${exitCode}${signal ? `, Signal: ${signal}` : ''}`,
          '',
          'You can also set a custom executable path in the Settings.'
        ].join('\n')
      }
    };

    this.emit('output', {
      panelId,
      sessionId,
      type: 'json',
      data: errorMessage,
      timestamp: new Date()
    } as CliOutputEvent);
  }

  /**
   * Handle process runtime failure
   */
  protected async handleProcessRuntimeFailure(exitCode: number | null, signal: number | undefined, panelId: string, sessionId: string, lastOutput: string): Promise<void> {
    this.logger?.error(`Last output from ${this.getCliToolName()}: ${lastOutput.slice(-500)}`);

    const errorMessage = {
      type: 'session',
      data: {
        status: 'error',
        message: `${this.getCliToolName()} exited with error (exit code: ${exitCode})`,
        details: lastOutput.length > 0 ? `Last output:\n${lastOutput.slice(-500)}` : 'No additional details available'
      }
    };

    this.emit('output', {
      panelId,
      sessionId,
      type: 'json',
      data: errorMessage,
      timestamp: new Date()
    } as CliOutputEvent);
  }

  // Process management utilities

  /**
   * Get all descendant PIDs of a parent process recursively
   *
   * The per-platform enumeration strategy (PowerShell (pid, ppid) table on
   * win32, per-level recursion on POSIX) lives in utils/platformProcess.ts.
   * This site injects its own POSIX one-level lister because it differs
   * from the other sites': `pgrep -P <ppid>` lists direct child PIDs and is
   * portable across macOS/BSD and Linux, while GNU `ps --ppid` is Linux-only
   * and silently returned no descendants on macOS (the primary ship platform).
   */
  protected getAllDescendantPids(parentPid: number): Promise<number[]> {
    return collectDescendantPidsAsync(parentPid, {
      posixChildPids: async (ppid) => {
        const { stdout } = await this.execAsync(`pgrep -P ${ppid} 2>/dev/null || true`);
        return String(stdout).split('\n')
          .map((line: string) => parseInt(line.trim(), 10))
          .filter((pid: number) => Number.isInteger(pid) && pid !== ppid);
      },
      onWalkError: (error) => this.logger?.warn(`Error getting descendant PIDs for ${parentPid}:`, error as Error),
    });
  }

  /**
   * A short name per pid, for the zombie report. The platform split lives in
   * utils/platformProcess (describeProcesses): `ps -o comm=` on POSIX, the
   * shared process table on Windows, which has no `ps`.
   */
  protected async getProcessInfo(pids: number[]): Promise<{ pid: number; name?: string }[]> {
    return describeProcesses(pids, {
      execCommand: (command) => this.execAsync(command),
      onError: (error) =>
        this.logger?.warn('Error getting process info from the Windows process table:', error as Error),
    });
  }

  /**
   * Kill a process and all its descendants.
   *
   * Both platform ladders live in utils/platformProcess.ts (killTree): win32 —
   * the shared taskkill ladder (graceful /T, bounded poll, /T /F, per-
   * descendant forced kills); POSIX — SIGTERM → group TERM → SIGKILL
   * escalation with NO pgid lookup (the pty child is its own group leader, so
   * the root pid IS the group id — posixGroupMode 'root') and the historical
   * fixed 200ms between SIGTERM and SIGKILL. This site contributes its seams
   * (execCommand, the pgrep-based descendant lister), its zombie reporting
   * (process names via getProcessInfo, emitted as CLI output) and the final
   * pty-kill fallback.
   */
  protected async killProcessTree(pid: number, panelId: string, sessionId: string): Promise<boolean> {
    const descendantPids = await this.getAllDescendantPids(pid);
    this.logger?.info(`[${this.getCliToolName()}] Found ${descendantPids.length} descendant processes for PID ${pid} in session ${sessionId}`);

    const success = await killTree(pid, {
      logger: {
        info: (message) => this.logger?.info(`[${this.getCliToolName()}] ${message}`),
        warn: (message, error) =>
          this.logger?.warn(`[${this.getCliToolName()}] ${message}`, error as Error),
      },
      descendantPids,
      execCommand: (command) => this.execAsync(command),
      // Grace: win32 keeps the bounded-poll defaults (return the moment the
      // pid is gone, capped at ~2s); POSIX kept a fixed, non-probed 200ms.
      graceMode: process.platform === 'win32' ? 'poll' : 'fixed',
      graceMs: process.platform === 'win32' ? 2000 : 200,
      posixGroupMode: 'root',
      listDescendants: () => this.getAllDescendantPids(pid),
      onGracefulError: (error) => {
        this.logger?.verbose(`[${this.getCliToolName()}] Graceful taskkill for ${pid} did not settle (expected for console apps): ${error}`);
      },
      onSurvivors: async (remainingPids) => {
        this.logger?.error(`[${this.getCliToolName()}] WARNING: ${remainingPids.length} zombie processes remain: ${remainingPids.join(', ')}`);
        const remainingProcesses = await this.getProcessInfo(remainingPids);
        const processReport = remainingProcesses.map(p => `${p.name || 'unknown'}(${p.pid})`).join(', ');
        this.emit('output', {
          panelId,
          sessionId,
          type: 'stderr',
          data: `\n[WARNING] Failed to terminate ${remainingPids.length} child process${remainingPids.length > 1 ? 'es' : ''}: ${processReport}\nPlease manually kill these processes.\n`,
          timestamp: new Date()
        } as CliOutputEvent);
      },
      onError: (error) => this.logger?.error(`[${this.getCliToolName()}] Error in killProcessTree:`, error as Error),
    });

    // Always try to kill via pty interface as final fallback
    try {
      const cliProcess = this.processes.get(panelId);
      if (cliProcess) {
        cliProcess.process.kill();
      }
    } catch (error) {
      // Process might already be dead
    }

    return success;
  }
}