import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import type Database from 'better-sqlite3';
import type * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import type { Logger } from '../../../utils/logger';
import type { ConfigManager } from '../../configManager';
import type { ConversationMessage } from '../../../database/models';
import { getShellPath, findExecutableInPath } from '../../../utils/shellPath';
import { findNodeExecutable } from '../../../utils/nodeFinder';
import { resolveMcpServerScriptPath } from '../../../orchestrator/mcpServer/scriptPath';
import { ApprovalRouter } from '../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../orchestrator/questionRouter';
import { AbstractCliManager } from '../cli/AbstractCliManager';
import { EventRouter, RawEventsSink, TypedEventNarrowing } from '../../streamParser';
import { TranscriptTailSource } from './transcript/transcriptTailSource';
import type { TranscriptSource, TurnEndMarker } from './transcript/transcriptSource';
import { InteractiveSettingsWriter } from './interactiveSettingsWriter';
import type { LoggerLike } from '../../../orchestrator/types';
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
 *                      (claudeCodeManager.ts:446). The hook WRITE body is owned by
 *                      S5/TASK-810 (interactiveSettingsWriter); TASK-819 calls
 *                      `settingsWriter.write(worktreePath, { permissionMode })` on
 *                      spawn and the gating is the WRITER's own opt-out branch —
 *                      'ignore'/'dontAsk' makes write() return null (no hook). The
 *                      manager adds NO second gate (single source of truth).
 *   strictMcpConfig  : threads `--strict-mcp-config` iff strictMcpConfig===true,
 *                      so only the per-run `.mcp.json` servers load and user
 *                      globals cannot interfere with the permission bridge.
 *                      Mirrors claudeCodeManager.ts:188.
 *   settings/hooks   : EXPLICIT decision (TASK-819) — the PreToolUse `'*'` shell-
 *                      approval hook is installed by InteractiveSettingsWriter into
 *                      the worktree's DEFAULT `<worktree>/.claude/settings.json`
 *                      that `claude` reads at launch; NO `--settings` flag is
 *                      emitted. The old `--settings <.cyboflow/interactive-
 *                      settings.json>` flag was dangling (nothing wrote that file →
 *                      NO hook → NO gating) and is dropped. The SDK reads
 *                      settingSources ['user','project'] via its own option; the
 *                      interactive REPL has no settingSources option, so the gate is
 *                      delivered through the on-disk settings file `claude` already
 *                      reads. A future explicit `--settings` MUST target the
 *                      writer's `.claude/settings.json` path, not the empty
 *                      `.cyboflow` file.
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
  /**
   * True for a TRUE persistent multi-turn REPL session (IDEA-030 / TASK-818).
   * Every run this manager spawns IS interactive, so this is set `true` at spawn.
   * When persistent, a turn-end emits a 'turn-end' EVENT and leaves the REPL
   * ALIVE (no EOF/`/exit`) — the REPL is torn down ONLY on explicit termination
   * (endSession / killProcess). When false (defensive / future non-interactive
   * use) the legacy TASK-808 single-turn behavior is preserved: the first
   * turn-end writes EOF/`/exit`.
   */
  persistent: boolean;
  /**
   * Per-turn re-armable guard. In the LEGACY non-persistent path it gates the
   * one-shot EOF write (true once an EOF/`/exit` has been written). In the
   * persistent path it is NOT used as a one-shot latch — each turn-end re-emits
   * the 'turn-end' event and re-arms (the REPL stays alive across turns).
   */
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

/**
 * Payload of the 'turn-end' event emitted on each assistant turn boundary of a
 * persistent interactive REPL (IDEA-030 / TASK-818). The SubstrateDispatchFacade
 * fans this in and re-emits it by reference; RunExecutor's event-driven rest
 * handler reads `runId` to drive running -> awaiting_review WITHOUT resolving the
 * spawn promise. The SDK manager NEVER emits this event.
 */
export interface InteractiveTurnEndPayload {
  panelId: string;
  sessionId: string;
  runId: string;
}

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

  /**
   * Merge-safe `.claude/settings.json` writer/remover (TASK-810). Installs the
   * PreToolUse `'*'` shell-approval hook on spawn (gated by the writer's own
   * permissionMode opt-out) and strips it on teardown. Constructed in the
   * constructor after super() so this.logger is available — the logger is
   * PASSED (adapted to LoggerLike) per the CLAUDE.md optional-logger rule
   * (omitting it silently no-ops the writer's write/skip/remove diagnostics).
   */
  private readonly settingsWriter: InteractiveSettingsWriter;

  /**
   * Injected deny-on-teardown shell-approval canceller (TASK-819). Wired at boot
   * via setShellApprovalCanceller to OrchSocketServer.cancelInFlightShellApprovals
   * (which delegates to the handler's shipped twin). Null until wired — quick
   * sessions and a boot before wiring no-op cleanly. Typed `(runId) => number`
   * to match the handler's return (count of sockets denied/closed).
   */
  private shellApprovalCanceller: ((runId: string) => number) | null = null;

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
    // PASS the logger to the writer (CLAUDE.md optional-logger rule). The
    // manager's Logger surface exposes verbose/info/warn/error but NOT `debug`,
    // so adapt it to LoggerLike at the call site (debug -> verbose) rather than
    // omitting it, which would silently no-op the writer's diagnostics. The shim
    // is undefined when no logger was supplied so the writer's own opt-out holds.
    this.settingsWriter = new InteractiveSettingsWriter(this.toLoggerLike(this.logger));
  }

  /**
   * Adapt the manager's `Logger` (verbose/info/warn/error) to the writer's
   * `LoggerLike` (info/warn/error/debug). Routes `debug` -> `verbose`. Returns
   * `undefined` when no logger is present so the writer falls back to its own
   * no-op branch — never fabricates a logger that swallows diagnostics.
   */
  private toLoggerLike(logger: Logger | undefined): LoggerLike | undefined {
    if (logger === undefined) return undefined;
    return {
      info: (message: string) => logger.info(message),
      warn: (message: string) => logger.warn(message),
      error: (message: string) => logger.error(message),
      debug: (message: string) => logger.verbose(message),
    };
  }

  /**
   * Inject the orchestrator IPC socket path so the cyboflow MCP server entry can
   * reach the orchestrator. Mirrors the setOrchSocketPath seam from
   * claudeCodeManager.ts:105. Call once at boot after the IPC server starts.
   */
  setOrchSocketPath(socketPath: string): void {
    this.orchSocketPath = socketPath;
  }

  /**
   * Inject the deny-on-teardown shell-approval canceller (TASK-819). Wired at
   * boot to OrchSocketServer.cancelInFlightShellApprovals so teardownRun can
   * deny/close any in-flight PreToolUse shell-approval socket for a run BEFORE
   * the PTY is killed. Mirrors the setOrchSocketPath injection seam. Null-safe:
   * unset until wired (quick sessions / pre-boot) and the deny no-ops cleanly.
   */
  setShellApprovalCanceller(fn: (runId: string) => number): void {
    this.shellApprovalCanceller = fn;
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

    // Treat an empty/whitespace customPath or config claudeExecutablePath as
    // "not configured". config.json seeds `claudeExecutablePath` as "" by
    // default, and `"" ?? x` keeps the empty string (?? only falls through on
    // null/undefined), which made `resolvedPath` an empty (falsy) string and
    // short-circuited straight to "not found" WITHOUT ever probing the PATH via
    // findExecutableInPath. Use `||` so an empty configured value falls through
    // to the PATH probe.
    const configuredPath =
      customPath?.trim() ||
      this.configManager?.getConfig()?.claudeExecutablePath?.trim() ||
      undefined;
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

    // Inject the cyboflow MCP stdio entry ONLY when its config file is present on
    // disk. writeInteractiveMcpConfig (called by spawnCliProcess just before args
    // are built) writes `<worktree>/.cyboflow/interactive-mcp.json` whenever an
    // orchestrator socket is injected. Emitting `--mcp-config` at a MISSING path
    // makes claude exit 1 ("Invalid MCP configuration: MCP config file not found")
    // and the run never advances past 'running' — the S5/TASK-810 gap this guard
    // closes. When no socket is present (quick sessions) the file is absent and
    // the flag is omitted so the REPL still launches.
    const mcpConfigPath = path.join(options.worktreePath, '.cyboflow', 'interactive-mcp.json');
    if (fs.existsSync(mcpConfigPath)) {
      args.push('--mcp-config', mcpConfigPath);
    }

    // No `--settings` flag is emitted (TASK-819 reconciliation): the PreToolUse
    // shell-approval hook is installed by InteractiveSettingsWriter into the
    // worktree's DEFAULT `<worktree>/.claude/settings.json` that `claude` reads
    // at launch — a DIFFERENT path from the dangling `.cyboflow/interactive-
    // settings.json` this manager used to point `--settings` at (nothing ever
    // wrote that file, so the hook never loaded → NO gating). Dropping the
    // dangling flag and letting `claude` pick up the writer-installed hook from
    // its default settings path is what makes the interactive gate actually
    // fire. A future explicit `--settings` MUST target the writer's path; do NOT
    // re-point it at the empty `.cyboflow` file.

    return args;
  }

  /**
   * Write the per-run interactive MCP config that `--mcp-config` points at.
   *
   * Mirrors ClaudeCodeManager.composeMcpServers: a single `cyboflow` MCP server
   * entry (`node <cyboflowMcpServer.js>`) carrying CYBOFLOW_RUN_ID +
   * CYBOFLOW_ORCH_SOCKET so the live REPL can call `cyboflow_report_step` et al.
   * over the orchestrator socket. The SDK path injects this server in-process;
   * the interactive REPL needs it as an on-disk file because `claude
   * --mcp-config` reads a path.
   *
   * Writes ONLY when an orchestrator socket has been injected (a workflow run).
   * For quick sessions with no socket there is no server to declare, so the file
   * is not written and buildCommandArgs omits the `--mcp-config` flag — claude
   * would otherwise exit 1 on the missing file. If the node executable cannot be
   * resolved we warn and skip the entry rather than ship a broken `command`
   * (same fail-soft as composeMcpServers).
   */
  protected async writeInteractiveMcpConfig(worktreePath: string, runId: string): Promise<void> {
    if (!this.orchSocketPath) return;

    let nodeCmd: string;
    try {
      nodeCmd = await findNodeExecutable();
    } catch (nodeErr) {
      this.logger?.warn(
        `[InteractiveClaudeManager] Could not resolve node executable; omitting cyboflow MCP entry: ${nodeErr instanceof Error ? nodeErr.message : String(nodeErr)}`,
      );
      return;
    }

    const config = {
      mcpServers: {
        cyboflow: {
          command: nodeCmd,
          args: [resolveMcpServerScriptPath()],
          env: {
            CYBOFLOW_RUN_ID: runId,
            CYBOFLOW_ORCH_SOCKET: this.orchSocketPath,
          },
        },
      },
    };

    const dir = path.join(worktreePath, '.cyboflow');
    const configPath = path.join(dir, 'interactive-mcp.json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    this.logger?.info(`[InteractiveClaudeManager] wrote interactive MCP config: ${configPath}`);
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

    // Install the PreToolUse `'*'` shell-approval hook into the worktree's
    // default `.claude/settings.json` BEFORE `claude` launches (TASK-819), so the
    // live interactive REPL gates tool calls for human review. The writer is
    // idempotent (drops any stale cyboflow entry before re-adding) so a respawn
    // is safe, and SKIPS internally when permissionMode is 'ignore'/'dontAsk'
    // (interactiveSettingsWriter.ts) — returning null — so NO second gate is
    // added here (the writer's opt-out branch is the single source of truth).
    // Synchronous fs; no await needed.
    this.settingsWriter.write(worktreePath, { permissionMode: options.permissionMode });

    // Write the per-run interactive MCP config (the path buildCommandArgs points
    // `--mcp-config` at) BEFORE building args, so the existence-guarded flag is
    // emitted. Closes the S5/TASK-810 gap that left `claude` exiting 1 on a
    // missing `--mcp-config` file (the interactive REPL needs an on-disk config;
    // the SDK path injects the same `cyboflow` server in-process).
    await this.writeInteractiveMcpConfig(worktreePath, runId);

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
      // Every run this manager spawns IS a persistent interactive REPL session
      // (IDEA-030 / TASK-818). The persistent flag gates the turn-end-kill: a
      // persistent run emits a 'turn-end' event instead of writing EOF/`/exit`,
      // so the REPL survives every in-session checkpoint and only terminates on
      // explicit end-session / killProcess. Resolved via an overridable seam so a
      // test can exercise the legacy single-turn (non-persistent) path.
      persistent: this.isPersistentRun(),
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

    // Raw-PTY byte path (TASK-814 / IDEA-030): register a SECOND, additive
    // ptyProcess.onData listener (the same multi-listener precedent as
    // wireCompletionExit's extra onExit) that emits the VERBATIM chunk on a NEW
    // 'pty-output' event for the live xterm terminal (TASK-815). The chunk is
    // forwarded UNMODIFIED — NO line-split, NO `\n` re-join — because the base
    // setupProcessHandlers.onData line-splits/re-joins for the structured
    // parseCliOutput per-line path, which would mangle xterm ANSI cursor/control
    // sequences. node-pty's onData is multi-listener, so this does NOT disturb
    // the inherited handler. The raw bytes ride 'pty-output' ONLY — they never
    // touch the 'output'/type:'json' channel and never reach runEventBridge
    // (Q3 panel-preservation; additive-isolation by construction).
    ptyProcess.onData((data: string) =>
      this.emit('pty-output', { panelId, sessionId, runId, type: 'pty', data, timestamp: new Date() }),
    );

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
    //
    // KNOWN BUG (NOT fixed here — reverted to keep the branch non-freezing): this
    // ordering is a DEADLOCK. claude does not create its transcript `.jsonl` until
    // it processes a prompt, but the prompt is sent only AFTER discovery — so
    // discovery always times out (15s) and the run never advances. Reordering the
    // sendInput BEFORE waitForFirstLine fixes the deadlock, BUT doing so lets claude
    // actually engage the cyboflow MCP server / transcript path for the first time,
    // which exposes a SEPARATE latent main-process busy-loop freeze (100% CPU,
    // event-loop spin) that must be root-caused (CPU profile) before the reorder can
    // ship. See [[project_interactive_persistent_session]] for the exact reorder and
    // freeze findings.
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
   * Whether a freshly-spawned run runs as a TRUE persistent multi-turn REPL
   * (IDEA-030 / TASK-818). Production is ALWAYS persistent — every run the
   * interactive manager spawns is a live interactive session. Overridable so a
   * test can exercise the legacy single-turn (non-persistent) EOF-on-turn-end
   * path that remains for defensive / future non-interactive use.
   */
  protected isPersistentRun(): boolean {
    return true;
  }

  /**
   * Handle a turn-end signal (Probe C).
   *
   * PERSISTENT path (IDEA-030 / TASK-818 — the live interactive REPL): do NOT
   * write EOF/`/exit`. The turn-end marker fires at the end of EVERY assistant
   * turn (transcriptNormalizer `stop_hook_summary` / `turn_duration`), including
   * every in-session human checkpoint — writing EOF here is exactly what TASK-808
   * did and what broke persistence (the REPL died at the first checkpoint).
   * Instead emit a 'turn-end' EVENT (consumed by SubstrateDispatchFacade ->
   * RunExecutor's event-driven rest, which transitions running -> awaiting_review
   * WITHOUT resolving the spawn promise) and leave the REPL ALIVE. The guard is
   * per-turn RE-ARMABLE: it is reset after each emit so the NEXT turn-end re-emits.
   *
   * LEGACY non-persistent path (defensive / future non-interactive use): preserve
   * the TASK-808 one-shot behavior — the first turn-end writes EOF/`/exit` so the
   * inherited onExit fires and (after the settle window) resolves the spawn promise.
   * Does NOT resolve the spawn promise directly — that happens only from the
   * inherited onExit path after the settle window.
   */
  private handleTurnEnd(panelId: string): void {
    const run = this.interactiveRuns.get(panelId);
    if (!run) return;

    if (run.persistent) {
      // Re-armable: emit the turn-end event and keep the REPL alive. `turnEnded`
      // is flipped per-turn purely for observability — it is NOT a one-shot latch
      // here (the next turn-end re-emits).
      run.turnEnded = true;
      this.logger?.verbose(
        `[InteractiveClaudeManager] turn-end for panel ${panelId} (persistent) — emitting 'turn-end', REPL stays alive`,
      );
      const payload: InteractiveTurnEndPayload = {
        panelId,
        sessionId: run.sessionId,
        runId: run.runId,
      };
      this.emit('turn-end', payload);
      // Re-arm for the NEXT turn so each subsequent stop_hook_summary re-emits.
      run.turnEnded = false;
      return;
    }

    // Legacy single-turn (non-persistent) path: one-shot EOF write.
    if (run.turnEnded) return;
    run.turnEnded = true;
    this.logger?.verbose(`[InteractiveClaudeManager] turn-end for panel ${panelId} — writing EOF/exit to end REPL turn`);
    this.writeExitToRepl(panelId);
  }

  /**
   * Write the EOF (Ctrl-D) + `/exit` control sequence into the live PTY stdin to
   * end the REPL turn / session. Shared by the legacy single-turn turn-end path
   * and the explicit-termination seam (endSession) so BOTH route through the same
   * conditional write. No-op when no live process exists for the panel. Does NOT
   * resolve the spawn promise — the inherited onExit path (wireCompletionExit)
   * does that after the settle window.
   */
  private writeExitToRepl(panelId: string): void {
    const cliProcess = this.processes.get(panelId);
    if (!cliProcess) return;
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
   * Explicit end-session seam (IDEA-030 / TASK-818). The ONLY non-kill path that
   * terminates a persistent interactive REPL: writes the EOF/`/exit` control
   * sequence so the inherited onExit (wireCompletionExit) settles the spawn
   * promise (resolve on clean exit / reject on non-zero) and teardownRun fires.
   * Wired from the run close-out mutations (Merge / Dismiss / Create-PR) via the
   * RelayDeps bag. No-op when no live process exists for the run/panel.
   *
   * panelId === runId per the orchestrator invariant, so the run close-out passes
   * the runId straight through. Returns a resolved promise once the exit write is
   * issued — the spawn-promise settle happens asynchronously on the PTY onExit.
   */
  public async endSession(panelId: string): Promise<void> {
    this.logger?.verbose(`[InteractiveClaudeManager] endSession for panel ${panelId} — writing EOF/exit to terminate REPL`);
    this.writeExitToRepl(panelId);
  }

  /**
   * Resize the live node-pty for a panel (IDEA-030 / TASK-818 — delivers
   * TASK-817's deferred manager-side resize seam that SubstrateDispatchFacade.
   * relayResize feature-detects via its narrow ResizeCapable interface). Looks up
   * the live process via the SAME per-panel `processes` map `sendInput` /
   * `writeExitToRepl` use; no-op when no live PTY exists for the panel. The SDK
   * manager gets no such method (no PTY) — Q3 / SDK byte-identity holds.
   */
  public resizePanel(panelId: string, cols: number, rows: number): void {
    const cliProcess = this.processes.get(panelId);
    if (!cliProcess?.process) return;
    cliProcess.process.resize(cols, rows);
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

    const runId = run?.runId ?? panelId;

    // Proactively deny + close any in-flight shell-approval sockets for the run
    // FIRST (TASK-819), so the held-open socket gets a real DENY verdict and the
    // blocked PreToolUse hook subprocess (and thus the blocked PTY) unblocks. This
    // MUST precede clearPendingForRun: ApprovalRouter.clearPendingForRun
    // deliberately does NOT touch the socket (correct for the in-process SDK
    // transport, WRONG for the shell transport), so the deny ships the verdict and
    // clearPendingForRun then settles the router's DB rows
    // (mcpQueryHandler.ts:505-511). Reordering deny -> clear (vs clear -> deny) is
    // the only structural change to this method.
    this.denyInFlightShellApprovals(runId);

    // Clear router pending under the runId (same id passed to requestApproval /
    // requestQuestion). Falls back to panelId when no run record exists.
    ApprovalRouter.getInstance().clearPendingForRun(runId);
    QuestionRouter.getInstance().clearPendingForRun(runId);

    // Remove the generated `.claude/settings.json` PreToolUse hook entry, leaving
    // user keys intact (the writer's merge-safe remove). Resolved from the run's
    // worktree (the run record is still present here — interactiveRuns.delete runs
    // last below).
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
   * Deny + close any in-flight shell-approval sockets for the run (TASK-819).
   * Delegates to the injected canceller (wired at boot to
   * OrchSocketServer.cancelInFlightShellApprovals, which forwards to the handler's
   * shipped twin at mcpQueryHandler.ts:519). The deny-and-close logic is NOT
   * re-implemented here — only invoked. No-op safe when no canceller is wired
   * (quick sessions / boot order) and when nothing is in flight.
   */
  private denyInFlightShellApprovals(runId: string): void {
    try {
      this.shellApprovalCanceller?.(runId);
    } catch (err) {
      this.logger?.warn(
        `[InteractiveClaudeManager] cancel in-flight shell approvals failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Remove the generated `.claude/settings.json` PreToolUse hook entry on teardown
   * (TASK-819) by delegating to the writer's merge-safe remove for the run's
   * worktree. The writer strips ONLY the cyboflow `'*'` entry and preserves all
   * user keys; it is a no-op when the file is absent or carries no cyboflow entry.
   * Resolves the worktree from the still-present interactiveRuns record (the run
   * is deleted last in teardownRun). No-op when no worktree is resolvable.
   */
  private removeGeneratedSettings(panelId: string): void {
    const run = this.interactiveRuns.get(panelId);
    const worktreePath = run?.worktreePath;
    if (!worktreePath) return;
    try {
      this.settingsWriter.remove(worktreePath);
    } catch (err) {
      this.logger?.warn(
        `[InteractiveClaudeManager] remove generated settings failed for panel ${panelId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
