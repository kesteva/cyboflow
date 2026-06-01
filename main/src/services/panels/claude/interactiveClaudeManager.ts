import * as path from 'path';
import { execSync } from 'child_process';
import type Database from 'better-sqlite3';
import type * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import type { Logger } from '../../../utils/logger';
import type { ConfigManager } from '../../configManager';
import type { ConversationMessage } from '../../../database/models';
import { getShellPath, findExecutableInPath } from '../../../utils/shellPath';
import { ApprovalRouter } from '../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../orchestrator/questionRouter';
import { AbstractCliManager } from '../cli/AbstractCliManager';
import { EventRouter, RawEventsSink, TypedEventNarrowing } from '../../streamParser';
import { TranscriptTailSource } from './transcript/transcriptTailSource';
import type { TranscriptSource, TurnEndMarker } from './transcript/transcriptSource';
import { buildStepReportingAppend } from '../../../orchestrator/prompts/step-reporting-instructions';
import { resolveWorkflowDefinition } from '../../../../../shared/types/workflows';

/**
 * InteractiveClaudeManager — the interactive (subscription-billed) Claude
 * substrate (IDEA-013 S3 / TASK-808).
 *
 * A sibling of ClaudeCodeManager (the SDK substrate). It extends
 * AbstractCliManager and OVERRIDES ONLY the abstract hooks — the LIVE base PTY
 * machinery (`spawnPtyProcess`, `setupProcessHandlers`, `killProcessTree`) is
 * inherited VERBATIM and must NOT be redeclared here (grep-enforced).
 *
 * Unlike the SDK manager, this drives a REAL interactive `claude` REPL with no
 * headless print flag and no stream-json output flag (the interactive REPL is
 * the noise terminal stream). Structured panel fidelity is instead
 * recovered out of band by a `TranscriptTailSource` (TASK-807) that tails the
 * on-disk `~/.claude/projects/<key>/<uuid>.jsonl` transcript and surfaces
 * ALREADY-NORMALIZED, stream-json-shaped panel objects. Each such line flows:
 *   narrow -> router.emitForRun(runId) -> emit('output', { panelId, sessionId,
 *   type: 'json', data, timestamp })
 * FIELD-IDENTICAL to the SDK envelope (claudeCodeManager.ts:383-389) so
 * runEventBridge + the structured Claude panel need ZERO edits.
 *
 * COMPLETION is TURN-END-driven (Probe C). Interactive `claude` writes NO
 * terminal `{type:'result'}` line and the REPL does NOT self-exit. On the
 * TranscriptSource `onTurnEnd` signal we write EOF/`/exit` to PTY stdin to end
 * the REPL turn; the inherited `setupProcessHandlers.onExit` (after a short
 * transcript-drain settle window) is what RESOLVES the spawn promise — so a
 * hung PTY awaiting input (no turn-end) NEVER spuriously resolves. PTY
 * quiescence is explicitly REJECTED as the completion signal.
 */

/* ---------------------------------------------------------------------------
 * Per-option parity table (decision record — mirror of the SDK manager).
 * Each row is the EXPLICIT interactive decision vs the SDK branch it mirrors.
 *
 *   model            : pass `--model X` ONLY when (model && model !== 'auto');
 *                      the DB session_info row uses (model || 'default').
 *                      Mirrors claudeCodeManager.ts:463 / :295.
 *   permissionMode   : 'ignore' (dontAsk / auto-allow) SKIPS writing the gating
 *                      shell hook — matching the SDK's permissionMode==='ignore'
 *                      branch that omits the PreToolUse hook
 *                      (claudeCodeManager.ts:446). The hook WRITE body itself is
 *                      owned by S5/TASK-810 (interactiveSettingsWriter); here we
 *                      only gate the seam call so 'ignore' produces no hook-write.
 *   strictMcpConfig  : threads `--strict-mcp-config` iff strictMcpConfig===true,
 *                      so only the per-run `.mcp.json` servers load and user
 *                      globals cannot interfere with the permission bridge.
 *                      Mirrors claudeCodeManager.ts:188.
 *   settingSources   : EXPLICIT decision — interactive ISOLATES from user/global
 *                      settings via the generated `--settings <path>` file (NOT
 *                      a silent flip of the SDK's settingSources:['user','project']).
 *                      The SDK reads ['user','project']; the interactive REPL has
 *                      no settingSources option, so isolation is achieved with
 *                      `--settings` pointing at the per-run file S5 owns. This is
 *                      a deliberate read-vs-isolate divergence, documented here.
 *   resume/isResume  : v1 is FRESH-SESSION-ONLY. Interactive `--resume` /
 *                      `--session-id` continuity is NOT implemented (#44607 is
 *                      ignored interactively). isResume is accepted but no
 *                      `--resume` flag is emitted.
 *   systemPromptAppend: NO interactive append channel exists. Delivery is via
 *                      prompt-body prepend in S6/TASK-811 — NOT implemented here.
 * ------------------------------------------------------------------------- */

/** CLI spawn options accepted by the interactive substrate. */
interface InteractiveClaudeSpawnOptions {
  panelId: string;
  sessionId: string;
  worktreePath: string;
  prompt: string;
  conversationHistory?: string[];
  /**
   * v1 fresh-session-only: accepted for interface parity but NEVER emits a
   * `--resume` flag interactively (#44607 ignored — see parity table).
   */
  isResume?: boolean;
  permissionMode?: 'approve' | 'ignore';
  model?: string;
  /**
   * The workflow_runs row ID for ApprovalRouter / the per-run RawEventsSink. For
   * workflow runs this equals panelId (RunExecutor invariant). For quick sessions
   * it is resolved from sessions.run_id and differs from panelId. Falls back to
   * panelId when unset.
   */
  runId?: string;
  /** When true, `--strict-mcp-config` is threaded (see parity table). */
  strictMcpConfig?: boolean;
  /**
   * NO interactive append channel — delivered via prompt-body prepend in
   * S6/TASK-811. Accepted for parity; not consumed here.
   */
  systemPromptAppend?: string;
  [key: string]: unknown;
}

/** Per-run pipeline tuple stored in the pipelines map. */
interface PipelineTuple {
  router: EventRouter;
  sink: RawEventsSink;
  runId: string;
}

/**
 * Per-run interactive bookkeeping, keyed by panelId. Holds the completion
 * deferred whose `resolve`/`reject` are invoked ONLY from the inherited onExit
 * path (after the settle window) — never directly from onTurnEnd.
 */
interface InteractiveRun {
  panelId: string;
  sessionId: string;
  runId: string;
  worktreePath: string;
  /** True once an EOF/`/exit` has been written in response to a turn-end. */
  turnEnded: boolean;
  /** Resolves the spawn promise on clean exit. */
  resolve: () => void;
  /** Rejects the spawn promise on non-zero exit (drives RunExecutor 'failed'). */
  reject: (err: Error) => void;
}

/** Discovery bound on the spawn -> first-`.jsonl` race (ms). */
const DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Transcript-drain settle window (ms). Exists ONLY to prevent tail truncation
 * between PTY exit and the final transcript appends being read; it is NOT the
 * completion signal (Probe C / Q4).
 */
const SETTLE_MS = 500;

/** EOF control byte (Ctrl-D) written to PTY stdin to end the REPL turn. */
const EOF_BYTE = '\x04';

export class InteractiveClaudeManager extends AbstractCliManager {
  /** Per-run pipeline (router -> sink), keyed by panelId. */
  private readonly pipelines = new Map<string, PipelineTuple>();

  /** Per-run TranscriptSource, keyed by panelId. */
  private readonly tailSources = new Map<string, TranscriptSource>();

  /** Per-run interactive bookkeeping (completion deferred), keyed by panelId. */
  private readonly interactiveRuns = new Map<string, InteractiveRun>();

  /**
   * Optional orchestrator IPC socket path. When set, initializeCliEnvironment
   * injects CYBOFLOW_RUN_ID / CYBOFLOW_ORCH_SOCKET so the interactive REPL's
   * cyboflow MCP server entry can reach the orchestrator socket. Set at boot via
   * setOrchSocketPath() (mirrors claudeCodeManager.ts:105).
   */
  private orchSocketPath: string | null = null;

  /**
   * Cached executable path resolved by the last availability probe. Used by
   * getCliExecutablePath() so spawn does not re-probe the shell PATH.
   */
  private resolvedExecutablePath: string | null = null;

  /**
   * Narrower owned by this manager. Every transcript line flows through
   * `narrowing.narrow()` before reaching the EventRouter. Constructed in the
   * constructor after super() so this.logger is available — passing the logger
   * enables verbose Zod-failure diagnostics per the CLAUDE.md optional-logger
   * rule (omitting it silently no-ops observability).
   */
  private readonly narrowing: TypedEventNarrowing;

  constructor(
    sessionManager: import('../../sessionManager').SessionManager,
    logger: Logger | undefined,
    configManager: ConfigManager | undefined,
    private readonly db: Database.Database,
  ) {
    super(sessionManager, logger, configManager);
    if (db == null) {
      throw new TypeError('[InteractiveClaudeManager] db argument is required; RawEventsSink cannot operate without a database handle.');
    }
    this.narrowing = new TypedEventNarrowing(this.logger);
  }

  /**
   * Inject the orchestrator IPC socket path so the cyboflow MCP server entry can
   * reach the orchestrator. Mirrors the setOrchSocketPath seam from
   * claudeCodeManager.ts:105. Call once at boot after the IPC server starts.
   */
  setOrchSocketPath(socketPath: string): void {
    this.orchSocketPath = socketPath;
  }

  // ---------------------------------------------------------------------------
  // Required AbstractCliManager abstract-method implementations
  // ---------------------------------------------------------------------------

  protected getCliToolName(): string {
    return 'Claude Code (Interactive)';
  }

  /**
   * Probe the REAL `claude` binary. Unlike the SDK manager (whose in-process
   * substrate is ALWAYS available), a missing binary MUST surface
   * `{ available: false }` so the spawn startup path fails loudly.
   *
   * Resolution order honors a custom path first, then config
   * `claudeExecutablePath`, then the shell PATH via findExecutableInPath.
   */
  protected async testCliAvailability(customPath?: string): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    // Ensure the enhanced shell PATH is loaded before probing.
    getShellPath();

    const configuredPath = customPath ?? this.configManager?.getConfig()?.claudeExecutablePath;
    const resolvedPath = configuredPath ?? findExecutableInPath('claude');

    if (!resolvedPath) {
      this.resolvedExecutablePath = null;
      return {
        available: false,
        error: 'claude executable not found in PATH and no claudeExecutablePath configured',
      };
    }

    try {
      const version = execSync(`"${resolvedPath}" --version`, {
        encoding: 'utf8',
        timeout: 10_000,
      }).trim();
      this.resolvedExecutablePath = resolvedPath;
      return { available: true, version, path: resolvedPath };
    } catch (err) {
      this.resolvedExecutablePath = null;
      const message = err instanceof Error ? err.message : String(err);
      return {
        available: false,
        error: `Failed to run "${resolvedPath} --version": ${message}`,
        path: resolvedPath,
      };
    }
  }

  /**
   * Resolve the `claude` executable path from the last availability probe, or
   * re-probe if not yet resolved. Throws if the binary is unavailable.
   */
  protected async getCliExecutablePath(): Promise<string> {
    if (this.resolvedExecutablePath) {
      return this.resolvedExecutablePath;
    }
    const availability = await this.testCliAvailability();
    if (!availability.available || !availability.path) {
      throw new Error(`Claude Code (Interactive) not available: ${availability.error ?? 'unknown error'}`);
    }
    return availability.path;
  }

  /**
   * Build the INTERACTIVE argv: NEITHER the headless print flag NOR the
   * stream-json output flag (the interactive REPL is the noise terminal stream
   * and structured events come exclusively from the TranscriptSource).
   *
   * See the per-option parity table at the top of this file for the
   * model / strictMcpConfig / settingSources / resume decisions.
   */
  protected buildCommandArgs(options: InteractiveClaudeSpawnOptions): string[] {
    const args: string[] = [];

    // model: pass `--model X` ONLY for a concrete model; 'auto'/'default' omit.
    if (options.model && options.model !== 'auto' && options.model !== 'default') {
      args.push('--model', options.model);
    }

    // strictMcpConfig: isolate to per-run .mcp.json servers only.
    if (options.strictMcpConfig) {
      args.push('--strict-mcp-config');
    }

    // Inject the cyboflow MCP stdio entry and isolate from user settings. The
    // actual `.mcp.json` / settings+hook file is GENERATED by S5/TASK-810; here
    // we only emit the flags pointed at the path that writer will own.
    const settingsPath = path.join(options.worktreePath, '.cyboflow', 'interactive-settings.json');
    const mcpConfigPath = path.join(options.worktreePath, '.cyboflow', 'interactive-mcp.json');
    args.push('--mcp-config', mcpConfigPath);
    // settingSources read-vs-isolate decision: ISOLATE via `--settings` (see
    // parity table). NOT a silent flip of the SDK's ['user','project'].
    args.push('--settings', settingsPath);

    return args;
  }

  /**
   * Initialize the interactive environment. Passes CYBOFLOW_RUN_ID /
   * CYBOFLOW_ORCH_SOCKET through when an orchestrator socket has been injected.
   * S6/TASK-811 asserts CYBOFLOW_RUN_ID === workflow_runs.id; this task only
   * wires the passthrough and does NOT re-touch composeMcpServers (TASK-800).
   */
  protected async initializeCliEnvironment(options: InteractiveClaudeSpawnOptions): Promise<{ [key: string]: string }> {
    const env: { [key: string]: string } = {};
    if (this.orchSocketPath) {
      const sessionRow = this.sessionManager.getDbSession(options.sessionId);
      const runId = (sessionRow?.run_id as string | null | undefined) ?? options.runId ?? options.panelId;
      env.CYBOFLOW_RUN_ID = runId;
      env.CYBOFLOW_ORCH_SOCKET = this.orchSocketPath;
    }
    return env;
  }

  /** Additional interactive env (none by default). */
  protected async getCliEnvironment(_options: InteractiveClaudeSpawnOptions): Promise<{ [key: string]: string }> {
    return {};
  }

  /**
   * The interactive substrate does NOT parse raw PTY stdout for structured
   * events — that is the noise terminal stream. Structured events come
   * exclusively from the TranscriptSource. The inherited
   * setupProcessHandlers.onData calls this per-line and gets [], which is
   * correct (no panel events from raw PTY).
   */
  protected parseCliOutput(_data: string, _panelId: string, _sessionId: string): Array<{ panelId: string; sessionId: string; type: 'json' | 'stdout' | 'stderr'; data: unknown; timestamp: Date }> {
    return [];
  }

  /**
   * Clean up the run's interactive resources. Runs on BOTH clean drain (from the
   * inherited onExit path) and abort (killProcess). Idempotent.
   *
   * cleanupCliResources is keyed by sessionId by the base contract, so we map
   * sessionId -> panelId via the active interactiveRuns/processes records.
   */
  protected async cleanupCliResources(sessionId: string): Promise<void> {
    const panelId = this.findPanelIdForSession(sessionId);
    if (panelId === undefined) return;
    this.teardownRun(panelId);
  }

  // ---------------------------------------------------------------------------
  // Core spawn — interactive PTY + TranscriptTailSource
  // ---------------------------------------------------------------------------

  /**
   * Override spawnCliProcess to drive an interactive REPL via the inherited base
   * PTY machinery interleaved with a TranscriptTailSource for structured output.
   *
   * Replicates the base availability + args + env preamble (AbstractCliManager
   * spawnCliProcess body) rather than calling super, because the tail wiring +
   * completion deferred must be interleaved with spawnPtyProcess /
   * setupProcessHandlers. spawnPtyProcess / setupProcessHandlers are CALLED
   * (inherited, NOT redeclared).
   *
   * The returned promise resolves ONLY from the inherited onExit path after the
   * settle window (clean exit) and rejects on non-zero exit (RunExecutor
   * 'failed'). A run with no turn-end + no exit NEVER resolves.
   */
  override async spawnCliProcess(options: InteractiveClaudeSpawnOptions): Promise<void> {
    const { panelId, sessionId, worktreePath } = options;

    if (this.processes.has(panelId)) {
      throw new Error(`Interactive Claude process already running for panel ${panelId}`);
    }

    // Availability probe (loud failure for a missing binary).
    const availability = await this.getCachedAvailability();
    if (!availability.available) {
      await this.handleCliNotAvailable(availability, panelId, sessionId);
      throw new Error(`${this.getCliToolName()} CLI not available: ${availability.error}`);
    }

    // Resolve the workflow_runs runId from the session's DB row (RunExecutor
    // invariant: for workflow runs panelId === runId).
    const sessionRow = this.sessionManager.getDbSession(sessionId);
    const runId = (sessionRow?.run_id as string | null | undefined) ?? options.runId ?? panelId;

    // Per-run pipeline (EventRouter + RawEventsSink). The manager OWNS raw_events
    // persistence (single INSERT per line); the RunExecutor bridge for interactive
    // runs runs with skipPersistence:true (wired in S4/TASK-809).
    const router = new EventRouter();
    const sink = new RawEventsSink(this.db, this.logger);
    sink.attachToRouter(router, runId);
    this.pipelines.set(panelId, { router, sink, runId });

    // Build args + env via the abstract hooks.
    const args = this.buildCommandArgs({ ...options, runId });
    const cliEnv = await this.initializeCliEnvironment({ ...options, runId });
    const extraEnv = await this.getCliEnvironment({ ...options, runId });
    const systemEnv = await this.getSystemEnvironment();
    const env = { ...systemEnv, ...cliEnv, ...extraEnv };
    const cliCommand = await this.getCliExecutablePath();

    this.logger?.info(`[${this.getCliToolName()}-command] COMMAND: ${cliCommand} ${args.join(' ')}`);
    this.logger?.info(`[${this.getCliToolName()}-command] Working directory: ${worktreePath}`);

    // Emit a session_info descriptor field-identical in shape to the SDK path so
    // the renderer has the run context. model uses (model || 'default').
    this.emit('output', {
      panelId,
      sessionId,
      type: 'json',
      data: {
        type: 'session_info',
        initial_prompt: options.prompt,
        claude_command: cliCommand,
        worktree_path: worktreePath,
        model: options.model || 'default',
        permission_mode: options.permissionMode || 'approve',
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date(),
    });

    // Build the completion deferred BEFORE spawning so the inherited onExit (and
    // the settle window it triggers) has a resolve/reject to call.
    let resolveSpawn!: () => void;
    let rejectSpawn!: (err: Error) => void;
    const spawnPromise = new Promise<void>((resolve, reject) => {
      resolveSpawn = resolve;
      rejectSpawn = reject;
    });

    const interactiveRun: InteractiveRun = {
      panelId,
      sessionId,
      runId,
      worktreePath,
      turnEnded: false,
      resolve: resolveSpawn,
      reject: rejectSpawn,
    };
    this.interactiveRuns.set(panelId, interactiveRun);

    // Spawn the PTY via the inherited base machinery (NOT redeclared).
    const ptyProcess = await this.spawnPtyProcess(cliCommand, args, worktreePath, env);

    // Record the process so isPanelRunning / getProcess / sendInput resolve.
    this.processes.set(panelId, {
      process: ptyProcess,
      panelId,
      sessionId,
      worktreePath,
    });

    // Wire the inherited onData/onExit handlers, then add the completion-settling
    // onExit listener.
    this.setupProcessHandlers(ptyProcess, panelId, sessionId);
    this.wireCompletionExit(ptyProcess, interactiveRun);

    this.emit('spawned', { panelId, sessionId });

    // Start the TranscriptTailSource (TASK-807). Each normalized line flows
    // narrow -> router.emitForRun(runId) -> emit('output', ...) field-identical
    // to the SDK envelope. The logger is PASSED (CLAUDE.md optional-logger rule).
    const tailSource = this.createTranscriptSource(worktreePath);
    this.tailSources.set(panelId, tailSource);

    const onLine = (normalizedLine: unknown): void => {
      const typed = this.narrowing.narrow(normalizedLine);
      try {
        router.emitForRun(runId, typed);
      } catch (routerErr) {
        this.logger?.warn(`[InteractiveClaudeManager] EventRouter emit error: ${routerErr instanceof Error ? routerErr.message : String(routerErr)}`);
      }
      this.emit('output', {
        panelId,
        sessionId,
        type: 'json',
        data: normalizedLine,
        timestamp: new Date(),
      });
    };

    const onTurnEnd = (_marker: TurnEndMarker): void => {
      this.handleTurnEnd(panelId);
    };

    await tailSource.start(onLine, onTurnEnd);

    // Wait for the transcript file to be discovered (loud diagnostic on timeout),
    // then write the initial prompt into PTY stdin.
    try {
      await tailSource.waitForFirstLine(DISCOVERY_TIMEOUT_MS);
    } catch (discoveryErr) {
      const message = discoveryErr instanceof Error ? discoveryErr.message : String(discoveryErr);
      this.logger?.error(`[InteractiveClaudeManager] transcript discovery failed for panel ${panelId}: ${message}`);
    }

    // single-writer-per-substrate: the interactive substrate writes
    // claude_session_id from the DISCOVERED transcript filename UUID. The SDK
    // event-driven write (sessionManager.ts:590, GenericMessageData.session_id)
    // belongs to the SDK substrate — the two NEVER both run for one run, so this
    // does not race/clobber the SDK path.
    this.persistDiscoveredSessionId(sessionId, tailSource);

    // Write the initial prompt once the REPL is ready. The step-reporting
    // instruction (TASK-803) is PREPENDED to the prompt head here — the
    // interactive analogue of the SDK manager's composeSystemPromptAppend
    // (claudeCodeManager.ts:478), which interactive `claude` cannot use because
    // the REPL has no SDK `systemPrompt.append` channel. See composePromptBody.
    const promptToSend = this.composePromptBody(runId, options.prompt);
    this.sendInput(panelId, promptToSend + '\n');

    return spawnPromise;
  }

  /**
   * Compose the initial prompt body written to PTY stdin: the per-run
   * step-reporting instruction (TASK-803 `buildStepReportingAppend`) prepended to
   * the run prompt, separated by a blank line.
   *
   * This is the ONE new seam this slice owns. It is the interactive analogue of
   * the SDK manager's `composeSystemPromptAppend` (claudeCodeManager.ts:478) /
   * the index.ts promptReader adapter (index.ts:614) — the interactive REPL has
   * no SDK `systemPrompt.append`, so the instruction reaches the MAIN session by
   * concatenation to the prompt HEAD instead.
   *
   * Dynamic step-id model (post main-merge): step ids are per-row, user-editable
   * data. `resolveWorkflowDefinition(name, spec_json)` is the RUNTIME source of
   * truth (a FULL override of the static WORKFLOW_DEFINITIONS seed), so we resolve
   * the run's EFFECTIVE definition from the run's workflow row BEFORE building the
   * append — never keying WORKFLOW_DEFINITIONS[name] directly. Mirrors the JOIN in
   * stepTransitionBridge.ts:134 / index.ts:617-622.
   *
   * Fail-soft: a missing run row, a non-SoloFlow name, or a broken/empty
   * `spec_json` resolves to a `null` definition → `buildStepReportingAppend(null)`
   * returns `''` → the prompt is sent UNCHANGED. Mirrors `resolveInitialStepId`'s
   * null branch (stepTransitionBridge.ts:52); nothing is ever prepended as garbage.
   */
  private composePromptBody(runId: string, prompt: string): string {
    const append = this.buildStepReportingAppendForRun(runId);
    return append ? `${append}\n\n${prompt}` : prompt;
  }

  /**
   * Resolve the run's effective WorkflowDefinition and build its step-reporting
   * append. Returns `''` (fail-soft) when the run row cannot be found or its
   * workflow has no resolvable definition (TASK-803 contract). No DB write, no
   * emit — this is a pure read of the run's workflow row.
   */
  private buildStepReportingAppendForRun(runId: string): string {
    let row: { name?: unknown; specJson?: unknown } | undefined;
    try {
      row = this.db
        .prepare(
          `SELECT w.name AS name, w.spec_json AS specJson
             FROM workflow_runs r
             JOIN workflows w ON w.id = r.workflow_id
            WHERE r.id = ?`,
        )
        .get(runId) as { name?: unknown; specJson?: unknown } | undefined;
    } catch (err) {
      this.logger?.warn(
        `[InteractiveClaudeManager] step-reporting workflow lookup failed for runId=${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return '';
    }

    if (!row) return '';
    const name = typeof row.name === 'string' ? row.name : '';
    const specJson = typeof row.specJson === 'string' ? row.specJson : null;
    return buildStepReportingAppend(resolveWorkflowDefinition(name, specJson));
  }

  /**
   * Factory for the TranscriptSource. Overridable in tests to inject a fake
   * source with zero PTY/FS coupling. Production constructs a real
   * TranscriptTailSource with the logger PASSED (CLAUDE.md optional-logger rule).
   */
  protected createTranscriptSource(worktreePath: string): TranscriptSource {
    if (this.logger === undefined) {
      throw new Error('[InteractiveClaudeManager] logger is required for TranscriptTailSource');
    }
    return new TranscriptTailSource({
      worktreePath,
      discoveryTimeoutMs: DISCOVERY_TIMEOUT_MS,
      logger: this.logger,
    });
  }

  /**
   * Handle a turn-end signal (Probe C). On the FIRST turn-end, write EOF/`/exit`
   * to PTY stdin to end the REPL turn. Does NOT resolve the spawn promise — that
   * happens only from the inherited onExit path after the settle window.
   */
  private handleTurnEnd(panelId: string): void {
    const run = this.interactiveRuns.get(panelId);
    if (!run || run.turnEnded) return;
    run.turnEnded = true;
    const cliProcess = this.processes.get(panelId);
    if (!cliProcess) return;
    this.logger?.verbose(`[InteractiveClaudeManager] turn-end for panel ${panelId} — writing EOF/exit to end REPL turn`);
    try {
      // EOF (Ctrl-D) then `/exit` — either ends the REPL turn so the inherited
      // onExit fires and (after the settle window) resolves the spawn promise.
      cliProcess.process.write(EOF_BYTE);
      cliProcess.process.write('/exit\n');
    } catch (err) {
      this.logger?.warn(`[InteractiveClaudeManager] failed to write EOF/exit for panel ${panelId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Bind the completion deferred to the inherited PTY onExit. The base
   * setupProcessHandlers already registered an onExit; this ADDS a second onExit
   * listener that, after the transcript-drain settle window, resolves the spawn
   * promise (clean exit, code 0 -> RunExecutor 'drained' -> awaiting_review) or
   * rejects it (non-zero -> 'failed'). The settle window prevents tail
   * truncation; it is NOT the completion signal.
   */
  private wireCompletionExit(ptyProcess: pty.IPty, run: InteractiveRun): void {
    let settled = false;
    ptyProcess.onExit(({ exitCode }) => {
      if (settled) return;
      settled = true;
      setTimeout(() => {
        if (exitCode === 0) {
          this.logger?.info(`[InteractiveClaudeManager] panel ${run.panelId} exited cleanly (code 0)`);
          run.resolve();
        } else {
          this.logger?.error(`[InteractiveClaudeManager] panel ${run.panelId} exited with code ${exitCode}`);
          run.reject(new Error(`Interactive Claude exited with code ${exitCode}`));
        }
      }, SETTLE_MS);
    });
  }

  /**
   * Persist claude_session_id from the discovered transcript filename UUID.
   * single-writer-per-substrate: only the interactive substrate writes from the
   * filename; the SDK event-driven write belongs to the SDK substrate.
   */
  private persistDiscoveredSessionId(sessionId: string, tailSource: TranscriptSource): void {
    const uuid = this.readDiscoveredSessionUuid(tailSource);
    if (!uuid) return;
    try {
      // Mirror the SDK substrate's DB-level write (sessionManager.ts:590) — the
      // high-level updateSession(SessionUpdate) does not pass claude_session_id
      // through, so write via the same db.updateSession seam the SDK path uses.
      this.sessionManager.db.updateSession(sessionId, { claude_session_id: uuid });
      this.logger?.verbose(`[InteractiveClaudeManager] persisted claude_session_id=${uuid} for session ${sessionId} (from transcript filename)`);
    } catch (err) {
      this.logger?.warn(`[InteractiveClaudeManager] failed to persist claude_session_id for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Read the discovered session UUID from a TranscriptTailSource, if available. */
  private readDiscoveredSessionUuid(tailSource: TranscriptSource): string | undefined {
    const candidate = tailSource as { getSessionUuid?: () => string | undefined };
    if (typeof candidate.getSessionUuid === 'function') {
      return candidate.getSessionUuid();
    }
    return undefined;
  }

  /**
   * Tear down a run's interactive resources: stop the TranscriptSource, clear
   * ApprovalRouter/QuestionRouter pending for the runId, deny/close any in-flight
   * shell-approval sockets (the cancel/teardown seam consumed by S5/TASK-810),
   * remove the generated settings.json hook entry (S5 owns the writer body), and
   * dispose the pipeline. Idempotent — safe on both clean drain and abort.
   */
  private teardownRun(panelId: string): void {
    const run = this.interactiveRuns.get(panelId);

    // Stop the TranscriptSource so its watchers/intervals exit (no leak).
    const tailSource = this.tailSources.get(panelId);
    if (tailSource) {
      try {
        tailSource.stop();
      } catch (err) {
        this.logger?.warn(`[InteractiveClaudeManager] TranscriptSource.stop() failed for panel ${panelId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.tailSources.delete(panelId);
    }

    // Clear router pending under the runId (same id passed to requestApproval /
    // requestQuestion). Falls back to panelId when no run record exists.
    const runId = run?.runId ?? panelId;
    ApprovalRouter.getInstance().clearPendingForRun(runId);
    QuestionRouter.getInstance().clearPendingForRun(runId);

    // Proactively deny + close any in-flight shell-approval sockets for the run.
    // Extensible seam — the socket-deny body lands in S5/TASK-810. No-op here.
    this.denyInFlightShellApprovals(runId);

    // Remove the generated settings.json hook entry. Removal call is a seam; the
    // writer body lands in S5/TASK-810.
    this.removeGeneratedSettings(panelId);

    // Dispose the pipeline (router + sink) for the run.
    const pipeline = this.pipelines.get(panelId);
    if (pipeline) {
      pipeline.sink.dispose(pipeline.runId);
      pipeline.router.clearRun(pipeline.runId);
      this.pipelines.delete(panelId);
    }

    this.interactiveRuns.delete(panelId);
  }

  /**
   * Deny + close any in-flight shell-approval sockets for the run. Extensible
   * teardown seam consumed by S5/TASK-810 — the socket-deny body lands there.
   * No-op in v1.
   */
  private denyInFlightShellApprovals(_runId: string): void {
    // S5/TASK-810 wires the shell-hook socket handler; this is the cancel seam.
  }

  /**
   * Remove the generated interactive settings.json hook entry. The writer body
   * is owned by S5/TASK-810; this is the removal seam. No-op in v1.
   */
  private removeGeneratedSettings(_panelId: string): void {
    // S5/TASK-810 owns interactiveSettingsWriter; this is the teardown seam.
  }

  /** Map a sessionId back to its active panelId via the run/process records. */
  private findPanelIdForSession(sessionId: string): string | undefined {
    for (const [panelId, run] of this.interactiveRuns) {
      if (run.sessionId === sessionId) return panelId;
    }
    for (const [panelId, proc] of this.processes) {
      if (proc.sessionId === sessionId) return panelId;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // AbstractCliManager panel-lifecycle abstract implementations
  // ---------------------------------------------------------------------------

  async startPanel(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    prompt: string,
    permissionMode?: 'approve' | 'ignore',
    model?: string,
  ): Promise<void> {
    await this.spawnCliProcess({ panelId, sessionId, worktreePath, prompt, permissionMode, model });
  }

  async continuePanel(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    prompt: string,
    _conversationHistory: ConversationMessage[],
    permissionMode?: 'approve' | 'ignore',
    model?: string,
  ): Promise<void> {
    // v1 fresh-session-only: interactive resume is not implemented (#44607
    // ignored interactively — see parity table). A continue spawns a fresh REPL.
    await this.killProcess(panelId);
    await this.spawnCliProcess({ panelId, sessionId, worktreePath, prompt, permissionMode, model });
  }

  async stopPanel(panelId: string): Promise<void> {
    await this.killProcess(panelId);
  }

  async restartPanelWithHistory(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    initialPrompt: string,
    _conversationHistory: ConversationMessage[],
  ): Promise<void> {
    await this.killProcess(panelId);
    await this.spawnCliProcess({ panelId, sessionId, worktreePath, prompt: initialPrompt });
  }

  protected getCliNotAvailableMessage(error?: string): string {
    return [
      `Error: ${error}`,
      '',
      'Claude Code (Interactive) is not available.',
      '',
      'Please install the `claude` CLI or set a custom executable path in Settings.',
    ].join('\n');
  }
}
