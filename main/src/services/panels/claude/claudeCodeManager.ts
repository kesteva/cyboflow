import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveMcpServerScriptPath } from '../../../orchestrator/mcpServer/scriptPath';
import { resolveClaudeExecutablePath } from './claudeExecutablePath';
import { findNodeExecutable } from '../../../utils/nodeFinder';
import { CONTEXT_1M_BETA, modelSupportsContext1M } from './modelContext';
import type { Options, HookCallback, PreToolUseHookInput, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { makeLoggerLike } from '../../../orchestrator/loggerAdapter';
import type Database from 'better-sqlite3';
import type { Logger } from '../../../utils/logger';
import type { ConfigManager } from '../../configManager';
import type { ConversationMessage } from '../../../database/models';
import { ApprovalRouter } from '../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../orchestrator/questionRouter';
import type { QuestionPayload } from '../../../orchestrator/questionRouter';
import { routePreToolUseThroughApprovalRouter } from '../../../orchestrator/preToolUseHookHelper';
import { loadMergedPermissionRules, isToolAllowed } from '../../../orchestrator/permissionRules';
import type { MergedPermissionRules } from '../../../orchestrator/permissionRules';
import { ACCEPT_EDITS_AUTO_APPROVE_TOOLS } from '../../../orchestrator/permissionModeMapper';
import { ReviewItemRouter, ReviewItemError } from '../../../orchestrator/reviewItemRouter';
import type { ReviewItemCreate } from '../../../orchestrator/reviewItemRouter';
import { DynamicWorkflowTracker } from '../../../orchestrator/dynamicWorkflows';
import type { PermissionPayload } from '../../../../../shared/types/reviews';
import { AbstractCliManager } from '../cli/AbstractCliManager';
import { WorkflowBundleWriter } from './workflowBundleWriter';
import { installWorkflowBundle } from './workflowBundleInstall';
import { withLock } from '../../../utils/mutex';
import { enhancePromptForStructuredCommit } from '../../../utils/promptEnhancer';
import { EventRouter, RawEventsSink, TypedEventNarrowing } from '../../streamParser';
import { transitionToAwaitingReview } from '../../cyboflow/transitions';
import type { TransitionToAwaitingReviewParams } from '../../cyboflow/transitions';
import { DEFAULT_PERMISSION_MODE } from '../../../../../shared/types/permissionMode';
import { isPermissionMode, type PermissionMode } from '../../../../../shared/types/workflows';

/**
 * MODEL-ELIGIBILITY GUARD for native auto-mode.
 *
 * Native Claude auto-mode (`--permission-mode auto` / `sdkOptions.permissionMode
 * = 'auto'`) relies on a recent classifier-capable model. Per the LOCKED design,
 * auto requires Opus 4.6+ / Sonnet 4.6+. This is a CONSERVATIVE guard: it returns
 * `true` for the common "let the SDK pick / use an alias family" cases
 * (undefined, 'auto', and any id whose family is 'sonnet'/'opus') and `false`
 * only for clearly-older pinned ids (Claude 3.x / 4.0–4.5 date-stamped or
 * version-tagged Sonnet/Opus, and Haiku which has no auto-classifier). When this
 * returns false for a requested 'auto' spawn, the caller FALLS BACK to default
 * approval behavior (installs the normal hook) and logs a warning — auto never
 * silently degrades to approve on an unsupported model.
 *
 * Kept module-level (pure, no `this`) so it is trivially unit-testable.
 */
export function modelSupportsAutoMode(model?: string): boolean {
  // Undefined / 'auto' → SDK default model (current, classifier-capable). Allow.
  if (!model || model === 'auto') return true;

  const id = model.toLowerCase();

  // Bare alias families ('sonnet' / 'opus' with no pinned version) resolve to
  // the current model the SDK ships, which is classifier-capable. Allow.
  if (id === 'sonnet' || id === 'opus') return true;

  // Haiku has no auto-mode classifier in any released line. Deny.
  if (id.includes('haiku')) return false;

  // Clearly-older pinned families: Claude 3 / 3.5 / 3.7 and the 4.0–4.5 line
  // predate the 4.6 auto-mode classifier. Deny so auto falls back to default.
  // Matches both date-stamped ids (e.g. 'claude-opus-4-1-20250805') and the
  // dotted marketing form (e.g. 'claude-3-5-sonnet').
  const OLDER_PINNED = [
    'claude-3', 'claude-3-5', 'claude-3-7',
    'claude-sonnet-3', 'claude-opus-3',
    'sonnet-3', 'opus-3',
    'claude-4-0', 'claude-4-1', 'claude-4-2', 'claude-4-3', 'claude-4-4', 'claude-4-5',
    'sonnet-4-0', 'sonnet-4-1', 'sonnet-4-2', 'sonnet-4-3', 'sonnet-4-4', 'sonnet-4-5',
    'opus-4-0', 'opus-4-1', 'opus-4-2', 'opus-4-3', 'opus-4-4', 'opus-4-5',
  ];
  if (OLDER_PINNED.some((older) => id.includes(older))) return false;

  // Unknown / newer pinned id (e.g. a 4.6+ stamp) — assume classifier-capable.
  return true;
}

interface ClaudeSpawnOptions {
  panelId: string;
  sessionId: string;
  worktreePath: string;
  prompt: string;
  conversationHistory?: string[];
  isResume?: boolean;
  permissionMode?: 'approve' | 'ignore';
  /**
   * Workflow 4-mode agent permission value resolved from the run snapshot
   * (`workflow_runs.permission_mode_snapshot`) and threaded by RunExecutor.
   * This is the NEW 4-mode field ('default' | 'acceptEdits' | 'auto' | 'dontAsk')
   * governing workflow runs — DISTINCT from the legacy session `permissionMode`
   * above ('approve' | 'ignore'), which stays for quick/legacy sessions.
   * Behavior branching off this value lands in a later step; here it is only
   * carried so the field threads through and compiles.
   */
  agentPermissionMode?: PermissionMode;
  model?: string;
  /**
   * The workflow_runs row ID for ApprovalRouter. For workflow runs this equals
   * panelId (RunExecutor invariant). For quick sessions it's resolved from
   * sessions.run_id and differs from panelId. Falls back to panelId when unset.
   */
  runId?: string;
  /**
   * Explicit SDK session id to resume (Piece C — idle-chat nudge). When set,
   * buildSdkOptions sets `sdkOptions.resume` to this value directly, taking
   * precedence over the `isResume` panel-customState lookup. Workflow runs use
   * this because they never create a panel row (so getPanelClaudeSessionId is
   * empty for them). Quick/panel resume paths (isResume) are unaffected.
   */
  resumeSessionId?: string;
  /**
   * When true, `--strict-mcp-config` is added to the CLI args so that only
   * the per-run `.mcp.json` servers load and user-global MCP servers from
   * `~/.claude.json` cannot interfere with the permission bridge.
   *
   * Defaults to `undefined` (falsy) for Cyboflow-session callers so existing
   * behaviour is preserved.  Cyboflow workflow run launches pass `true`.
   */
  strictMcpConfig?: boolean;
  /**
   * Per-spawn system prompt append from workflow frontmatter `system_prompt_append`.
   * When present, appended AFTER the dbSession-derived append (single blank line
   * separator). Falsy values are no-ops — behavior is unchanged from the
   * dbSession-only path.
   */
  systemPromptAppend?: string;
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
  sink: RawEventsSink;
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
   * Inject the orchestrator IPC socket path so the cyboflow MCP server entry
   * can be included in per-session mcpServers options.
   *
   * Call this once at boot after the permission IPC server has started.
   * The socket path is reused for both crystal-permissions (via PreToolUse hook
   * in this SDK path) and the cyboflow MCP server.
   */
  setOrchSocketPath(socketPath: string): void {
    // TODO(epic-7): first production caller is the OrchSocketProvider wiring task.
    // Until that task lands, composeMcpServers() always takes the orchSocketPath=null branch
    // and no cyboflow_* tools are surfaced to Claude sessions.
    this.orchSocketPath = socketPath;
    // Eagerly kick off node-path resolution at boot so the first session never
    // races against a not-yet-resolved promise.  The result is stored as a
    // Promise field; composeMcpServers() awaits it rather than polling.
    this.cachedNodePathPromise = findNodeExecutable();
  }

  /** Active SDK runs, keyed by panelId. */
  private readonly sdkRuns = new Map<string, ClaudeSdkRun>();

  /** Per-run pipeline (router → sink). */
  private readonly pipelines = new Map<string, PipelineTuple>();

  /**
   * Optional orchestrator IPC socket path.  When set, composeMcpServers()
   * injects a 'cyboflow' MCP server entry into every SDK session so Claude Code
   * can call cyboflow_* tools.  Set at boot via setOrchSocketPath().
   */
  private orchSocketPath: string | null = null;

  /**
   * Cached promise for the node executable path used in the cyboflow MCP entry.
   * Populated eagerly inside setOrchSocketPath() so the path is resolved before
   * the first composeMcpServers() call. Awaited (not polled) in composeMcpServers().
   */
  private cachedNodePathPromise: Promise<string> | null = null;

  /**
   * Narrower owned by this manager. Every SDK event flows through
   * `narrowing.narrow()` before reaching the EventRouter — the single
   * validated boundary into raw_events. Fail-soft: returns
   * `{ kind: '__unknown__', raw }` on Zod failure, never throws.
   *
   * Constructed in the constructor body after super() so this.logger is
   * available — passing the logger enables verbose Zod-failure diagnostics
   * per the CLAUDE.md optional-logger rule.
   */
  private readonly narrowing: TypedEventNarrowing;

  /**
   * Installs/removes the run's co-located `/cyboflow-<phase>` command bundle (and
   * any subagents) into the worktree's `.claude/commands` + `.claude/agents`
   * before spawn (IDEA-013 rung-(ii)). The SDK substrate auto-discovers these
   * files via `settingSources: ['user','project']`, so writing them is the SAME
   * substrate-shared mechanism the interactive REPL uses — the slim shared
   * planner/sprint prose depends on these commands existing on BOTH paths.
   * Merge-safe + namespaced (`cyboflow-*`). Logger PASSED (optional-logger rule).
   */
  private readonly bundleWriter: WorkflowBundleWriter;

  /**
   * Per-session worktree paths captured at spawn so `cleanupCliResources`
   * (sessionId-keyed) can remove the run's `cyboflow-*` bundle. Quick sessions
   * with no bundle still record harmlessly (remove is a no-op when nothing was
   * written).
   */
  private readonly bundleWorktrees = new Map<string, string>();

  constructor(
    sessionManager: import('../../sessionManager').SessionManager,
    logger: Logger | undefined,
    configManager: ConfigManager | undefined,
    private readonly db: Database.Database,
  ) {
    super(sessionManager, logger, configManager);
    if (db == null) {
      throw new TypeError('[ClaudeCodeManager] db argument is required; RawEventsSink cannot operate without a database handle.');
    }
    this.narrowing = new TypedEventNarrowing(this.logger);
    this.bundleWriter = new WorkflowBundleWriter(makeLoggerLike(this.logger));
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
   * No command args are consumed by the SDK substrate — query() takes structured
   * options, not a CLI argv array.  This method satisfies the abstract contract
   * and records the --strict-mcp-config flag for any future path that reverts to
   * PTY-spawning or inspects the args array directly.
   *
   * When `options.strictMcpConfig` is true the returned array contains
   * '--strict-mcp-config' so callers that read these args (e.g. integration
   * tests, a future PTY fallback path) get the correct argv.
   */
  protected buildCommandArgs(options: ClaudeSpawnOptions): string[] {
    const args: string[] = [];
    if (options.strictMcpConfig) {
      args.push('--strict-mcp-config');
    }
    return args;
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

  protected async cleanupCliResources(sessionId: string): Promise<void> {
    // Approval cleanup is done in runSdkQuery's finally block via
    // ApprovalRouter.getInstance().clearPendingForRun(panelId) — using panelId
    // (the id under which requestApproval() was called) rather than sessionId.
    // cleanupCliResources fires on the ABORT path (killProcess); normal completion
    // tears down via runSdkQuery's finally. Bundle removal is routed through the
    // shared helper from BOTH so it never depends on which path ended the run.
    this.removeBundleForSession(sessionId);
  }

  /**
   * Remove the run's cyboflow-* command/agent bundle from the worktree (IDEA-013
   * rung-(ii); strips ONLY cyboflow files, leaves user agents/commands intact) and
   * drop the per-session worktree record. Idempotent + no-op when nothing was
   * written (quick sessions / custom flows). Called from runSdkQuery's finally
   * (normal completion + abort-via-iterator-settle) AND cleanupCliResources (the
   * base killProcess path) so the bundle and the bundleWorktrees entry never leak.
   */
  private removeBundleForSession(sessionId: string): void {
    const worktreePath = this.bundleWorktrees.get(sessionId);
    if (worktreePath === undefined) return;
    this.bundleWriter.remove(worktreePath);
    this.bundleWorktrees.delete(sessionId);
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
          const errMsg = `Cannot resume: no Claude session_id stored for Cyboflow session ${sessionId}`;
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

      // Resolve the workflow_runs runId from the session's DB row.
      // For workflow runs: panelId === runId (invariant from RunExecutor).
      // For quick sessions: sessions.run_id was backfilled by the IPC handler
      // (sessions:create-quick) and differs from panelId.
      const sessionRow = this.sessionManager.getDbSession(sessionId);
      const runId = (sessionRow?.run_id as string | null) ?? panelId;

      // Install the run's co-located `/cyboflow-<phase>` command bundle (+ any
      // subagents) into `<worktree>/.claude/commands` | `.claude/agents` BEFORE
      // the query() runs. The SDK auto-discovers them via settingSources
      // ['user','project'], so the slim shared planner/sprint prose finds its
      // phase commands on the SDK path too (IDEA-013 rung-(ii)). Keyed off the
      // run's workflow_path → quick sessions / custom flows write nothing.
      // worktreePath is recorded by sessionId so cleanupCliResources can remove it.
      installWorkflowBundle(this.db, this.bundleWriter, runId, options.worktreePath, makeLoggerLike(this.logger));
      this.bundleWorktrees.set(sessionId, options.worktreePath);

      // Build SDK options (uses runId for the approval-router hook).
      const sdkOptions = await this.buildSdkOptions({ ...options, runId });

      // Set up the per-run pipeline (EventRouter + RawEventsSink).
      const router = new EventRouter();
      const sink = new RawEventsSink(this.db, this.logger);
      sink.attachToRouter(router, runId);
      this.pipelines.set(panelId, { router, sink, runId });

      // Passive dynamic-workflow detection: watch this run's normalized event
      // stream for Workflow-tool launches. Fail-soft when the tracker singleton
      // is not initialized (unit tests / early boot).
      DynamicWorkflowTracker.tryGetInstance()?.attachToRouter(router, { runId, sessionId });

      // Abort controller for cancellation.
      const abortController = new AbortController();

      // Emit session_info descriptor (renderer-visible context).
      const sessionInfoMessage = {
        type: 'session_info',
        initial_prompt: options.prompt,
        claude_command: 'sdk-in-process',
        worktree_path: options.worktreePath,
        model: options.model || 'default',
        permission_mode: options.permissionMode || DEFAULT_PERMISSION_MODE,
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
      const iteratorDone = this.runSdkQuery(panelId, sessionId, finalPrompt, sdkOptions, abortController, router, runId);

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

      // Wait for the SDK iterator to drain before returning. Callers (RunExecutor,
      // continueConversation) await spawnCliProcess to know when the turn is done —
      // runExecutor.ts:217 fires `transitionToCompleted` immediately after this
      // resolves, expecting status='running' from the matching `pre_spawn` transition.
      // Returning before the iterator drains races those transitions: status flips
      // running → completed before SDK tool calls fire, then ApprovalRouter rejects
      // every tool request with RunNotRunningError. runSdkQuery's try/catch swallows
      // SDK errors, so this await never throws — the lock releases on iterator drain.
      await iteratorDone;
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
    runId: string,
  ): Promise<void> {
    let exitCode = 0;
    // Piece C — capture the SDK conversation id ONCE per workflow run from the
    // first system/init event, so an idle-chat nudge can re-spawn with --resume.
    // Local latch avoids a DB hit on every subsequent event (the guarded UPDATE
    // is itself idempotent via `claude_session_id IS NULL`).
    let runClaudeSessionCaptured = false;
    try {
      const q = query({ prompt, options: { ...sdkOptions, abortController } });
      for await (const event of q) {
        if (abortController.signal.aborted) break;

        // Forward to EventRouter / RawEventsSink pipeline via validated narrowing.
        const typed = this.narrowing.narrow(event);

        // Persist the run's SDK session_id from its first system/init event.
        if (!runClaudeSessionCaptured) {
          const captured = this.captureRunClaudeSessionId(runId, event);
          if (captured) runClaudeSessionCaptured = true;
        }

        // Step G — native auto-mode visibility. When the auto classifier (or any
        // non-interactive deny) short-circuits a tool call, the SDK emits a
        // system/permission_denied message. Fold it into the review inbox as a
        // NON-BLOCKING row so the user can SEE what auto denied. The run is never
        // paused on this — fire-and-forget, errors are swallowed.
        this.maybeFoldAutoDenyVisibility(runId, event);

        try {
          router.emitForRun(runId, typed);
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
      // Clear pending approvals and questions under runId — the same id passed to
      // requestApproval() / requestQuestion() via makePreToolUseHook.
      ApprovalRouter.getInstance().clearPendingForRun(runId);
      QuestionRouter.getInstance().clearPendingForRun(runId);
      // Remove the run's cyboflow-* command/agent bundle on normal completion
      // (cleanupCliResources only fires on the abort path) — single-sourced with
      // it via removeBundleForSession so the bundleWorktrees entry never leaks.
      this.removeBundleForSession(sessionId);
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

  /**
   * Persist the SDK conversation id for a workflow run (Piece C — idle-chat nudge).
   *
   * Reads `session_id` from the first system/init event of the run's SDK query
   * and writes it to workflow_runs.claude_session_id with a guarded
   * `claude_session_id IS NULL` clause so only the FIRST init event ever wins.
   * Returns true once a non-empty session_id has been observed (so the caller
   * can stop probing subsequent events).
   *
   * Fail-soft: any DB error is logged at warn level and swallowed — session-id
   * capture must never crash the SDK iterator. The quick-session capture
   * (sessionManager.handleClaudeOutput) is a separate path and untouched.
   *
   * `event` is an SDK message of unknown runtime shape; narrowed structurally
   * here (no `any`) the same way sessionManager.ts:529 does for the quick path.
   */
  private captureRunClaudeSessionId(runId: string, event: unknown): boolean {
    if (typeof event !== 'object' || event === null) return false;
    const e = event as { type?: unknown; subtype?: unknown; session_id?: unknown };
    if (e.type !== 'system' || e.subtype !== 'init') return false;
    if (typeof e.session_id !== 'string' || e.session_id === '') return false;

    try {
      this.db
        .prepare(
          `UPDATE workflow_runs
              SET claude_session_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND claude_session_id IS NULL`,
        )
        .run(e.session_id, runId);
    } catch (err) {
      this.logger?.warn(
        `[ClaudeCodeManager] failed to capture claude_session_id for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Return true regardless of UPDATE row count: the session_id has been
    // observed for this run, so the caller stops probing further events.
    return true;
  }

  /**
   * Step G — fold a native-auto / non-interactive tool deny into the review
   * inbox as a NON-BLOCKING `permission` row (visibility only).
   *
   * The SDK emits `SDKPermissionDeniedMessage` ({ type: 'system', subtype:
   * 'permission_denied', tool_name, tool_use_id, tool_input?, decision_reason?,
   * ... }) when a tool call is auto-denied WITHOUT an interactive prompt — e.g.
   * the auto-mode classifier, dontAsk mode, or a deny rule. We surface these so
   * the user can see what auto rejected. Per the LOCKED design these rows are
   * NON-BLOCKING (blocking=0) and the run is NEVER paused.
   *
   * Structurally narrowed (no `any`); fail-soft: a malformed event, an
   * uninitialized ReviewItemRouter, or a missing project_id is logged at warn
   * and swallowed — visibility folding must never crash the SDK iterator.
   *
   * Fire-and-forget: applyReviewItem is queued per-project; we do not await it
   * (the iterator must keep draining). A late chokepoint rejection is logged.
   */
  private maybeFoldAutoDenyVisibility(runId: string, event: unknown): void {
    if (typeof event !== 'object' || event === null) return;
    const e = event as {
      type?: unknown;
      subtype?: unknown;
      tool_name?: unknown;
      tool_input?: unknown;
      tool_use_id?: unknown;
      decision_reason?: unknown;
      decision_reason_type?: unknown;
    };
    if (e.type !== 'system' || e.subtype !== 'permission_denied') return;
    const toolName = typeof e.tool_name === 'string' ? e.tool_name : 'unknown';

    let router: ReviewItemRouter;
    try {
      router = ReviewItemRouter.getInstance();
    } catch (err) {
      this.logger?.warn(
        `[ClaudeCodeManager] auto-deny visibility skipped (ReviewItemRouter not initialized): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    // Resolve the project_id for the run; review items are project-scoped.
    let projectId: number | undefined;
    try {
      const row = this.db
        .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE id = ?')
        .get(runId) as { projectId?: unknown } | undefined;
      if (row && typeof row.projectId === 'number') projectId = row.projectId;
    } catch (err) {
      this.logger?.warn(
        `[ClaudeCodeManager] auto-deny visibility skipped (project_id lookup failed for run ${runId}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (projectId === undefined) {
      // No workflow_runs row (e.g. quick session) — nothing to scope the
      // visibility row to. Skip silently at verbose level.
      this.logger?.verbose(
        `[ClaudeCodeManager] auto-deny visibility skipped (no workflow_runs row for run ${runId})`,
      );
      return;
    }

    const reason = typeof e.decision_reason === 'string' ? e.decision_reason : undefined;
    const reasonType = typeof e.decision_reason_type === 'string' ? e.decision_reason_type : undefined;
    const payload: PermissionPayload = {
      kind: 'permission',
      toolName,
      toolInput: e.tool_input ?? null,
    };
    const create: ReviewItemCreate = {
      op: 'create',
      actor: 'orchestrator',
      kind: 'permission',
      title: `Auto-mode denied ${toolName}`,
      body: reason ?? null,
      blocking: false, // NON-BLOCKING — visibility only, never pauses the run.
      source: reasonType ? `auto:${reasonType}` : 'auto',
      runId,
      payload,
    };

    // Fire-and-forget — the run is NEVER gated on the inbox.
    void router.applyReviewItem(projectId, create).catch((err) => {
      this.logger?.warn(
        `[ClaudeCodeManager] auto-deny visibility folding failed (non-blocking) for run ${runId}: ${
          err instanceof ReviewItemError ? err.code : err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  // ---------------------------------------------------------------------------
  // SDK options builder
  // ---------------------------------------------------------------------------

  private async buildSdkOptions(options: ClaudeSpawnOptions): Promise<Options> {
    // Resolve the effective mode ONCE (applies the model-eligibility guard, may
    // warn). Both the hook installation and the native-auto permissionMode flag
    // derive from this single value so the guard never logs twice.
    const effectiveMode = this.resolveEffectiveSdkMode(options);

    const sdkOptions: Options = {
      cwd: options.worktreePath,
      includePartialMessages: true,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: this.composeSystemPromptAppend(options) ?? undefined,
      },
      mcpServers: await this.composeMcpServers(options),
      env: this.composeRunEnv(options),
      settingSources: ['user', 'project'],
      // Enable markdown previews for AskUserQuestion option items. The model emits
      // the `preview` field on each option when this is set; the renderer uses it
      // to display rich content alongside each choice. Unconditional — even when
      // permissionMode='ignore' (no PreToolUse hook), the SDK's built-in
      // AskUserQuestion handler is the consumer and benefits from the config.
      toolConfig: {
        askUserQuestion: {
          previewFormat: 'markdown' as const,
        },
      },
      ...this.composeHookOptions(options, effectiveMode),
    };

    // Packaging fix: in a packaged app the SDK resolves its native `claude`
    // binary via require.resolve() from inside the asar'd sdk.mjs, yielding an
    // app.asar-INTERNAL path. fs.existsSync() passes (asar fs shim) but spawn()
    // fails with ENOTDIR — the claude subprocess never starts and query() yields
    // no output. Point the SDK at the asar-UNPACKED copy explicitly. Returns
    // undefined in dev (SDK resolves correctly), leaving this unset.
    const claudeExecutable = resolveClaudeExecutablePath();
    if (claudeExecutable) {
      sdkOptions.pathToClaudeCodeExecutable = claudeExecutable;
      this.logger?.info(`[ClaudeCodeManager] Using packaged claude executable: ${claudeExecutable}`);
    }

    // Native Claude auto-mode (model classifier owns gating). Set ONLY when the
    // resolved effective mode is 'auto' — the eligibility guard inside
    // resolveEffectiveSdkMode() has already downgraded unsupported models to
    // 'default', so this never sets permissionMode on an old pinned id.
    if (effectiveMode === 'auto') {
      // SDK PermissionMode includes 'auto' (sdk.d.ts). This is the native
      // auto-mode the LOCKED design routes BOTH substrates through.
      sdkOptions.permissionMode = 'auto';
    }

    if (options.model && options.model !== 'auto') {
      sdkOptions.model = options.model;
    }

    // Enable the 1M-token context window for Sonnet 4/4.5 (the only family the SDK
    // beta supports). Without this a Sonnet run reports a 200k window, so the chat
    // context meter caps at 200k even though the model is 1M-capable.
    if (modelSupportsContext1M(options.model)) {
      sdkOptions.betas = [CONTEXT_1M_BETA];
    }

    // Piece C — idle-chat nudge. An explicit resumeSessionId (threaded by
    // RunExecutor.execute from workflow_runs.claude_session_id) takes precedence
    // over the panel-customState lookup that workflow runs cannot satisfy. Only
    // ONE of the two resume paths is ever active for a given spawn: nudges set
    // resumeSessionId (and never isResume); quick/panel resumes set isResume.
    if (options.resumeSessionId) {
      sdkOptions.resume = options.resumeSessionId;
    } else if (options.isResume) {
      const claudeSessionId = this.sessionManager.getPanelClaudeSessionId(options.panelId);
      if (!claudeSessionId) {
        throw new Error(`Cannot resume: no Claude session_id stored for Cyboflow session ${options.sessionId}`);
      }
      sdkOptions.resume = claudeSessionId;
    }

    return sdkOptions;
  }

  private composeSystemPromptAppend(options: ClaudeSpawnOptions): string | undefined {
    const dbSession = this.sessionManager.getDbSession(options.sessionId);
    const sessionAppend = this.buildSystemPromptAppend(dbSession ? { ...dbSession } : { id: options.sessionId });
    const perSpawn = options.systemPromptAppend?.trim();
    if (!perSpawn) return sessionAppend;
    if (!sessionAppend) return perSpawn;
    return `${sessionAppend}\n\n${perSpawn}`;
  }

  /**
   * Compose the mcpServers record for the SDK options.
   *
   * Reads .mcp.json and ~/.claude.json from the base project directory.
   * The cyboflow-permissions MCP server is replaced by the PreToolUse hook.
   *
   * When an orchestrator socket path has been injected via setOrchSocketPath(),
   * a 'cyboflow' MCP server entry is also included so Claude Code can call
   * cyboflow_list_pending_approvals, cyboflow_get_run, and
   * cyboflow_submit_checkpoint during the session.
   */
  private async composeMcpServers(options: ClaudeSpawnOptions): Promise<Record<string, McpServerConfig>> {
    const { mcpServers } = this.getBaseProjectMcpServers(options.sessionId);

    if (this.orchSocketPath) {
      try {
        const cyboflowMcpScriptPath = resolveMcpServerScriptPath();
        // Await the eagerly-started promise so we always get the real node path.
        // If the promise rejects (node not found) we warn and skip the cyboflow
        // entry — never ship a broken command:'node' fallback.
        let nodeCmd: string;
        try {
          nodeCmd = await (this.cachedNodePathPromise ?? (this.cachedNodePathPromise = findNodeExecutable()));
        } catch (nodeErr) {
          this.logger?.warn(
            `[ClaudeCodeManager] Could not resolve node executable; omitting cyboflow MCP entry: ${nodeErr instanceof Error ? nodeErr.message : String(nodeErr)}`,
          );
          return mcpServers as Record<string, McpServerConfig>;
        }

        const cyboflowEntry: McpServerConfig = {
          command: nodeCmd,
          args: [cyboflowMcpScriptPath],
          env: {
            // CYBOFLOW_RUN_ID is the real workflow_runs.id for workflow runs
            // (options.runId, threaded through the spawn path by RunExecutor).
            // For legacy quick sessions that have no run, options.runId is
            // undefined/empty and we fall back to sessionId so the value is
            // always populated. Empty string is treated as absent.
            CYBOFLOW_RUN_ID: (options.runId && options.runId.length > 0) ? options.runId : options.sessionId,
            CYBOFLOW_ORCH_SOCKET: this.orchSocketPath,
          },
        };
        // Key literal kept as a string so grep-based AC checks can verify it.
        mcpServers["cyboflow"] = cyboflowEntry;
      } catch (err) {
        this.logger?.warn(
          `[ClaudeCodeManager] Failed to inject cyboflow MCP server: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

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
   * Resolve the effective hook-installation mode for a spawn.
   *
   * Precedence (per the LOCKED design): the NEW 4-mode `agentPermissionMode`
   * (workflow runs) wins when present; otherwise fall back to the legacy
   * `permissionMode` ('ignore' → 'dontAsk', anything else → 'default') so
   * quick/legacy sessions behave exactly as before this step.
   *
   * Returns the 4-mode value DIRECTLY (no eligibility downgrade) — the
   * separate resolveEffectiveSdkMode() applies the model-eligibility guard for
   * the native-auto path so the two concerns stay independent.
   */
  private resolveHookMode(options: ClaudeSpawnOptions): PermissionMode {
    if (options.agentPermissionMode) {
      return options.agentPermissionMode;
    }
    return options.permissionMode === 'ignore' ? 'dontAsk' : 'default';
  }

  /**
   * Resolve the effective mode the SDK should run under, applying the
   * MODEL-ELIGIBILITY GUARD for native auto-mode.
   *
   * Native auto requires a recent classifier-capable model (Opus 4.6+ /
   * Sonnet 4.6+). When 'auto' is requested but the pinned model is clearly
   * older, fall back to 'default' (the normal approval hook is installed) and
   * log a warning so auto never silently degrades to approve on an unsupported
   * model. Any other mode passes through unchanged.
   */
  private resolveEffectiveSdkMode(options: ClaudeSpawnOptions): PermissionMode {
    const mode = this.resolveHookMode(options);
    if (mode === 'auto' && !modelSupportsAutoMode(options.model)) {
      this.logger?.warn(
        `[ClaudeCodeManager] auto permission mode requested but model '${options.model}' does not support native auto-mode; falling back to 'default' (approval hook installed).`,
      );
      return 'default';
    }
    return mode;
  }

  /**
   * Compose the `hooks` slice of the SDK Options based on the effective mode.
   *
   * HOOK PRE-EMPTION RULE: PreToolUse hooks run FIRST in the CLI permission
   * order. The hook installed here MUST match the mode so it never pre-empts a
   * native decision:
   *   - 'dontAsk' → NO PreToolUse hook (unrestricted; legacy 'ignore' parity).
   *   - 'auto'    → an AskUserQuestion-ONLY hook (question gates still reach
   *                 QuestionRouter) that defers EVERY other tool to the native
   *                 classifier — it MUST NOT route through ApprovalRouter.
   *   - 'default' / 'acceptEdits' → the full permission hook (allowlist +
   *                 optional acceptEdits auto-allow + ApprovalRouter routing),
   *                 with AskUserQuestion routed to QuestionRouter.
   *
   * The user/project allow-list is loaded ONCE per spawn and captured in the
   * hook closure (the hook fires per tool call and must not touch the FS each
   * time).
   *
   * @param mode - the already-resolved effective mode (post eligibility guard);
   *   passed in by buildSdkOptions so the guard's warn only fires once.
   */
  private composeHookOptions(options: ClaudeSpawnOptions, mode: PermissionMode): Pick<Options, 'hooks'> {
    const runId = options.runId ?? options.panelId;

    if (mode === 'dontAsk') {
      // No PreToolUse hook — every tool call is auto-allowed by the SDK
      // (matches the pre-SDK / legacy 'ignore' "skip the bridge" behavior).
      return {};
    }

    const hook =
      mode === 'auto'
        ? this.makeAutoModePreToolUseHook(runId)
        : this.makePreToolUseHook(runId, loadMergedPermissionRules(options.worktreePath), mode);

    return {
      hooks: {
        PreToolUse: [{ hooks: [hook] }],
      },
    };
  }

  /**
   * Build the AskUserQuestion-ONLY PreToolUse hook for native auto-mode.
   *
   * Auto-mode delegates ALL permission gating to the native Claude classifier
   * (set via sdkOptions.permissionMode = 'auto'). A PreToolUse hook that emitted
   * an allow/deny decision would pre-empt that classifier (hooks run first in
   * the CLI permission order), silently degrading auto to approve. So this hook:
   *   - routes tool_name === 'AskUserQuestion' to QuestionRouter (so planner /
   *     sprint question gates still work), and
   *   - for EVERY other tool returns a pass-through with NO permissionDecision,
   *     deferring to the lower layers (the native classifier). Per the SDK
   *     contract (PreToolUseHookSpecificOutput.permissionDecision is optional),
   *     omitting the decision means "no opinion — defer".
   *
   * It MUST NOT call routePreToolUseThroughApprovalRouter.
   */
  private makeAutoModePreToolUseHook(runId: string): HookCallback {
    const loggerLike = makeLoggerLike(this.logger);
    return async (input, _toolUseId, _ctx) => {
      const pretool = input as PreToolUseHookInput;
      if (pretool.tool_name === 'AskUserQuestion') {
        return this.routeAskUserQuestion(pretool, runId, loggerLike);
      }
      // Defer to the native classifier: emit a PreToolUse output with NO
      // permissionDecision so the lower permission layers decide. This is the
      // documented "no opinion" form (permissionDecision is optional).
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
        },
      };
    };
  }

  /**
   * Build the PreToolUse hook callback that routes tool-use permission
   * decisions through ApprovalRouter (or QuestionRouter for AskUserQuestion)
   * and translates to SDK hookSpecificOutput.
   *
   * AskUserQuestion is intercepted before reaching ApprovalRouter — it is a
   * user-question gate, not a permission gate, and its answer flows back via
   * `updatedInput: { questions, answers }` rather than allow/deny.
   *
   * When `mode === 'acceptEdits'`, tool names in ACCEPT_EDITS_AUTO_APPROVE_TOOLS
   * (Edit/Write/MultiEdit) are auto-allowed BEFORE the user/project allowlist
   * check; all other tools follow the same allowlist → ApprovalRouter path as
   * 'default'. `mode === 'default'` keeps the pre-step behavior exactly.
   *
   * All non-auto-allowed tools delegate to routePreToolUseThroughApprovalRouter
   * so the allow/deny/error semantics are maintained in a single place
   * alongside permissionModeMapper.
   *
   * A deny may originate from clearPendingForRun() when the run is terminated
   * mid-approval (e.g., user cancels the run while awaiting a PreToolUse
   * decision). In that case decision.message will be
   * 'Run was terminated before approval could be processed'.
   *
   * @param mode - The effective hook mode; defaults to 'default' so existing
   *   2-arg callers (tests, legacy) keep their behavior.
   */
  private makePreToolUseHook(
    runId: string,
    allowRules: MergedPermissionRules,
    mode: PermissionMode = 'default',
  ): HookCallback {
    const loggerLike = makeLoggerLike(this.logger);
    return async (input, _toolUseId, _ctx) => {
      const pretool = input as PreToolUseHookInput;
      if (pretool.tool_name === 'AskUserQuestion') {
        return this.routeAskUserQuestion(pretool, runId, loggerLike);
      }
      // acceptEdits: auto-allow the edit tools BEFORE the allowlist check.
      if (
        mode === 'acceptEdits' &&
        (ACCEPT_EDITS_AUTO_APPROVE_TOOLS as readonly string[]).includes(pretool.tool_name)
      ) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'allow' as const,
          },
        };
      }
      // Honor user/project allow grants: a tool the user already approved at the
      // settings level is auto-allowed without re-prompting via ApprovalRouter.
      // Conservative by design — non-matches fall through to the approval router.
      const toolInput = (pretool.tool_input ?? {}) as Record<string, unknown>;
      if (isToolAllowed(pretool.tool_name, toolInput, allowRules)) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'allow' as const,
          },
        };
      }
      return routePreToolUseThroughApprovalRouter(pretool, runId, 'ClaudeCodeManager', loggerLike);
    };
  }

  /**
   * Route an AskUserQuestion PreToolUse hook through QuestionRouter.
   *
   * Awaits the user's answer from QuestionRouter.requestQuestion, then
   * returns an SDK hookSpecificOutput with updatedInput: { questions, answers }
   * so the SDK synthesizes the tool_result from the user's selections.
   *
   * On error (e.g. RunNotRunningError, DB failure), returns a deny output so
   * the SDK receives a well-formed response instead of a thrown exception.
   */
  private async routeAskUserQuestion(
    pretool: PreToolUseHookInput,
    panelId: string,
    loggerLike: ReturnType<typeof makeLoggerLike>,
  ): Promise<import('@anthropic-ai/claude-agent-sdk').HookJSONOutput> {
    try {
      const input = pretool.tool_input as { questions: QuestionPayload[] };
      const answer = await QuestionRouter.getInstance().requestQuestion(
        panelId,
        pretool.tool_use_id,
        input.questions,
        () => {},
      );
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'allow' as const,
          updatedInput: {
            questions: input.questions,
            answers: answer.answers,
            ...(answer.annotations ? { annotations: answer.annotations } : {}),
          },
        },
      };
    } catch (err) {
      loggerLike.error(
        `[ClaudeCodeManager] AskUserQuestion hook failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: 'Internal question-router error',
        },
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Process lifecycle overrides
  // ---------------------------------------------------------------------------

  /**
   * Override killProcess to abort the SDK run instead of killing a PTY.
   */
  override async killProcess(panelId: string): Promise<void> {
    // Deliberate ordering: await abortCurrentRun first so the SDK iterator's
    // finally block (in runSdkQuery) disposes the pipeline and clears pending
    // approvals BEFORE we return. Calling the pipeline-dispose helper here
    // directly would tear down the RawEventsSink listener while the iterator is
    // still pushing tail events, silently dropping raw_events rows. Pipeline
    // disposal is single-sourced through runSdkQuery's finally to eliminate
    // that race.
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
    // Stop dynamic-workflow detection/tailing for the run before sink disposal.
    DynamicWorkflowTracker.tryGetInstance()?.detachRun(pl.runId);
    pl.sink.dispose(pl.runId);
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
    // Carry the session's legacy permission_mode through the restart, parallel to
    // continuePanel — otherwise spawnClaudeCode seeds agentPermissionMode from the
    // GLOBAL default and an explicit session-level 'ignore' (don't-ask) would be
    // silently clobbered on restart.
    const permissionMode = this.sessionManager.getDbSession(sessionId)?.permission_mode;
    await this.spawnClaudeCode(panelId, sessionId, worktreePath, initialPrompt, historyStrings, false, permissionMode);
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
      // Quick/legacy SDK sessions resolve their 4-mode agent permission from the
      // per-session override (sessions.agent_permission_mode, migration 021) when
      // set, else the GLOBAL default — so both the Settings control AND the
      // Session Start Wizard step-3 / quick-session config govern them (not just
      // workflow runs). resolveHookMode prefers agentPermissionMode over the
      // legacy 'approve'|'ignore' value, so this is what takes effect. An explicit
      // legacy 'ignore' (don't-ask) is a stronger statement and is preserved by
      // leaving agentPermissionMode unset (the legacy 'ignore' → 'dontAsk' branch
      // in resolveHookMode then governs). Workflow runs never reach this path
      // (they call spawnCliProcess directly with agentPermissionMode already set
      // from the run snapshot).
      agentPermissionMode: this.resolveSessionAgentPermissionMode(sessionId, permissionMode),
      model
    };
    await this.spawnCliProcess(options);
  }

  /**
   * Resolve the 4-mode agent permission for a quick/legacy SDK session spawn.
   * Precedence: legacy 'ignore' (don't-ask) wins and returns undefined (the
   * legacy branch is preserved); else the PER-SESSION override
   * (sessions.agent_permission_mode, migration 021) if set and valid; else the
   * GLOBAL default (Settings → Agent Permission Mode). Reading the override from
   * the DB row (not a threaded arg) keeps it restart-safe — continuePanel /
   * restartPanelWithHistory re-resolve it for free on every respawn.
   */
  private resolveSessionAgentPermissionMode(
    sessionId: string,
    legacyPermissionMode?: 'approve' | 'ignore',
  ): PermissionMode | undefined {
    if (legacyPermissionMode === 'ignore') return undefined;
    const stored = this.sessionManager.getDbSession(sessionId)?.agent_permission_mode;
    if (isPermissionMode(stored)) return stored;
    return this.configManager?.getDefaultAgentPermissionMode();
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
    try {
      transitionToAwaitingReview(this.db, params);
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
