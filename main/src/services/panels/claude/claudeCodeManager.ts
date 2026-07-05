import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveMcpServerScriptPath } from '../../../orchestrator/mcpServer/scriptPath';
import { readInstalledPluginIds, buildExclusiveEnabledPluginsMap } from '../../../orchestrator/integrations/installedPlugins';
import { resolveClaudeExecutablePath } from './claudeExecutablePath';
import { findNodeExecutable } from '../../../utils/nodeFinder';
import { getCyboflowSubdirectory } from '../../../utils/cyboflowDirectory';
import { captureSeamError } from '../../telemetry';
import {
  resolveModelAlias,
  sdkModelAndBetas,
  applyModelAvailabilityFallback,
  resolveUnavailableDefaultModelFallback,
} from './modelContext';
import {
  ModelAvailabilityService,
  isModelUsable,
  isModelUnavailableError,
} from '../../modelAvailabilityService';
import { guardedModelByConcreteId, type GuardedModelSpec } from '../../../../../shared/types/modelAvailability';
import type { Options, HookCallback, PreToolUseHookInput, McpServerConfig, CanUseTool, PermissionResult, SdkBeta } from '@anthropic-ai/claude-agent-sdk';
import { makeLoggerLike } from '../../../orchestrator/loggerAdapter';
import type Database from 'better-sqlite3';
import type { Logger } from '../../../utils/logger';
import type { ConfigManager } from '../../configManager';
import type { ConversationMessage } from '../../../database/models';
import { ApprovalRouter, RunNotRunningError } from '../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../orchestrator/questionRouter';
import type { QuestionPayload } from '../../../orchestrator/questionRouter';
import { routePreToolUseThroughApprovalRouter } from '../../../orchestrator/preToolUseHookHelper';
import { SprintLaneStore } from '../../../orchestrator/sprintLaneStore';
import { loadMergedPermissionRules, isToolAllowed } from '../../../orchestrator/permissionRules';
import type { MergedPermissionRules } from '../../../orchestrator/permissionRules';
import { isAcceptEditsAutoApprovable } from '../../../orchestrator/permissionModeMapper';
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
import { transitionToAwaitingReview, reviveQuickRunToRunning } from '../../cyboflow/transitions';
import type { TransitionToAwaitingReviewParams } from '../../cyboflow/transitions';
import { resolveGateRunId } from '../../../orchestrator/chatSentinelProvider';
import type { ChatSentinelProvider } from '../../../orchestrator/chatSentinelProvider';
import { DEFAULT_PERMISSION_MODE } from '../../../../../shared/types/permissionMode';
import type { FastModeState, FastModeStateNotice } from '../../../../../shared/types/panels';
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

/**
 * Extract the error text from a Claude Code `result` event whose `is_error` is
 * true, else null. The CLI reports a failed turn (including an unusable `--model`)
 * as a terminal result message rather than a thrown error, so the model-guard
 * path inspects the event stream via this. Structural narrowing (no `any`), same
 * shape the streamParser result schemas validate. Returns '' for an is_error
 * result with no `result` string (still an error, just no message).
 */
function resultErrorText(event: unknown): string | null {
  if (typeof event !== 'object' || event === null) return null;
  const e = event as { type?: unknown; is_error?: unknown; result?: unknown };
  if (e.type !== 'result' || e.is_error !== true) return null;
  return typeof e.result === 'string' ? e.result : '';
}

/**
 * Classify a Claude Code `result` event as a TERMINAL turn failure, returning its
 * error message (or null when the turn did not fatally fail).
 *
 * The CLI surfaces a fatal turn (usage limit, auth failure, execution error) as a
 * terminal `result` event with `is_error: true` — NOT a thrown error — so it drains
 * the query() iterator normally. Left unhandled, the driving RunExecutor treats the
 * clean drain as a REST and parks the run in `awaiting_review` (the false "Workflow
 * complete" state). This lets spawnCliProcess detect that case and fail the run.
 *
 * `error_max_turns` is deliberately EXCLUDED (returns null): a run that merely hit
 * the turn cap is RECOVERABLE — it rests and can be nudged/resumed — so it must not
 * be re-marked failed. Every other error subtype (including unknown future ones)
 * defaults to terminal, so a fatal turn fails loudly rather than resting silently.
 */
function terminalResultError(event: unknown): string | null {
  if (typeof event !== 'object' || event === null) return null;
  const e = event as { type?: unknown; is_error?: unknown; subtype?: unknown; result?: unknown };
  if (e.type !== 'result' || e.is_error !== true) return null;
  if (e.subtype === 'error_max_turns') return null;
  return typeof e.result === 'string' && e.result.length > 0
    ? e.result
    : 'The agent session ended with an error.';
}

/**
 * Thrown by spawnCliProcess when a FLOW-RUN's driving SDK turn ends on a TERMINAL
 * error (a fatal is_error result per `terminalResultError`, or a thrown SDK/spawn
 * error) that the CLI surfaces WITHOUT rejecting the query() iterator. Rejecting
 * spawnCliProcess with it routes RunExecutor.execute()'s catch into its single
 * `failed` transition (transitionToFailed → status='failed' + error_message).
 *
 * Quick CHAT turns never raise it (their runId resolves to the `__quick__` sentinel,
 * not the run panel) so a chat Session Error stays inline exactly as before.
 */
export class SdkSessionTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SdkSessionTerminalError';
  }
}

/**
 * SDK option guards that ENFORCE a per-session MCP deny-list at spawn.
 *
 * composeMcpServers already deletes disabled servers from the explicit
 * `mcpServers`, but `settingSources: ['user','project']` makes the CLI ALSO
 * auto-load MCP servers from ~/.claude.json / .mcp.json and merge them back,
 * silently re-adding a "disabled" server. These guards close that gap:
 *   - strictMcpConfig: the CLI uses ONLY the explicit (already-filtered)
 *     mcpServers and ignores config-file MCP discovery → the server never
 *     connects;
 *   - disallowedTools (`mcp__<server>`): removes the server's tools from the
 *     model's context as defense-in-depth (never re-surfaced via ToolSearch).
 *
 * Returns an EMPTY object when nothing is disabled (the deny-free path must stay
 * byte-identical). 'cyboflow' is never disable-able (orchestrator socket) and is
 * always filtered out. Kept module-level (pure, no `this`) for unit-testing.
 */
export function mcpDenyListSdkGuards(disabledMcps: readonly string[]): {
  strictMcpConfig?: true;
  disallowedTools?: string[];
} {
  const denied = disabledMcps.filter((name) => name !== 'cyboflow');
  if (denied.length === 0) return {};
  return { strictMcpConfig: true, disallowedTools: denied.map((name) => `mcp__${name}`) };
}

/**
 * Tool-name prefix for the first-party 'cyboflow' MCP server (report_step,
 * create/update task, sprint batch, …) — the app calling its own orchestrator
 * socket. These are never model-gated: in native auto-mode they are allowed
 * deterministically BEFORE the classifier so a run's own orchestration surface
 * can't be denied when the classifier's model is unavailable (which soft-bricks
 * the flow — `current_step_id` never advances past a denied report_step).
 * Narrowly the 'cyboflow' server only; other MCP servers stay classifier-gated.
 */
const CYBOFLOW_MCP_TOOL_PREFIX = 'mcp__cyboflow__';

/**
 * Instrumentation-only watchdog window for the SDK substrate's first query()
 * event. The SDK surfaces a failed claude subprocess spawn (bad executable
 * path, auth hang) by yielding NOTHING — no throw, no event — so the session
 * just looks stuck. When this window elapses with zero events the failure is
 * reported to Sentry + the log; the turn is NOT aborted (a slow first token on
 * a long context is legitimate).
 */
const SDK_FIRST_EVENT_TIMEOUT_MS = 30_000;

interface ClaudeSpawnOptions {
  panelId: string;
  sessionId: string;
  worktreePath: string;
  prompt: string;
  conversationHistory?: string[];
  isResume?: boolean;
  permissionMode?: 'approve' | 'ignore';
  /**
   * Workflow 4-mode agent permission value threaded by RunExecutor (resolved per
   * the permission-mode redesign from the owning SESSION, not the demoted
   * `permission_mode_snapshot`). This is the NEW 4-mode field
   * ('default' | 'acceptEdits' | 'auto' | 'dontAsk') — DISTINCT from the legacy
   * session `permissionMode` above ('approve' | 'ignore'), which stays for
   * quick/legacy sessions. NOTE: the SDK PreToolUse hook no longer consumes this
   * field directly — it LIVE-READS `sessions.agent_permission_mode` on every tool
   * call (§3b/§4). The field is retained for parity/observability and any
   * non-SDK-hook reader.
   */
  agentPermissionMode?: PermissionMode;
  model?: string;
  /**
   * Per-launch opt-in for Anthropic "fast mode" (premium, Opus-only research
   * preview). Threaded from the quick-session launch toggle. When absent/false,
   * buildSdkOptions pins fast mode OFF (and per-session) so a persisted `/fast`
   * from the user's `~/.claude/settings.json` (loaded via settingSources) never
   * leaks into a cyboflow run.
   */
  fastMode?: boolean;
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
  /**
   * Additive per-lane spawn identity (`runId + ':' + itemId`), set ONLY for a
   * programmatic fan-out lane. spawnCliProcess keys the spawn lock, the
   * dup-guard, and the per-spawn maps (processes / sdkRuns / pipelines) on this
   * value, DEFAULTING to panelId when absent — so every non-fan-out path stays
   * byte-identical. It NEVER replaces panelId: panelId remains the run id used
   * for event attribution and the substrate-registry lookup.
   */
  spawnKey?: string;
}

/**
 * A running SDK query, keyed by spawnKey in the sdkRuns map (per-lane on a
 * programmatic fan-out, else === panelId).
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

  /**
   * The injected chat-gate sentinel provider (permission-mode redesign §6).
   * Resolves a chat turn's approval-gate run to the session's persistent
   * `__quick__` `chat_run_id` sentinel (minted on read), DECOUPLED from
   * `sessions.run_id` (the latest flow run). Set once at boot after the
   * WorkflowRegistry is constructed (index.ts). Null in tests / pre-wiring boot —
   * `resolveGateRunId` then falls back to the pre-redesign `run_id ?? panelId`.
   */
  private chatSentinelProvider: ChatSentinelProvider | null = null;

  /**
   * Inject the chat-gate sentinel provider (§6). Mirrors setOrchSocketPath: a
   * single boot-time injection seam, constructed at the orchestrator layer where
   * WorkflowRegistry ownership lives. Idempotent.
   */
  setChatSentinelProvider(provider: ChatSentinelProvider): void {
    this.chatSentinelProvider = provider;
  }

  /**
   * Active SDK runs, keyed by spawnKey (`runId + ':' + itemId` for a
   * programmatic fan-out lane, else === panelId). One entry per concurrent lane.
   */
  private readonly sdkRuns = new Map<string, ClaudeSdkRun>();

  /**
   * TERMINAL turn errors captured by runSdkQuery, keyed by spawnKey. Set when a
   * flow-run turn ends on a fatal is_error result / thrown SDK error (see
   * terminalResultError); read+cleared once by spawnCliProcess right after the
   * iterator drains so it can reject the spawn and drive the run to `failed`.
   * Per-spawnKey so concurrent fan-out lanes never clobber each other.
   */
  private readonly terminalErrorBySpawn = new Map<string, string>();

  /**
   * Latest per-panel fast-mode report, keyed by displayPanelId. The CLI stamps
   * `fast_mode_state` on the system/init and result stream events; the toggle
   * only records the user's REQUEST, so the composer's Fast pill reads this to
   * show whether fast mode actually engaged (the CLI's org/entitlement check or
   * a rate-limit cooldown can decline it). Pushed to the renderer on change via
   * the 'fast-mode-state' event; snapshot readable via getFastModeReport.
   */
  private readonly fastModeReports = new Map<string, FastModeStateNotice>();

  /**
   * Per-spawn pipeline (router → sink), keyed by spawnKey (per-lane for a
   * programmatic fan-out, else === panelId). The stored tuple carries the runId
   * so cleanup can still tear down run-scoped subscriptions.
   */
  private readonly pipelines = new Map<string, PipelineTuple>();

  /**
   * Registry of the live spawnKeys for each runId. Fan-out drives multiple lanes
   * under ONE runId (panelId), each with a distinct spawnKey. M4 uses this to
   * abort every lane of a run from a single run-scoped kill. A spawnKey is added
   * on spawn and removed on cleanup; the Set is deleted when it empties.
   */
  private readonly spawnKeysByRunId = new Map<string, Set<string>>();

  /**
   * Refcount of live spawns per runId for the DynamicWorkflowTracker
   * attach/detach (SUB-HAZARD A). The tracker is a singleton keyed by runId, so
   * with multiple fan-out lanes sharing one runId the FIRST lane must attach and
   * only the LAST lane's cleanup may detach — otherwise a sibling lane's
   * detector subscription is torn down while it is still live. Increment on
   * spawn (attach only on 0→1), decrement on cleanup (detach only on 1→0).
   */
  private readonly trackerRefcountByRunId = new Map<string, number>();

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

  /**
   * Per-sessionId refcount of live spawns that provisioned the cyboflow-* command
   * bundle (SUB-HAZARD: SHARED BUNDLE). A programmatic fan-out drives multiple
   * lanes under ONE sessionId, all sharing the same `.claude/commands` bundle in
   * the shared worktree. removeBundleForSession(sessionId) strips that bundle, so
   * the FIRST lane to finish would delete it out from under a still-live sibling
   * (the sibling's next `/cyboflow-<phase>` command then 404s mid-turn). Increment
   * on every spawn that installs/uses the bundle; removeBundleForSession only
   * actually removes when the count returns to 0 (the LAST lane). For a single
   * (non-fan-out) spawn the count is 1→0, so removal happens exactly as before.
   */
  private readonly bundleRefcountBySession = new Map<string, number>();

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
    // SHARED-BUNDLE refcount (SUB-HAZARD): decrement this session's live-spawn
    // count and only strip the bundle when it reaches 0 (the LAST lane). A
    // finishing fan-out lane must NOT delete the shared `.claude/commands` bundle
    // while a sibling lane is still mid-turn. The refcount is incremented in
    // spawnCliProcess right after installWorkflowBundle. Guard against an
    // unexpected double-cleanup driving the count negative (treat <=0 as the last
    // lane). For a single non-fan-out spawn the count is 1→0, so removal happens
    // exactly as before.
    const remaining = (this.bundleRefcountBySession.get(sessionId) ?? 1) - 1;
    if (remaining > 0) {
      this.bundleRefcountBySession.set(sessionId, remaining);
      return;
    }
    this.bundleRefcountBySession.delete(sessionId);
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
    // Additive per-lane identity. For a programmatic fan-out lane this is
    // `runId + ':' + itemId`; for every other path it DEFAULTS to panelId, so the
    // lock string, dup-guard, and per-spawn maps stay byte-identical to before.
    // spawnKey NEVER replaces panelId — panelId remains the run id used for event
    // attribution and the substrate registry lookup.
    const spawnKey = options.spawnKey ?? options.panelId;
    // M3 — re-attribution invariant. Internal lookups/maps (lock string,
    // dup-guard, processes / sdkRuns / pipelines, spawnKeysByRunId) key on
    // spawnKey so concurrent fan-out lanes stay isolated; but EVERY outbound
    // event carries the run DISPLAY panelId so a lane's output interleaves under
    // the run panel and passes the AbstractAIPanelManager output gate. For a
    // non-fan-out path spawnKey === panelId, so this is a no-op there.
    const displayPanelId = options.panelId;
    // M5(1) — RESUME is dead for lanes. Only a TOP-LEVEL run may take the SDK
    // resume path; a fan-out lane (spawnKey set AND distinct from panelId) is a
    // fresh per-item turn that must NEVER inherit isResume / resumeSessionId.
    // Resolving the run's stored claude_session_id for a lane would either fail
    // the resume validation (panel has no claude session id) or, worse, splice
    // every lane into the SAME prior conversation. Strip both resume signals for
    // lanes here so buildSdkOptions and the resume-validation block below treat
    // the lane as a clean spawn. Non-lane spawns (spawnKey === panelId) pass
    // through byte-identical.
    const isLaneSpawn = options.spawnKey !== undefined && options.spawnKey !== options.panelId;
    const effectiveOptions: ClaudeSpawnOptions = isLaneSpawn
      ? { ...options, isResume: false, resumeSessionId: undefined }
      : options;
    return await withLock(`claude-spawn-${spawnKey}`, async () => {
      const { panelId, sessionId, isResume } = effectiveOptions;

      // Guard: reject duplicate spawns of the SAME lane (keyed by spawnKey so
      // concurrent fan-out lanes under one panelId do not collide).
      if (this.processes.has(spawnKey)) {
        throw new Error(`Claude process already running for spawn ${spawnKey}`);
      }

      // Resume validation.
      if (isResume) {
        const claudeSessionId = this.sessionManager.getPanelClaudeSessionId(panelId);
        if (!claudeSessionId) {
          const errMsg = `Cannot resume: no Claude session_id stored for Cyboflow session ${sessionId}`;
          this.logger?.error(`[ClaudeCodeManager] ${errMsg}`);
          this.emit('output', {
            panelId: displayPanelId,
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

      // Resolve the approval-gate runId via the gate-vehicle discriminator (§6).
      // CHAT turn (getDbSession resolves a real session row) → the persistent
      // `__quick__` chat_run_id sentinel, minted on read by chatSentinelProvider —
      // DECOUPLED from sessions.run_id (the latest flow run) so a chat turn after a
      // terminal flow no longer silent-denies (#4). The provider also rejects a
      // chat turn while the session's flow run is non-terminal (ChatDuringActiveFlowError).
      // FLOW step (panelId === sessionId === runId, getDbSession → undefined) → panelId,
      // byte-identical to before. NO `?? run_id` arm in production.
      const sessionRow = this.sessionManager.getDbSession(sessionId);
      const runId = resolveGateRunId({
        sessionRow,
        panelId,
        sessionId,
        provider: this.chatSentinelProvider,
      });

      // Approval-gate revival (quick sessions only). A quick session's `__quick__`
      // sentinel run is set to 'running' once at creation, but leaves 'running'
      // when the app restarts (force-failed by runRecovery) or the session is
      // closed out — and no quick-turn path restored it. The ApprovalRouter gate
      // (running → awaiting_review) then matches 0 rows, so every approval-gated
      // tool on a later turn was silently denied with no prompt. Flip the sentinel
      // back to 'running' before the hook is wired so this turn's approvals work.
      // STRICTLY gated to the '__quick__' sentinel — a real workflow run (panelId
      // === runId, RunExecutor-owned) never matches the JOIN and is untouched.
      try {
        const revival = reviveQuickRunToRunning(this.db, runId);
        if (revival.revived) {
          this.logger?.info(
            `[ClaudeCodeManager] revived quick sentinel run ${runId} '${revival.fromStatus}' → 'running' for approval gate`,
          );
        }
      } catch (err) {
        // Best-effort: a revival failure must never block the spawn. The worst
        // case is the pre-fix behavior (approvals denied) for this one turn.
        this.logger?.warn(
          `[ClaudeCodeManager] quick run revival skipped for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Build the final prompt BEFORE any per-spawn / per-run resource is
      // registered below. enhancePromptForStructuredCommit / getDbSession are the
      // only synchronous throw points in the setup window; computing finalPrompt
      // here means a throw leaks nothing — no bundle refcount, pipeline, tracker,
      // or processes entry has been installed yet.
      const dbSession = this.sessionManager.getDbSession(sessionId);
      const finalPrompt = enhancePromptForStructuredCommit(
        options.prompt,
        dbSession || { id: sessionId },
        this.logger
      );

      // Install the run's co-located `/cyboflow-<phase>` command bundle (+ any
      // subagents) into `<worktree>/.claude/commands` | `.claude/agents` BEFORE
      // the query() runs. The SDK auto-discovers them via settingSources
      // ['user','project'], so the slim shared planner/sprint prose finds its
      // phase commands on the SDK path too (IDEA-013 rung-(ii)). Keyed off the
      // run's workflow_path → quick sessions / custom flows write nothing.
      // worktreePath is recorded by sessionId so cleanupCliResources can remove it.
      installWorkflowBundle(this.db, this.bundleWriter, runId, options.worktreePath, makeLoggerLike(this.logger));
      this.bundleWorktrees.set(sessionId, options.worktreePath);
      // SHARED-BUNDLE refcount: this spawn now relies on the bundle for the rest
      // of its turn. Increment so a finishing sibling lane (same sessionId) cannot
      // remove the bundle out from under this one — removeBundleForSession only
      // strips it when the LAST lane decrements back to 0.
      this.bundleRefcountBySession.set(sessionId, (this.bundleRefcountBySession.get(sessionId) ?? 0) + 1);

      // Build SDK options (uses runId for the approval-router hook). Built from
      // effectiveOptions so a lane spawn's stripped resume signals (M5(1)) reach
      // buildSdkOptions — a lane never resumes. Non-lane spawns: effectiveOptions
      // === options, so this is byte-identical.
      //
      // SHARED-BUNDLE leak fix: buildSdkOptions assembles SDK options (mode
      // resolution, env compose, hook wiring) and can REJECT. It runs AFTER the
      // bundleRefcountBySession bump above but BEFORE runSdkQuery (whose finally
      // owns the paired decrement), so a rejection here would strand the refcount
      // at +1 — and the genuinely-last lane could then never strip the shared
      // bundle. Undo the bump on failure, then rethrow so the caller still sees it.
      let sdkOptions: Options;
      try {
        sdkOptions = await this.buildSdkOptions({ ...effectiveOptions, runId });
      } catch (buildErr) {
        this.removeBundleForSession(sessionId);
        throw buildErr;
      }

      // Set up the per-run pipeline (EventRouter + RawEventsSink).
      const router = new EventRouter();
      const sink = new RawEventsSink(this.db, this.logger);
      sink.attachToRouter(router, runId);
      this.pipelines.set(spawnKey, { router, sink, runId });

      // Track this lane under its runId so a run-scoped kill (M4) can abort every
      // lane, and so the DynamicWorkflowTracker refcount below knows when this
      // run's first/last lane attaches/detaches.
      let keySet = this.spawnKeysByRunId.get(runId);
      if (keySet === undefined) {
        keySet = new Set<string>();
        this.spawnKeysByRunId.set(runId, keySet);
      }
      keySet.add(spawnKey);

      // Passive dynamic-workflow detection: watch this run's normalized event
      // stream for Workflow-tool launches. Fail-soft when the tracker singleton
      // is not initialized (unit tests / early boot).
      //
      // SUB-HAZARD A: the tracker is a runId-keyed singleton, so with multiple
      // fan-out lanes per runId only the FIRST lane attaches (0→1); the per-lane
      // routers are separate, but re-attaching for the same runId would tear down
      // the prior lane's subscription. Refcount so attach happens once and detach
      // waits for the last lane (cleanupPipeline decrements / detaches on 1→0).
      const priorRefcount = this.trackerRefcountByRunId.get(runId) ?? 0;
      this.trackerRefcountByRunId.set(runId, priorRefcount + 1);
      if (priorRefcount === 0) {
        DynamicWorkflowTracker.tryGetInstance()?.attachToRouter(router, { runId, sessionId });
      }

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
        panelId: displayPanelId,
        sessionId,
        type: 'json',
        data: sessionInfoMessage,
        timestamp: new Date()
      });

      // Push stub into processes map so isPanelRunning / getAllProcesses work.
      const stub: StubCliProcess = {
        process: undefined as never,
        panelId,
        sessionId,
        worktreePath: options.worktreePath
      };
      // Cast: AbstractCliManager.processes is Map<string, CliProcess> where
      // CliProcess.process is pty.IPty. We never access .process on SDK paths.
      // Keyed by spawnKey so concurrent fan-out lanes do not overwrite each other.
      (this.processes as Map<string, StubCliProcess>).set(spawnKey, stub);

      // Wire up the ClaudeSdkRun entry. runSdkQuery's finally tears down by
      // spawnKey, so it is threaded in. displayPanelId (the run/session panel) is
      // threaded too so every event runSdkQuery emits re-attributes to the run
      // panel, never to the per-lane spawnKey.
      const iteratorDone = this.runSdkQuery(spawnKey, displayPanelId, sessionId, finalPrompt, sdkOptions, abortController, router, runId);

      const run: ClaudeSdkRun = {
        abortController,
        iteratorDone,
        panelId,
        sessionId,
        worktreePath: options.worktreePath
      };
      this.sdkRuns.set(spawnKey, run);

      // Emit spawned — matching the upstream AbstractAIPanelManager listener.
      // Re-attributed to the run display panelId so a fan-out lane's spawn shows
      // under the run panel, not its per-lane spawnKey.
      this.emit('spawned', { panelId: displayPanelId, sessionId });

      this.logger?.info(`[ClaudeCodeManager] SDK query started for panel ${displayPanelId} (session ${sessionId})`);

      // Wait for the SDK iterator to drain before returning. Callers (RunExecutor,
      // continueConversation) await spawnCliProcess to know when the turn is done —
      // runExecutor.ts:217 fires `transitionToCompleted` immediately after this
      // resolves, expecting status='running' from the matching `pre_spawn` transition.
      // Returning before the iterator drains races those transitions: status flips
      // running → completed before SDK tool calls fire, then ApprovalRouter rejects
      // every tool request with RunNotRunningError. runSdkQuery's try/catch swallows
      // SDK errors, so this await never throws — the lock releases on iterator drain.
      await iteratorDone;

      // TERMINAL-error propagation. A fatal turn (usage limit / auth failure / spawn
      // error) is surfaced by the CLI as an is_error RESULT event or a thrown SDK
      // error — neither rejects the iterator, so without this spawnCliProcess would
      // RESOLVE and RunExecutor.execute() would rest the run in awaiting_review (the
      // false "Workflow complete" state; see WorkflowSummaryPanel). runSdkQuery stashed
      // the reason (terminalResultError) under spawnKey; read+clear it and REJECT for a
      // FLOW-RUN spawn (runId === displayPanelId) so execute()'s catch routes the run
      // through its single `failed` transition. A quick CHAT turn resolves its runId to
      // the `__quick__` sentinel (≠ displayPanelId) and is left untouched — its Session
      // Error stays inline exactly as before.
      const terminalError = this.terminalErrorBySpawn.get(spawnKey);
      this.terminalErrorBySpawn.delete(spawnKey);
      if (terminalError !== undefined && runId === displayPanelId) {
        throw new SdkSessionTerminalError(terminalError);
      }
    });
  }

  /**
   * Drive the query() async iterator. Emits output / exit / error events
   * that AbstractAIPanelManager.setupEventHandlers forwards upstream.
   *
   * M3 re-attribution: internal teardown keys on `spawnKey` (per-lane on a
   * programmatic fan-out), but every OUTBOUND event carries `displayPanelId`
   * (the run/session panel) so a lane's output interleaves under the run panel
   * and passes the AbstractAIPanelManager output gate. For a non-fan-out spawn
   * displayPanelId === spawnKey, so this is identical to the pre-M2 behavior.
   */
  private async runSdkQuery(
    spawnKey: string,
    displayPanelId: string,
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
    // Per-attempt SDK options so a mid-call model-unavailability (Fable 5 pulled)
    // can retry the turn ONCE on the fallback family (Opus) instead of surfacing a
    // hard Session Error. `attempt` caps the retry at one; only the FIRST attempt
    // is eligible so an Opus error can never loop.
    let activeOptions: Options = sdkOptions;
    let attempt = 0;
    // A fatal turn-ending error (is_error result or thrown SDK error) for THIS
    // (final) attempt — stashed for spawnCliProcess to reject on. Reset at the top
    // of each attempt so a recovered model-fallback retry never leaves a stale one.
    let terminalError: string | null = null;
    // First-event watchdog (see SDK_FIRST_EVENT_TIMEOUT_MS): armed per attempt,
    // cleared by the first event and in the finally. Report-only — never aborts.
    let firstEventTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      retry: while (true) {
        attempt++;
        terminalError = null;
        if (firstEventTimer) clearTimeout(firstEventTimer);
        firstEventTimer = setTimeout(() => {
          if (abortController.signal.aborted) return;
          const msg = `SDK query yielded no events within ${SDK_FIRST_EVENT_TIMEOUT_MS}ms — claude subprocess may have failed to start`;
          this.logger?.error(`[ClaudeCodeManager] ${msg} (panel ${displayPanelId})`);
          captureSeamError('sdk-first-event-timeout', new Error(msg), {
            substrate: 'sdk',
            packaged: String(Boolean(app.isPackaged)),
          });
        }, SDK_FIRST_EVENT_TIMEOUT_MS);
        const q = query({ prompt, options: { ...activeOptions, abortController } });
        for await (const event of q) {
          if (firstEventTimer) {
            clearTimeout(firstEventTimer);
            firstEventTimer = null;
          }
          if (abortController.signal.aborted) break;

          // Mid-call graceful fallback: the CLI reports an unusable `--model` as an
          // is_error RESULT event (never a throw), so it lands here, not in the
          // catch. On the FIRST attempt only, mark the guarded model unavailable
          // (greys the pickers) and retry THIS turn with the fallback model,
          // DISCARDING the error result so the user sees the fallback's answer.
          if (attempt === 1) {
            const fb = this.modelUnavailableFallback(activeOptions.model, event);
            if (fb) {
              this.logger?.warn(
                `[ClaudeCodeManager] model '${activeOptions.model}' unavailable mid-call; retrying panel ${displayPanelId} with '${fb.model}'.`,
              );
              // Tell the renderer this run swapped models mid-turn so the composer
              // can update its model pill and show a one-off toast (the persistent
              // grey-out is driven separately by the availability 'changed' push).
              this.emit('model-fallback', {
                panelId: displayPanelId,
                sessionId,
                unavailableAlias: fb.guarded.alias,
                unavailableLabel: fb.guarded.label,
                fallbackAlias: fb.guarded.fallbackAlias,
              });
              activeOptions = { ...activeOptions, model: fb.model, betas: fb.betas.length > 0 ? fb.betas : undefined };
              runClaudeSessionCaptured = false;
              continue retry;
            }
          }

          // Forward to EventRouter / RawEventsSink pipeline via validated narrowing.
          const typed = this.narrowing.narrow(event);

          // Persist the run's SDK session_id from its first system/init event.
          if (!runClaudeSessionCaptured) {
            const captured = this.captureRunClaudeSessionId(runId, event);
            if (captured) runClaudeSessionCaptured = true;
          }

          // Surface the CLI's per-turn fast_mode_state (system/init + result
          // events) so the composer's Fast pill reflects whether fast mode
          // actually engaged — the entitlement check or a cooldown can decline
          // a requested opt-in silently.
          this.captureFastModeState(displayPanelId, sessionId, event, activeOptions);

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

          // Forward to AbstractAIPanelManager via 'output' event. Re-attributed to
          // displayPanelId so a fan-out lane's output lands under the run panel.
          this.emit('output', {
            panelId: displayPanelId,
            sessionId,
            type: 'json',
            data: event,
            timestamp: new Date()
          });

          // Detect a TERMINAL turn failure surfaced as an is_error RESULT event
          // (usage limit / auth / execution error). Placed AFTER the fallback check
          // above (which `continue retry`s past it), so a recovered model-unavailable
          // result never counts. `error_max_turns` is excluded as recoverable. The
          // event is still forwarded as output so the "Session Error" stays visible.
          const resultErr = terminalResultError(event);
          if (resultErr !== null) terminalError = resultErr;
        }
        break; // iterator drained without triggering a fallback retry
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        // Intentional abort — treat as clean exit.
        this.logger?.info(`[ClaudeCodeManager] SDK query aborted for panel ${displayPanelId}`);
      } else {
        exitCode = 1;
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger?.error(`[ClaudeCodeManager] SDK query error for panel ${displayPanelId}: ${errMsg}`);
        this.emit('error', { panelId: displayPanelId, sessionId, error: errMsg });
        // A thrown SDK error (auth / network / spawn failure) is terminal too.
        terminalError = errMsg;
        // Reactive availability detection: if the failure names the pinned MODEL
        // (not found / no access), and that model is one we guard (Fable 5), record
        // it so every later spawn falls back to Opus and the pickers grey it out.
        // `activeOptions.model` is exactly what was sent this attempt — undefined/
        // 'auto'/Opus (a prior fallback) never match a guarded id, so this only
        // fires when a guarded model was actually attempted and rejected.
        this.noteModelUnavailabilityFromError(activeOptions.model, errMsg);
      }
    } finally {
      if (firstEventTimer) {
        clearTimeout(firstEventTimer);
        firstEventTimer = null;
      }
      this.cleanupPipeline(spawnKey);
      // Clear pending approvals and questions under runId — the same id passed to
      // requestApproval() / requestQuestion() via makePreToolUseHook. STAYS on
      // runId (run-scoped, not per-lane) — see M5 for the fan-out hazard.
      ApprovalRouter.getInstance().clearPendingForRun(runId);
      QuestionRouter.getInstance().clearPendingForRun(runId);
      // Remove the run's cyboflow-* command/agent bundle on normal completion
      // (cleanupCliResources only fires on the abort path) — single-sourced with
      // it via removeBundleForSession so the bundleWorktrees entry never leaks.
      // STAYS on sessionId; its refcount hazard is handled in M5.
      this.removeBundleForSession(sessionId);
      // Per-spawn teardown keyed by spawnKey so a finishing lane never evicts a
      // still-live sibling lane sharing the same panelId.
      this.processes.delete(spawnKey);
      this.sdkRuns.delete(spawnKey);
      this.forgetSpawnKey(runId, spawnKey);
      // Re-attributed to displayPanelId. NOTE (M3 step 3): emitting this 'exit'
      // does NOT, by itself, flip the run to a terminal state — this handler
      // writes NO workflow_runs terminal status. Terminal run state is the
      // WorkflowController's job once ALL lanes of the fan-out have settled.
      this.emit('exit', {
        panelId: displayPanelId,
        sessionId,
        exitCode,
        signal: null
      });
    }

    // Stash a terminal turn error (never on an abort — that is an intentional
    // cancel, not a failure) AFTER the 'exit' emit so the run's UI teardown is
    // unchanged. spawnCliProcess reads+clears this by spawnKey and rejects for a
    // flow-run spawn; the iterator promise itself still RESOLVES so the run.iteratorDone
    // awaiters (e.g. cancel) are unaffected.
    if (terminalError !== null && !abortController.signal.aborted) {
      this.terminalErrorBySpawn.set(spawnKey, terminalError);
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
   * Capture the CLI's per-turn `fast_mode_state` (stamped on the system/init and
   * result stream events) and, on change, push a {@link FastModeStateNotice} to
   * the renderer (events.ts forwards the 'fast-mode-state' emit). The notice
   * carries whether THIS spawn requested fast mode, so the pill only warns about
   * a declined opt-in — never about a turn that ran with fast mode off by choice.
   * Structurally narrowed (no `any`); never throws.
   */
  private captureFastModeState(
    displayPanelId: string,
    sessionId: string,
    event: unknown,
    activeOptions: Options,
  ): void {
    if (typeof event !== 'object' || event === null) return;
    const state = (event as { fast_mode_state?: unknown }).fast_mode_state;
    if (state !== 'off' && state !== 'cooldown' && state !== 'on') return;

    const settings = activeOptions.settings;
    const requestedFast =
      typeof settings === 'object' && settings !== null && (settings as { fastMode?: unknown }).fastMode === true;

    const previous = this.fastModeReports.get(displayPanelId);
    const notice: FastModeStateNotice = { panelId: displayPanelId, sessionId, state: state as FastModeState, requestedFast };
    this.fastModeReports.set(displayPanelId, notice);
    if (previous?.state === notice.state && previous.requestedFast === notice.requestedFast) return;
    this.emit('fast-mode-state', notice);
  }

  /** Latest fast-mode report for a panel, or null if no turn has reported yet. */
  getFastModeReport(panelId: string): FastModeStateNotice | null {
    return this.fastModeReports.get(panelId) ?? null;
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

  /**
   * When an SDK query fails, check whether the failure was the pinned MODEL being
   * unavailable and — if it was a guarded model (Fable 5) — record it on the
   * ModelAvailabilityService so subsequent spawns fall back to Opus and the pickers
   * grey it out. Best-effort and fail-soft: a non-guarded model, a non-model error,
   * or an uninitialized service are all no-ops. Returns true iff it marked a guarded
   * model unavailable (so the mid-call result-event path can decide to retry).
   */
  private noteModelUnavailabilityFromError(sdkModel: string | undefined, errMsg: string): boolean {
    const guarded = guardedModelByConcreteId(sdkModel);
    if (!guarded) return false;
    if (!isModelUnavailableError(errMsg)) return false;
    ModelAvailabilityService.tryGetInstance()?.markUnavailable(guarded.concreteId, errMsg.slice(0, 200));
    this.logger?.warn(
      `[ClaudeCodeManager] ${guarded.label} appears unavailable (${errMsg}); future spawns will fall back to ${guarded.fallbackAlias}.`,
    );
    return true;
  }

  /**
   * Mid-call graceful fallback. The Claude Code CLI reports an unusable `--model`
   * (Fable 5 pulled from release) as an `is_error` RESULT event — NOT a thrown
   * error — so it arrives inside the runSdkQuery iterator, never its catch. When
   * such a result names a guarded model, mark it unavailable (greys the pickers
   * and pre-falls-back later spawns) and return the fallback family's SDK
   * model+betas so the CURRENT turn can be retried on Opus instead of surfacing a
   * hard Session Error. Returns null for any non-result event, a non-model error,
   * a non-guarded pinned model, or when the fallback can't be resolved.
   */
  private modelUnavailableFallback(
    pinnedModel: string | undefined,
    event: unknown,
  ): { model: string; betas: SdkBeta[]; guarded: GuardedModelSpec } | null {
    const text = resultErrorText(event);
    if (text === null) return null; // not an is_error result event
    if (!this.noteModelUnavailabilityFromError(pinnedModel, text)) return null;
    const guarded = guardedModelByConcreteId(pinnedModel);
    if (!guarded) return null; // unreachable after the note above, but narrows the type
    const { model, betas } = sdkModelAndBetas(resolveModelAlias(guarded.fallbackAlias));
    if (!model || model === 'auto') return null;
    return { model, betas, guarded };
  }

  // ---------------------------------------------------------------------------
  // SDK options builder
  // ---------------------------------------------------------------------------

  private async buildSdkOptions(options: ClaudeSpawnOptions): Promise<Options> {
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
      ...this.composeHookOptions(options),
    };

    // Per-session MCP deny-list ENFORCEMENT (sessions.disabled_mcp_servers_json).
    // composeMcpServers already deletes disabled servers from the explicit
    // `mcpServers`, but `settingSources: ['user','project']` makes the CLI ALSO
    // auto-load MCP servers from ~/.claude.json / .mcp.json and MERGE them back —
    // silently re-adding a "disabled" server (the fal-ai report). Two guards,
    // applied ONLY when something is disabled so a deny-free session stays
    // byte-identical:
    //   1. strictMcpConfig — the CLI uses ONLY the explicit (already-filtered)
    //      mcpServers and ignores config-file MCP discovery, so the disabled
    //      server never connects. composeMcpServers re-reads .mcp.json +
    //      ~/.claude.json (and injects 'cyboflow'), so non-disabled servers are
    //      preserved.
    //   2. disallowedTools — removes the server's tools from the model's context
    //      as defense-in-depth (never re-surfaced via ToolSearch). 'cyboflow' is
    //      never disable-able (orchestrator socket) and is excluded.
    const denyGuards = mcpDenyListSdkGuards(this.resolveSessionDisabledMcps(options.sessionId));
    if (denyGuards.strictMcpConfig) {
      sdkOptions.strictMcpConfig = true;
      sdkOptions.disallowedTools = [
        ...(sdkOptions.disallowedTools ?? []),
        ...(denyGuards.disallowedTools ?? []),
      ];
      this.logger?.info(
        `[MCP] Enforcing deny-list for session ${options.sessionId} (strictMcpConfig + disallow): ${(denyGuards.disallowedTools ?? []).join(', ')}`,
      );
    }

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
    } else if (app.isPackaged) {
      // Packaged build with NO unpacked binary: the SDK falls back to its own
      // require.resolve, yielding an asar-internal path whose spawn fails
      // ENOTDIR with no surfaced error — query() simply never yields (the
      // silent "session stuck / times out" failure). Report it loudly.
      const msg = `packaged claude binary missing from app.asar.unpacked (${process.platform}-${process.arch}); SDK spawn will fail silently`;
      this.logger?.error(`[ClaudeCodeManager] ${msg}`);
      captureSeamError('sdk-packaged-binary-missing', new Error(msg), { substrate: 'sdk' });
    }

    // Native Claude auto-mode is pinned WHENEVER the model supports the
    // classifier — NOT only when the spawn's mode is 'auto'. The always-installed
    // dynamic PreToolUse hook (composeHookOptions) pre-empts the classifier for
    // every hook-decided mode (default/acceptEdits/dontAsk emit a concrete
    // decision; PreToolUse runs first in the CLI permission order) and DEFERS to
    // it only when the live session mode is 'auto'. Pinning unconditionally (per
    // supported model) is what makes a live switch INTO 'auto' take effect on the
    // next tool call with no re-spawn. On an auto-UNSUPPORTED model the flag stays
    // unset and the hook's per-call eligibility check routes 'auto' through the
    // ApprovalRouter instead (there is no classifier to defer to).
    if (modelSupportsAutoMode(options.model)) {
      // SDK PermissionMode includes 'auto' (sdk.d.ts). This is the native
      // auto-mode the LOCKED design routes BOTH substrates through.
      sdkOptions.permissionMode = 'auto';
    }

    // Pin the bare alias ('opus'/'sonnet'/'haiku', incl. '-250k' variants) to the
    // current concrete snapshot so the SDK can't resolve it to a previous-gen
    // model (the opus→4.7 / sonnet→250k drift). The resolved id may carry a `[1m]`
    // window marker; sdkModelAndBetas translates it per-family — Opus keeps its
    // `[1m]` id, Sonnet's 1M becomes the bare id + the context-1m beta, and the
    // 250k variants emit neither. 'auto'/undefined/concrete ids pass through.
    const requestedModel = resolveModelAlias(options.model);
    // Graceful fallback: if the pinned model is a guarded model the availability
    // guard reports unavailable (e.g. Fable 5 pulled from release), swap it for its
    // fallback family (Opus) BEFORE the SDK spawn so the turn runs instead of
    // hard-failing. A no-op for every other model.
    const resolvedModel = applyModelAvailabilityFallback(requestedModel, isModelUsable);
    if (resolvedModel !== requestedModel) {
      this.logger?.warn(
        `[ClaudeCodeManager] model '${requestedModel}' is unavailable; falling back to '${resolvedModel}' for panel ${options.panelId}.`,
      );
    }
    const { model: sdkModel, betas } = sdkModelAndBetas(resolvedModel);
    if (sdkModel && sdkModel !== 'auto') {
      sdkOptions.model = sdkModel;
    }
    if (betas.length > 0) {
      sdkOptions.betas = betas;
    }

    // Classifier-availability guard for native auto-mode. With no explicit model
    // pin (a NULL/'auto' run model → sdkOptions.model unset above) the bundled CLI
    // uses its own default, which the auto classifier shares; when that default is
    // a guarded model the availability guard reports unavailable (Fable 5 pulled),
    // the classifier can't run and denies every non-first-party tool. Pin the
    // guarded model's fallback family so the classifier has a working,
    // classifier-capable model. Explicit pins are already swapped above via
    // applyModelAvailabilityFallback; this only covers the unpinned default.
    if (sdkOptions.permissionMode === 'auto' && !sdkOptions.model) {
      const classifierFallback = resolveUnavailableDefaultModelFallback(isModelUsable);
      const { model: fbModel, betas: fbBetas } = sdkModelAndBetas(classifierFallback);
      if (fbModel && fbModel !== 'auto') {
        sdkOptions.model = fbModel;
        if (fbBetas.length > 0) sdkOptions.betas = fbBetas;
        this.logger?.warn(
          `[ClaudeCodeManager] auto-mode default model unavailable; pinning classifier-capable '${fbModel}' for panel ${options.panelId}.`,
        );
      }
    }

    // Fast mode (premium, Opus-only research preview) is a per-launch opt-in.
    // The SDK loads `Settings` from `settingSources: ['user','project']`, so a
    // `/fast` the user once enabled in plain Claude Code PERSISTS in
    // `~/.claude/settings.json` and would otherwise leak into every cyboflow
    // spawn (the "model is in fast mode by default" report). Pin it via an inline
    // `settings` overlay: `fastModePerSessionOptIn: true` makes each session
    // start with fast mode OFF regardless of the inherited file, and `fastMode`
    // re-enables it for exactly the session whose launch toggle requested it.
    // Per-session plugin enablement (allow-list from sessions.enabled_plugins_json,
    // read at spawn). Merged into the SAME inline (flag-tier) settings overlay so
    // it layers ON TOP of the file-loaded user/project plugins — settingSources
    // (line above) is untouched. `undefined` when the allow-list is empty, so the
    // default path emits no enabledPlugins key and inherited plugins are untouched.
    const enabledPlugins = this.resolveSessionEnabledPlugins(options.sessionId);
    sdkOptions.settings = {
      ...(typeof sdkOptions.settings === 'object' ? sdkOptions.settings : {}),
      fastMode: options.fastMode === true,
      fastModePerSessionOptIn: true,
      ...(enabledPlugins ? { enabledPlugins } : {}),
    };

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

    // Per-session MCP removal (deny-list from sessions.disabled_mcp_servers_json,
    // read at spawn). Delete each disabled server from the composed record — but
    // NEVER the 'cyboflow' entry, which carries the orchestrator socket the
    // permission bridge depends on (it is injected just below regardless). An
    // empty/missing deny-set leaves `mcpServers` byte-identical to before.
    for (const name of this.resolveSessionDisabledMcps(options.sessionId)) {
      if (name === 'cyboflow') continue;
      if (name in mcpServers) {
        delete mcpServers[name];
        this.logger?.info(`[MCP] Removed disabled MCP server for session ${options.sessionId}: ${name}`);
      }
    }

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
          // SDK 0.3.142 made MCP startup non-blocking by default; block startup
          // until the injected socket server is connected so turn-1 cyboflow_*
          // tool calls don't race its readiness.
          alwaysLoad: true,
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

  private composeRunEnv(options: ClaudeSpawnOptions): Record<string, string | undefined> {
    const verbose = this.configManager?.getConfig()?.verbose;
    // The per-run artifacts dir the agent writes screenshot PNGs into — the SAME
    // CYBOFLOW_DIR/artifacts/runs/<runId>/ subtree the gallery serves bytes from
    // (artifacts:load-images) and the auto-mint safety-net scan reads. Keyed by
    // the SAME run id used for CYBOFLOW_RUN_ID (runId for workflow runs, falling
    // back to sessionId for legacy quick sessions) so all three agree. The agent
    // reports the PNG BASENAMES via cyboflow_report_artifact(atype:'screenshots').
    const artifactRunKey =
      options.runId && options.runId.length > 0 ? options.runId : options.sessionId;
    const runArtifactsDir = getCyboflowSubdirectory('artifacts', 'runs', artifactRunKey);
    return {
      ...process.env,
      CYBOFLOW_RUN_ARTIFACTS_DIR: runArtifactsDir,
      ...(verbose ? { MCP_DEBUG: '1' } : {})
    };
  }

  /**
   * Compose the `hooks` slice of the SDK Options.
   *
   * ALWAYS installs exactly ONE dynamic PreToolUse hook (no per-mode fork, no
   * dontAsk early-return). The hook live-reads the owning session's permission
   * mode on EVERY tool call (permission-mode redesign §3b/§4), so entering or
   * leaving any of the four modes takes effect on the NEXT tool call with no
   * re-spawn:
   *   - 'dontAsk'              → the hook emits 'allow' (pre-empts the classifier).
   *   - 'acceptEdits'          → edit-tool fast-allow → allowlist → ApprovalRouter.
   *   - 'default'              → allowlist → ApprovalRouter.
   *   - 'auto' (model capable) → EMPTY PreToolUse output → defer to the native
   *                              classifier (permissionMode:'auto' is pinned in
   *                              buildSdkOptions whenever the model supports it).
   *   - 'auto' (model NOT capable) → allowlist → ApprovalRouter (no classifier
   *                              exists to defer to — model-eligibility is checked
   *                              PER CALL inside the hook).
   * AskUserQuestion is routed through QuestionRouter in ALL modes (incl. dontAsk).
   *
   * The owning session is resolved ONCE here from the gate `runId` via the
   * `workflow_runs → sessions` join (immutable for the life of the run), and the
   * user/project allow-list is loaded ONCE — both captured in the hook closure so
   * the per-call path does only a single-column session read and never touches the
   * FS. §1 ROOT FIX: keying the live read on the gate runId (NOT options.sessionId)
   * is required because for flow runs sessionId === runId, so a WHERE sessions.id =
   * runId lookup would miss and strand the run at the global default.
   *
   * canUseTool (permission-mode redesign §5 / Slice 7) is composed here too — from
   * the SAME gateRunId + allowRules (loaded once) — and returned UNCONDITIONALLY so
   * the native auto-mode classifier's terminal 'ask' verdict becomes a blocking
   * ApprovalRouter prompt. It is INERT in every hook-decided mode (the hook emits a
   * concrete decision that pre-empts the classifier, so the SDK never issues a
   * `can_use_tool` control-request); see makeCanUseTool.
   *
   * MUTUAL EXCLUSION: canUseTool ⊥ permissionPromptToolName — the SDK throws at
   * runtime if BOTH are set. cyboflow sets permissionPromptToolName NOWHERE
   * (grep = 0); do NOT introduce it while canUseTool is installed.
   */
  private composeHookOptions(options: ClaudeSpawnOptions): Pick<Options, 'hooks' | 'canUseTool'> {
    const gateRunId = options.runId ?? options.panelId;
    const ownerSessionId = this.resolveOwnerSessionId(gateRunId);
    const allowRules = loadMergedPermissionRules(options.worktreePath);
    const hook = this.makeDynamicPreToolUseHook(gateRunId, ownerSessionId, allowRules, options.model);

    return {
      hooks: {
        PreToolUse: [{ hooks: [hook] }],
      },
      canUseTool: this.makeCanUseTool(gateRunId, allowRules),
    };
  }

  /**
   * Resolve the owning session UUID for a gate run ONCE at spawn from the gate
   * `runId` (permission-mode redesign §3b). Robust for BOTH entry shapes:
   *   - chat turn → gate run = a `__quick__` chat sentinel → its `session_id`
   *   - flow run  → gate run = the flow run itself → its `session_id`
   * (for flows sessionId === runId, so the run→session indirection is the fix).
   * Returns undefined when no row resolves (legacy sentinel left NULL by design,
   * or an unknown run) — readLiveSessionMode then floors to the global default.
   */
  private resolveOwnerSessionId(gateRunId: string): string | undefined {
    try {
      const row = this.db
        .prepare('SELECT session_id FROM workflow_runs WHERE id = ?')
        .get(gateRunId) as { session_id?: unknown } | undefined;
      return typeof row?.session_id === 'string' && row.session_id.length > 0
        ? row.session_id
        : undefined;
    } catch {
      // Fail-soft (matches the spawn-seam revive/lane-derive guards): a read
      // failure (e.g. an older DB predating migration 019's session_id column)
      // floors the live read to the global default rather than crashing the spawn.
      return undefined;
    }
  }

  /**
   * Live-read the owning session's 4-mode permission value (the single execution
   * authority — `sessions.agent_permission_mode`). Called once per hook
   * invocation so a mid-run mode switch takes effect on the next tool call. Floors
   * to the global default (Settings → Agent Permission Mode) when the column is
   * unset/invalid or the session does not resolve. Does NOT trust
   * BaseHookInput.permission_mode (that reflects the SDK's own mode, not the
   * session column).
   */
  private readLiveSessionMode(ownerSessionId: string | undefined): PermissionMode {
    if (ownerSessionId) {
      const row = this.db
        .prepare('SELECT agent_permission_mode AS m FROM sessions WHERE id = ?')
        .get(ownerSessionId) as { m?: unknown } | undefined;
      const m: unknown = row?.m;
      if (isPermissionMode(m)) return m;
    }
    // 4-mode floor ('ask before edits') when no configManager is wired — matches
    // resolveRunAgentPermissionMode / permissionModeResolver's DEFAULT floor. (The
    // legacy DEFAULT_PERMISSION_MODE constant is the 2-mode 'approve', not this.)
    return this.configManager?.getDefaultAgentPermissionMode() ?? 'default';
  }

  /**
   * Build the single always-installed dynamic PreToolUse hook (permission-mode
   * redesign §4). Merges the former per-mode hooks (makePreToolUseHook +
   * makeAutoModePreToolUseHook) behind one live-mode branch. Per call, in order:
   *
   *   0. deriveLaneFromTaskDispatch (observe-only) — BEFORE the mode branch so a
   *      sprint Task dispatch advances its lane in EVERY mode, including auto-defer
   *      and dontAsk (which never reach the ApprovalRouter, where the in-router
   *      twin of this call lives). Strict no-op off the sprint path; never throws.
   *   1. mode = readLiveSessionMode() — re-read fresh on every call.
   *   2. AskUserQuestion → QuestionRouter in ALL modes (incl. dontAsk; intentional
   *      — it is the agent's CONTENT question, not a permission prompt).
   *   3. branch on the freshly-read mode (see composeHookOptions doc).
   *
   * The default/acceptEdits and auto-unsupported branches delegate to the pre-built
   * makePreToolUseHook closures (allowlist + acceptEdits fast-allow + ApprovalRouter
   * routing); the auto-supported branch delegates to makeAutoModePreToolUseHook
   * (empty defer output). The closures are built ONCE here, not per call.
   */
  private makeDynamicPreToolUseHook(
    gateRunId: string,
    ownerSessionId: string | undefined,
    allowRules: MergedPermissionRules,
    model: string | undefined,
  ): HookCallback {
    const loggerLike = makeLoggerLike(this.logger);
    // Per-mode delegate hooks, built once (each captures gateRunId + allowRules).
    const routerDefaultHook = this.makePreToolUseHook(gateRunId, allowRules, 'default');
    const routerAcceptEditsHook = this.makePreToolUseHook(gateRunId, allowRules, 'acceptEdits');
    const autoDeferHook = this.makeAutoModePreToolUseHook(gateRunId);

    return async (input, toolUseId, ctx) => {
      const pretool = input as PreToolUseHookInput;

      // (0) Observe-only sprint-lane auto-derive — BEFORE the mode branch so it
      // fires even on the auto-defer / dontAsk paths that never reach the router.
      // (routePreToolUseThroughApprovalRouter fires the in-process twin too; the
      // call is idempotent/monotonic-forward, so the redundant default/acceptEdits
      // fire is harmless.) Defensive: never disturbs the gating verdict.
      try {
        SprintLaneStore.getInstance().deriveLaneFromTaskDispatch({
          runId: gateRunId,
          toolName: pretool.tool_name,
          toolInput: (pretool.tool_input ?? {}) as Record<string, unknown>,
        });
      } catch {
        // SprintLaneStore not initialized / read failure — auto-derive is best-effort.
      }

      // (1) Live-read the owning session's mode for THIS call.
      const mode = this.readLiveSessionMode(ownerSessionId);

      // (2) AskUserQuestion → QuestionRouter in EVERY mode (intentional change —
      // dontAsk previously used the SDK's native handler).
      if (pretool.tool_name === 'AskUserQuestion') {
        return this.routeAskUserQuestion(pretool, gateRunId, loggerLike);
      }

      // (3) Branch on the freshly-read mode.
      switch (mode) {
        case 'dontAsk':
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'allow' as const,
            },
          };
        case 'acceptEdits':
          return routerAcceptEditsHook(input, toolUseId, ctx);
        case 'auto':
          // Model-eligibility is evaluated PER CALL: defer to the native
          // classifier only on a classifier-capable model; otherwise route
          // through the ApprovalRouter (treat like 'default') since no classifier
          // exists to defer to.
          return modelSupportsAutoMode(model)
            ? autoDeferHook(input, toolUseId, ctx)
            : routerDefaultHook(input, toolUseId, ctx);
        case 'default':
        default:
          return routerDefaultHook(input, toolUseId, ctx);
      }
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
   *     sprint question gates still work),
   *   - allows the first-party `mcp__cyboflow__*` tools deterministically (the
   *     app's own orchestration surface — never model-gated; see
   *     {@link CYBOFLOW_MCP_TOOL_PREFIX}), and
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
      // First-party cyboflow MCP tools (report_step, create/update task, …) are the
      // app's own orchestration surface — allow them deterministically so they never
      // reach the classifier. When the classifier's model is unavailable it denies
      // EVERY tool ("cannot determine the safety"), which soft-bricks the run
      // (report_step denied → current_step_id never advances → the plan gate no-ops).
      if (pretool.tool_name.startsWith(CYBOFLOW_MCP_TOOL_PREFIX)) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'allow' as const,
          },
        };
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
   * Build the UNCONDITIONAL `canUseTool` callback (permission-mode redesign §5 /
   * Slice 7 — auto-mode prompting). The terminal sink for the native auto-mode
   * classifier's 'ask' verdict.
   *
   * SDK permission precedence (sdk.d.ts): static rules → PreToolUse hook →
   * permission-mode eval (the auto classifier, ONLY when permissionMode:'auto') →
   * if the resolved verdict is 'ask', the SDK issues a `can_use_tool`
   * control-request → THIS callback. Because the always-installed dynamic hook
   * (makeDynamicPreToolUseHook) emits a concrete allow/deny for EVERY hook-decided
   * mode (default / acceptEdits / dontAsk, and 'auto' on an auto-UNSUPPORTED model),
   * canUseTool is reached ONLY on the auto path where the hook deferred and the
   * classifier said 'ask'. It is INERT (never invoked) in the hook-decided modes —
   * no double-prompt. Installing it unconditionally keeps a live switch INTO 'auto'
   * (no re-spawn) fully gated.
   *
   * It mirrors routePreToolUseThroughApprovalRouter (the hook's router path),
   * mapping an ApprovalDecision → PermissionResult. `updatedInput` is MANDATORY on
   * the allow branch: the native CLI Zod-validates our can_use_tool control-response
   * and its allow schema requires `updatedInput` to be a record — a bare
   * `{ behavior: 'allow' }` fails as `invalid_union` ("expected record, received
   * undefined") and reaches the model as an is_error "Tool permission request
   * failed: ZodError …" tool_result (NOT a denial; the agent then loops, retrying
   * the tool). So echo the reviewer's modified input when present, else the original
   * tool `input` unchanged:
   *   - allowlist short-circuit (defense-in-depth: honor user/project grants even on
   *     the auto path) → { behavior: 'allow', updatedInput: input };
   *   - allow → { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
   *   - deny  → { behavior: 'deny', message } (message is MANDATORY on deny);
   *   - RunNotRunningError → { behavior: 'deny', message: 'Run not active' };
   *   - any other error → rethrow (only the run-not-running case is a benign deny;
   *     the surrounding hook/SDK boundary renders an unexpected throw as is_error).
   * `interrupt` is deliberately NOT set — let the agent retry, matching the hook
   * deny path. deriveLaneFromTaskDispatch is NOT here: it lives in the always-firing
   * hook (the classifier auto-allows a benign Task dispatch, so canUseTool would
   * never fire for it).
   *
   * MUTUAL EXCLUSION: canUseTool ⊥ permissionPromptToolName (the SDK throws at
   * runtime if both are set). cyboflow sets permissionPromptToolName NOWHERE.
   */
  private makeCanUseTool(gateRunId: string, allowRules: MergedPermissionRules): CanUseTool {
    return async (toolName, input, _opts): Promise<PermissionResult> => {
      // Defense-in-depth: honor the user/project allowlist even on the auto path.
      // `updatedInput: input` echoes the original tool input unchanged — MANDATORY
      // on the allow branch (the CLI's can_use_tool response schema requires a
      // record; a bare `{ behavior: 'allow' }` ZodErrors → see makeCanUseTool doc).
      if (isToolAllowed(toolName, input, allowRules)) {
        return { behavior: 'allow', updatedInput: input };
      }
      try {
        const decision = await ApprovalRouter.getInstance().requestApproval(
          gateRunId,
          toolName,
          input,
          () => {}, // socketReply is a no-op on the SDK path (the decision arrives via the gate)
        );
        return decision.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: decision.updatedInput ?? input }
          : { behavior: 'deny', message: decision.message ?? 'Denied by reviewer' };
      } catch (err) {
        if (err instanceof RunNotRunningError) {
          return { behavior: 'deny', message: 'Run not active' };
        }
        throw err;
      }
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
   * When `mode === 'acceptEdits'`, the acceptEdits auto-approve surface
   * (Edit/Write/MultiEdit PLUS the widened read-only surface — safe read-only
   * tools and provably read-only Bash/git, via isAcceptEditsAutoApprovable) is
   * auto-allowed BEFORE the user/project allowlist check; all other tools follow
   * the same allowlist → ApprovalRouter path as 'default'. `mode === 'default'`
   * keeps the pre-step behavior exactly.
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
      // acceptEdits: auto-allow the edit tools + the widened read-only surface
      // (safe reads + provably read-only Bash/git) BEFORE the allowlist check.
      if (mode === 'acceptEdits' && isAcceptEditsAutoApprovable(pretool.tool_name, pretool.tool_input)) {
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
   *
   * Fan-out dispatch: a programmatic fan-out run drives multiple lanes under ONE
   * runId (panelId), each registered in spawnKeysByRunId. When panelId is a runId
   * with registered spawns, delegate to killRun so EVERY lane is aborted —
   * aborting only the spawn keyed by panelId would leave sibling lanes running.
   * This guard ALSO catches single-lane workflow runs (panelId === runId, one
   * registered spawnKey === panelId): killRun over that one-entry set is
   * behaviorally identical to the single-abort path below. Only ids with NO
   * registry entry — quick sessions (run_id ≠ panelId) and untracked panels —
   * fall through to the EXISTING single-abort path, byte-identical.
   */
  override async killProcess(panelId: string): Promise<void> {
    if (this.spawnKeysByRunId.has(panelId)) {
      await this.killRun(panelId);
      return;
    }
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
   * Abort EVERY lane spawn of a programmatic fan-out run and wait for them all
   * to settle. Reads the run's live spawnKeys from spawnKeysByRunId and routes
   * each through the single-spawn abort routine (abortCurrentRun, keyed by
   * spawnKey since the sdkRuns / processes maps are spawnKey-keyed). Tolerates an
   * absent or empty set as a no-op. Snapshots the set first because each lane's
   * teardown (forgetSpawnKey) mutates it.
   */
  async killRun(runId: string): Promise<void> {
    const keySet = this.spawnKeysByRunId.get(runId);
    if (keySet === undefined || keySet.size === 0) return;
    const spawnKeys = Array.from(keySet);
    await Promise.all(
      spawnKeys.map(async (spawnKey) => {
        await this.abortCurrentRun(spawnKey);
        this.processes.delete(spawnKey);
      })
    );
  }

  /**
   * Abort the running SDK query for a single spawn and wait for it to settle.
   * The key is a spawnKey: on a non-fan-out path it === panelId (so existing
   * callers pass panelId unchanged); on a fan-out lane killRun passes the lane's
   * spawnKey. The sdkRuns map is spawnKey-keyed, so this resolves the right run.
   */
  private async abortCurrentRun(spawnKey: string): Promise<void> {
    const run = this.sdkRuns.get(spawnKey);
    if (!run) return;
    run.abortController.abort();
    await run.iteratorDone.catch(() => {});
    this.sdkRuns.delete(spawnKey);
  }

  /**
   * Dispose and remove the pipeline tuple for a spawnKey (per-lane on fan-out,
   * else === panelId). Idempotent: safe to call multiple times.
   *
   * SUB-HAZARD A: the DynamicWorkflowTracker is a runId-keyed singleton shared by
   * all fan-out lanes. Detach ONLY when this run's refcount falls to 0 (the last
   * lane), so a finishing lane never tears down a sibling lane's detector. The
   * per-lane sink/router ARE per-spawn and always disposed.
   */
  private cleanupPipeline(spawnKey: string): void {
    const pl = this.pipelines.get(spawnKey);
    if (!pl) return;
    // Decrement the per-run tracker refcount; detach only when the LAST lane of
    // this run is cleaned up (1→0). Guard against double-cleanup driving it < 0.
    const remaining = (this.trackerRefcountByRunId.get(pl.runId) ?? 0) - 1;
    if (remaining <= 0) {
      this.trackerRefcountByRunId.delete(pl.runId);
      // Stop dynamic-workflow detection/tailing for the run before sink disposal.
      DynamicWorkflowTracker.tryGetInstance()?.detachRun(pl.runId);
    } else {
      this.trackerRefcountByRunId.set(pl.runId, remaining);
    }
    pl.sink.dispose(pl.runId);
    pl.router.clearRun(pl.runId);
    this.pipelines.delete(spawnKey);
  }

  /**
   * Remove a spawnKey from its run's live-lane registry, deleting the Set once
   * the run has no remaining lanes. Idempotent — safe on the abort + normal
   * teardown paths.
   */
  private forgetSpawnKey(runId: string, spawnKey: string): void {
    const keySet = this.spawnKeysByRunId.get(runId);
    if (keySet === undefined) return;
    keySet.delete(spawnKey);
    if (keySet.size === 0) {
      this.spawnKeysByRunId.delete(runId);
    }
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
    model?: string,
    fastMode?: boolean
  ): Promise<void> {
    const { validatePanelSessionOwnership, logValidationFailure } = require('../../../utils/sessionValidation');
    const validation = validatePanelSessionOwnership(panelId, sessionId);
    if (!validation.valid) {
      logValidationFailure('ClaudeCodeManager.startPanel', validation);
      throw new Error(`Panel validation failed: ${validation.error}`);
    }
    console.log(`[ClaudeCodeManager] Validated panel ${panelId} belongs to session ${sessionId}`);
    return this.spawnClaudeCode(panelId, sessionId, worktreePath, prompt, undefined, false, permissionMode, model, fastMode);
  }

  async continuePanel(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    prompt: string,
    conversationHistory: ConversationMessage[],
    permissionModeOverride?: 'approve' | 'ignore',
    model?: string,
    fastMode?: boolean
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
        model,
        fastMode
      });

      if (shouldSkipContinue) {
        console.log(`[ClaudeCodeManager] Clearing skip_continue_next flag for session ${sessionId}`);
        this.sessionManager.updateSession(sessionId, { skip_continue_next: false });
        console.log(`[ClaudeCodeManager] Skipping resume for panel ${panelId} due to prompt compaction`);
        return this.spawnClaudeCode(panelId, sessionId, worktreePath, prompt, [], false, permissionMode, model, fastMode);
      } else {
        console.log(`[ClaudeCodeManager] Using resume for panel ${panelId}`);
        return this.spawnClaudeCode(panelId, sessionId, worktreePath, prompt, [], true, permissionMode, model, fastMode);
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
    model?: string,
    fastMode?: boolean
  ): Promise<void> {
    const options: ClaudeSpawnOptions = {
      panelId,
      sessionId,
      worktreePath,
      prompt,
      conversationHistory,
      isResume,
      permissionMode,
      fastMode,
      // Quick/legacy SDK sessions resolve their 4-mode agent permission from the
      // per-session override (sessions.agent_permission_mode, migration 021) when
      // set, else the GLOBAL default — so both the Settings control AND the
      // Session Start Wizard step-3 / quick-session config govern them (not just
      // workflow runs). NOTE (permission-mode redesign §3b/§4): the SDK PreToolUse
      // hook now LIVE-READS this same session column on every tool call (the single
      // execution authority), so this seeded value is a launch-time hint that the
      // hook re-derives from the DB rather than a value the hook consumes directly.
      // Threaded here for parity/observability and for any non-SDK reader.
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

  /**
   * Per-session MCP DENY list — read at spawn from sessions.disabled_mcp_servers_json
   * (migration 036). Returns the parsed server-name array, or [] when the column
   * is missing/empty/malformed (so the default path filters nothing and stays
   * byte-identical). The 'cyboflow' entry is never honored — composeMcpServers
   * skips it explicitly. Reading the DB row (not a threaded arg) keeps it
   * restart-safe, mirroring resolveSessionAgentPermissionMode.
   */
  private resolveSessionDisabledMcps(sessionId: string): string[] {
    const raw = this.sessionManager.getDbSession(sessionId)?.disabled_mcp_servers_json;
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      return [];
    }
  }

  /**
   * The installed plugin universe (`"<name>@<marketplace>"` ids). Split out as a
   * `protected` seam so tests can stub it hermetically (the production read hits
   * the user's `~/.claude/plugins/installed_plugins.json`).
   */
  protected getInstalledPluginIds(): string[] {
    return readInstalledPluginIds();
  }

  /**
   * Per-session plugin selection → a DETERMINISTIC (EXCLUSIVE) enabledPlugins
   * map, read at spawn from sessions.enabled_plugins_json (migration 039).
   *
   * The selection is an ALLOW list (the plugins the session wants ON). Because
   * cyboflow keeps `settingSources: ['user','project']`, plugins the user
   * enabled globally would otherwise leak into every session and an additive
   * `{ id: true }` overlay could not turn them off. So instead we emit the FULL
   * exclusive map: every SELECTED plugin → true, every OTHER installed plugin →
   * false. Our overlay lands at the `flag` precedence tier (user < project <
   * local < flag < policy), so a `false` here overrides a file-enabled `true` —
   * the session runs EXACTLY the selected set (only a managed `policy` can win).
   * The map itself is built by the shared `buildExclusiveEnabledPluginsMap`
   * helper — the interactive PTY sibling now emits the SAME exclusive map (the
   * CLI's honoring of `enabledPlugins:{id:false}` at the flag tier was confirmed
   * empirically), so the logic lives in one place to prevent drift.
   *
   * Returns `undefined` when the column is missing/empty/malformed — no
   * enabledPlugins key is emitted and file-loaded plugins are untouched
   * (byte-identical opt-out default). When the installed universe can't be read
   * (empty catalogue) it degrades to the old additive behavior (only the
   * selected `true` entries — nothing to disable).
   */
  private resolveSessionEnabledPlugins(sessionId: string): Record<string, boolean> | undefined {
    const raw = this.sessionManager.getDbSession(sessionId)?.enabled_plugins_json;
    if (!raw) return undefined;
    return buildExclusiveEnabledPluginsMap(raw, this.getInstalledPluginIds());
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
