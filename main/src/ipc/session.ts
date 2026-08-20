import { IpcMain } from 'electron';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import type { AppServices } from './types';
import { aggregateExecutionDiffTotals } from './executionDiffAggregation';
import { computeSessionFileStats, type SessionFileStats } from './sessionFileStats';
import type { CreateSessionRequest } from '../types/session';
import { getCyboflowSubdirectory } from '../utils/cyboflowDirectory';
import { convertDbFolderToFolder } from './folders';
import { panelManager } from '../services/panelManager';
import { trackUsage, captureSeamError } from '../services/telemetry';
import { classifyErrorPattern } from '../orchestrator/programmatic/systemicError';
import {
  validateSessionExists,
  validatePanelSessionOwnership,
  validatePanelExists,
  validateSessionIsActive,
  logValidationFailure,
  createValidationError
} from '../utils/sessionValidation';
import type { SerializedArchiveTask } from '../services/archiveProgressManager';
import {
  agentStreamEventToClaudeStreamEvent,
  MessageProjection,
  TypedEventNarrowing,
} from '../services/streamParser';
import type { UnifiedMessage } from '../../../shared/types/unifiedMessage';
import type { SessionSummaryPayload } from '../../../shared/types/sessionSummary';
import type { SessionOutput, Session as SessionType } from '../types/session';
import type { Logger } from '../utils/logger';
import { transitionToRunning } from '../services/cyboflow/transitions';
import { assertTransitionAllowed } from '../services/cyboflow/stateMachine';
import {
  createQuickSessionCore,
  stampQuickSessionRuntimeConfig,
  QUICK_PROVIDER_SDK_RUNTIME,
} from '../services/createQuickSessionCore';
import { isPermissionMode, type PermissionMode } from '../../../shared/types/workflows';
import { dismissPendingReviewItemsForSession, stampSessionRunsOutcome } from '../orchestrator/runRecovery';
import { makeDatabaseLike } from '../orchestrator/loggerAdapter';
import { ArtifactRouter } from '../orchestrator/artifactRouter';
import { selectSessionRunTokenTotals } from '../orchestrator/insightsQueries';
import { isCliSubstrate } from '../../../shared/types/substrate';
import {
  AGENT_PROVIDER_LABELS,
  claudeRuntimeFromSubstrate,
  formatProviderRuntimeConflict,
  isAgentProvider,
  isAgentProviderEnabled,
  isSessionAgentRuntime,
  providerForRuntime,
  providerRuntimeConflict,
} from '../../../shared/types/agentRuntime';
import { DEFAULT_OMP_MODEL } from '../../../shared/types/omp';
import type { AgentProvider } from '../../../shared/types/agentRuntime';
import type { SessionAgentRuntime } from '../../../shared/types/agentRuntime';
import { normalizeAgentModelSelection } from '../../../shared/types/agentModels';
import { isAnyEffortLevel, type ReasoningEffort } from '../../../shared/types/reasoningEffort';
import {
  QUICK_PTY_BRIEFING,
  QUICK_CODEX_PTY_BRIEFING,
  QUICK_CODEX_SDK_BRIEFING,
  QUICK_OMP_PTY_BRIEFING,
} from './quickSessionBriefings';
import { relayOrSpawnPtyPanel } from './ptyPanelDispatch';
import { agentProviderDisabledMessage, assertAgentProviderAllowed } from '../services/agentProviderGuard';
import { resolveSubstrate } from '../orchestrator/substrateResolver';
import { isPtyLane, resolvePanelLane, type PanelLane } from '../services/panelLane';
import type { AbstractCliManager } from '../services/panels/cli/AbstractCliManager';
import type { ToolPanel } from '../../../shared/types/panels';
import { isAgentStreamEvent } from '../../../shared/types/agentStream';
import { isQuickSessionWorktreeMode } from '../../../shared/types/worktreeMode';
import { DynamicWorkflowTracker } from '../orchestrator/dynamicWorkflows';
import { AgentInvocationStore } from '../orchestrator/agentInvocationStore';
import { encodeCwd } from '../services/panels/claude/transcript/encodeCwd';
import { getCurrentBranch } from '../services/gitPlumbingCommands';
import { ClaudeCodeManager } from '../services/panels/claude/claudeCodeManager';
import { updateSessionAgentPermissionMode } from '../orchestrator/sessionPermissionMode';
import { listQuickSessions } from '../orchestrator/quickSessionListing';
import { QuestionRouter } from '../orchestrator/questionRouter';
import { ApprovalRouter } from '../orchestrator/approvalRouter';
import { validateDesignIdeaLink } from '../services/designIdeaValidation';
import { detectClaudeCredentials } from '../utils/claudeCredentials';
import { detectClaudeBinary } from '../utils/claudeCodeTest';
import { computeState as computeClaudeDetectionState } from './claudeDetection';

/**
 * Whether claude's own on-disk transcript for a resumable session still exists at
 * `~/.claude/projects/<encodeCwd(worktree)>/<uuid>.jsonl`. Resume (`claude --resume
 * <uuid>`) fails if it is gone (cleared ~/.claude, moved project, etc.), so the
 * resume offer is gated on this — otherwise the first message rides a failed spawn
 * and is lost. Mirrors TranscriptTailSource's path scheme.
 */

// QUICK_PROVIDER_SDK_RUNTIME (the provider → structured-runtime projection this
// handler's ladder reads) lives in createQuickSessionCore.ts, next to the stamp
// chokepoint, so the A/B quick-arm path resolves against the SAME table.

/**
 * Report a swallowed EAGER PTY spawn failure (create-quick's fire-and-forget
 * `startPanel`) to Sentry.
 *
 * The eager spawn is deliberately fail-soft — create-quick has already returned
 * `success` plus a `claudePanelId`, and a later `sessions:input` re-spawns the
 * REPL — but fail-soft is also INVISIBLE: the renderer mounts a terminal on a
 * `cyboflow:pty:<id>` channel that will never emit a byte and shows a bare
 * cursor indefinitely, with no error on any surface. Only `spawnCliProcess`'s
 * own final failure self-reports (`pty-spawn-failed`); anything `startPanel`
 * throws before reaching it (worktree checks, settings writes, briefing prep)
 * previously died in a `console.error` nobody would ever read on a user's
 * machine. This makes that class of blank terminal diagnosable.
 *
 * Fixed message + bounded `errorClass` per captureSeamError's payload rules —
 * the raw error text stays in the local console.error at the call site.
 */
function reportEagerSpawnFailure(err: unknown, substrate: string, cliTool: string): void {
  const errorClass = classifyErrorPattern(err instanceof Error ? err.message : String(err));
  captureSeamError(
    'eager-pty-spawn-failed',
    new Error(`eager ${cliTool} REPL spawn failed (${errorClass})`),
    { substrate, cliTool, errorClass },
  );
}

function interactiveTranscriptExists(
  worktreePath: string | null | undefined,
  claudeSessionId: string | null | undefined,
): boolean {
  if (!worktreePath || !claudeSessionId) return false;
  const file = path.join(
    os.homedir(),
    '.claude',
    'projects',
    encodeCwd(worktreePath),
    `${claudeSessionId}.jsonl`,
  );
  return existsSync(file);
}

type ClaudeConfig = NonNullable<CreateSessionRequest['claudeConfig']>;

function normalizeClaudeConfig(config: ClaudeConfig | undefined): ClaudeConfig | undefined {
  if (!config) return undefined;
  const { model: rawModel, ...rest } = config;
  const model = normalizeAgentModelSelection('claude', rawModel);
  return {
    ...rest,
    ...(model !== undefined ? { model } : {}),
  };
}

function firstProviderModel(
  provider: AgentProvider,
  ...models: Array<string | null | undefined>
): string | undefined {
  for (const model of models) {
    const normalized = normalizeAgentModelSelection(provider, model);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

/**
 * Project an ordered array of raw stored outputs into UnifiedMessage[].
 *
 * Each output whose `type === 'json'` is fed through TypedEventNarrowing and
 * then MessageProjection. Outputs that project to null (e.g. user/tool_result
 * events, stream_event deltas) are filtered out. The persisted output timestamp
 * is used in place of MessageProjection's `new Date()` default so that UI
 * ordering reflects the actual run time.
 *
 * NOTE — legacy read path: this helper reads from session_outputs (written by
 * the SDK event-forward branch in claudeCodeManager.runSdkQuery). The parallel
 * pipeline (SDK query() iterator -> EventRouter -> RawEventsSink -> raw_events
 * table, also wired in claudeCodeManager) is the intended long-term read source
 * once the renderer migrates from panels:get-json-messages to the
 * EventRouter/tRPC path (Day-3 cutover — TBD task ID). Do NOT merge these
 * paths until that migration lands.
 */
export function projectStoredOutputs(
  outputs: SessionOutput[],
  panelId: string,
  logger?: Logger,
): UnifiedMessage[] {
  const narrower = new TypedEventNarrowing(logger);
  const projection = new MessageProjection(panelId);
  const result: UnifiedMessage[] = [];

  // Ensure chronological order (DB usually returns in insert order, but be safe).
  const sorted = [...outputs].sort((a, b) => {
    const ta = a.timestamp instanceof Date ? a.timestamp.getTime() : 0;
    const tb = b.timestamp instanceof Date ? b.timestamp.getTime() : 0;
    return ta - tb;
  });

  for (const output of sorted) {
    if (output.type !== 'json') continue;

    // sessionManager.getPanelOutputs pre-parses JSON data; accept objects directly.
    // Also handle the string case defensively.
    let raw: unknown;
    if (typeof output.data === 'string') {
      try {
        raw = JSON.parse(output.data);
      } catch {
        continue; // Unparseable — skip.
      }
    } else if (typeof output.data === 'object' && output.data !== null) {
      raw = output.data;
    } else {
      continue;
    }

    const event = isAgentStreamEvent(raw)
      ? agentStreamEventToClaudeStreamEvent(raw)
      : narrower.narrow(raw);
    const projected = projection.project(event);
    if (projected !== null) {
      // Overwrite the MessageProjection-generated timestamp with the persisted one.
      const iso =
        output.timestamp instanceof Date
          ? output.timestamp.toISOString()
          : projected.timestamp;
      result.push({ ...projected, timestamp: iso });
    }
  }

  return result;
}

// Word lists for generateQuickWorktreeBranchName (IDEA-001: Heroku/Docker-style
// two-word names). All lowercase ascii [a-z]+, friendly/neutral vocabulary
// (nature, colors, textures, animals, landforms) — nothing violent, anatomical,
// branded, or ambiguous. Kept free of duplicates within each list (asserted by
// a test), but the two lists are independent so cross-list repeats are fine.
export const QUICK_NAME_ADJECTIVES = [
  'amber', 'azure', 'brave', 'bright', 'calm', 'coral', 'cozy', 'crisp',
  'curious', 'dawn', 'dusty', 'eager', 'earthy', 'emerald', 'faint', 'fresh',
  'gentle', 'golden', 'grand', 'green', 'happy', 'hazy', 'hidden', 'humble',
  'ivory', 'jade', 'jolly', 'kind', 'lively', 'lucky', 'mellow', 'misty',
  'mossy', 'muted', 'nimble', 'noble', 'olive', 'peaceful', 'pale', 'plucky',
  'quiet', 'quick', 'rustic', 'sandy', 'shiny', 'silent', 'silver', 'sleepy',
  'smooth', 'soft', 'solar', 'steady', 'stormy', 'sunny', 'swift', 'tidy',
  'tranquil', 'twilight', 'velvet', 'vivid', 'warm', 'wild', 'windy', 'zesty',
] as const;

export const QUICK_NAME_NOUNS = [
  'alpaca', 'badger', 'basin', 'beacon', 'birch', 'bison', 'bluff', 'brook',
  'canyon', 'cedar', 'cliff', 'clover', 'comet', 'coral', 'cove', 'coyote',
  'crane', 'creek', 'delta', 'dune', 'eagle', 'ember', 'falcon', 'fern',
  'field', 'finch', 'fjord', 'forest', 'fox', 'glacier', 'glade', 'grove',
  'harbor', 'hawk', 'heron', 'hill', 'island', 'ivy', 'juniper', 'lagoon',
  'lake', 'lantern', 'lark', 'leaf', 'ledge', 'lily', 'lynx', 'maple',
  'marsh', 'meadow', 'moss', 'mountain', 'otter', 'owl', 'panda', 'peak',
  'pebble', 'pine', 'plain', 'plateau', 'pond', 'prairie', 'quail', 'reef',
  'ridge', 'river', 'robin', 'sage', 'shore', 'sparrow', 'spring', 'stone',
  'stream', 'summit', 'swan', 'thicket', 'tide', 'trail', 'valley', 'willow',
  'wolf', 'wren',
] as const;

/**
 * Generate a human-friendly two-word worktree branch name for quick sessions
 * (IDEA-001), Heroku/Docker style: `<adjective>-<noun>`, both drawn from fixed
 * word lists below. No behavioral code keys off the old `quick-` prefix (see
 * IDEA-001 investigation), so it is dropped in favor of the plain two-word
 * shape, but the UTC creation date is appended (`<adjective>-<noun>-YYYYMMDD`)
 * so names stay chronologically scannable in branch lists. The `rng` / `now`
 * parameters exist for deterministic test output; defaults are `Math.random`
 * and the wall-clock instant at call time.
 */
export function generateQuickWorktreeBranchName(
  rng: () => number = Math.random,
  now: Date = new Date(),
): string {
  const adjective = QUICK_NAME_ADJECTIVES[Math.floor(rng() * QUICK_NAME_ADJECTIVES.length)];
  const noun = QUICK_NAME_NOUNS[Math.floor(rng() * QUICK_NAME_NOUNS.length)];
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  return `${adjective}-${noun}-${date}`;
}

/**
 * First prompt written into the persistent interactive REPL when a quick session
 * opts into the PTY substrate (sessions:create-quick eager spawn). A minimal
 * context briefing — NOT a workflow prompt: it must never instruct the agent to
 * start work. NOTE: this text must NEVER contain the word "ultracode" — that
 * keyword is reserved for the USER to type (it is what the passive
 * dynamic-workflow detection at the EventRouter seam keys off).
 */
export function registerSessionHandlers(ipcMain: IpcMain, services: AppServices): void {
  const {
    sessionManager,
    databaseService,
    taskQueue,
    worktreeManager,
    cliManagerFactory,
    claudeCodeManager, // For backward compatibility
    interactiveCliManager, // PTY substrate sibling (quick-session relay/spawn)
    codexSdkManager, // Structured Codex app-server quick-session runtime
    codexPtyManager, // Codex PTY quick-session runtime
    ompSdkManager, // Structured OMP RPC quick-session runtime
    ompPtyManager, // OMP PTY quick-session runtime
    killLiveSession, // hard-kill seam for a dismissed PTY quick session's REPL
    registerLivePanel, // at-spawn runId→panelId seed for the facade's relay translation
    registerCodexPtyPanel, // at-spawn runId→panelId seed for Codex PTY quick sessions
    registerOmpPtyPanel, // the OMP twin of registerCodexPtyPanel
    gitStatusManager,
    gitDiffManager, // git-derived session file stats for sessions:get-statistics
    archiveProgressManager,
    configManager, // demo-mode probe — gates the real interactive PTY spawn/relay
    chatSentinelProvider, // chat-gate vehicle resolver (revives an app_restart-parked sentinel)
    ompSessionManager, // OMP fleet runtime (remote worker; undefined when bridge unconfigured)
    cyboflow
  } = services;

  // Resolve the single server-side 'claude' panel id an interactive quick session
  // owns (created by sessions:create-quick). Undefined if none exists yet.
  const resolveClaudePanelId = (sessionId: string): string | undefined =>
    panelManager.getPanelsForSession(sessionId).find((p) => p.type === 'claude')?.id;

  /**
   * Resolve WHICH chat panel a resume request targets.
   *
   * A session can host several chat panels (TASK-103 Add-chat), so the resume
   * seams can no longer assume "the session's first claude panel". Prefer the
   * caller-supplied panelId — validated to exist, to be a claude panel, and to
   * belong to THIS session so a stale/foreign id can never respawn someone else's
   * REPL — and fall back to the first panel for legacy callers that pass none.
   */
  const resolveResumeTargetPanel = (
    sessionId: string,
    panelId: string | undefined,
  ): ToolPanel | undefined => {
    const panels = panelManager.getPanelsForSession(sessionId).filter((p) => p.type === 'claude');
    if (panelId) return panels.find((p) => p.id === panelId);
    return panels[0];
  };

  /**
   * The panel's EFFECTIVE substrate: a per-panel override (Add-chat picker /
   * claude-panels:set-substrate) wins over the session's, mirroring
   * ClaudePanelManager.getCliManager and ptyPanelDispatch. `env: {}` — panel
   * routing inherits only the session value, never the process environment.
   */
  const resolvePanelSubstrate = (panel: ToolPanel, dbSession: { substrate?: string | null } | undefined) =>
    resolveSubstrate({
      panelOverrideSubstrate: panel.substrate ?? undefined,
      requestedSubstrate: dbSession?.substrate ?? undefined,
      env: {},
    });

  /**
   * The (provider × substrate) lane that owns a panel — see services/panelLane.ts.
   *
   * Every chat dispatch seam below switches on THIS, never on the session's
   * `agent_runtime` alone: the runtime fixes only the provider, and reading it as
   * if it also fixed the substrate is what made per-panel overrides inert on the
   * Codex side.
   */
  const laneForPanel = (panel: ToolPanel): PanelLane =>
    resolvePanelLane(databaseService.getSession(panel.sessionId), panel);

  /** Lane for a panel id, when only the id is in hand (event handlers). */
  const laneForPanelId = (panelId: string): PanelLane | undefined => {
    const panel = panelManager.getPanel(panelId);
    return panel ? laneForPanel(panel) : undefined;
  };

  /**
   * Route an OMP-fleet panel turn: relay into the live worker, or spawn it on
   * the first message (the ADR's "first message spawns"). Returns null when the
   * panel's session is NOT omp-fleet (the caller keeps its own lane), otherwise
   * an IPC-shaped result. Fail-closed: an unconfigured bridge (no manager) is an
   * `unavailable`, never a fallback to a local provider.
   */
  const routeOmpPanelTurn = async (
    panelId: string,
    input: string,
  ): Promise<{ success: boolean; error?: string } | null> => {
    const dbSession = databaseService.getSession(panelManager.getPanel(panelId)?.sessionId ?? '');
    if (!dbSession || dbSession.agent_runtime !== 'omp-fleet') return null;
    // Refuse a switched-off provider BEFORE any side effect (persisted user
    // turn, spawn, send) — the codex-pty branch does the same; the catch
    // below already maps AgentProviderDisabledError to user-facing copy.
    assertAgentProviderAllowed('omp', 'this chat turn');
    if (!ompSessionManager) {
      return { success: false, error: 'OMP fleet is not available — the bridge is not configured.' };
    }
    // Persist the user turn BEFORE dispatch, exactly like the claude/codex
    // lanes: useUnifiedPanelMessages renders user bubbles solely from
    // panels:get-conversation-messages, and the composer reconciles its
    // optimistic 'sending' row against that same source — without this the
    // row sticks at 'sending' forever and the transcript never shows the user.
    if (input) {
      sessionManager.addPanelConversationMessage(panelId, 'user', input);
    }
    if (ompSessionManager.isPanelRunning(panelId)) {
      const handed = await ompSessionManager.sendInput(panelId, input);
      if (!handed) {
        return { success: false, error: 'Failed to deliver input to the OMP worker' };
      }
    } else {
      // spawn() fails CLOSED (it emits `exit` and drops the panel) rather than
      // throwing, so its result is the only honest signal — answering
      // `success: true` here would leave the composer showing a delivered turn
      // for a worker that never booted.
      const spawned = await ompSessionManager.spawn(panelId, dbSession.id, input, {
        model: DEFAULT_OMP_MODEL,
        cwd: dbSession.worktree_path ?? undefined,
      });
      if (!spawned) {
        return { success: false, error: 'Failed to start the OMP worker' };
      }
    }
    // Mirror the other lanes: a delivered turn puts the session in 'running' so
    // the sidebar and the session header stop showing it as idle.
    await sessionManager.updateSession(dbSession.id, { status: 'running' });
    return { success: true };
  };

  interface QueuedPanelInput {
    id: string;
    text: string;
  }

  /**
   * One STRUCTURED (non-PTY, non-Claude) chat lane.
   *
   * `codex-sdk` and `omp-sdk` are the same machine with a different vendor
   * behind it: both ride a 'claude'-typed panel, both spawn from THIS layer with
   * a caller-supplied gate runId, both refuse `continuePanel` (follow-up turns
   * must re-enter through the turn-start path), and both need the same mid-turn
   * queue + rest-boundary drain. Written once and instantiated per lane so a
   * third provider is a row in {@link structuredChatLanes} rather than another
   * copy of ~150 lines — and so the dispatch seams below switch on lane
   * MEMBERSHIP instead of the binary `=== 'codex-sdk'` tests that would have
   * silently routed an OMP panel to Claude.
   */
  interface StructuredChatLane {
    readonly lane: PanelLane;
    readonly provider: AgentProvider;
    /** The vendor's own name, for anything the user reads. */
    readonly label: string;
    readonly manager: AbstractCliManager | undefined;
    /** Start a turn now (resuming this panel's own thread when one exists). */
    startTurn(panelId: string, text: string): Promise<void>;
    /** Buffer a mid-turn message and try an immediate flush. */
    enqueue(panelId: string, id: string, text: string): void;
    listQueued(panelId: string): QueuedPanelInput[];
    dequeue(panelId: string, id: string): boolean;
  }

  /** Per-lane construction input; everything else is derived. */
  interface StructuredChatLaneConfig {
    readonly lane: PanelLane;
    readonly manager: AbstractCliManager | undefined;
    /**
     * `systemPromptAppend` for a vendor whose spawn accepts one. OMP has no
     * such flag (its session context comes from the gating extension + MCP
     * config), so its lane leaves this undefined rather than passing an option
     * the manager would drop on the floor.
     */
    readonly briefing?: string;
  }

  const createStructuredChatLane = (config: StructuredChatLaneConfig): StructuredChatLane => {
    const { lane, manager, briefing } = config;
    const provider = providerForRuntime(lane);
    const label = AGENT_PROVIDER_LABELS[provider];
    const queues = new Map<string, QueuedPanelInput[]>();

    const startTurn = async (panelId: string, text: string): Promise<void> => {
      // Refuse a switched-off provider BEFORE any side effect. The spawn below
      // asserts too, but by then this function has already persisted the user turn
      // and flipped the session to 'running' — and nothing rolls those back, so a
      // refused send left the chat showing a phantom "<vendor> is thinking…"
      // placeholder and a live Stop button with no turn behind them.
      assertAgentProviderAllowed(provider, 'this chat turn');
      if (!manager) throw new Error(`${label} SDK manager is not available`);
      const panel = panelManager.getPanel(panelId);
      if (!panel || panel.type !== 'claude') throw new Error(`${label} panel ${panelId} not found`);
      const dbSession = databaseService.getSession(panel.sessionId);
      // Lane, not runtime: an sdk-override panel in a PTY session of the same
      // vendor belongs on the structured transport too, and an interactive-override
      // panel in a structured session must NOT be dragged onto it.
      if (!dbSession || resolvePanelLane(dbSession, panel) !== lane) {
        throw new Error(`Panel ${panelId} is not owned by a ${label} SDK chat`);
      }
      const session = await sessionManager.getSession(panel.sessionId);
      if (!session) throw new Error(`Session ${panel.sessionId} not found`);
      // Resolve the gate vehicle through the chat-sentinel provider, NOT a raw
      // `chat_run_id` read. The provider revives a `__quick__` sentinel that boot
      // recovery force-failed on app restart; without it a RESUMED chat is
      // stamped with a terminal CYBOFLOW_RUN_ID, so every run-scoped cyboflow_*
      // MCP write rejects with `run_not_active` and every approval-gate grab
      // (`UPDATE … WHERE status='running'`) silently misses. The Claude lanes get
      // this via resolveGateRunId inside their managers; these lanes spawn from
      // here with a caller-supplied runId, so it resolves at this seam instead.
      // Called BEFORE the user turn is persisted and the session flips 'running',
      // so a ChatDuringActiveFlowError refusal leaves no phantom turn behind.
      const runId = chatSentinelProvider
        ? chatSentinelProvider(panel.sessionId)
        : (dbSession.chat_run_id ?? dbSession.run_id); // uninjected fallback (tests/boot)
      if (!runId) throw new Error('Session is missing its chat run');

      const settings = databaseService.getPanelSettings(panelId);
      const model = typeof settings?.model === 'string' ? settings.model : undefined;
      // Per-turn reasoning effort (IDEA-029), persisted on the panel by the wizard
      // launch / composer EffortPill exactly like `model`. Codex maps it onto the
      // app-server turn's `effort` and OMP onto `--thinking`, so a structured quick
      // session honors it on the very NEXT turn with no warm-respawn — contrast the
      // Claude SDK seam, where it rides Options.effort and must sit in the warm
      // fingerprint. (OMP re-guards the value against its own scale at the spawn.)
      const rawEffort = settings?.reasoningEffort;
      const reasoningEffort = isAnyEffortLevel(rawEffort) ? rawEffort : undefined;
      // PER-PANEL resume target. `runId` here is the session's chat sentinel —
      // shared by EVERY chat panel of the session — so the run-scoped lookup handed
      // a second chat the FIRST chat's thread and both panels then replayed
      // one conversation (the "two chats share a history" bug). Resolve by panelId
      // instead so each chat continues its OWN thread.
      //
      // Pre-087 rows carry panel_id NULL and belong to the panel that existed when
      // they were written — the session's FIRST chat panel. Fall back to the
      // run-scoped lookup for exactly that panel so an in-flight single-chat
      // session keeps resuming across the upgrade; any other panel starts fresh,
      // which is the correct answer for a chat that never had its own thread.
      //
      // The target must match THIS lane's provider AND runtime: a panel whose
      // session was switched between vendors would otherwise hand one vendor's
      // opaque session handle to another.
      const invocationStore = new AgentInvocationStore(databaseService.getDb());
      const isFirstChatPanel = panelId === resolveClaudePanelId(panel.sessionId);
      const resumeTarget =
        invocationStore.getLatestPanelResumeTarget(runId, panelId) ??
        (isFirstChatPanel ? invocationStore.getLatestTopLevelResumeTarget(runId) : null);
      const resumeSessionId =
        resumeTarget?.provider === provider && resumeTarget.runtime === lane
          ? resumeTarget.externalSessionId
          : undefined;
      const agentPermissionMode = isPermissionMode(dbSession.agent_permission_mode)
        ? dbSession.agent_permission_mode
        : undefined;

      const priorStatus = session.status;
      sessionManager.addPanelConversationMessage(panelId, 'user', text);
      await sessionManager.updateSession(panel.sessionId, { status: 'running' });
      try {
        await manager.spawnCliProcess({
          panelId,
          sessionId: panel.sessionId,
          runId,
          worktreePath: session.worktreePath,
          prompt: text,
          ...(briefing !== undefined ? { systemPromptAppend: briefing } : {}),
          ...(agentPermissionMode !== undefined ? { agentPermissionMode } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
          ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        });
      } catch (error) {
        // The turn never started, so nothing will ever flip 'running' back — the
        // turn-end listeners key off events this spawn would have emitted. Leaving
        // it stuck paints a "<vendor> is thinking…" placeholder and an un-stoppable
        // Stop button over an idle chat. Restore the pre-turn status and re-throw
        // so the caller still reports the failure.
        try {
          await sessionManager.updateSession(panel.sessionId, { status: priorStatus });
        } catch (revertError: unknown) {
          console.error(`[IPC] Failed to restore status after a ${label} turn spawn failure on ${panelId}:`, revertError);
        }
        throw error;
      }
    };

    // Put un-delivered entries BACK at the front of the queue. A queued message is
    // the user's, so it must never be silently dropped: if delivery cannot happen
    // now it stays queued (still listed + dequeuable by click-to-reopen) and the
    // next rest boundary retries it.
    const requeue = (panelId: string, entries: QueuedPanelInput[]): void => {
      if (entries.length === 0) return;
      const current = queues.get(panelId) ?? [];
      queues.set(panelId, [...entries, ...current]);
    };

    const flushIfIdle = (panelId: string): void => {
      if (!manager || manager.isPanelRunning(panelId)) return;
      const queued = queues.get(panelId);
      if (!queued?.length) return;
      queues.delete(panelId);
      // Deliver on a LATER macrotask, never inline. This flush normally runs inside
      // the manager's 'exit' emit, which fires from within spawnCliProcess's own try
      // block — its `finally` has NOT yet released the spawnKey reservation, so
      // spawning here synchronously always throws "… already running for spawn
      // <panelId>" and would strand the message. setImmediate lets that reservation
      // (and the awaited spawn promise) settle first; this mirrors
      // ClaudeCodeManager's setImmediate quick-input drain for the same reason.
      setImmediate(() => {
        // A new turn may have started on the deferred tick — hand the messages back
        // so they ride that turn's rest boundary instead of racing it.
        if (!manager || manager.isPanelRunning(panelId)) {
          requeue(panelId, queued);
          return;
        }
        const combined = queued.map((entry) => entry.text).join('\n\n');
        void startTurn(panelId, combined).catch((error: unknown) => {
          console.error(`[IPC] ${label} panel-input queue delivery failed for ${panelId}:`, error);
          requeue(panelId, queued);
        });
      });
    };

    manager?.on('output', (payload: {
      panelId?: string;
      sessionId?: string;
      type?: string;
      data?: unknown;
      timestamp?: Date;
    }) => {
      if (typeof payload.panelId !== 'string' || typeof payload.sessionId !== 'string') return;
      const panel = panelManager.getPanel(payload.panelId);
      if (!panel || panel.sessionId !== payload.sessionId || panel.type !== 'claude') return;
      try {
        sessionManager.addPanelOutput(payload.panelId, {
          type: payload.type === 'json' || payload.type === 'stderr' || payload.type === 'error'
            ? payload.type
            : 'stdout',
          data: payload.data ?? '',
          timestamp: payload.timestamp ?? new Date(),
        });
      } catch (error) {
        console.error(`[IPC] Failed to store ${label} SDK panel output for ${payload.panelId}:`, error);
      }
    });

    manager?.on('exit', (payload: { panelId?: string; sessionId?: string; exitCode?: number }) => {
      if (typeof payload.sessionId !== 'string') return;
      // Lane, not session runtime: this manager also serves an sdk-override panel
      // inside the same vendor's PTY session, whose runtime would fail a
      // `=== '<lane>'` test and leave the session stuck showing "working" after
      // the turn ended. With no panelId on the payload there is no lane to read —
      // keep the session-level test rather than resting a session this manager
      // may not own.
      const exitLane = typeof payload.panelId === 'string' ? laneForPanelId(payload.panelId) : undefined;
      const dbSession = databaseService.getSession(payload.sessionId);
      if (exitLane ? exitLane !== lane : dbSession?.agent_runtime !== lane) return;
      try {
        sessionManager.updateSession(payload.sessionId, { status: payload.exitCode === 0 ? 'stopped' : 'error' });
      } catch (error) {
        console.error(`[IPC] Failed to update ${label} SDK session status for ${payload.sessionId}:`, error);
      }
      if (typeof payload.panelId === 'string') {
        flushIfIdle(payload.panelId);
      }
    });

    return {
      lane,
      provider,
      label,
      manager,
      startTurn,
      // Buffer one mid-turn message and try an immediate flush (the turn may have
      // ended between the caller's running-probe and here). `id` is the client
      // pending-send id so panels:dequeue-input (click-to-reopen) targets this
      // exact entry. Shared by panels:queue-input and the panels:continue branch.
      enqueue: (panelId, id, text) => {
        const queue = queues.get(panelId) ?? [];
        queue.push({ id, text: text.trim() });
        queues.set(panelId, queue);
        flushIfIdle(panelId);
      },
      listQueued: (panelId) => [...(queues.get(panelId) ?? [])],
      dequeue: (panelId, id) => {
        const queue = queues.get(panelId) ?? [];
        const next = queue.filter((entry) => entry.id !== id);
        if (next.length === 0) queues.delete(panelId);
        else queues.set(panelId, next);
        return next.length !== queue.length;
      },
    };
  };

  /** lane → its structured chat driver. THE dispatch table for these lanes. */
  const structuredChatLanes = new Map<PanelLane, StructuredChatLane>(
    [
      createStructuredChatLane({
        lane: 'codex-sdk',
        manager: codexSdkManager,
        briefing: QUICK_CODEX_SDK_BRIEFING,
      }),
      // No briefing: OMP's spawn has no `--append-system-prompt` equivalent, so
      // passing one would be silently dropped rather than delivered.
      createStructuredChatLane({ lane: 'omp-sdk', manager: ompSdkManager }),
    ].map((entry) => [entry.lane, entry]),
  );

  /** The structured driver owning this panel, or undefined for a Claude/PTY lane. */
  const structuredChatLaneForPanel = (panel: ToolPanel | undefined): StructuredChatLane | undefined =>
    panel && panel.type === 'claude' ? structuredChatLanes.get(laneForPanel(panel)) : undefined;

  /**
   * The PTY-backed quick-session lanes cyboflow spawns from THIS layer (Codex
   * and OMP; the Claude REPL resolves its own gate inside its manager and keeps
   * its own branch below). Same shape reason as {@link structuredChatLanes}.
   */
  interface QuickPtyLane {
    readonly label: string;
    isPanelRunning(panelId: string): boolean;
    relayUserTurn(panelId: string, input: string): void;
    /** Deterministic at-spawn runId→panelId seed on the dispatch facade. */
    registerPanel(runId: string, panelId: string): void;
    startPanel(options: {
      panelId: string;
      sessionId: string;
      worktreePath: string;
      prompt: string;
      permissionMode?: 'approve' | 'ignore';
      model?: string;
      runId?: string;
      reasoningEffort?: ReasoningEffort;
    }): Promise<void>;
    /** First-turn context briefing for an eager (promptless) spawn. */
    readonly briefing: string;
  }

  const quickPtyLanes = new Map<PanelLane, QuickPtyLane>([
    [
      'codex-pty',
      {
        label: AGENT_PROVIDER_LABELS.codex,
        isPanelRunning: (panelId) => codexPtyManager.isPanelRunning(panelId),
        relayUserTurn: (panelId, input) => codexPtyManager.relayUserTurn(panelId, input),
        registerPanel: registerCodexPtyPanel,
        startPanel: (o) =>
          codexPtyManager.startPanel(
            o.panelId,
            o.sessionId,
            o.worktreePath,
            o.prompt,
            o.permissionMode,
            o.model,
            o.runId,
            o.reasoningEffort,
          ),
        briefing: QUICK_CODEX_PTY_BRIEFING,
      },
    ],
    [
      'omp-pty',
      {
        label: AGENT_PROVIDER_LABELS.omp,
        isPanelRunning: (panelId) => ompPtyManager.isPanelRunning(panelId),
        relayUserTurn: (panelId, input) => ompPtyManager.relayUserTurn(panelId, input),
        registerPanel: registerOmpPtyPanel,
        // OMP's TUI takes no per-turn thinking flag on this lane (the level is
        // spawn-baked on the RPC lane only), so reasoningEffort is not forwarded.
        startPanel: (o) =>
          ompPtyManager.startPanel(
            o.panelId,
            o.sessionId,
            o.worktreePath,
            o.prompt,
            o.permissionMode,
            o.model,
            o.runId,
          ),
        briefing: QUICK_OMP_PTY_BRIEFING,
      },
    ],
  ]);

  /**
   * The manager that owns a lane's live process for Stop / Dismiss close-out, or
   * undefined for the two CLAUDE lanes — those keep their own fallbacks (the
   * interactive one degrades to `killLiveSession` when its manager is absent,
   * and `claudeCodeManager.stopPanel` is the session-level Stop that predates
   * the interactive split).
   */
  const laneStopOwner = (lane: PanelLane): AbstractCliManager | undefined => {
    switch (lane) {
      case 'codex-sdk':
        return codexSdkManager;
      case 'codex-pty':
        return codexPtyManager;
      case 'omp-sdk':
        return ompSdkManager;
      case 'omp-pty':
        return ompPtyManager;
      default:
        return undefined;
    }
  };

  /**
   * Rest the session when a PTY lane's process exits. Lane, not session runtime:
   * the manager also serves an interactive-override panel inside the same
   * vendor's SDK session, whose runtime would fail a `=== '<lane>'` test and
   * leave that session stuck showing "working".
   */
  const handlePtyLaneExit = (
    lane: PanelLane,
    payload: { panelId?: string; sessionId?: string; exitCode?: number },
  ): void => {
    if (typeof payload.sessionId !== 'string') return;
    const ptyExitLane = typeof payload.panelId === 'string' ? laneForPanelId(payload.panelId) : undefined;
    const dbSession = databaseService.getSession(payload.sessionId);
    if (ptyExitLane ? ptyExitLane !== lane : dbSession?.agent_runtime !== lane) return;
    try {
      sessionManager.updateSession(payload.sessionId, { status: payload.exitCode === 0 ? 'stopped' : 'error' });
    } catch (error) {
      console.error(`[IPC] Failed to update ${lane} session status for ${payload.sessionId}:`, error);
    }
  };

  for (const [ptyLane, manager] of [
    ['codex-pty', codexPtyManager],
    ['omp-pty', ompPtyManager],
  ] as const) {
    manager?.on?.('exit', (payload: { panelId?: string; sessionId?: string; exitCode?: number }) => {
      handlePtyLaneExit(ptyLane, payload);
    });
  }

  // Wire the panel-input-queue re-drive collaborator ("always allow messaging a
  // running quick session"). At a turn's rest boundary ClaudeCodeManager hands us
  // the combined queued text; we assemble the continue context exactly like
  // panels:continue (worktree, per-panel model + fast-mode, conversation history)
  // and re-drive continuePanel — now on an IDLE panel, so there is no destructive
  // mid-turn abort. Registered once; a no-op-safe guard skips the PTY manager.
  if (claudeCodeManager instanceof ClaudeCodeManager) {
    claudeCodeManager.setPanelInputDeliverer((panelId: string, text: string) => {
      void (async () => {
        try {
          const { claudePanelManager } = require('./claudePanel');
          if (!claudePanelManager) return;
          const panel = panelManager.getPanel(panelId);
          if (!panel || panel.type !== 'claude') return;
          const session = await sessionManager.getSession(panel.sessionId);
          if (!session) return;
          // Persist the queued text as a user turn (parity with panels:continue).
          sessionManager.addPanelConversationMessage(panelId, 'user', text);
          const settings = databaseService.getPanelSettings(panelId);
          const model = typeof settings?.model === 'string' ? settings.model : undefined;
          const fastMode = settings?.fastMode === true;
          const rawEffort = settings?.reasoningEffort;
          const reasoningEffort = isAnyEffortLevel(rawEffort) ? rawEffort : undefined;
          const conversationHistory = sessionManager.getPanelConversationMessages
            ? await sessionManager.getPanelConversationMessages(panelId)
            : await sessionManager.getConversationMessages(panel.sessionId);
          await claudePanelManager.continuePanel(
            panelId,
            session.worktreePath,
            text,
            conversationHistory,
            model,
            fastMode,
            reasoningEffort,
          );
        } catch (err) {
          console.error('[IPC] panel-input queue delivery failed:', err);
        }
      })();
    });
  }

  // Helper function to get CLI manager for a specific tool
  // TODO: This will be used in the future to support multiple CLI tools
  const getCliManager = async (toolId: string = 'claude') => {
    try {
      return await cliManagerFactory.createManager(toolId, {
        sessionManager,
        additionalOptions: {}
      });
    } catch (error) {
      console.warn(`Failed to get CLI manager for ${toolId}, falling back to default:`, error);
      return claudeCodeManager; // Fallback to default for backward compatibility
    }
  };

  // NOTE: Current IPC handlers use claudeCodeManager directly for backward compatibility
  // Future versions will use getCliManager() to support multiple CLI tools dynamically

  // Session management handlers
  ipcMain.handle('sessions:get-all', async () => {
    try {
      const sessions = await sessionManager.getAllSessions();
      return { success: true, data: sessions };
    } catch (error) {
      console.error('Failed to get sessions:', error);
      return { success: false, error: 'Failed to get sessions' };
    }
  });

  ipcMain.handle('sessions:get', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);

      if (!session) {
        return { success: false, error: 'Session not found' };
      }
      return { success: true, data: session };
    } catch (error) {
      console.error('Failed to get session:', error);
      return { success: false, error: 'Failed to get session' };
    }
  });

  ipcMain.handle('sessions:get-all-with-projects', async () => {
    try {
      const allProjects = databaseService.getAllProjects();
      const projectsWithSessions = allProjects.map(project => {
        const sessions = sessionManager.getSessionsForProject(project.id);
        const folders = databaseService.getFoldersForProject(project.id);
        const convertedFolders = folders.map(convertDbFolderToFolder);
        return {
          ...project,
          sessions,
          folders: convertedFolders
        };
      });
      return { success: true, data: projectsWithSessions };
    } catch (error) {
      console.error('Failed to get sessions with projects:', error);
      return { success: false, error: 'Failed to get sessions with projects' };
    }
  });

  ipcMain.handle('sessions:create', async (_event, request: CreateSessionRequest) => {
    try {
      let targetProject;

      if (request.projectId) {
        // Use the project specified in the request
        targetProject = databaseService.getProject(request.projectId);
        if (!targetProject) {
          return { success: false, error: 'Project not found' };
        }
      } else {
        // Fall back to active project for backward compatibility
        targetProject = sessionManager.getActiveProject();
        if (!targetProject) {
          console.warn('[IPC] No project specified and no active project found');
          return { success: false, error: 'No project specified. Please provide a projectId.' };
        }
      }

      if (!taskQueue) {
        console.error('[IPC] Task queue not initialized');
        return { success: false, error: 'Task queue not initialized' };
      }

      const requestedAgentProvider = isAgentProvider(request.agentProvider)
        ? request.agentProvider
        : undefined;
      const requestedAgentRuntime = isSessionAgentRuntime(request.agentRuntime)
        ? request.agentRuntime
        : undefined;
      // Non-quick sessions are a Claude-only surface: TaskQueue.createSession's
      // spawn path resolves the Claude managers directly, so naming any other
      // vendor here would run as Claude. Derived from the provider registry
      // rather than listing Codex's runtimes, so a third provider is refused the
      // day it is declared instead of the day someone remembers this branch.
      const nonClaudeRequest: AgentProvider | undefined =
        requestedAgentProvider !== undefined && requestedAgentProvider !== 'claude'
          ? requestedAgentProvider
          : requestedAgentRuntime !== undefined && providerForRuntime(requestedAgentRuntime) !== 'claude'
            ? providerForRuntime(requestedAgentRuntime)
            : undefined;
      if (nonClaudeRequest !== undefined) {
        return {
          success: false,
          error: `${AGENT_PROVIDER_LABELS[nonClaudeRequest]} runtimes are not wired yet. Use Claude for this build.`,
        };
      }
      const projectedAgentRuntime =
        requestedAgentRuntime ??
        (isCliSubstrate(request.substrate) ? claudeRuntimeFromSubstrate(request.substrate) : undefined);
      const normalizedClaudeConfig = normalizeClaudeConfig(request.claudeConfig);
      const normalizedAgentModel =
        firstProviderModel(requestedAgentProvider ?? 'claude', request.agentModel, normalizedClaudeConfig?.model) ?? null;

      const count = request.count || 1;

      if (count > 1) {
        const jobs = await taskQueue.createMultipleSessions(
          request.prompt,
          request.worktreeTemplate || '',
          count,
          request.permissionMode,
          targetProject.id,
          request.baseBranch,
          request.toolType,
          normalizedClaudeConfig,
          request.folderId,
          requestedAgentProvider,
          projectedAgentRuntime,
          normalizedAgentModel
        );

        // Note: Model is now stored at panel level, not session level

        return { success: true, data: { jobIds: jobs.map(job => job.id) } };
      } else {
        const job = await taskQueue.createSession({
          prompt: request.prompt,
          worktreeTemplate: request.worktreeTemplate || '',
          permissionMode: request.permissionMode,
          projectId: targetProject.id,
          folderId: request.folderId,
          baseBranch: request.baseBranch,
          toolType: request.toolType,
          claudeConfig: normalizedClaudeConfig,
          agentProvider: requestedAgentProvider,
          agentRuntime: projectedAgentRuntime,
          agentModel: normalizedAgentModel,
        });

        // Note: Model is now stored at panel level, not session level

        return { success: true, data: { jobId: job.id } };
      }
    } catch (error) {
      console.error('[IPC] Failed to create session:', error);
      console.error('[IPC] Error stack:', error instanceof Error ? error.stack : 'No stack trace');

      // Extract detailed error information
      let errorMessage = 'Failed to create session';
      let errorDetails = '';
      let command = '';

      if (error instanceof Error) {
        errorMessage = error.message;
        errorDetails = error.stack || error.toString();

        // Check if it's a git command error
        const gitError = error as Error & { gitCommand?: string; cmd?: string; gitOutput?: string; stderr?: string };
        if (gitError.gitCommand) {
          command = gitError.gitCommand;
        } else if (gitError.cmd) {
          command = gitError.cmd;
        }

        // Include git output if available
        if (gitError.gitOutput) {
          errorDetails = gitError.gitOutput;
        } else if (gitError.stderr) {
          errorDetails = gitError.stderr;
        }
      }

      return {
        success: false,
        error: errorMessage,
        details: errorDetails,
        command: command
      };
    }
  });

  /**
   * sessions:create-quick — Create a worktree session without a flow or initial prompt.
   *
   * Architectural notes:
   * (a) Delegates to `TaskQueue.createSession` with `prompt: ''` to keep worktree +
   *     session lifecycle single-sourced in the queue processor.
   * (b) `prompt === ''` causes TaskQueue to skip prompt-related setup (conversation
   *     message, prompt marker, Claude panel auto-start) — the user's first message
   *     via `sessions:input` will bootstrap the Claude panel on demand.
   * (c) `db.createSession` writes `data.run_id ?? null` into the INSERT column list
   *     (TASK-754). The quick-session path never sets `data.run_id`, so the row is
   *     persisted with `run_id = NULL` via the `?? null` coalesce.
   * (d) Second-precision branch-name collisions (two quick sessions in the same
   *     second) are resolved by `TaskQueue.ensureUniqueNames`, which appends a
   *     `-<counter>` suffix.
   *
   * Returns `{ success: true, data: { jobId, sessionId, worktreePath } }` so
   * frontend slices (TASK-747, TASK-748) can navigate and bootstrap a panel
   * without a follow-up IPC round trip.
   */
  ipcMain.handle('sessions:create-quick', async (_event, request: CreateSessionRequest) => {
    try {
      if (!request.projectId) {
        return { success: false, error: 'No project specified. Quick sessions require a projectId.' };
      }

      if (!taskQueue) {
        console.error('[IPC] Task queue not initialized');
        return { success: false, error: 'Task queue not initialized' };
      }

      const targetProject = databaseService.getProject(request.projectId);
      if (!targetProject) {
        return { success: false, error: 'Project not found' };
      }

      // Design Mode (design-mode.md "Session plumbing — SDK-pinned,
      // fail-closed" + "Idea link — integrity contract"): a non-empty
      // designIdeaId opts this launch into the design branch. Every
      // non-design launch (absent or blank field) is byte-identical to
      // before. BEFORE creating anything: (a) validate the idea is live and
      // owned by this project, then (b) fail-closed on Claude/SDK
      // availability so a design session never silently degrades onto a
      // substrate without the design MCP scope contract.
      const designIdeaId =
        typeof request.designIdeaId === 'string' && request.designIdeaId.trim().length > 0
          ? request.designIdeaId
          : undefined;
      const isDesignSession = designIdeaId !== undefined;
      if (isDesignSession) {
        const ideaValidation = validateDesignIdeaLink(databaseService.getDb(), designIdeaId, targetProject.id);
        if (!ideaValidation.ok) {
          return { success: false, error: ideaValidation.error };
        }

        // Fail-closed Claude/SDK availability pre-flight. Design sessions are
        // hard-pinned to the Claude SDK substrate below (step 2), so an
        // unavailable Claude login/binary must reject HERE — before any
        // worktree is cut — rather than let normal substrate resolution
        // silently fall through to a substrate the design MCP scope doesn't
        // cover. Reuses the same detection helpers + state mapping as
        // onboarding (claudeDetection.ts computeState) so "available" means
        // the same thing in both places.
        // Zeroth pre-flight: the Claude provider must be switched on at all.
        // Design sessions hard-pin the Claude SDK, so a Claude-off install can
        // never serve one — reject before the detection probe (which would
        // otherwise report a perfectly healthy account the user disabled).
        if (!configManager.isAgentProviderEnabled('claude')) {
          return {
            success: false,
            error:
              'Design sessions require Claude, which is turned off in Settings → Integrations. Enable Claude to start a design session.',
          };
        }

        const [designCredentials, designBinary] = await Promise.all([
          detectClaudeCredentials(),
          detectClaudeBinary(configManager.getConfig()?.claudeExecutablePath),
        ]);
        if (computeClaudeDetectionState(designCredentials.found, designBinary.found) !== 'detected') {
          return {
            success: false,
            error:
              'Design sessions require the Claude SDK substrate — Claude credentials/binary not detected. Sign in to Claude Code and try again.',
          };
        }

        // Second pre-flight: the global interactivePtyOnly lock
        // (configManager.isInteractivePtyOnly, folded into getForcedSubstrate)
        // forces EVERY run/session onto the interactive PTY substrate, which
        // conflicts with the design session's hard SDK pin — fail closed
        // before creating anything rather than let createRun's post-resolution
        // guard (requireSdkSubstrate, below) throw after a worktree already
        // exists. Demo mode's forced 'sdk' pin is compatible with the design
        // pin and is NOT checked here.
        if (configManager.isInteractivePtyOnly()) {
          return {
            success: false,
            error:
              'Design sessions cannot run on the interactive substrate, but this app is locked to interactive-PTY-only mode. Disable that lock in Settings to start a design session.',
          };
        }
      }

      const branchName = request.branchName ?? generateQuickWorktreeBranchName();
      const toolType: 'claude' | 'none' = request.toolType ?? 'claude';

      // Per-session 4-mode agent-permission override (Session Start Wizard step 3 /
      // quick-session config). Validate the untyped IPC value; an absent/invalid
      // value leaves the session on the global default (byte-identical to before).
      const requestedAgentMode = isPermissionMode(request.agentPermissionMode)
        ? request.agentPermissionMode
        : undefined;

      const requestedAgentProvider = isAgentProvider(request.agentProvider)
        ? request.agentProvider
        : undefined;
      const requestedAgentRuntime = isSessionAgentRuntime(request.agentRuntime)
        ? request.agentRuntime
        : undefined;

      const providerConflict = providerRuntimeConflict(
        requestedAgentProvider,
        requestedAgentRuntime,
      );
      if (providerConflict) {
        return {
          success: false,
          error: formatProviderRuntimeConflict(providerConflict.provider, providerConflict.runtime),
        };
      }

      // Provider-access gate — the session-side twin of the createRun gate, and
      // the authoritative enforcement of the Settings → Integrations / onboarding
      // Connect toggles for quick sessions. A launch that EXPLICITLY names a
      // switched-off provider fails closed (the wizard's picker already hides it,
      // but a stale/scripted payload can still name it); a launch that names
      // nothing and would default to Claude reroutes to Codex when Claude is the
      // disabled one, so a Codex-only install can still start quick sessions.
      const providerAccess = configManager.getAgentProviderAccess();
      const explicitProvider: AgentProvider | undefined =
        requestedAgentProvider ??
        (requestedAgentRuntime !== undefined ? providerForRuntime(requestedAgentRuntime) : undefined);
      if (explicitProvider !== undefined && !isAgentProviderEnabled(providerAccess, explicitProvider)) {
        return {
          success: false,
          error: `The ${AGENT_PROVIDER_LABELS[explicitProvider]} provider is turned off in Settings → Integrations. Enable it to start this session.`,
        };
      }
      // Unrequested launch under a Claude-off install: fall back to the provider
      // the user left enabled rather than resolving onto the disabled default.
      const fallbackToCodex =
        explicitProvider === undefined &&
        !isAgentProviderEnabled(providerAccess, 'claude') &&
        isAgentProviderEnabled(providerAccess, 'codex');

      // Design Mode (design-mode.md "Session plumbing — SDK-pinned,
      // fail-closed"): no non-Claude runtime may ever resolve for a design
      // launch, regardless of what the request's own provider/runtime fields
      // say — this is what keeps the eager-PTY-spawn block below (gated on the
      // resolved runtime's lane, independently of the resolved substrate) from
      // ever firing for a design session. isDesignSession is computed above from
      // designIdeaId, before this point.
      //
      // ONE resolved runtime replaces the `useCodexSdk`/`useCodexPty` boolean
      // pair: a third provider would otherwise need a third pair, and every
      // downstream site would need to learn about it.
      const useOmpFleet = !isDesignSession && requestedAgentRuntime === 'omp-fleet';
      const quickProvider: AgentProvider | undefined =
        requestedAgentProvider ?? (fallbackToCodex ? 'codex' : undefined);
      const quickResolvedRuntime: SessionAgentRuntime | undefined = isDesignSession
        ? undefined
        : (requestedAgentRuntime ??
          // A launch naming only a PROVIDER lands on that provider's STRUCTURED
          // lane. Claude is deliberately excluded: it must stay `undefined` so
          // the substrate ladder below (which defaults quick sessions to the
          // PTY) still decides sdk-vs-interactive for it.
          (quickProvider !== undefined && quickProvider !== 'claude'
            ? QUICK_PROVIDER_SDK_RUNTIME[quickProvider]
            : undefined));
      const quickResolvedProvider: AgentProvider =
        quickResolvedRuntime !== undefined ? providerForRuntime(quickResolvedRuntime) : 'claude';
      /**
       * A non-Claude runtime fixes the substrate outright; Claude's is a ladder.
       * omp-fleet is NOT a lane — it is the fleet-supervisor runtime backed by
       * `OmpSessionManager` (omp-phase4-coexistence-adr.md §3) — so it is
       * excluded here and reaches its own dispatch below via `useOmpFleet`;
       * leaving it in would type this onto PanelLane maps that cannot serve it.
       */
      const nonClaudeQuickRuntime =
        quickResolvedRuntime !== undefined &&
        quickResolvedProvider !== 'claude' &&
        quickResolvedRuntime !== 'omp-fleet'
          ? quickResolvedRuntime
          : undefined;

      const substrateFromAgentRuntime =
        requestedAgentRuntime === 'claude-interactive'
          ? 'interactive'
          : requestedAgentRuntime === 'claude-sdk'
            ? 'sdk'
            : undefined;

      // Opt-in CLI substrate for the quick session (migration 027). Validate the
      // untyped IPC value; an absent/invalid value leaves the run + session on
      // the SDK default (byte-identical to before). During provider/runtime
      // migration, a Claude agentRuntime request projects back to substrate.
      const requestedSubstrate = nonClaudeQuickRuntime !== undefined
        ? (isPtyLane(nonClaudeQuickRuntime) ? 'interactive' : 'sdk')
        : isCliSubstrate(request.substrate)
          ? request.substrate
          : substrateFromAgentRuntime;

      // Opt-in agent effort (the "Ultracode" wizard card). 'ultracode' launches
      // the interactive REPL with the ultracode setting; any other value is
      // ignored. Demo mode never spawns a real REPL — it drives a canned dynamic
      // workflow instead (below) — so the setting only reaches the live spawn.
      const requestedEffort = request.effort === 'ultracode' ? 'ultracode' : undefined;

      // Per-launch model config for the quick session. Picker values are
      // provider-scoped so a stale Claude alias cannot be stamped onto another vendor.
      const quickAgentProvider: AgentProvider = quickResolvedProvider;
      const normalizedClaudeConfig = normalizeClaudeConfig(request.claudeConfig);
      const requestedModel = firstProviderModel(
        quickAgentProvider,
        request.agentModel,
        normalizedClaudeConfig?.model,
      );
      const requestedFastMode = normalizedClaudeConfig?.fastMode === true;
      const requestedReasoningEffort = normalizedClaudeConfig?.reasoningEffort;

      // Resolve where this quick session works (migration 047): the per-launch
      // request wins when valid, otherwise the global Settings default (which
      // floors to 'worktree'). An in-place session skips worktree provisioning
      // and runs directly in the project checkout. BOTH substrates support
      // in-place: the interactive PTY gate rides the inline `--settings` flag
      // (resolveInlineGatingHooks — nothing is written into the checkout), and
      // the spawn skips the remaining worktree-mutating setup (mcpEnabler /
      // workflow bundle) for in-place sessions.
      const requestedWorktreeMode = isQuickSessionWorktreeMode(request.worktreeMode)
        ? request.worktreeMode
        : undefined;
      const inPlace = (requestedWorktreeMode ?? configManager.getQuickSessionWorktreeMode()) === 'in-place';

      // Design Mode (design-mode.md "Session plumbing — SDK-pinned,
      // fail-closed"): step 2 — force the launch provider/runtime/substrate to
      // Claude SDK, HARD-CODED here and never sourced from the request's own
      // substrate/agentProvider/agentRuntime fields (a malformed or malicious
      // request must not be able to smuggle a different substrate through).
      // requireSdkSubstrate threads WorkflowRegistry.createRun's
      // post-resolution belt-guard (step 3) for the same invariant. (Note:
      // isDesignSession itself is declared earlier, alongside designIdeaId,
      // because it also gates quickResolvedRuntime above.)
      const quickAgentProviderForLaunch: AgentProvider = isDesignSession ? 'claude' : quickAgentProvider;
      const quickAgentRuntimeForLaunch: SessionAgentRuntime | undefined = isDesignSession
        ? 'claude-sdk'
        : quickResolvedRuntime;
      const quickRequestedSubstrateForLaunch = isDesignSession ? 'sdk' : requestedSubstrate;

      // Create the session + wire the __quick__ sentinel run via the SHARED core
      // (createQuickSessionCore) — the same path experiments.startSideBySide uses
      // for its SHA-pinned arm sessions. The core: enqueues the session-create job
      // (worktree + session row, or in-place directly in the project checkout),
      // awaits the session-created event, ensures the __quick__ sentinel workflow,
      // creates the sentinel run through the FULL substrate/permission ladder
      // (returning the RESOLVED substrate everything below keys off), advances it
      // queued→starting→running, stamps its worktree_path, and backfills
      // sessions.run_id + chat_run_id. The per-session config persistence + eager
      // PTY spawn below layer on top of the result.
      const { session, runId, resolvedSubstrate, jobId } = await createQuickSessionCore(
        {
          taskQueue,
          sessionManager,
          workflowRegistry: cyboflow.workflowRegistry,
          getDb: () => databaseService.getDb(),
        },
        {
          projectId: targetProject.id,
          nameHint: branchName,
          baseBranch: request.baseBranch,
          folderId: request.folderId,
          toolType,
          claudeConfig: quickAgentProviderForLaunch === 'claude' ? normalizedClaudeConfig : undefined,
          requestedSubstrate: quickRequestedSubstrateForLaunch,
          requestedAgentMode,
          agentProvider: quickAgentProviderForLaunch,
          agentRuntime: quickAgentRuntimeForLaunch,
          agentModel: requestedModel ?? null,
          // In-place quick session (migration 047): the core switches session
          // matching to the NAME fallback.
          inPlace,
          ...(isDesignSession ? { requireSdkSubstrate: true } : {}),
        },
      );

      const db = databaseService.getDb();

      // Design Mode step 4 (design-mode.md "Session plumbing"): a second belt
      // for the same SDK-substrate invariant — createQuickSessionCore already
      // resolved (the requireSdkSubstrate guard inside createRun would have
      // thrown and propagated out of the await above otherwise), so this
      // branch is expected to be unreachable in practice. If a future
      // refactor ever defeats both the pre-flight AND the createRun guard,
      // fail closed here too: return failure WITHOUT stamping
      // design_idea_id and WITHOUT running any of the per-session config /
      // eager-PTY-spawn logic below — the already-created session is left as
      // an ordinary UNLINKED quick session rather than a design session on
      // the wrong substrate (which would expose the full run-scoped MCP
      // toolset instead of the design-scoped one).
      if (isDesignSession) {
        if (resolvedSubstrate !== 'sdk') {
          console.error(
            `[IPC] Design session ${session.id} resolved to substrate '${resolvedSubstrate}' instead of 'sdk'; leaving it unlinked (design_idea_id not stamped).`,
          );
          return {
            success: false,
            error: 'Design sessions require the Claude SDK substrate. The session was created but could not be linked to the idea — please retry.',
          };
        }
        // Only NOW stamp the link (:253-precedent backfill UPDATE inside
        // createQuickSessionCore is the pattern this mirrors) — after the
        // resolved-substrate belt confirms 'sdk'.
        db.prepare(`UPDATE sessions SET design_idea_id = ? WHERE id = ?`).run(designIdeaId, session.id);

        // v0.5 re-entry stub (design-mode.md "Entry (two doors)"): create the
        // session's ui-prototype artifact row NOW, bytes-less, with the same
        // server-side sourceRef/sessionId stamp handleReportArtifact applies —
        // so the artifact tab and its "Enter design mode" CTA exist from the
        // session's first second. The fullscreen surface flag is in-memory
        // only, so a renderer reload before the agent's first report would
        // otherwise strand the user with NO re-entry door. The agent's first
        // real report enriches THIS row in place (one artifact per
        // (runId, atype); the design report resolves to this same sentinel
        // runId == sessions.chat_run_id), stamping the byte pointer and
        // bumping the revision. Fail-soft: a stub failure must never fail
        // session creation.
        try {
          await ArtifactRouter.getInstance().apply(targetProject.id, {
            op: 'create',
            runId,
            atype: 'ui-prototype',
            label: 'Prototype',
            payloadJson: null,
            sourceRef: designIdeaId,
            sessionId: session.id,
            isNew: true,
            actor: 'orchestrator',
          });
        } catch (stubErr) {
          console.error('[IPC] Design prototype stub creation failed (non-fatal):', stubErr);
        }
      }

      // NOTE: the sentinel run's session_id is now stamped by createRun above (it
      // received session.id), for BOTH substrates — the prior interactive-only
      // `UPDATE workflow_runs SET session_id` conditional has been removed. An SDK
      // sentinel's session_id was previously held NULL to keep the session meter
      // from double-counting (it writes both session_outputs AND sentinel
      // raw_events). The token-scan exclusion that makes the stamped SDK sentinel
      // safe co-ships in slice 1b (insightsQueries `NOT (name='__quick__' AND
      // substrate='sdk')`); a transient SDK quick-turn double-count between the
      // 1a and 1b commits is expected and acceptable.

      // Persist the per-session agent-permission override (migration 021) and the
      // RESOLVED substrate + agent_runtime (migrations 027 + 059-064) via the
      // SHARED stamp chokepoint (createQuickSessionCore.ts) — the experiment
      // quick-arm path (index.ts createArmSession) stamps through the same helper
      // so the two callers can never drift.
      stampQuickSessionRuntimeConfig(db, session.id, {
        resolvedSubstrate,
        ...(nonClaudeQuickRuntime !== undefined ? { sessionAgentRuntime: nonClaudeQuickRuntime } : {}),
        requestedAgentMode,
        ...(useOmpFleet ? { agentRuntimeOverride: 'omp-fleet' } : {}),
      });
      // Persist the per-session agent effort (migration 029) so the unified
      // chat composer can surface it as a read-only pill (set at session start;
      // mid-session change deferred). The only value is 'ultracode' (the
      // Ultracode wizard card); any other request resolved to undefined above,
      // and a non-ultracode session stamps NULL. Independent of substrate on the
      // row, though the wizard only ever pairs 'ultracode' with 'interactive'.
      db.prepare(`UPDATE sessions SET effort = ? WHERE id = ?`).run(
        requestedEffort ?? null,
        session.id,
      );

      // Persist the per-session MCP deny-list / plugin selection chosen at session
      // start (the launch wizard's Advanced section; migration 039). Read at spawn
      // on both substrates (MCP: composeMcpServers delete + disallowedTools;
      // plugins: exclusive enabledPlugins map).
      //
      // MCP is a DENY list — only stamped when non-empty so a deny-free session
      // leaves the column NULL (inherit all servers), byte-identical.
      const requestedDisabledMcps = Array.isArray(request.disabledMcpServers)
        ? request.disabledMcpServers.filter((s): s is string => typeof s === 'string')
        : [];
      if (requestedDisabledMcps.length > 0) {
        db.prepare(`UPDATE sessions SET disabled_mcp_servers_json = ? WHERE id = ?`).run(
          JSON.stringify(requestedDisabledMcps),
          session.id,
        );
      }
      // Plugins are EXCLUSIVE — the wizard reflects the user's current enabled set
      // and sends the selection ONLY when it differs from that baseline. So the
      // field's presence is meaningful: an ABSENT field → column NULL (inherit),
      // while a PRESENT array (including an explicit `[]` = "disable everything")
      // is stamped verbatim. Do NOT skip the empty array here.
      if (Array.isArray(request.enabledPlugins)) {
        const requestedEnabledPlugins = request.enabledPlugins.filter(
          (s): s is string => typeof s === 'string',
        );
        db.prepare(`UPDATE sessions SET enabled_plugins_json = ? WHERE id = ?`).run(
          JSON.stringify(requestedEnabledPlugins),
          session.id,
        );
      }

      // The session-created event fired before the sentinel/default-agent stamps
      // above. Refresh the active cache and emit a normal session-updated event
      // so provider/runtime/model do not silently stay at their INSERT defaults
      // until a later read or status transition.
      sessionManager.refreshSessionFromDatabase(session.id);

      // EAGER PTY SPAWN (interactive substrate only): create the claude panel
      // server-side (same pattern sessions:input uses) and boot the persistent
      // REPL now, with the cyboflow context briefing as its first prompt, so the
      // live terminal is alive before the user's first message.
      // ⚠️ NEVER await startPanel here: the interactive spawn promise resolves
      // only when the REPL EXITS (persistent-session contract) — awaiting would
      // deadlock create-quick until the session ends.
      let claudePanelId: string | undefined;
      // A non-Claude PTY launch (codex-pty / omp-pty) eager-spawns through its
      // lane record; the Claude REPL keeps its own branch below because it
      // resolves its gate runId inside its own manager and carries the
      // ultracode/fast-mode spawn options these lanes have no equivalent for.
      const eagerPtyLane =
        nonClaudeQuickRuntime !== undefined ? quickPtyLanes.get(nonClaudeQuickRuntime) : undefined;
      // OMP FLEET FIRST — this branch must outrank every substrate branch below.
      // A fleet session's work runs on a REMOTE worker; any local eager spawn
      // here would boot a second, unwanted agent against the same worktree.
      // Today `ompSdkRequested` happens to force resolvedSubstrate to 'sdk', so
      // the interactive branches miss it by luck rather than by design — one
      // change to substrate resolution and a fleet session would silently grow a
      // local Claude REPL. Ordering makes that structural instead of incidental.
      if (useOmpFleet) {
        // Create the panel server-side (so the frontend skips a duplicate) but
        // do NOT spawn — the ADR's "first message spawns". The remote worker
        // boots on the first panels:send-input / panels:continue.
        try {
          const panel = await panelManager.createPanel({
            sessionId: session.id,
            type: 'claude',
            title: 'Chat',
          });
          claudePanelId = panel.id;
        } catch (error) {
          console.error(`[IPC] Failed to create OMP panel for quick session ${session.id}:`, error);
        }
      } else if (eagerPtyLane) {
        try {
          const panel = await panelManager.createPanel({
            sessionId: session.id,
            type: 'claude',
            title: 'Chat',
          });
          claudePanelId = panel.id;
          if (requestedModel !== undefined) {
            databaseService.updatePanelSettings(panel.id, { model: requestedModel });
          }
          if (requestedReasoningEffort !== undefined) {
            databaseService.updatePanelSettings(panel.id, { reasoningEffort: requestedReasoningEffort });
          }
          eagerPtyLane.registerPanel(runId, panel.id);
          void eagerPtyLane
            .startPanel({
              panelId: panel.id,
              sessionId: session.id,
              worktreePath: session.worktreePath,
              prompt: eagerPtyLane.briefing,
              permissionMode: session.permissionMode,
              model: requestedModel,
              runId,
              reasoningEffort: requestedReasoningEffort,
            })
            .catch((err: unknown) => {
              console.error(`[IPC] Eager ${eagerPtyLane.label} PTY spawn failed for session ${session.id}:`, err);
              reportEagerSpawnFailure(err, 'interactive', quickResolvedProvider);
            });
          await sessionManager.updateSession(session.id, { status: 'running' });
        } catch (error) {
          console.error(`[IPC] Failed to create ${eagerPtyLane.label} panel for quick session ${session.id}:`, error);
        }
      } else if (resolvedSubstrate === 'interactive' && configManager.isDemoMode()) {
        // Demo mode: the session is stamped 'interactive' (so ClaudePanel swaps
        // in the terminal surface), but the real persistent REPL is NEVER
        // spawned — DemoTerminalView paints a canned, client-side Claude Code
        // session. Still create the claude panel + mark running so the center
        // pane mounts ClaudePanel (and skips the resting canvas) exactly like a
        // live interactive quick session.
        try {
          const panel = await panelManager.createPanel({
            sessionId: session.id,
            type: 'claude',
            title: 'Chat',
          });
          claudePanelId = panel.id;
          await sessionManager.updateSession(session.id, { status: 'running' });

          // Ultracode in demo: illustrate the dynamic-workflow visualization.
          // The real feature is on-disk journal-tail driven; demo has no real
          // agent, so drive a CANNED fan-out into the tracker — the
          // QuickSessionCanvas takeover + landing ActiveAgents cards light up as
          // they would for a live ultracode run. A plain interactive demo
          // session (no effort) just shows the canned terminal.
          if (requestedEffort === 'ultracode') {
            DynamicWorkflowTracker.tryGetInstance()?.injectDemoWorkflow({
              runId,
              sessionId: session.id,
            });
          }
        } catch (error) {
          console.error(`[IPC] Failed to create Claude panel for demo interactive quick session ${session.id}:`, error);
        }
      } else if (resolvedSubstrate === 'interactive') {
        try {
          // NOTE: deliberately NOT registered with ClaudePanelManager (the
          // frontend panels:create handler auto-registers claude panels,
          // panels.ts:30-41; this server-side createPanel does not). The
          // interactive PTY surface drives this panel end-to-end — relay/resize/
          // close-out all route through the SubstrateDispatchFacade, and the
          // structured-panel claudePanels:* IPC is never used for it. Same
          // intentional asymmetry as the pre-existing sessions:input in-handler
          // createPanel below.
          const panel = await panelManager.createPanel({
            sessionId: session.id,
            type: 'claude',
            title: 'Chat'
          });
          claudePanelId = panel.id;
          // Persist the launch model + fast-mode on the panel so a later
          // sessions:input respawn re-applies them (the eager spawn below already
          // receives them directly).
          if (requestedModel !== undefined || requestedFastMode || requestedReasoningEffort !== undefined) {
            databaseService.updatePanelSettings(panel.id, {
              ...(requestedModel !== undefined ? { model: requestedModel } : {}),
              fastMode: requestedFastMode,
              ...(requestedReasoningEffort !== undefined ? { reasoningEffort: requestedReasoningEffort } : {}),
            });
          }
          // Deterministic at-spawn registration (facade.registerInteractivePanel):
          // seed the runId→panelId translation BEFORE the PTY spawn so a relay or
          // close-out racing the first PTY byte never falls back to the sentinel
          // runId ("No claude process found").
          registerLivePanel(runId, panel.id);
          void interactiveCliManager
            .startPanel(
              panel.id,
              session.id,
              session.worktreePath,
              QUICK_PTY_BRIEFING,
              session.permissionMode,
              requestedModel, // pinned to a concrete snapshot at the spawn seam
              requestedEffort, // 'ultracode' → `--settings {ultracode:true}` (Ultracode card)
              requestedFastMode, // default off; opts this session into fast mode
              undefined, // resumeSessionId — not applicable to a fresh eager spawn
              requestedReasoningEffort,
            )
            .catch((err: unknown) => {
              // Fail-soft: a spawn failure leaves the session usable — the next
              // sessions:input re-spawns the REPL with the user's prompt.
              console.error(`[IPC] Eager interactive REPL spawn failed for session ${session.id}:`, err);
              // …but fail-soft is INVISIBLE: create-quick already returned
              // success + a claudePanelId, so the renderer mounts a terminal on
              // a channel that will never emit a byte and shows a bare cursor
              // forever, with no error anywhere. Only spawnCliProcess's own
              // final failure self-reports (`pty-spawn-failed`); anything
              // startPanel throws BEFORE that (worktree/settings/briefing prep)
              // died here in a console.error. Report it so a blank terminal is
              // diagnosable instead of silent. Fixed message + bounded
              // errorClass — the raw text stays in the console.error above.
              reportEagerSpawnFailure(err, 'interactive', 'claude');
            });
          // Mirror sessions:input — the REPL is live; show the session as running.
          await sessionManager.updateSession(session.id, { status: 'running' });
        } catch (error) {
          console.error(`[IPC] Failed to create Claude panel for interactive quick session ${session.id}:`, error);
          // Continue without the eager spawn — sessions:input bootstraps on demand.
        }
      }

      // claudePanelId is only set on the interactive path (so the frontend skips
      // creating a duplicate claude panel); the SDK response shape is unchanged.
      return {
        success: true,
        data: {
          jobId,
          sessionId: session.id,
          worktreePath: session.worktreePath,
          runId,
          ...(claudePanelId !== undefined ? { claudePanelId } : {}),
        },
      };
    } catch (error) {
      console.error('[IPC] Failed to create quick session:', error);
      console.error('[IPC] Error stack:', error instanceof Error ? error.stack : 'No stack trace');

      let errorMessage = 'Failed to create quick session';
      let errorDetails = '';
      let command = '';

      if (error instanceof Error) {
        errorMessage = error.message;
        errorDetails = error.stack || error.toString();

        const gitError = error as Error & { gitCommand?: string; cmd?: string; gitOutput?: string; stderr?: string };
        if (gitError.gitCommand) {
          command = gitError.gitCommand;
        } else if (gitError.cmd) {
          command = gitError.cmd;
        }

        if (gitError.gitOutput) {
          errorDetails = gitError.gitOutput;
        } else if (gitError.stderr) {
          errorDetails = gitError.stderr;
        }
      }

      return {
        success: false,
        error: errorMessage,
        details: errorDetails,
        command: command
      };
    }
  });

  ipcMain.handle('sessions:delete', async (_event, sessionId: string) => {
    try {
      // Get database session details before archiving (includes worktree_name and project_id)
      const dbSession = databaseService.getSession(sessionId);
      if (!dbSession) {
        return { success: false, error: 'Session not found' };
      }
      
      // Check if session is already archived
      if (dbSession.archived) {
        return { success: false, error: 'Session is already archived' };
      }

      // Dismissal has the same gate settlement contract as Stop. Resolve gates
      // before killing the owner so a parked SDK/PTY turn cannot emit against an
      // archived session while the worktree is being removed.
      const dismissGateRunId = dbSession.chat_run_id ?? dbSession.run_id;
      if (dismissGateRunId) {
        QuestionRouter.getInstance().clearPendingForRun(dismissGateRunId);
        ApprovalRouter.getInstance().clearPendingForRun(dismissGateRunId);
      }

      // Dismissing a session must not strand its hosted workflow runs: cancel
      // every non-terminal run FIRST (git-neutral — stops the live agent and
      // settles pending approvals/questions so no orphaned review-queue items;
      // a sprint run's lane batch is closed too). Fail-soft: a cancel failure
      // must not block the archive.
      try {
        await cyboflow.cancelHostedRuns(sessionId);
      } catch (cancelError) {
        console.error(`[Main] Failed to cancel hosted runs for session ${sessionId}:`, cancelError);
      }

      // NOTE (IDEA-039): the session-dismiss reap of uncommitted run artifacts was
      // REMOVED here. The reap now runs ONLY on MERGE / create-PR close-out
      // (ArtifactRouter.reapForRun, wired at the git.ts session-merge + create-PR
      // seams and the legacy runs.merge/createPr seams). A dismiss-without-merge
      // intentionally LEAKS the run's uncommitted artifacts (accepted product
      // decision — no GC sweep). The UNRELATED `artifacts/<sessionId>` image-dir
      // cleanup in the background cleanupCallback below is untouched.

      // Add a message to session output about archiving
      const timestamp = new Date().toLocaleTimeString();
      let archiveMessage = `\r\n\x1b[36m[${timestamp}]\x1b[0m \x1b[1m\x1b[44m\x1b[37m 📦 ARCHIVING SESSION \x1b[0m\r\n`;
      archiveMessage += `\x1b[90mSession will be archived and removed from the active sessions list.\x1b[0m\r\n`;

      // PTY quick-session close-out: a live interactive REPL must not be
      // orphaned when its session is dismissed/archived. HARD kill (not the
      // graceful EOF/`/exit` end — a dismissed session's claude may be mid-turn
      // and never read PTY stdin) BEFORE the worktree-removal cleanup below
      // tears the cwd out from under it. The facade translates the chat sentinel
      // runId to the live panelId and NO-OPs for the SDK substrate. Fail-soft:
      // a kill failure must never block the dismiss. Role-G: the live REPL gates on
      // the chat_run_id sentinel (the gate vehicle), not sessions.run_id.
      const dismissPanels = panelManager.getPanelsForSession(sessionId).filter((p) => p.type === 'claude');
      for (const panel of dismissPanels) {
        try {
          // OMP fleet panels are 'claude'-typed but owned by the remote-worker
          // manager, and omp-fleet is NOT a PanelLane — resolvePanelLane maps
          // them onto the omp-sdk lane, whose manager never spawned them, so
          // its stopPanel is a no-op and the REMOTE worker survives a dismiss
          // that is about to delete the worktree out from under it.
          if (dbSession.agent_runtime === 'omp-fleet') {
            await ompSessionManager?.stopPanel(panel.id);
            continue;
          }
          // Per-PANEL lane: a mixed session (an overridden chat next to inherited
          // ones) has panels on two different managers, so a session-level test
          // would leave the odd one out running.
          const dismissLane = resolvePanelLane(dbSession, panel);
          const dismissOwner = laneStopOwner(dismissLane);
          if (dismissOwner) {
            await dismissOwner.stopPanel(panel.id);
          } else if (dismissLane === 'claude-interactive') {
            if (interactiveCliManager) {
              await interactiveCliManager.stopPanel(panel.id);
            } else if (dismissGateRunId) {
              await killLiveSession(dismissGateRunId);
            }
          } else {
            await claudeCodeManager.stopPanel(panel.id);
          }
        } catch (err) {
          console.warn(`[IPC:session] Failed to tear down live panel ${panel.id} for dismissed session ${sessionId}:`, err);
        }
      }
      // A quick session can lose its panel row during startup recovery. Keep the
      // sentinel kill as a final fallback so a warm SDK query or PTY REPL cannot
      // survive archive/worktree removal.
      if (dismissPanels.length === 0 && dismissGateRunId) {
        try {
          await killLiveSession(dismissGateRunId);
        } catch (err) {
          console.warn(`[IPC:session] Failed to kill live quick agent for dismissed session ${sessionId}:`, err);
        }
      }

      // Archive the session immediately to provide fast feedback to the user
      await sessionManager.archiveSession(sessionId);

      // Stamp outcome='dismissed' on this session's runs so the run-outcome stats
      // (Insights) record the dismiss. Runs link via workflow_runs.session_id —
      // the sessionId here IS that key. Guarded by `outcome IS NULL` inside
      // stampSessionRunsOutcome so a run that already recorded its own decision is
      // never clobbered. Fail-soft: a stamping failure is logged and never fails
      // the archive (which has already succeeded).
      try {
        const stamped = stampSessionRunsOutcome(makeDatabaseLike(databaseService), sessionId, 'dismissed');
        if (stamped > 0) {
          console.log(`[Main] Stamped outcome='dismissed' on ${stamped} run(s) for session ${sessionId}`);
        }
      } catch (stampError) {
        console.error(`[Main] Failed to stamp dismissed outcome for session ${sessionId}:`, stampError);
      }
      trackUsage('session_resolved', { action: 'dismiss' });

      // Archive semantics intentionally differ from merge: dismiss ALL pending
      // review items across every run hosted by this session, while git merge
      // keeps the narrower dynamic-workflow-only resolve sweep. The helper is
      // fail-soft per row, and this is the sole owner of archive close-out.
      const reviewItemSweep = await dismissPendingReviewItemsForSession(
        makeDatabaseLike(databaseService),
        sessionId,
        {
          warn: (message, context) => console.warn(`[IPC:session] ${message}`, context),
        },
      );
      if (reviewItemSweep.itemsDismissed > 0) {
        console.log(`[IPC:session] Dismissed ${reviewItemSweep.itemsDismissed} pending review item(s) for session ${sessionId}`);
      }

      // Add the archive message to session output
      sessionManager.addSessionOutput(sessionId, {
        type: 'stdout',
        data: archiveMessage,
        timestamp: new Date()
      });

      // Create cleanup callback for background operations
      const cleanupCallback = async () => {
        let cleanupMessage = '';
        
        // Clean up the worktree if session has one, but NOT for main-repo sessions
        // (singleton dashboard) or in-place sessions (migration 047) — an in-place
        // session's worktree_path IS the user's real checkout, which must never be
        // torn down by `git worktree remove`.
        if (dbSession.worktree_name && dbSession.project_id && !dbSession.is_main_repo && !dbSession.in_place) {
          const project = databaseService.getProject(dbSession.project_id);
          if (project) {
            try {
              // Update progress: removing worktree
              if (archiveProgressManager) {
                archiveProgressManager.updateTaskStatus(sessionId, 'removing-worktree');
              }

              await worktreeManager.removeWorktree(project.path, dbSession.worktree_name, project.worktree_folder || undefined);

              cleanupMessage += `\x1b[32m✓ Worktree removed successfully\x1b[0m\r\n`;

              // Dismiss discards the session, so its branch goes with the
              // worktree (mirrors runs.dismiss) — session branches are created
              // AS the worktree name at createWorktree time, and leaving them
              // behind litters the repo with orphaned quick-* refs. Force (-D)
              // because dismissed work is unmerged by definition. Skip a
              // PRE-EXISTING branch the session merely checked out — recorded
              // at create time as base_branch === worktree_name — that branch
              // is the user's, not ours. Fail-soft: a branch-delete failure
              // must never fail the cleanup task (worktree removal, the part
              // that blocks re-creation, has already succeeded).
              if (dbSession.base_branch !== dbSession.worktree_name) {
                try {
                  await worktreeManager.deleteBranch(project.path, dbSession.worktree_name, { force: true });
                  cleanupMessage += `\x1b[32m✓ Branch removed successfully\x1b[0m\r\n`;
                } catch (branchError) {
                  console.error(`[Main] Failed to delete branch ${dbSession.worktree_name}:`, branchError);
                  cleanupMessage += `\x1b[33m⚠ Failed to delete branch (manual cleanup may be needed)\x1b[0m\r\n`;
                }
              }
            } catch (worktreeError) {
              // Log the error but don't fail
              console.error(`[Main] Failed to remove worktree ${dbSession.worktree_name}:`, worktreeError);
              cleanupMessage += `\x1b[33m⚠ Failed to remove worktree (manual cleanup may be needed)\x1b[0m\r\n`;
              
              // Update progress: failed
              if (archiveProgressManager) {
                archiveProgressManager.updateTaskStatus(sessionId, 'failed', 'Failed to remove worktree');
              }
            }
          }
        }

        // Clean up session artifacts (images)
        const artifactsDir = getCyboflowSubdirectory('artifacts', sessionId);
        if (existsSync(artifactsDir)) {
          try {
            // Update progress: cleaning artifacts
            if (archiveProgressManager) {
              archiveProgressManager.updateTaskStatus(sessionId, 'cleaning-artifacts');
            }
            
            await fs.rm(artifactsDir, { recursive: true, force: true });
            
            cleanupMessage += `\x1b[32m✓ Artifacts removed successfully\x1b[0m\r\n`;
          } catch (artifactsError) {
            console.error(`[Main] Failed to remove artifacts for session ${sessionId}:`, artifactsError);
            cleanupMessage += `\x1b[33m⚠ Failed to remove artifacts (manual cleanup may be needed)\x1b[0m\r\n`;
          }
        }

        // If there were any cleanup messages, add them to the session output
        if (cleanupMessage) {
          sessionManager.addSessionOutput(sessionId, {
            type: 'stdout',
            data: cleanupMessage,
            timestamp: new Date()
          });
        }
      };

      // Queue the cleanup task if we have worktree cleanup to do. In-place
      // sessions (migration 047) have no worktree to remove — route them to the
      // immediate artifact-only cleanup instead of a bogus "cleaning worktree"
      // progress task (the callback's own guard would skip the removal anyway).
      if (dbSession.worktree_name && dbSession.project_id && !dbSession.is_main_repo && !dbSession.in_place) {
        const project = databaseService.getProject(dbSession.project_id);
        if (project && archiveProgressManager) {
          archiveProgressManager.addTask(
            sessionId,
            dbSession.name,
            dbSession.worktree_name,
            project.name,
            cleanupCallback
          );
        }
      } else {
        // No worktree cleanup needed, just run artifact cleanup immediately
        setImmediate(() => cleanupCallback());
      }

      return { success: true };
    } catch (error) {
      console.error('Failed to delete session:', error);
      return { success: false, error: 'Failed to delete session' };
    }
  });

  ipcMain.handle('sessions:input', async (_event, sessionId: string, input: string) => {
    // Declared outside the try so the catch can undo the optimistic 'running'
    // flip below; null means we never flipped and must not touch the status.
    let flippedFromStatus: SessionType['status'] | null = null;
    try {
      // Validate session exists and is active
      const sessionValidation = validateSessionIsActive(sessionId);
      if (!sessionValidation.valid) {
        logValidationFailure('sessions:input', sessionValidation);
        return createValidationError(sessionValidation);
      }

      // Session-summary debounce reset (session-summary-plan.md §2.2). This is
      // the load-bearing turn-start signal for the PTY relay path: a composer
      // turn on a live REPL goes through relayUserTurn and emits NO 'spawned'
      // event, so the scheduler's SDK 'spawned' clear never fires for it. Clear
      // the pending idle timer here, before dispatching the user turn, so a stale
      // timer cannot fire mid-turn (the turn's own turn-end re-arms).
      services.sessionSummaryScheduler?.noteTurnStart(sessionId);

      // Refuse a switched-off provider up here, ahead of every side effect below.
      // The spawn seams assert too, but each branch flips the session to 'running'
      // (and persists the user turn) FIRST, and no listener will ever flip it back
      // for a turn that never started — the chat would sit on a phantom "thinking"
      // placeholder with a Stop button behind it. This is the session-scoped input
      // path, taken only when the panel inherits its session's lane, so the
      // session's own runtime is the right provider to check.
      const inputDbSession = databaseService.getSession(sessionId);
      const inputRuntime = inputDbSession?.agent_runtime;
      assertAgentProviderAllowed(
        isSessionAgentRuntime(inputRuntime) ? providerForRuntime(inputRuntime) : 'claude',
        'this chat turn',
      );

      // Update session status back to running when user sends input
      const currentSession = await sessionManager.getSession(sessionId);
      // Remembered so the catch below can undo it: everything after this point can
      // throw, and a stranded 'running' outlives the failed turn forever.
      if (currentSession && currentSession.status === 'waiting') {
        console.log(`[Main] User sent input to session ${sessionId}, updating status to 'running'`);
        flippedFromStatus = currentSession.status;
        await sessionManager.updateSession(sessionId, { status: 'running' });
      }

      // Store user input in session outputs for persistence
      const userInputDisplay = `> ${input.trim()}\n`;
      await sessionManager.addSessionOutput(sessionId, {
        type: 'stdout',
        data: userInputDisplay,
        timestamp: new Date()
      });

      const finalInput = input;
      const dbSession = inputDbSession;

      // Get session to determine tool type
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      // Determine which tool type to use for panel operations
      const sessionToolType = session.toolType || 'claude'; // Default to claude for backward compatibility
      
      // Panel Integration: Find or create appropriate panel for input based on session's tool type
      console.log(`[IPC] Checking for ${sessionToolType} panels for session ${sessionId}`);
      const inputPanels = panelManager.getPanelsForSession(sessionId);
      const inputToolPanels = inputPanels.filter(p => p.type === sessionToolType);
      
      if (inputToolPanels.length === 0 && sessionToolType !== 'none') {
        console.log(`[IPC] No ${sessionToolType} panel found, creating one for session ${sessionId}`);
        try {
          await panelManager.createPanel({
            sessionId: sessionId,
            type: 'claude',
            title: 'Chat'
          });
          console.log(`[IPC] Created Claude panel for session ${sessionId}`);
        } catch (error) {
          console.error(`[IPC] Failed to create Claude panel for session ${sessionId}:`, error);
          // Continue without panel - fallback to session-level handling
        }
      } else if (sessionToolType !== 'none') {
        console.log(`[IPC] Found ${inputToolPanels.length} ${sessionToolType} panel(s) for session ${sessionId}`);
      }

      if (sessionToolType === 'none') {
        console.log(`[IPC] Session ${sessionId} has no tool type - cannot send input`);
        return { success: false, error: 'Session has no tool configured' };
      }

      // Get Claude panels for this session after potential creation (only for Claude sessions)
      const postCreatePanels = panelManager.getPanelsForSession(sessionId);
      const postCreateClaudePanels = postCreatePanels.filter(p => p.type === 'claude');
      
      if (postCreateClaudePanels.length === 0) {
        console.error(`[IPC] No Claude panels found for session ${sessionId} after creation attempt`);
        return { success: false, error: 'No Claude panels found for session' };
      }
      
      // Use the first Claude panel (in most cases there will be only one)
      const claudePanel = postCreateClaudePanels[0];
      console.log(`[IPC] Using Claude panel ${claudePanel.id} for input to session ${sessionId}`);

      // Per-panel launch config persisted at quick-session launch (the Configure
      // model dropdown + fast-mode toggle) or by the in-composer ModelPill.
      // sessions:input is the quick-turn path for BOTH substrates and otherwise
      // passes NO model — leaving resolution to the SDK/CLI default — so read the
      // persisted choice here and thread it on every respawn.
      const panelLaunchSettings = databaseService.getPanelSettings(claudePanel.id);
      const panelModel = typeof panelLaunchSettings?.model === 'string' ? panelLaunchSettings.model : undefined;
      const panelFastMode = panelLaunchSettings?.fastMode === true;
      const rawPanelEffort = panelLaunchSettings?.reasoningEffort;
      const panelReasoningEffort = isAnyEffortLevel(rawPanelEffort) ? rawPanelEffort : undefined;

      if (dbSession?.agent_runtime === 'omp-fleet') {
        // Fail-closed provider guard before any side effect (persisted user
        // turn, remote spawn, send): a user who switched OMP off must not steer
        // OMP panels from the composer. The catch already maps the refusal to
        // user-facing copy.
        assertAgentProviderAllowed('omp', 'this chat turn');
        if (!ompSessionManager) {
          return { success: false, error: 'OMP fleet is not available — the bridge is not configured.' };
        }
        if (finalInput) {
          sessionManager.addPanelConversationMessage(claudePanel.id, 'user', finalInput);
        }
        if (ompSessionManager.isPanelRunning(claudePanel.id)) {
          const handed = await ompSessionManager.sendInput(claudePanel.id, finalInput);
          if (!handed) {
            return { success: false, error: 'Failed to deliver input to the OMP worker' };
          }
        } else {
          // See routeOmpPanelTurn: spawn fails closed, so its result is the
          // only honest signal for this turn.
          const spawned = await ompSessionManager.spawn(claudePanel.id, sessionId, finalInput, {
            model: DEFAULT_OMP_MODEL,
            cwd: session.worktreePath ?? undefined,
          });
          if (!spawned) {
            return { success: false, error: 'Failed to start the OMP worker' };
          }
        }
        await sessionManager.updateSession(sessionId, { status: 'running' });
        return { success: true };
      }

      // Lane, not session runtime: the two tests this replaces read the SESSION's
      // runtime as if it also fixed the panel's substrate, so a per-panel
      // override in a Codex session was answered by the wrong transport — and a
      // binary `=== 'codex-*'` pair would have routed every OMP panel to Claude.
      const inputLane = resolvePanelLane(dbSession, claudePanel);
      const inputPtyLane = quickPtyLanes.get(inputLane);
      if (inputPtyLane) {
        if (inputPtyLane.isPanelRunning(claudePanel.id)) {
          console.log(`[IPC] Relaying input into live ${inputPtyLane.label} PTY for panel ${claudePanel.id}`);
          inputPtyLane.relayUserTurn(claudePanel.id, finalInput);
          await sessionManager.updateSession(sessionId, { status: 'running' });
        } else {
          console.log(`[IPC] ${inputPtyLane.label} PTY not running for panel ${claudePanel.id}, re-spawning fresh...`);
          if (dbSession?.chat_run_id) {
            inputPtyLane.registerPanel(dbSession.chat_run_id, claudePanel.id);
          }
          void inputPtyLane
            .startPanel({
              panelId: claudePanel.id,
              sessionId,
              worktreePath: session.worktreePath,
              prompt: finalInput,
              permissionMode: session.permissionMode,
              model: panelModel,
              runId: dbSession?.chat_run_id ?? dbSession?.run_id ?? undefined,
              reasoningEffort: panelReasoningEffort,
            })
            .catch((err: unknown) => {
              console.error(`[IPC] ${inputPtyLane.label} PTY re-spawn failed for session ${sessionId}:`, err);
            });
          await sessionManager.updateSession(sessionId, { status: 'running' });
        }
        return { success: true };
      }

      const inputStructuredLane = structuredChatLanes.get(inputLane);
      if (inputStructuredLane) {
        const { manager, label } = inputStructuredLane;
        if (!manager) return { success: false, error: `${label} SDK manager is not available` };
        if (manager.isPanelRunning(claudePanel.id)) {
          return {
            success: false,
            error: `${label} is still processing the previous message.`,
          };
        }

        await inputStructuredLane.startTurn(claudePanel.id, finalInput);
        return { success: true };
      }

      // INTERACTIVE substrate branch (sessions.substrate, migration 027): the
      // session's claude lives in a persistent PTY REPL, so a composer turn is
      // RELAYED into the live process — never the SDK manager (whose
      // startPanel/sendInput would spawn a competing SDK conversation). The SDK
      // path below stays byte-identical for sdk/NULL sessions (Q3 invariant).
      // Demo mode never spawns the real REPL (the canned DemoTerminalView owns
      // its own client-side input), so an interactive demo session must NOT hit
      // the real interactive manager — fall through to the SDK/demo path below.
      if (dbSession?.substrate === 'interactive' && !configManager.isDemoMode()) {
        // Continued interaction supersedes any FINISHED dynamic-workflow card:
        // the operator is moving on, so dismiss this session's terminal runs
        // (a still-running one is left in place). Fail-soft, fire-and-forget.
        DynamicWorkflowTracker.tryGetInstance()?.dismissTerminalForSession(sessionId);
        if (interactiveCliManager.isPanelRunning(claudePanel.id)) {
          console.log(`[IPC] Relaying input into live interactive REPL for panel ${claudePanel.id}`);
          interactiveCliManager.relayUserTurn(claudePanel.id, finalInput);
          // Show the new turn as running so the turn-end rest listener
          // (index.ts) has a 'running' edge to flip — mirrors the SDK quick
          // cycle where each input re-enters 'running'.
          await sessionManager.updateSession(sessionId, { status: 'running' });
        } else {
          // REPL died or the app restarted — re-spawn FRESH with the user's input
          // as the first prompt. ⚠️ NEVER await startPanel: the interactive spawn
          // promise resolves only when the REPL EXITS (persistent-session
          // contract) — awaiting would deadlock sessions:input until the session
          // ends. RESUMING a lost conversation is NOT done here: it is an explicit,
          // EAGER user choice (sessions:resume-interactive, the open-time "Resume
          // previous session" prompt), which spawns `--resume <uuid>` immediately.
          // By the time a turn reaches this branch the REPL is already live (the
          // relay branch above), so this path is only ever a fresh fallback.
          console.log(`[IPC] Interactive REPL not running for panel ${claudePanel.id}, re-spawning fresh...`);
          // Deterministic at-spawn registration (mirrors the create-quick eager
          // spawn): seed the facade's runId→panelId translation BEFORE the PTY
          // spawn so a relay/close-out racing the first PTY byte never falls
          // back to the sentinel runId. Role-G: the interactive REPL gates on the
          // chat_run_id sentinel (the gate vehicle the manager spawn resolves), not
          // sessions.run_id — register the chat sentinel so the translation matches.
          if (dbSession?.chat_run_id) {
            registerLivePanel(dbSession.chat_run_id, claudePanel.id);
          }
          void interactiveCliManager
            .startPanel(
              claudePanel.id,
              sessionId,
              session.worktreePath,
              finalInput,
              session.permissionMode,
              panelModel,
              undefined, // effort — re-spawn does not carry the ultracode card setting
              panelFastMode,
              undefined, // resumeSessionId — a fresh-fallback respawn, not an explicit resume
              panelReasoningEffort,
            )
            .catch((err: unknown) => {
              console.error(`[IPC] Interactive REPL re-spawn failed for session ${sessionId}:`, err);
            });
          await sessionManager.updateSession(sessionId, { status: 'running' });
        }
        return { success: true };
      }

      // Check if Claude Code is running for this panel
      // TODO: In the future, this should detect the panel's CLI tool type and get the appropriate manager
      const isClaudeRunning = claudeCodeManager.isPanelRunning(claudePanel.id);
      
      if (!isClaudeRunning) {
        console.log(`[IPC] Claude Code not running for panel ${claudePanel.id}, starting it now...`);
        
        // Session already fetched above, no need to fetch again
        
        // Start Claude Code via the panel with the input as the initial prompt
        await claudeCodeManager.startPanel(claudePanel.id, sessionId, session.worktreePath, finalInput, session.permissionMode, panelModel, panelFastMode, panelReasoningEffort);
        
        // Update session status to running
        await sessionManager.updateSession(sessionId, { status: 'running' });
      } else {
        // Claude Code is already running, just send the input to the panel
        claudeCodeManager.sendInput(claudePanel.id, finalInput);
      }
      
      return { success: true };
    } catch (error) {
      console.error('Failed to send input:', error);
      // Undo the optimistic 'running' flip. The turn never started, so none of the
      // turn-end listeners (which key off the spawn's own events) will ever fire to
      // clear it — the chat would keep painting a "thinking" placeholder and a Stop
      // button over an idle session until something else moved the status.
      if (flippedFromStatus !== null) {
        try {
          await sessionManager.updateSession(sessionId, { status: flippedFromStatus });
        } catch (revertError: unknown) {
          console.error(`[IPC] Failed to restore status after a failed input on ${sessionId}:`, revertError);
        }
      }
      // Surface a provider-disabled refusal verbatim: it is user-authored copy
      // (and carries the code the composer parses into an "Open Settings →
      // Integrations" action), so collapsing it into the generic string below
      // would strand the user retrying with no stated reason.
      const disabled = agentProviderDisabledMessage(error);
      return { success: false, error: disabled ?? 'Failed to send input' };
    }
  });

  // INTERACTIVE RESUME (lost quick-session REPL recovery) ---------------------
  // After an app close/restart the persistent interactive REPL is gone and its
  // sentinel run is force-failed by boot recovery, but sessions.claude_session_id
  // (persisted from the transcript filename) AND claude's on-disk transcript
  // survive. These handlers back the open-time UI's "Resume previous session" vs
  // "Start fresh" prompt: the query reports whether a resume is possible; the
  // resume handler EAGERLY re-spawns the REPL with `--resume <uuid>` (no fork, no
  // first message required) so the prior conversation reopens live the moment the
  // user clicks. Scope: interactive quick sessions only.
  ipcMain.handle('sessions:get-interactive-resume-state', async (_event, sessionId: string, panelId?: string) => {
    try {
      const dbSession = databaseService.getSession(sessionId);
      if (!dbSession) {
        return { success: false, error: 'Session not found' };
      }
      const target = resolveResumeTargetPanel(sessionId, panelId);
      const replRunning = target ? interactiveCliManager.isPanelRunning(target.id) : false;
      // Only surface a resumable id when claude's on-disk transcript still exists —
      // a missing transcript makes `claude --resume` fail and would lose the first
      // message to a dead spawn.
      const storedId = sessionManager.getClaudeSessionId(sessionId) ?? null;
      // sessions.claude_session_id is SESSION-scoped: it names ONE transcript, the
      // one the session's PRIMARY chat panel wrote. An ADDED chat panel (TASK-103)
      // has no transcript id of its own, so offering it that id would resume it
      // into the primary panel's conversation — two panels replaying one thread.
      // Report not-resumable for added panels instead; they start fresh, which is
      // the honest answer until per-panel transcript ids exist.
      const ownsSessionTranscript = target?.id === resolveClaudePanelId(sessionId);
      const claudeSessionId =
        ownsSessionTranscript && interactiveTranscriptExists(dbSession.worktree_path, storedId)
          ? storedId
          : null;
      const worktreeExists = !!dbSession.worktree_path && existsSync(dbSession.worktree_path);
      return { success: true, data: { replRunning, claudeSessionId, worktreeExists } };
    } catch (error) {
      console.error('[IPC] Failed to get interactive resume state:', error);
      return { success: false, error: 'Failed to get interactive resume state' };
    }
  });

  ipcMain.handle('sessions:resume-interactive', async (
    _event,
    sessionId: string,
    panelId?: string,
    /**
     * The resume prompt's "Resume anyway" — the user was shown that Claude is
     * switched off and chose to reopen the conversation regardless. Without it a
     * disabled provider refuses here, with a reason the prompt can render.
     */
    acknowledgeProviderDisabled?: boolean,
  ) => {
    try {
      const dbSession = databaseService.getSession(sessionId);
      if (!dbSession) {
        return { success: false, error: 'Session not found' };
      }
      const targetPanel = resolveResumeTargetPanel(sessionId, panelId);
      if (!targetPanel) {
        return { success: false, error: 'No Claude panel for this session' };
      }
      // Gate on the PANEL's effective substrate, not the session's: a per-panel
      // interactive override on an otherwise-SDK session is a real PTY that must
      // be resumable, and the old session-level check rejected it outright.
      if (resolvePanelSubstrate(targetPanel, dbSession) !== 'interactive') {
        return { success: false, error: 'Panel is not backed by an interactive REPL' };
      }
      const claudeSessionId = sessionManager.getClaudeSessionId(sessionId);
      if (!claudeSessionId || !interactiveTranscriptExists(dbSession.worktree_path, claudeSessionId)) {
        return { success: false, error: 'No prior Claude conversation to resume' };
      }
      // Only the panel that OWNS the session-scoped transcript may resume it —
      // see the note in sessions:get-interactive-resume-state. An added panel
      // resuming this id would replay the primary panel's conversation.
      if (targetPanel.id !== resolveClaudePanelId(sessionId)) {
        return { success: false, error: 'This chat has no prior conversation to resume' };
      }
      const claudePanelId = targetPanel.id;
      // Already live (e.g. a double-click, or the REPL was never actually lost) —
      // nothing to do.
      if (interactiveCliManager.isPanelRunning(claudePanelId)) {
        return { success: true };
      }
      // Provider gate. The spawn below is fire-and-forget (an interactive spawn
      // promise resolves only when the REPL EXITS), so a refusal thrown down
      // there lands in a .catch that only logs — the handler still answered
      // success and the prompt closed onto a permanently blank terminal. Decide
      // it HERE, where the answer can reach the user. Unless, of course, they
      // already saw the warning and chose to reopen the conversation anyway: a
      // lost REPL's history is recoverable only by respawning it, and that
      // choice is theirs to make.
      if (!acknowledgeProviderDisabled) {
        assertAgentProviderAllowed('claude', 'resuming this terminal session');
      }
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }
      // Per-panel launch config (model / fast-mode) persisted at quick-session
      // launch — thread it on the resume respawn exactly like sessions:input does.
      const panelLaunchSettings = databaseService.getPanelSettings(claudePanelId);
      const panelModel = typeof panelLaunchSettings?.model === 'string' ? panelLaunchSettings.model : undefined;
      const panelFastMode = panelLaunchSettings?.fastMode === true;
      const rawResumeEffort = panelLaunchSettings?.reasoningEffort;
      const panelReasoningEffort = isAnyEffortLevel(rawResumeEffort) ? rawResumeEffort : undefined;
      // Seed the facade's runId→panelId translation BEFORE the PTY spawn (mirrors
      // the create-quick eager spawn) so a relay/close-out racing the first PTY byte
      // never falls back to the sentinel runId. Register the CHAT sentinel — the
      // gate vehicle the interactive spawn resolves and the id the manager stamps
      // on its pty-output — matching the create-quick and sessions:input seams;
      // run_id is only the legacy fallback (equal for quick sessions today).
      const resumeGateRunId = dbSession.chat_run_id ?? dbSession.run_id;
      if (resumeGateRunId) {
        registerLivePanel(resumeGateRunId, claudePanelId);
      }
      // EAGER resume: spawn the REPL NOW with an EMPTY prompt so it reopens directly
      // into the prior conversation (`claude --resume <uuid>`, no fork, no turn).
      // ⚠️ NEVER await startPanel: the interactive spawn promise resolves only when
      // the REPL EXITS (persistent-session contract). The live xterm paints from the
      // raw PTY byte path as soon as claude renders the resumed conversation.
      console.log(`[IPC] Eagerly resuming interactive session ${sessionId} via --resume ${claudeSessionId}`);
      void interactiveCliManager
        .startPanel(
          claudePanelId,
          sessionId,
          session.worktreePath,
          '', // empty prompt → bare resumed REPL, no first turn forced
          session.permissionMode,
          panelModel,
          undefined, // effort — resume does not carry the ultracode card setting
          panelFastMode,
          claudeSessionId, // → `--resume <uuid>` (no fork)
          panelReasoningEffort,
          acknowledgeProviderDisabled === true,
        )
        .catch((err: unknown) => {
          console.error(`[IPC] Interactive resume spawn failed for session ${sessionId}:`, err);
        });
      await sessionManager.updateSession(sessionId, { status: 'running' });
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to resume interactive session:', error);
      // A provider-disabled refusal is user-authored copy carrying the code the
      // prompt parses into its warning + "Resume anyway" action — pass it through
      // rather than collapsing it into the generic string.
      const disabled = agentProviderDisabledMessage(error);
      return { success: false, error: disabled ?? 'Failed to resume interactive session' };
    }
  });

  /**
   * Restart a DEAD interactive REPL from scratch — the "Retry" action behind the
   * terminal's stalled state.
   *
   * The twin of `sessions:resume-interactive`, for the case that handler
   * explicitly refuses: no prior conversation to resume. That is exactly the
   * shape of the reported bug — create-quick's eager spawn is fire-and-forget
   * and fail-soft, so a spawn that dies leaves a panel whose terminal never
   * receives a byte and never will. There was no way back from that state short
   * of typing a message (which re-spawns via sessions:input) or discarding the
   * session; this gives the blank terminal an explicit recovery.
   *
   * Same spawn the eager path performs (fresh REPL, QUICK_PTY_BRIEFING, the
   * panel's persisted model / fast-mode / effort), and — following the resume
   * handler's hard-won lesson — the provider gate is decided HERE, where the
   * answer can reach the user, rather than inside the fire-and-forget spawn
   * whose rejection only ever reached a `.catch` that logs.
   */
  ipcMain.handle('sessions:restart-interactive', async (_event, sessionId: string, panelId?: string) => {
    try {
      const dbSession = databaseService.getSession(sessionId);
      if (!dbSession) {
        return { success: false, error: 'Session not found' };
      }
      const targetPanel = resolveResumeTargetPanel(sessionId, panelId);
      if (!targetPanel) {
        return { success: false, error: 'No Claude panel for this session' };
      }
      if (resolvePanelSubstrate(targetPanel, dbSession) !== 'interactive') {
        return { success: false, error: 'Panel is not backed by an interactive REPL' };
      }
      const claudePanelId = targetPanel.id;
      // Already live — the REPL recovered (or was never actually dead) between
      // the stall probe and this click. Nothing to do; a second spawn on a live
      // panel would orphan the first.
      if (interactiveCliManager.isPanelRunning(claudePanelId)) {
        return { success: true };
      }
      assertAgentProviderAllowed('claude', 'restarting this terminal session');
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }
      const panelLaunchSettings = databaseService.getPanelSettings(claudePanelId);
      const panelModel = typeof panelLaunchSettings?.model === 'string' ? panelLaunchSettings.model : undefined;
      const panelFastMode = panelLaunchSettings?.fastMode === true;
      const rawEffort = panelLaunchSettings?.reasoningEffort;
      const panelReasoningEffort = isAnyEffortLevel(rawEffort) ? rawEffort : undefined;
      // Seed the facade's runId→panelId translation BEFORE the spawn, exactly as
      // the create-quick eager path and the resume handler do.
      const gateRunId = dbSession.chat_run_id ?? dbSession.run_id;
      if (gateRunId) {
        registerLivePanel(gateRunId, claudePanelId);
      }
      console.log(`[IPC] Restarting interactive REPL for session ${sessionId} (panel ${claudePanelId})`);
      // ⚠️ NEVER await startPanel — the interactive spawn promise resolves only
      // when the REPL EXITS (persistent-session contract).
      void interactiveCliManager
        .startPanel(
          claudePanelId,
          sessionId,
          session.worktreePath,
          QUICK_PTY_BRIEFING,
          session.permissionMode,
          panelModel,
          undefined, // effort — the ultracode card setting is a launch-time choice
          panelFastMode,
          undefined, // resumeSessionId — a restart is a FRESH conversation
          panelReasoningEffort,
        )
        .catch((err: unknown) => {
          console.error(`[IPC] Interactive restart spawn failed for session ${sessionId}:`, err);
          reportEagerSpawnFailure(err, 'interactive', 'claude');
        });
      await sessionManager.updateSession(sessionId, { status: 'running' });
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to restart interactive session:', error);
      // Pass a provider-disabled refusal through as user-authored copy (mirrors
      // the resume handler) so the retry button can say WHY it refused.
      const disabled = agentProviderDisabledMessage(error);
      return { success: false, error: disabled ?? 'Failed to restart interactive session' };
    }
  });

  ipcMain.handle('sessions:get-or-create-main-repo', async (_event, projectId: number) => {
    try {
      console.log('[IPC] sessions:get-or-create-main-repo handler called with projectId:', projectId);

      // Get or create the main repo session
      const session = await sessionManager.getOrCreateMainRepoSession(projectId);

      // If it's a newly created session, just emit the created event
      const dbSession = databaseService.getSession(session.id);
      if (dbSession && dbSession.status === 'pending') {
        console.log('[IPC] New main repo session created:', session.id);

        // Emit session created event
        sessionManager.emitSessionCreated(session);

        // Set the status to stopped since Claude Code isn't running yet
        sessionManager.updateSession(session.id, { status: 'stopped' });
      }

      return { success: true, data: session };
    } catch (error) {
      console.error('Failed to get or create main repo session:', error);
      return { success: false, error: 'Failed to get or create main repo session' };
    }
  });

  // NOTE (PTY quick sessions): no interactive-substrate branch here. The quick
  // session composer routes through sessions:input (ChatInput.tsx →
  // API.sessions.sendInput), and API.sessions.continue has NO production
  // frontend caller — the structured panel UI uses panels:continue instead. If
  // a caller ever appears, mirror the sessions:input substrate guard
  // (relayUserTurn / never-await startPanel) before the SDK manager is touched.
  ipcMain.handle('sessions:continue', async (_event, sessionId: string, prompt?: string, model?: string) => {
    try {
      // Validate session exists and is active
      const sessionValidation = validateSessionIsActive(sessionId);
      if (!sessionValidation.valid) {
        logValidationFailure('sessions:continue', sessionValidation);
        return createValidationError(sessionValidation);
      }

      // Session-summary debounce reset (session-summary-plan.md §2.2) — mirror of
      // the sessions:input clear for the continue/relay dispatch path.
      services.sessionSummaryScheduler?.noteTurnStart(sessionId);

      // Get session details
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      // Determine tool type for this session
      const sessionToolType = session.toolType || 'claude'; // Default to claude for backward compatibility
      
      if (sessionToolType === 'none') {
        console.log(`[IPC] Session ${sessionId} has no tool type - cannot continue`);
        return { success: false, error: 'Session has no tool configured' };
      }

      // Check if Claude is already running for this session to prevent duplicate starts
      if (claudeCodeManager.isSessionRunning(sessionId)) {
        console.log(`[IPC] Session ${sessionId} is already running, preventing duplicate continue`);
        return { success: false, error: 'Session is already processing a request' };
      }

      // Claude Panel Integration: Find or create Claude panel for continuation (only for Claude sessions)
      if (prompt) {
        console.log(`[IPC] Checking for Claude panels for session ${sessionId}`);
        const continuePanels = panelManager.getPanelsForSession(sessionId);
        const continueClaudePanels = continuePanels.filter(p => p.type === 'claude');
        
        if (continueClaudePanels.length === 0) {
          console.log(`[IPC] No Claude panel found, creating one for session ${sessionId}`);
          try {
            console.log('[IPC] Routing panels:continue to ClaudePanelManager.continuePanel');
            await panelManager.createPanel({
              sessionId: sessionId,
              type: 'claude',
              title: 'Chat'
            });
            console.log(`[IPC] Created Claude panel for session ${sessionId}`);
          } catch (error) {
            console.error(`[IPC] Failed to create Claude panel for session ${sessionId}:`, error);
            // Continue without panel - fallback to session-level handling
          }
        } else {
          console.log(`[IPC] Found ${continueClaudePanels.length} Claude panel(s) for session ${sessionId}`);
          // Route to panel-based handler if panels exist  
          // For now, continue with session-level handling but panels will handle the UI
        }
      }

      // MIGRATION FIX: Get conversation history using appropriate method
      const continuePanelsAfterCheck = panelManager.getPanelsForSession(sessionId);
      const continueClaudePanelsAfterCheck = continuePanelsAfterCheck.filter(p => p.type === 'claude');
      
      let conversationHistory;
      if (continueClaudePanelsAfterCheck.length > 0 && sessionManager.getPanelConversationMessages) {
        // Use panel-based method for migrated sessions
        console.log(`[IPC] Using panel-based conversation history for session ${sessionId} with Claude panel ${continueClaudePanelsAfterCheck[0].id}`);
        conversationHistory = sessionManager.getPanelConversationMessages(continueClaudePanelsAfterCheck[0].id);
      } else {
        // Use session-based method for non-migrated sessions
        conversationHistory = sessionManager.getConversationMessages(sessionId);
      }

      // If no prompt provided, use empty string (for resuming)
      const continuePrompt = prompt || '';

      // Check if this is a main repo session that hasn't started Claude Code yet
      const dbSession = databaseService.getSession(sessionId);
      const isMainRepoFirstStart = dbSession?.is_main_repo && conversationHistory.length === 0 && continuePrompt;

      // Update session status to initializing and clear run_started_at
      sessionManager.updateSession(sessionId, {
        status: 'initializing',
        run_started_at: null // Clear previous run time
      });

      if (isMainRepoFirstStart && continuePrompt) {
        // First message in main repo session - start Claude Code without --resume
        console.log(`[IPC] Starting Claude Code for main repo session ${sessionId} with first prompt`);

        // Add initial prompt marker
        sessionManager.addInitialPromptMarker(sessionId, continuePrompt);

        // Add initial prompt to conversation messages
        sessionManager.addConversationMessage(sessionId, 'user', continuePrompt);

        // Add the prompt to output so it's visible
        const timestamp = new Date().toLocaleTimeString();
        const initialPromptDisplay = `\r\n\x1b[36m[${timestamp}]\x1b[0m \x1b[1m\x1b[42m\x1b[30m 👤 USER PROMPT \x1b[0m\r\n` +
                                     `\x1b[1m\x1b[92m${continuePrompt}\x1b[0m\r\n\r\n`;
        await sessionManager.addSessionOutput(sessionId, {
          type: 'stdout',
          data: initialPromptDisplay,
          timestamp: new Date()
        });

        // Run build script if configured
        const project = dbSession?.project_id ? databaseService.getProject(dbSession.project_id) : null;
        if (project?.build_script) {
          console.log(`[IPC] Running build script for main repo session ${sessionId}`);

          const buildWaitingMessage = `\x1b[36m[${new Date().toLocaleTimeString()}]\x1b[0m \x1b[1m\x1b[33m⏳ Waiting for build script to complete...\x1b[0m\r\n\r\n`;
          await sessionManager.addSessionOutput(sessionId, {
            type: 'stdout',
            data: buildWaitingMessage,
            timestamp: new Date()
          });

          const buildCommands = project.build_script.split('\n').filter(cmd => cmd.trim());
          const buildResult = await sessionManager.runBuildScript(sessionId, buildCommands, session.worktreePath);
          console.log(`[IPC] Build script completed. Success: ${buildResult.success}`);
        }

        // Get Claude panels for this session
        const mainRepoPanels = panelManager.getPanelsForSession(sessionId);
        const mainRepoClaudePanels = mainRepoPanels.filter(p => p.type === 'claude');
        
        if (mainRepoClaudePanels.length > 0) {
          // Start Claude Code via the first Claude panel
          const claudePanel = mainRepoClaudePanels[0];
          console.log(`[IPC] Starting Claude via panel ${claudePanel.id} for main repo session ${sessionId}`);
          // Model is now managed at panel level
          await claudeCodeManager.startPanel(
            claudePanel.id,
            sessionId,
            session.worktreePath,
            continuePrompt,
            dbSession?.permission_mode,
            model
          );
        } else {
          // Fallback to session-based start
          console.log(`[IPC] No Claude panels found, falling back to session-based start for ${sessionId}`);
          // Model is now managed at panel level  
          await claudeCodeManager.startSession(
            sessionId,
            session.worktreePath,
            continuePrompt,
            dbSession?.permission_mode,
            model
          );
        }
      } else {
        // Normal continue for existing sessions
        if (continuePrompt) {
          await sessionManager.continueConversation(sessionId, continuePrompt);
        }

        // Get Claude panels for this session
        const normalContinuePanels = panelManager.getPanelsForSession(sessionId);
        const normalContinueClaudePanels = normalContinuePanels.filter(p => p.type === 'claude');
        
        if (normalContinueClaudePanels.length > 0) {
          // Continue Claude conversation via the first Claude panel
          const claudePanel = normalContinueClaudePanels[0];
          // Model is now managed at panel level
          console.log(`[IPC] Continuing Claude via panel ${claudePanel.id} for session ${sessionId}`);
          await claudeCodeManager.continuePanel(
            claudePanel.id,
            sessionId,
            session.worktreePath,
            continuePrompt,
            conversationHistory,
            model
          );
        } else {
          // Fallback to session-based continue
          // Model is now managed at panel level
          console.log(`[IPC] No Claude panels found, continuing session ${sessionId}`);
          await claudeCodeManager.continueSession(
            sessionId,
            session.worktreePath,
            continuePrompt,
            conversationHistory,
            model
          );
        }
      }

      // The session manager will update status based on Claude output
      return { success: true };
    } catch (error) {
      console.error('Failed to continue conversation:', error);
      return { success: false, error: 'Failed to continue conversation' };
    }
  });

  ipcMain.handle('sessions:get-output', async (_event, sessionId: string, limit?: number) => {
    try {
      // Validate session exists
      const sessionValidation = validateSessionExists(sessionId);
      if (!sessionValidation.valid) {
        logValidationFailure('sessions:get-output', sessionValidation);
        return createValidationError(sessionValidation);
      }

      // Performance optimization: Default to loading only recent outputs
      const DEFAULT_OUTPUT_LIMIT = 5000;
      const outputLimit = limit || DEFAULT_OUTPUT_LIMIT;
      
      console.log(`[IPC] sessions:get-output called for session: ${sessionId} with limit: ${outputLimit}`);
      
      // Migration: Check if this session needs a Claude panel
      const session = await sessionManager.getSession(sessionId);
      if (session && !session.archived) {
        const sessionToolType = session.toolType ?? 'claude';
        if (sessionToolType === 'claude') {
          console.log(`[IPC] Checking for Claude panels migration for session ${sessionId}`);
          const existingPanels = panelManager.getPanelsForSession(sessionId);
          const claudePanels = existingPanels.filter(p => p.type === 'claude');

          // Check if session has conversation history but no Claude panels
          const conversationHistory = sessionManager.getConversationMessages(sessionId);
          const hasConversation = conversationHistory.length > 0;
          const hasClaudePanels = claudePanels.length > 0;

          if (hasConversation && !hasClaudePanels) {
            console.log(`[IPC] Session ${sessionId} has conversation history but no Claude panels, creating one`);
            try {
              await panelManager.createPanel({
                sessionId: sessionId,
                type: 'claude',
                title: 'Chat'
              });
              console.log(`[IPC] Migrated session ${sessionId} to use Claude panel`);
            } catch (error) {
              console.error(`[IPC] Failed to create Claude panel during migration for session ${sessionId}:`, error);
            }
          }
        } else {
          console.log(`[IPC] Skipping Claude panel migration for session ${sessionId} with tool type ${sessionToolType}`);
        }

        // Refresh git status when session is loaded/viewed
        gitStatusManager.refreshSessionGitStatus(sessionId, false).catch(error => {
          console.error(`[IPC] Failed to refresh git status for session ${sessionId}:`, error);
        });
      }
      
      // MIGRATION FIX: Check if session has Claude panels and use panel-based data retrieval
      const sessionPanels = panelManager.getPanelsForSession(sessionId);
      const sessionClaudePanels = sessionPanels.filter(p => p.type === 'claude');
      
      let outputs;
      if (sessionClaudePanels.length > 0 && sessionManager.getPanelOutputs) {
        // Use panel-based method for migrated sessions
        console.log(`[IPC] Using panel-based output retrieval for session ${sessionId} with Claude panel ${sessionClaudePanels[0].id}`);
        outputs = await sessionManager.getPanelOutputs(sessionClaudePanels[0].id, outputLimit);
      } else {
        // Use session-based method for non-migrated sessions
        outputs = await sessionManager.getSessionOutputs(sessionId, outputLimit);
      }
      console.log(`[IPC] Retrieved ${outputs.length} outputs for session ${sessionId}`);

      // Performance optimization: Process outputs in batches to avoid blocking
      const { formatJsonForOutputEnhanced } = await import('../utils/toolFormatter');
      const BATCH_SIZE = 100;
      const transformedOutputs = [];
      
      for (let i = 0; i < outputs.length; i += BATCH_SIZE) {
        const batch = outputs.slice(i, Math.min(i + BATCH_SIZE, outputs.length));
        
        const transformedBatch = batch.map(output => {
          if (output.type === 'json') {
            // Generate formatted output from JSON
            const outputText = formatJsonForOutputEnhanced(output.data as Record<string, unknown>);
            if (outputText) {
              // Return as stdout for the Output view
              return {
                ...output,
                type: 'stdout' as const,
                data: outputText
              };
            }
            // If no output format can be generated, skip this JSON message
            return null;
          }
          // Pass through all other output types including 'error'
          return output; 
        }).filter(Boolean);
        
        transformedOutputs.push(...transformedBatch);
      } // Remove any null entries
      return { success: true, data: transformedOutputs };
    } catch (error) {
      console.error('Failed to get session outputs:', error);
      return { success: false, error: 'Failed to get session outputs' };
    }
  });

  ipcMain.handle('sessions:get-conversation', async (_event, sessionId: string) => {
    try {
      // MIGRATION FIX: Check if session has Claude panels and use panel-based data retrieval
      const sessionPanels = panelManager.getPanelsForSession(sessionId);
      const sessionClaudePanels = sessionPanels.filter(p => p.type === 'claude');
      
      let messages;
      if (sessionClaudePanels.length > 0 && sessionManager.getPanelConversationMessages) {
        // Use panel-based method for migrated sessions
        console.log(`[IPC] Using panel-based conversation retrieval for session ${sessionId} with Claude panel ${sessionClaudePanels[0].id}`);
        messages = await sessionManager.getPanelConversationMessages(sessionClaudePanels[0].id);
      } else {
        // Use session-based method for non-migrated sessions
        messages = await sessionManager.getConversationMessages(sessionId);
      }
      
      return { success: true, data: messages };
    } catch (error) {
      console.error('Failed to get conversation messages:', error);
      return { success: false, error: 'Failed to get conversation messages' };
    }
  });

  ipcMain.handle('sessions:get-conversation-messages', async (_event, sessionId: string) => {
    try {
      // MIGRATION FIX: Check if session has Claude panels and use panel-based data retrieval
      const sessionPanels = panelManager.getPanelsForSession(sessionId);
      const sessionClaudePanels = sessionPanels.filter(p => p.type === 'claude');
      
      let messages;
      if (sessionClaudePanels.length > 0 && sessionManager.getPanelConversationMessages) {
        // Use panel-based method for migrated sessions
        console.log(`[IPC] Using panel-based conversation messages retrieval for session ${sessionId} with Claude panel ${sessionClaudePanels[0].id}`);
        messages = await sessionManager.getPanelConversationMessages(sessionClaudePanels[0].id);
      } else {
        // Use session-based method for non-migrated sessions
        messages = await sessionManager.getConversationMessages(sessionId);
      }
      
      return { success: true, data: messages };
    } catch (error) {
      console.error('Failed to get conversation messages:', error);
      return { success: false, error: 'Failed to get conversation messages' };
    }
  });

  // Quick-session rolling summary + append-only history (session-summary-plan.md
  // §7). A pure read: it never blocks on or mutates summary state. When it
  // observes content above the summarizer's watermark it fires the §2.7 lazy
  // catch-up kick — fire-and-forget, bounded by the scheduler's own cooldown so
  // the renderer's 30s poll cannot become a hot retry loop.
  ipcMain.handle('sessions:get-summary', async (_event, sessionId: string) => {
    try {
      const sessionValidation = validateSessionExists(sessionId);
      if (!sessionValidation.valid) {
        logValidationFailure('sessions:get-summary', sessionValidation);
        return createValidationError(sessionValidation);
      }

      const enabled = configManager.isSessionSummaryEnabled();
      const summaryRow = databaseService.getSessionSummary(sessionId);
      const entryRows = databaseService.listSessionSummaryEntries(sessionId);

      // Lazy catch-up decision (§2.7): any conversation_messages row above the
      // watermark means unsummarized content — kick the scheduler (which re-runs
      // every other gate). The read itself is not awaited and mutates nothing.
      const watermark = summaryRow?.last_turn_id ?? 0;
      const hasNewerContent = databaseService.getConversationMessagesAfter(sessionId, watermark).length > 0;
      if (enabled && hasNewerContent) {
        services.sessionSummaryScheduler?.maybeSummarizeNow(sessionId, 'lazy-catchup');
      }

      const payload: SessionSummaryPayload = {
        enabled,
        summary: summaryRow ? summaryRow.summary : null,
        updatedAt: summaryRow ? summaryRow.updated_at : null,
        entries: entryRows.map((row) => ({ id: row.id, entry: row.entry, createdAt: row.created_at })),
      };
      return { success: true, data: payload };
    } catch (error) {
      console.error('Failed to get session summary:', error);
      return { success: false, error: 'Failed to get session summary' };
    }
  });

  // Panel-based handlers for Claude panels
  ipcMain.handle('panels:get-output', async (_event, panelId: string, limit?: number) => {
    try {
      // Validate panel exists
      const panelValidation = validatePanelExists(panelId);
      if (!panelValidation.valid) {
        logValidationFailure('panels:get-output', panelValidation);
        return createValidationError(panelValidation);
      }

      const outputLimit = limit && limit > 0 ? Math.min(limit, 10000) : undefined;
      console.log(`[IPC] panels:get-output called for panel: ${panelId} (session: ${panelValidation.sessionId}) with limit: ${outputLimit}`);
      
      if (!sessionManager.getPanelOutputs) {
        console.error('[IPC] Panel-based output methods not available on sessionManager');
        return { success: false, error: 'Panel-based output methods not available' };
      }
      
      const outputs = await sessionManager.getPanelOutputs(panelId, outputLimit);
      console.log(`[IPC] Returning ${outputs.length} outputs for panel ${panelId}`);
      return { success: true, data: outputs };
    } catch (error) {
      console.error('Failed to get panel outputs:', error);
      return { success: false, error: 'Failed to get panel outputs' };
    }
  });

  ipcMain.handle('panels:get-conversation-messages', async (_event, panelId: string) => {
    try {
      if (!sessionManager.getPanelConversationMessages) {
        console.error('[IPC] Panel-based conversation methods not available on sessionManager');
        return { success: false, error: 'Panel-based conversation methods not available' };
      }

      const messages = await sessionManager.getPanelConversationMessages(panelId);
      // Ensure timestamps are in ISO format for proper sorting with JSON messages
      const messagesWithIsoTimestamps = messages.map(msg => ({
        ...msg,
        timestamp: msg.timestamp.includes('T') || msg.timestamp.includes('Z')
          ? msg.timestamp  // Already ISO format
          : msg.timestamp + 'Z'  // SQLite format, append Z for UTC
      }));
      return { success: true, data: messagesWithIsoTimestamps };
    } catch (error) {
      console.error('Failed to get panel conversation messages:', error);
      return { success: false, error: 'Failed to get panel conversation messages' };
    }
  });

  ipcMain.handle('panels:get-json-messages', async (_event, panelId: string) => {
    try {
      console.log(`[IPC] panels:get-json-messages called for panel: ${panelId}`);

      const panelValidation = validatePanelExists(panelId);
      if (!panelValidation.valid) {
        logValidationFailure('panels:get-json-messages', panelValidation);
        return createValidationError(panelValidation);
      }

      if (!sessionManager.getPanelOutputs) {
        console.error('[IPC] Panel-based output methods not available on sessionManager');
        return { success: false, error: 'Panel-based output methods not available' };
      }

      const outputs = await sessionManager.getPanelOutputs(panelId);
      const unifiedMessages = projectStoredOutputs(outputs, panelId, services.logger);

      console.log(`[IPC] panel ${panelId}: projected ${unifiedMessages.length} UnifiedMessages from ${outputs.length} raw outputs`);
      return { success: true, data: unifiedMessages };
    } catch (error) {
      console.error('Failed to get panel JSON messages:', error);
      return { success: false, error: 'Failed to get panel JSON messages' };
    }
  });

  ipcMain.handle('panels:get-prompts', async (_event, panelId: string) => {
    try {
      console.log(`[IPC] panels:get-prompts called for panel: ${panelId}`);
      
      // Get all conversation messages to find assistant responses
      const allMessages = databaseService.getPanelConversationMessages(panelId);
      
      // Build prompts with assistant response timestamps
      const prompts = allMessages
        .map((msg, index) => {
          if (msg.message_type === 'user') {
            // Find the next assistant message for completion timestamp
            const nextAssistantMsg = allMessages
              .slice(index + 1)
              .find(m => m.message_type === 'assistant');
            
            return {
              id: msg.id,
              session_id: msg.session_id,
              panel_id: panelId,
              prompt_text: msg.content,
              output_index: index,
              timestamp: msg.timestamp,
              // Use the assistant's response timestamp as completion
              completion_timestamp: nextAssistantMsg?.timestamp
            };
          }
          return null;
        })
        .filter(Boolean); // Remove nulls (assistant messages)
      
      console.log(`[IPC] Returning ${prompts.length} user prompts for panel ${panelId}`);
      return { success: true, data: prompts };
    } catch (error) {
      console.error('Failed to get panel prompts:', error);
      return { success: false, error: 'Failed to get panel prompts' };
    }
  });

  // Generic panel input handlers that route to specific panel type handlers
  ipcMain.handle('panels:send-input', async (_event, panelId: string, input: string) => {
    try {
      console.log(`[IPC] panels:send-input called for panel: ${panelId}`);

      // Validate panel exists
      const panelValidation = validatePanelExists(panelId);
      if (!panelValidation.valid) {
        logValidationFailure('panels:send-input', panelValidation);
        return createValidationError(panelValidation);
      }

      // Additional validation that the session is active
      const sessionValidation = validateSessionIsActive(panelValidation.sessionId!);
      if (!sessionValidation.valid) {
        logValidationFailure('panels:send-input session check', sessionValidation);
        return createValidationError(sessionValidation);
      }

      // Get the panel to determine its type
      const panel = panelManager.getPanel(panelId);
      if (!panel) {
        return { success: false, error: 'Panel not found' };
      }

      console.log(`[IPC] Validated panel ${panelId} belongs to session ${panel.sessionId}`);

      // Route to appropriate panel type handler
      switch (panel.type) {
        case 'claude':
          try {
            // PTY-backed panels (interactive Claude / Codex PTY) relay a PANEL-
            // SCOPED turn into THIS panel's own live REPL (or spawn a fresh one on
            // a dead REPL), keyed by the panel's own id. This is the composer's
            // per-panel path (⌃G) for a second/added PTY chat — the session-scoped
            // sessions:input always resolves the session's FIRST panel, which would
            // misroute an added panel's turn. relayOrSpawnPtyPanel returns false for
            // SDK / demo panels, which fall through to the structured SDK path.
            const ompResult = await routeOmpPanelTurn(panelId, input);
            if (ompResult !== null) return ompResult;
            const relayed = await relayOrSpawnPtyPanel(services, panel, input);
            if (relayed) return { success: true };
            // Save the user input as a conversation message for panel history
            if (input) {
              sessionManager.addPanelConversationMessage(panelId, 'user', input);
            }
            // Call Claude panel manager directly
            const { claudePanelManager } = require('./claudePanel');
            if (!claudePanelManager) {
              return { success: false, error: 'Claude panel manager not available' };
            }
            claudePanelManager.sendInputToPanel(panelId, input);
            return { success: true };
          } catch (err) {
            console.error('Failed to send input to Claude panel:', err);
            // Surface a provider-disabled refusal verbatim: it is user-authored copy
            // (and carries the code the composer parses into an "Open Settings →
            // Integrations" action), so collapsing it into the generic string below
            // would strand the user retrying with no stated reason.
            const disabled = agentProviderDisabledMessage(err);
            return { success: false, error: disabled ?? 'Failed to send input to Claude panel' };
          }
        case 'terminal':
          // Terminal panels don't have input handlers - they use runTerminalCommand
          return { success: false, error: 'Terminal panels use different input methods' };
        default:
          return { success: false, error: `Unsupported panel type: ${panel.type}` };
      }
    } catch (error) {
      console.error('Failed to send input to panel:', error);
      // Surface a provider-disabled refusal verbatim: it is user-authored copy
      // (and carries the code the composer parses into an "Open Settings →
      // Integrations" action), so collapsing it into the generic string below
      // would strand the user retrying with no stated reason.
      const disabled = agentProviderDisabledMessage(error);
      return { success: false, error: disabled ?? 'Failed to send input to panel' };
    }
  });

  ipcMain.handle('panels:continue', async (_event, panelId: string, input: string, model?: string, interrupt?: boolean, pendingId?: string) => {
    try {
      console.log(`[IPC] panels:continue called for panel: ${panelId}`);

      // Validate panel exists
      const panelValidation = validatePanelExists(panelId);
      if (!panelValidation.valid) {
        logValidationFailure('panels:continue', panelValidation);
        return createValidationError(panelValidation);
      }

      // Additional validation that the session is active
      const sessionValidation = validateSessionIsActive(panelValidation.sessionId!);
      if (!sessionValidation.valid) {
        logValidationFailure('panels:continue session check', sessionValidation);
        return createValidationError(sessionValidation);
      }

      // Get the panel to determine its type
      const panel = panelManager.getPanel(panelId);
      if (!panel) {
        return { success: false, error: 'Panel not found' };
      }

      console.log(`[IPC] Validated panel ${panelId} belongs to session ${panel.sessionId}`);

      // Route to appropriate panel type handler
      switch (panel.type) {
        case 'claude':
          try {
            // Structured non-Claude quick sessions ride the SAME 'claude'-typed
            // panel, but their turns run on that vendor's own transport, not
            // claudePanelManager. Give them the same mid-turn queue guard +
            // Interrupt & send affordances Claude gets (this is the panel-scoped
            // continue the composer routes them through — see
            // dispatchQuickSessionInput). isPanelRunning is exact for both: a
            // warm-parked entry is NOT in `processes`, so there is no warm-idle
            // false-positive (unlike Claude's isPanelTurnInFlight).
            const continueLane = laneForPanel(panel);
            const ompContinue = await routeOmpPanelTurn(panelId, input);
            if (ompContinue !== null) return ompContinue;
            // A non-Claude PTY lane relays a PANEL-SCOPED turn into this panel's
            // own REPL. claudePanelManager below reaches only the two CLAUDE
            // managers, so such a terminal panel — every panel of a codex-pty /
            // omp-pty session, and an interactive override on a structured one —
            // must be intercepted here or Claude would answer it. The
            // claude-interactive lane is left on claudePanelManager.continuePanel,
            // whose getCliManager already routes it correctly.
            const continuePtyLane = quickPtyLanes.get(continueLane);
            if (continuePtyLane) {
              const relayed = await relayOrSpawnPtyPanel(services, panel, input);
              if (relayed) return { success: true };
              return {
                success: false,
                error: `Could not reach the ${continuePtyLane.label} terminal for this chat`,
              };
            }
            const continueStructuredLane = structuredChatLanes.get(continueLane);
            if (continueStructuredLane) {
              const { manager, label } = continueStructuredLane;
              if (!manager) {
                return { success: false, error: `${label} SDK manager is not available` };
              }
              const laneRunning = manager.isPanelRunning(panelId);
              // Mid-turn (not interrupt): buffer + deliver at the turn's rest
              // boundary (via the manager's 'exit' → the lane's idle flush),
              // exactly like the Claude queue guard. Returns queued so the composer
              // flips its optimistic 'sending' row to the addressable 'queued' state
              // instead of surfacing the old "still processing" failure.
              if (laneRunning && !interrupt) {
                console.log(`[IPC] panels:continue mid-turn (${continueLane}) for panel ${panelId} — queueing at the rest boundary`);
                continueStructuredLane.enqueue(panelId, pendingId ?? randomUUID(), input);
                return { success: true, data: { queued: true } };
              }
              // Interrupt & send: abort the live turn, then enqueue the message.
              // The abort's 'exit' fires the lane's idle flush, which drives the
              // queued message as a fresh (resumed) turn — so the deliver is
              // race-free even if teardown outlives stopPanel here.
              if (laneRunning && interrupt) {
                console.log(`[IPC] panels:continue interrupt (${continueLane}) for panel ${panelId} — aborting the in-flight turn first`);
                await manager.stopPanel(panelId);
                continueStructuredLane.enqueue(panelId, pendingId ?? randomUUID(), input);
                return { success: true };
              }
              // Idle: start the turn now (startTurn resumes the conversation via
              // the persisted external session id).
              await continueStructuredLane.startTurn(panelId, input);
              return { success: true };
            }

            const { claudePanelManager } = require('./claudePanel');
            if (!claudePanelManager) {
              return { success: false, error: 'Claude panel manager not available' };
            }

            // Get session to retrieve worktreePath and determine resume behavior
            const session = await sessionManager.getSession(panel.sessionId);
            if (!session) {
              return { success: false, error: 'Session not found' };
            }

            // Mid-turn guard: when a logical turn is IN FLIGHT (including a turn
            // PARKED at an AskUserQuestion gate), continuePanel would either
            // destructively abort it or — when the turn was itself started by a
            // continue — starve for 30s on the `claude-continue-<panelId>` lock
            // that the parked turn holds, and fail. Route the text into the
            // panel input queue instead (delivered as the next continuation at
            // the turn's rest boundary — same path the composer's running-state
            // send uses). The queue deliverer persists the user turn on
            // delivery, so do NOT addPanelConversationMessage here.
            //
            // `interrupt` OPTS OUT of the guard: the "Interrupt & send" affordance
            // wants exactly continuePanel's native abort-the-in-flight-turn-then-
            // continue behavior (it acquires the lock, aborts the live turn, waits
            // for it to settle, then drives the new turn). Falling through here is
            // safe because that turn is ABORTED (not lock-held) once continuePanel
            // runs, so the mutex is released rather than starved.
            if (
              !interrupt &&
              input &&
              claudeCodeManager instanceof ClaudeCodeManager &&
              claudeCodeManager.isPanelTurnInFlight(panelId)
            ) {
              console.log(`[IPC] panels:continue mid-turn for panel ${panelId} — queueing at the rest boundary`);
              // Key the queue entry by the CLIENT pending-send id when supplied, so
              // the displayed 'queued' row can dequeue this exact server entry
              // (click-to-reopen); fall back to a fresh id for id-less callers.
              claudeCodeManager.enqueuePanelInput(panelId, pendingId ?? randomUUID(), input);
              // Race guard: the turn may have ended between the probe and the
              // enqueue — deliver now instead of stranding the message.
              claudeCodeManager.flushPanelInputQueueIfIdle(panelId);
              return { success: true, data: { queued: true } };
            }

            // Interrupt & send: abort the in-flight turn BEFORE continuePanel runs.
            // continuePanel wraps its whole turn (incl. the warm dispatch's await)
            // in the `claude-continue-<panelId>` lock, so its OWN abort-then-continue
            // would first block on that lock — held by the turn it means to abort —
            // and 30s-timeout. abortInFlightTurn aborts OUTSIDE the lock, releasing
            // it; continuePanel below then sees no turn in flight and drives the new
            // one immediately. No-op when already idle.
            if (
              interrupt &&
              claudeCodeManager instanceof ClaudeCodeManager &&
              claudeCodeManager.isPanelTurnInFlight(panelId)
            ) {
              console.log(`[IPC] panels:continue interrupt for panel ${panelId} — aborting the in-flight turn first`);
              await claudeCodeManager.abortInFlightTurn(panelId);
            }

            // Save the user input as a conversation message
            if (input) {
              sessionManager.addPanelConversationMessage(panelId, 'user', input);
            }

            // Per-panel fast-mode persisted at quick-session launch (wizard toggle)
            // or by the in-composer FastModePill — panels:continue respawns the SDK
            // process per turn, so read the persisted choice and thread it on every
            // respawn exactly like sessions:input does; otherwise fast mode silently
            // reverts to standard speed the moment a turn routes through this path.
            const panelSettings = databaseService.getPanelSettings(panelId);
            const panelFastMode = panelSettings?.fastMode === true;
            // Per-panel reasoning-effort persisted at quick-session launch (wizard
            // select) or by the in-composer EffortPill — mirrors panelFastMode
            // above: panels:continue respawns per turn, so re-thread the persisted
            // choice on every respawn or it silently reverts to the provider default.
            const rawContinueEffort = panelSettings?.reasoningEffort;
            const panelReasoningEffort = isAnyEffortLevel(rawContinueEffort) ? rawContinueEffort : undefined;

            // If there's no running process and no Claude session id yet, this is likely the first message.
            // Start fresh (no --resume) so the user can begin a new conversation.
            const isRunning = claudePanelManager.isPanelRunning(panelId);
            const hasClaudeSessionId = !!sessionManager.getPanelClaudeSessionId(panelId);

            if (!isRunning && !hasClaudeSessionId) {
              console.log('[IPC] panels:continue starting fresh via startPanel (no running process, no claude_session_id)');
              const dbSession = sessionManager.getDbSession(panel.sessionId);
              // Model is now managed at panel level in Claude panel settings
              await claudePanelManager.startPanel(
                panelId,
                session.worktreePath,
                input || '',
                dbSession?.permission_mode,
                model,
                panelFastMode,
                panelReasoningEffort
              );
              return { success: true };
            }

            // Otherwise continue; ClaudeCodeManager enforces strict --resume behavior
            const conversationHistory = sessionManager.getPanelConversationMessages
              ? await sessionManager.getPanelConversationMessages(panelId)
              : await sessionManager.getConversationMessages(panel.sessionId);

            // Model is now managed at panel level in Claude panel settings
            await claudePanelManager.continuePanel(
              panelId,
              session.worktreePath,
              input || '',
              conversationHistory,
              model,
              panelFastMode,
              panelReasoningEffort
            );
            return { success: true };
          } catch (err) {
            console.error('Failed to continue Claude panel:', err);
            // Surface a provider-disabled refusal verbatim: it is user-authored copy
            // (and carries the code the composer parses into an "Open Settings →
            // Integrations" action), so collapsing it into the generic string below
            // would strand the user retrying with no stated reason.
            const disabled = agentProviderDisabledMessage(err);
            return { success: false, error: disabled ?? 'Failed to continue Claude panel' };
          }
        default:
          return { success: false, error: `Panel type ${panel.type} does not support continue operation` };
      }
    } catch (error) {
      console.error('Failed to continue panel conversation:', error);
      // Surface a provider-disabled refusal verbatim: it is user-authored copy
      // (and carries the code the composer parses into an "Open Settings →
      // Integrations" action), so collapsing it into the generic string below
      // would strand the user retrying with no stated reason.
      const disabled = agentProviderDisabledMessage(error);
      return { success: false, error: disabled ?? 'Failed to continue panel conversation' };
    }
  });

  // ---------------------------------------------------------------------------
  // Mid-turn input queue ("always allow messaging a running quick session").
  // A message sent while a quick-session SDK turn is RUNNING is buffered on the
  // ClaudeCodeManager and delivered as ONE combined continuation at the turn's
  // rest boundary (see setPanelInputDeliverer above + runSdkQuery's drain call) —
  // no destructive mid-turn abort. `id` is the client pending-send id so a later
  // panels:dequeue-input (click-to-reopen) targets the exact entry.
  // ---------------------------------------------------------------------------
  ipcMain.handle('panels:queue-input', async (_event, panelId: string, id: string, text: string) => {
    try {
      const panelValidation = validatePanelExists(panelId);
      if (!panelValidation.valid) {
        logValidationFailure('panels:queue-input', panelValidation);
        return createValidationError(panelValidation);
      }
      if (typeof text !== 'string' || text.trim() === '') {
        return { success: false, error: 'Nothing to queue' };
      }
      const panel = panelManager.getPanel(panelId);
      const queueLane = structuredChatLaneForPanel(panel);
      if (queueLane) {
        queueLane.enqueue(panelId, id, text);
        return { success: true, data: { queued: true } };
      }
      if (!(claudeCodeManager instanceof ClaudeCodeManager)) {
        return { success: false, error: 'Queue not supported on this CLI manager' };
      }
      claudeCodeManager.enqueuePanelInput(panelId, id, text);
      // Race guard: if the turn already ended before this landed, deliver now
      // instead of stranding the message until the next (never-coming) rest point.
      claudeCodeManager.flushPanelInputQueueIfIdle(panelId);
      return { success: true, data: { queued: true } };
    } catch (error) {
      console.error('Failed to queue panel input:', error);
      // Surface a provider-disabled refusal verbatim: it is user-authored copy
      // (and carries the code the composer parses into an "Open Settings →
      // Integrations" action), so collapsing it into the generic string below
      // would strand the user retrying with no stated reason.
      const disabled = agentProviderDisabledMessage(error);
      return { success: false, error: disabled ?? 'Failed to queue panel input' };
    }
  });

  ipcMain.handle('panels:list-queued-input', async (_event, panelId: string) => {
    try {
      const panel = panelManager.getPanel(panelId);
      const listLane = structuredChatLaneForPanel(panel);
      if (listLane) {
        return { success: true, data: listLane.listQueued(panelId) };
      }
      if (!(claudeCodeManager instanceof ClaudeCodeManager)) {
        return { success: true, data: [] };
      }
      return { success: true, data: claudeCodeManager.listPanelInputQueue(panelId) };
    } catch (error) {
      console.error('Failed to list queued panel input:', error);
      return { success: false, error: 'Failed to list queued panel input' };
    }
  });

  ipcMain.handle('panels:dequeue-input', async (_event, panelId: string, id: string) => {
    try {
      const panel = panelManager.getPanel(panelId);
      const dequeueLane = structuredChatLaneForPanel(panel);
      if (dequeueLane) {
        return { success: true, data: { dequeued: dequeueLane.dequeue(panelId, id) } };
      }
      if (!(claudeCodeManager instanceof ClaudeCodeManager)) {
        return { success: false, error: 'Queue not supported on this CLI manager' };
      }
      const removed = claudeCodeManager.dequeuePanelInput(panelId, id);
      return { success: true, data: { dequeued: removed } };
    } catch (error) {
      console.error('Failed to dequeue panel input:', error);
      return { success: false, error: 'Failed to dequeue panel input' };
    }
  });

  ipcMain.handle('sessions:generate-compacted-context', async (_event, sessionId: string) => {
    try {
      console.log('[IPC] sessions:generate-compacted-context called for sessionId:', sessionId);
      
      // Get all the data we need for compaction
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      // Get the database session for the compactor (it expects the database model)
      const dbSession = databaseService.getSession(sessionId);
      if (!dbSession) {
        return { success: false, error: 'Session not found in database' };
      }

      // MIGRATION FIX: Use panel-based data retrieval if session has Claude panels
      const compactPanels = panelManager.getPanelsForSession(sessionId);
      const compactClaudePanels = compactPanels.filter(p => p.type === 'claude');
      
      let conversationMessages, promptMarkers, executionDiffs, sessionOutputs;
      
      if (compactClaudePanels.length > 0) {
        // Use panel-based methods for migrated sessions
        const claudePanel = compactClaudePanels[0];
        console.log(`[IPC] Using panel-based data retrieval for context compaction, session ${sessionId} with Claude panel ${claudePanel.id}`);
        
        conversationMessages = sessionManager.getPanelConversationMessages ? 
          await sessionManager.getPanelConversationMessages(claudePanel.id) :
          await sessionManager.getConversationMessages(sessionId);
          
        promptMarkers = databaseService.getPanelPromptMarkers ? 
          databaseService.getPanelPromptMarkers(claudePanel.id) :
          databaseService.getPromptMarkers(sessionId);
          
        executionDiffs = databaseService.getPanelExecutionDiffs ? 
          databaseService.getPanelExecutionDiffs(claudePanel.id) :
          databaseService.getExecutionDiffs(sessionId);
          
        sessionOutputs = sessionManager.getPanelOutputs ? 
          await sessionManager.getPanelOutputs(claudePanel.id) :
          await sessionManager.getSessionOutputs(sessionId);
      } else {
        // Use session-based methods for non-migrated sessions
        conversationMessages = await sessionManager.getConversationMessages(sessionId);
        promptMarkers = databaseService.getPromptMarkers(sessionId);
        executionDiffs = databaseService.getExecutionDiffs(sessionId);
        sessionOutputs = await sessionManager.getSessionOutputs(sessionId);
      }
      
      // Import the compactor utility
      const { ProgrammaticCompactor } = await import('../utils/contextCompactor');
      const compactor = new ProgrammaticCompactor(databaseService);
      
      // Generate the compacted summary
      const summary = await compactor.generateSummary(sessionId, {
        session: dbSession,
        conversationMessages,
        promptMarkers,
        executionDiffs,
        sessionOutputs: sessionOutputs
      });
      
      // Set flag to skip --resume on the next execution
      console.log('[IPC] Setting skip_continue_next flag to true for session:', sessionId);
      await sessionManager.updateSession(sessionId, { skip_continue_next: true });
      
      // Verify the flag was set
      const updatedSession = databaseService.getSession(sessionId);
      console.log('[IPC] Verified skip_continue_next flag after update:', {
        raw_value: updatedSession?.skip_continue_next,
        type: typeof updatedSession?.skip_continue_next,
        is_truthy: !!updatedSession?.skip_continue_next
      });
      console.log('[IPC] Generated compacted context summary and set skip_continue_next flag');
      
      // Add a system message to the session outputs so it appears in rich output view
      const contextCompactionMessage = {
        type: 'system',
        subtype: 'context_compacted',
        timestamp: new Date().toISOString(),
        summary: summary,
        message: 'Context has been compacted. You can continue chatting - your next message will automatically include the context summary above.'
      };
      
      await sessionManager.addSessionOutput(sessionId, {
        type: 'json',
        data: contextCompactionMessage,
        timestamp: new Date()
      });
      
      return { success: true, data: { summary } };
    } catch (error) {
      console.error('Failed to generate compacted context:', error);
      return { success: false, error: 'Failed to generate compacted context' };
    }
  });

  ipcMain.handle('sessions:mark-viewed', async (_event, sessionId: string) => {
    try {
      await sessionManager.markSessionAsViewed(sessionId);
      return { success: true };
    } catch (error) {
      console.error('Failed to mark session as viewed:', error);
      return { success: false, error: 'Failed to mark session as viewed' };
    }
  });

  // Live quick-session status board (replaces the old idle-session review_item
  // mint). Derives each quick session's state on read: `blocked` when its chat
  // run has a pending AskUserQuestion / permission gate (SDK gates via the
  // Question/Approval routers; PTY gates via the interactive manager's
  // awaiting-input flag), else `running`/`idle` from the DB status. `projectId`
  // scopes to one project; omit for the cross-project review home.
  ipcMain.handle('sessions:list-quick', async (_event, projectId?: number) => {
    try {
      const blockedRunIds = new Set<string>();
      for (const q of QuestionRouter.getInstance().getPending()) blockedRunIds.add(q.runId);
      for (const a of ApprovalRouter.getInstance().getPending()) blockedRunIds.add(a.runId);
      for (const runId of interactiveCliManager.getAwaitingInputRunIds()) blockedRunIds.add(runId);

      const rows = listQuickSessions(
        makeDatabaseLike(databaseService),
        blockedRunIds,
        typeof projectId === 'number' ? projectId : undefined,
      );
      return { success: true, data: rows };
    } catch (error) {
      console.error('Failed to list quick sessions:', error);
      return { success: false, error: 'Failed to list quick sessions' };
    }
  });

  ipcMain.handle('sessions:stop', async (_event, sessionId: string) => {
    try {
      const dbSession = databaseService.getSession(sessionId);
      if (!dbSession) {
        return { success: false, error: 'Session not found' };
      }

      // Settle any pending human gates on the session's gate run FIRST (Stop is
      // a user cancel — the gate dies with the turn, preserveGates=false). A
      // turn parked inside the AskUserQuestion PreToolUse hook is blocked on
      // the QuestionRouter promise; resolving it here unparks the hook so the
      // abort below can never hang on it, and guarantees the gate cannot
      // outlive the stop even if teardown stalls. Idempotent with the SDK
      // query's own finally-block clear (guarded UPDATEs, no-op when empty).
      const gateRunId = dbSession.chat_run_id ?? dbSession.run_id;
      if (gateRunId) {
        try {
          QuestionRouter.getInstance().clearPendingForRun(gateRunId);
          ApprovalRouter.getInstance().clearPendingForRun(gateRunId);
        } catch (gateErr) {
          console.warn('[IPC] sessions:stop gate settlement failed (fail-soft):', gateErr);
        }
      }

      // Agent panels retain the legacy `claude` panel type. Dispatch by the
      // session runtime so Stop reaches the process that actually owns them.
      const stopPanels = panelManager.getPanelsForSession(sessionId);
      const stopClaudePanels = stopPanels.filter(p => p.type === 'claude');
      
      if (stopClaudePanels.length > 0) {
        // Stop all Claude panels for this session
        console.log(`[IPC] Stopping ${stopClaudePanels.length} agent panel(s) for session ${sessionId}`);
        for (const claudePanel of stopClaudePanels) {
          if (dbSession.agent_runtime === 'omp-fleet') {
            // OMP panels are 'claude'-typed but owned by the remote-worker
            // manager — resolvePanelLane would map them to the claude-sdk lane
            // and claudeCodeManager.stopPanel would stop a non-existent child.
            await ompSessionManager?.stopPanel(claudePanel.id);
            continue;
          }
          // Per-PANEL lane — see the dismiss teardown above. claudeCodeManager
          // covers both Claude lanes here (its stopPanel is the session-level
          // Stop that predates the interactive split).
          const stopOwner = laneStopOwner(resolvePanelLane(dbSession, claudePanel));
          await (stopOwner ?? claudeCodeManager).stopPanel(claudePanel.id);
        }
      } else {
        // Fallback to session-based stop
        console.log(`[IPC] No Claude panels found, stopping session ${sessionId} directly`);
        await claudeCodeManager.stopSession(sessionId);
      }

      const timestamp = new Date();
      const cancellationMessage = {
        type: 'session',
        data: {
          status: 'cancelled',
          message: 'Cancelled by user',
          source: 'user'
        }
      };

      try {
        if (stopClaudePanels.length > 0 && sessionManager.addPanelOutput) {
          for (const claudePanel of stopClaudePanels) {
            sessionManager.addPanelOutput(claudePanel.id, {
              type: 'json',
              data: cancellationMessage,
              timestamp
            });

            const payload = {
              panelId: claudePanel.id,
              sessionId,
              type: 'json' as const,
              data: cancellationMessage,
              timestamp
            };

            sessionManager.emit('session-output', payload);
          }
        } else {
          sessionManager.addSessionOutput(sessionId, {
            type: 'json',
            data: cancellationMessage,
            timestamp
          });
        }
      } catch (loggingError) {
        console.warn('[IPC] Failed to record cancellation message for session stop:', loggingError);
      }

      sessionManager.stopSession(sessionId);
      
      return { success: true };
    } catch (error) {
      console.error('Failed to stop session:', error);
      return { success: false, error: 'Failed to stop session' };
    }
  });

  ipcMain.handle('sessions:rename', async (_event, sessionId: string, newName: string) => {
    try {
      // Update the session name in the database
      const updatedSession = databaseService.updateSession(sessionId, { name: newName });
      if (!updatedSession) {
        return { success: false, error: 'Session not found' };
      }

      // Emit update event so frontend gets notified
      const session = sessionManager.getSession(sessionId);
      if (session) {
        session.name = newName;
        sessionManager.emit('session-updated', session);
      }

      return { success: true, data: updatedSession };
    } catch (error) {
      console.error('Failed to rename session:', error);
      return { success: false, error: 'Failed to rename session' };
    }
  });

  ipcMain.handle('sessions:toggle-favorite', async (_event, sessionId: string) => {
    try {
      console.log('[IPC] sessions:toggle-favorite called for sessionId:', sessionId);
      
      // Get current session to check current favorite status
      const currentSession = databaseService.getSession(sessionId);
      if (!currentSession) {
        console.error('[IPC] Session not found in database:', sessionId);
        return { success: false, error: 'Session not found' };
      }
      
      console.log('[IPC] Current session favorite status:', currentSession.is_favorite);

      // Toggle the favorite status
      const newFavoriteStatus = !currentSession.is_favorite;
      console.log('[IPC] Toggling favorite status to:', newFavoriteStatus);
      
      const updatedSession = databaseService.updateSession(sessionId, { is_favorite: newFavoriteStatus });
      if (!updatedSession) {
        console.error('[IPC] Failed to update session in database');
        return { success: false, error: 'Failed to update session' };
      }
      
      console.log('[IPC] Database updated successfully. Updated session:', updatedSession.is_favorite);

      // Emit update event so frontend gets notified
      const session = sessionManager.getSession(sessionId);
      if (session) {
        session.isFavorite = newFavoriteStatus;
        console.log('[IPC] Emitting session-updated event with favorite status:', session.isFavorite);
        sessionManager.emit('session-updated', session);
      } else {
        console.warn('[IPC] Session not found in session manager:', sessionId);
      }

      return { success: true, data: { isFavorite: newFavoriteStatus } };
    } catch (error) {
      console.error('Failed to toggle favorite status:', error);
      if (error instanceof Error) {
        console.error('Error stack:', error.stack);
      }
      return { success: false, error: 'Failed to toggle favorite status' };
    }
  });

  // Update the per-session agent permission mode (4-mode) mid-session — driven by
  // the composer permission pill. resolveSessionAgentPermissionMode re-reads
  // sessions.agent_permission_mode on each SDK spawn, so the change takes effect
  // on the next turn (no respawn). Mirrors sessions:toggle-favorite for the
  // persist + runtime-session mutate + 'session-updated' emit.
  ipcMain.handle('sessions:update-agent-permission-mode', async (_event, sessionId: string, mode: PermissionMode) => {
    try {
      if (!isPermissionMode(mode)) {
        return { success: false, error: `Invalid agent permission mode: ${String(mode)}` };
      }
      // Funnel through the single session-mode write chokepoint (permission-mode
      // redesign §3d): persist + runtime mutate + 'session-updated' emit.
      // cyboflow.runs.setPermissionMode + RunLauncher.launch share the SAME
      // chokepoint so every mode write lands identically on the session. The
      // interactive substrate needs no spawn-side priming — the PTY gating hook
      // rides the inline `--settings` flag and is recomputed from the persisted
      // mode at every spawn.
      const result = updateSessionAgentPermissionMode(
        {
          databaseService,
          sessionManager,
        },
        sessionId,
        mode,
      );
      if (!result.ok) {
        return { success: false, error: 'Session not found' };
      }

      return { success: true };
    } catch (error) {
      console.error('Failed to update agent permission mode:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update agent permission mode',
      };
    }
  });

  // Per-session MCP DENY list (migration 037). Persists the disabled-server set
  // to sessions.disabled_mcp_servers_json; claudeCodeManager.resolveSessionDisabledMcps
  // re-reads the column on each SDK spawn so the change applies on the next turn
  // (no respawn). Mirrors sessions:update-agent-permission-mode: persist + mutate
  // the runtime session + 'session-updated' emit. An empty [] is byte-identical
  // to the prior all-servers-load default.
  ipcMain.handle('sessions:update-session-mcps', async (_event, sessionId: string, disabledMcpServers: string[]) => {
    try {
      if (!Array.isArray(disabledMcpServers) || !disabledMcpServers.every((m) => typeof m === 'string')) {
        return { success: false, error: 'Invalid MCP selection' };
      }
      const updated = databaseService.updateSession(sessionId, {
        disabled_mcp_servers_json: JSON.stringify(disabledMcpServers),
      });
      if (!updated) {
        return { success: false, error: 'Session not found' };
      }
      const session = sessionManager.getSession(sessionId);
      if (session) {
        session.disabledMcpServers = disabledMcpServers;
        sessionManager.emit('session-updated', session);
      }
      return { success: true };
    } catch (error) {
      console.error('Failed to update session MCPs:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update session MCPs',
      };
    }
  });

  // Per-session plugin ALLOW list (migration 037). Persists the force-enabled
  // plugin-id set to sessions.enabled_plugins_json; resolveSessionEnabledPlugins
  // re-reads it on each SDK spawn (next-turn apply). Same persist + runtime mirror
  // + emit shape; an empty [] inherits the user's file plugins (byte-identical).
  ipcMain.handle('sessions:update-session-plugins', async (_event, sessionId: string, enabledPlugins: string[]) => {
    try {
      if (!Array.isArray(enabledPlugins) || !enabledPlugins.every((p) => typeof p === 'string')) {
        return { success: false, error: 'Invalid plugin selection' };
      }
      const updated = databaseService.updateSession(sessionId, {
        enabled_plugins_json: JSON.stringify(enabledPlugins),
      });
      if (!updated) {
        return { success: false, error: 'Session not found' };
      }
      const session = sessionManager.getSession(sessionId);
      if (session) {
        session.enabledPlugins = enabledPlugins;
        sessionManager.emit('session-updated', session);
      }
      return { success: true };
    } catch (error) {
      console.error('Failed to update session plugins:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update session plugins',
      };
    }
  });

  ipcMain.handle('sessions:reorder', async (_event, sessionOrders: Array<{ id: string; displayOrder: number }>) => {
    try {
      databaseService.reorderSessions(sessionOrders);
      return { success: true };
    } catch (error) {
      console.error('Failed to reorder sessions:', error);
      return { success: false, error: 'Failed to reorder sessions' };
    }
  });

  // Save images for a session
  ipcMain.handle('sessions:save-images', async (_event, sessionId: string, images: Array<{ name: string; dataUrl: string; type: string }>) => {
    try {
      // For pending sessions (those created before the actual session), we still need to save the files
      // Check if this is a pending session ID (starts with 'pending_')
      const isPendingSession = sessionId.startsWith('pending_');
      
      if (!isPendingSession) {
        // For real sessions, verify it exists
        const session = await sessionManager.getSession(sessionId);
        if (!session) {
          throw new Error('Session not found');
        }
      }

      // Create images directory in CYBOFLOW_DIR/artifacts/{sessionId}
      const imagesDir = getCyboflowSubdirectory('artifacts', sessionId);
      if (!existsSync(imagesDir)) {
        await fs.mkdir(imagesDir, { recursive: true });
      }

      const savedPaths: string[] = [];
      
      for (const image of images) {
        // Generate unique filename
        const timestamp = Date.now();
        const randomStr = Math.random().toString(36).substring(2, 9);
        const extension = image.type.split('/')[1] || 'png';
        const filename = `${timestamp}_${randomStr}.${extension}`;
        const filePath = path.join(imagesDir, filename);

        // Extract base64 data
        const base64Data = image.dataUrl.split(',')[1];
        const buffer = Buffer.from(base64Data, 'base64');

        // Save the image
        await fs.writeFile(filePath, buffer);
        
        // Return the absolute path that Claude Code can access
        savedPaths.push(filePath);
      }

      return savedPaths;
    } catch (error) {
      console.error('Failed to save images:', error);
      throw error;
    }
  });

  // Save large text for a session
  ipcMain.handle('sessions:save-large-text', async (_event, sessionId: string, text: string) => {
    try {
      // For pending sessions (those created before the actual session), we still need to save the files
      // Check if this is a pending session ID (starts with 'pending_')
      const isPendingSession = sessionId.startsWith('pending_');
      
      if (!isPendingSession) {
        // For real sessions, verify it exists
        const session = await sessionManager.getSession(sessionId);
        if (!session) {
          throw new Error('Session not found');
        }
      }

      // Create text directory in CYBOFLOW_DIR/artifacts/{sessionId}
      const textDir = getCyboflowSubdirectory('artifacts', sessionId);
      if (!existsSync(textDir)) {
        await fs.mkdir(textDir, { recursive: true });
      }

      // Generate unique filename
      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(2, 9);
      const filename = `text_${timestamp}_${randomStr}.txt`;
      const filePath = path.join(textDir, filename);

      // Save the text content
      await fs.writeFile(filePath, text, 'utf8');
      
      console.log(`[Large Text] Saved ${text.length} characters to ${filePath}`);
      
      // Return the absolute path that Claude Code can access
      return filePath;
    } catch (error) {
      console.error('Failed to save large text:', error);
      throw error;
    }
  });

  // Restore functionality removed - worktrees are deleted on archive so restore doesn't make sense

  // Debug handler to check table structure
  ipcMain.handle('debug:get-table-structure', async (_event, tableName: 'folders' | 'sessions') => {
    try {
      const structure = databaseService.getTableStructure(tableName);
      return { success: true, data: structure };
    } catch (error) {
      console.error('Failed to get table structure:', error);
      return { success: false, error: 'Failed to get table structure' };
    }
  });

  // Archive progress handler
  ipcMain.handle('archive:get-progress', async () => {
    try {
      if (!archiveProgressManager) {
        return { success: true, data: { tasks: [], activeCount: 0, totalCount: 0 } };
      }
      
      const tasks = archiveProgressManager.getActiveTasks();
      const activeCount = tasks.filter((t: SerializedArchiveTask) => 
        t.status !== 'completed' && t.status !== 'failed'
      ).length;
      
      return { 
        success: true, 
        data: { 
          tasks, 
          activeCount, 
          totalCount: tasks.length 
        } 
      };
    } catch (error) {
      console.error('Failed to get archive progress:', error);
      return { success: false, error: 'Failed to get archive progress' };
    }
  });

  // Session statistics handler
  ipcMain.handle('sessions:get-statistics', async (_event, sessionId: string) => {
    try {
      console.log('[IPC] sessions:get-statistics called for sessionId:', sessionId);
      
      // Get session details
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      // Resolve the LIVE worktree branch once per session (worktree-level,
      // not per-panel) — falls back to the stored baseBranch only when the
      // worktree is unreadable or in a detached HEAD state (getCurrentBranch
      // returns null). baseBranch itself is untouched below.
      const liveBranch = getCurrentBranch(session.worktreePath);
      const resolvedBranch = liveBranch ?? (session.baseBranch || 'main');

      // Calculate session duration
      const startTime = new Date(session.createdAt).getTime();
      const endTime = session.status === 'stopped' || session.status === 'completed_unviewed'
        ? (session.lastActivity ? new Date(session.lastActivity).getTime() : Date.now())
        : Date.now();
      const duration = endTime - startTime;

      // Get token usage from session_outputs with type 'json'
      const tokenUsageData = databaseService.getSessionTokenUsage(sessionId);

      // Whole-session totals ALSO include any workflow runs hosted by this
      // session (run_usage / raw_events) — a pipeline disjoint from the
      // quick-chat session_outputs that getSessionTokenUsage sums, so the two
      // never overlap. Zero-cost for a session with no hosted runs.
      const runTokenTotals = selectSessionRunTokenTotals(databaseService.getDb(), sessionId);

      // Get execution diff stats for file changes — narrow projection, no
      // git_diff blobs (this poll only ever reads the stats_* / files_changed
      // columns; see getExecutionDiffStats).
      const executionDiffs = databaseService.getExecutionDiffStats(sessionId);
      
      // File statistics come from GIT — the worktree diffed against the commit
      // the session branched from — because execution_diffs only gets a row when
      // the agent PROCESS EXITS: a warm-SDK / PTY quick session holds one process
      // across every turn and therefore has NO rows however much it edits, and a
      // session that commits its work has rows that each read zero. See
      // ipc/sessionFileStats.ts for the full rationale.
      const gitFileStats = await computeSessionFileStats({
        worktreePath: session.worktreePath,
        baseCommit: session.baseCommit,
        // Only consulted when the recorded branch point no longer resolves —
        // which is the normal case for a main-repo session, since those are
        // created without a base_commit.
        resolveFallbackRef: async () => {
          try {
            const project = sessionManager.getProjectForSession(sessionId);
            if (!project?.path) return null;
            const mainBranch = await worktreeManager.getProjectMainBranch(project.path);
            // A main-repo session works ON the main branch, so comparing against
            // that branch is comparing HEAD to itself: its own commits advance
            // the ref and vanish from the count. Compare against the remote tip
            // instead — the same ref getSessionCommitHistory uses for the Diff
            // tab, so card and panel keep agreeing.
            if (!session.isMainRepo) return mainBranch;
            return (
              (await worktreeManager.getOriginBranch(session.worktreePath, mainBranch)) ?? mainBranch
            );
          } catch {
            return null;
          }
        },
        gitDiffManager,
        logger: services.logger,
      });

      // Fallback for a session git can no longer answer for (archived / removed
      // worktree, gc'd base commit): the historical execution_diffs aggregation,
      // which dedups cumulative working-directory-diff rows (commit-disabled
      // turns) so totals aren't multiplied by the number of uncommitted turns
      // (TASK-086). See aggregateExecutionDiffTotals.
      const fileStats: SessionFileStats = gitFileStats ?? (() => {
        const totals = aggregateExecutionDiffTotals(executionDiffs);
        return {
          totalFilesChanged: totals.filesModified.size,
          totalLinesAdded: totals.totalLinesAdded,
          totalLinesDeleted: totals.totalLinesDeleted,
          filesModified: Array.from(totals.filesModified),
        };
      })();

      // MIGRATION FIX: Get prompt count and messages using appropriate method
      const statsPanels = panelManager.getPanelsForSession(sessionId);
      const statsClaudePanels = statsPanels.filter(p => p.type === 'claude');
      
      let promptMarkers, messageCount;
      if (statsClaudePanels.length > 0) {
        // Use panel-based methods for migrated sessions
        const claudePanel = statsClaudePanels[0];
        console.log(`[IPC] Using panel-based prompt/message counts for session ${sessionId} with Claude panel ${claudePanel.id}`);
        
        promptMarkers = databaseService.getPanelPromptMarkers ? 
          databaseService.getPanelPromptMarkers(claudePanel.id) :
          databaseService.getPromptMarkers(sessionId);
          
        messageCount = databaseService.getPanelConversationMessageCount ? 
          databaseService.getPanelConversationMessageCount(claudePanel.id) :
          databaseService.getConversationMessageCount(sessionId);
      } else {
        // Use session-based methods for non-migrated sessions
        promptMarkers = databaseService.getPromptMarkers(sessionId);
        messageCount = databaseService.getConversationMessageCount(sessionId);
      }
      
      // Resolve the session's model from its Claude panel SETTINGS (model is
      // managed at panel level, not on the session row — stored in
      // tool_panels.settings JSON, not state.customState). Used by the live
      // session meter to price token usage. The value is the picker alias
      // ('opus' / 'sonnet' / 'haiku' / 'auto') or a concrete id; ratesForModel
      // resolves families by substring, and the frontend defaults a missing /
      // 'auto' model to the quick-session default. Null when no setting exists.
      const statsPanelModel = ((): string | null => {
        const p = statsClaudePanels[0];
        if (!p) return null;
        const m = databaseService.getPanelSettings(p.id).model;
        return typeof m === 'string' && m.length > 0 ? m : null;
      })();

      // Get session outputs count by type
      const outputCounts = databaseService.getSessionOutputCounts(sessionId);
      
      // Get tool usage statistics
      const toolUsage = databaseService.getSessionToolUsage(sessionId);

      const statistics = {
        session: {
          id: session.id,
          name: session.name,
          status: session.status,
          // Model is managed at panel level; surfaced here for the session meter.
          model: statsPanelModel,
          createdAt: session.createdAt,
          updatedAt: session.lastActivity || session.createdAt,
          duration: duration,
          worktreePath: session.worktreePath,
          // Live worktree branch (resolved once above), falling back to
          // baseBranch only on detached HEAD / unreadable worktree.
          branch: resolvedBranch
        },
        tokens: {
          totalInputTokens: tokenUsageData.totalInputTokens,
          totalOutputTokens: tokenUsageData.totalOutputTokens,
          totalCacheReadTokens: tokenUsageData.totalCacheReadTokens,
          totalCacheCreationTokens: tokenUsageData.totalCacheCreationTokens,
          messageCount: tokenUsageData.messageCount,
          // Workflow-run tokens hosted by this session (additive, disjoint from
          // the session_outputs totals above). Consumers that want a
          // whole-session figure SUM the chat + run fields per category.
          runInputTokens: runTokenTotals.runInputTokens,
          runOutputTokens: runTokenTotals.runOutputTokens,
          runCacheReadTokens: runTokenTotals.runCacheReadTokens,
          runCacheCreationTokens: runTokenTotals.runCacheCreationTokens
        },
        files: {
          totalFilesChanged: fileStats.totalFilesChanged,
          totalLinesAdded: fileStats.totalLinesAdded,
          totalLinesDeleted: fileStats.totalLinesDeleted,
          filesModified: fileStats.filesModified,
          // Turns whose agent process exited — still an execution_diffs count,
          // which is exactly what it measures.
          executionCount: executionDiffs.length
        },
        activity: {
          promptCount: promptMarkers.length,
          messageCount: messageCount,
          outputCounts: outputCounts,
          lastActivity: session.lastActivity || session.createdAt
        },
        toolUsage: {
          tools: toolUsage.tools,
          totalToolCalls: toolUsage.totalToolCalls
        }
      };

      return { success: true, data: statistics };
    } catch (error) {
      console.error('Failed to get session statistics:', error);
      return { success: false, error: 'Failed to get session statistics' };
    }
  });

  // Set active session for smart git status polling
  ipcMain.handle('sessions:set-active-session', async (event, sessionId: string | null) => {
    try {
      // Notify GitStatusManager about the active session change
      gitStatusManager.setActiveSession(sessionId);
      return { success: true };
    } catch (error) {
      console.error('Failed to set active session:', error);
      return { success: false, error: 'Failed to set active session' };
    }
  });

} 
