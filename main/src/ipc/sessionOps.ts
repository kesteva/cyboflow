/**
 * Concrete implementation of {@link SessionOpsLike} — the business logic behind
 * the `cyboflow.sessions` tRPC router (batch 1 of the session-surface IPC→tRPC
 * migration; docs/CODE-PATTERNS.md).
 *
 * The 15 renderer-facing session-record handlers moved here VERBATIM from
 * main/src/ipc/session.ts — the only changes are mechanical: each registration
 * of a channel handler taking `(_event, a, b)` became
 * `const <method> = async ({ a, b }) => {…}` with the same body, same logging
 * and same error strings, and the closures are returned as one object at the
 * end. `debug:get-table-structure` was dropped entirely (zero preload/frontend
 * callers); DatabaseService.getTableStructure itself is untouched.
 *
 * The session LIFECYCLE handlers (create / delete / input / stop / continue /
 * conversation + output reads / interactive resume / attachments, plus every
 * `panels:*` channel) did NOT move — they are still registered by
 * registerSessionHandlers in session.ts.
 *
 * Unlike the router and contract, this file is SERVICES-SIDE and may import
 * anything — the panel manager, the question/approval routers, the session
 * validation helpers. That asymmetry is the whole point of the seam.
 */
import type { AppServices } from './types';
import type { SessionOpsLike } from '../orchestrator/trpc/contracts/sessionOps';
import { convertDbFolderToFolder } from './folders';
import { panelManager } from '../services/panelManager';
import { aggregateExecutionDiffTotals } from './executionDiffAggregation';
import { computeSessionFileStats, type SessionFileStats } from './sessionFileStats';
import {
  validateSessionExists,
  logValidationFailure,
  createValidationError,
} from '../utils/sessionValidation';
import type { SerializedArchiveTask } from '../services/archiveProgressManager';
import type { SessionSummaryPayload } from '../../../shared/types/sessionSummary';
import type { QuickSessionRow, QuickSessionGitSnapshot } from '../../../shared/types/quickSessions';
import { isPermissionMode } from '../../../shared/types/workflows';
import { makeDatabaseLike } from '../orchestrator/loggerAdapter';
import { selectSessionRunTokenTotals } from '../orchestrator/insightsQueries';
import { getCurrentBranch } from '../services/gitPlumbingCommands';
import { updateSessionAgentPermissionMode } from '../orchestrator/sessionPermissionMode';
import { listQuickSessions } from '../orchestrator/quickSessionListing';
import { QuestionRouter } from '../orchestrator/questionRouter';
import { ApprovalRouter } from '../orchestrator/approvalRouter';

/**
 * The request shape of one ops method, taken from the contract itself so the
 * two can never drift.
 */
type OpsInput<K extends keyof SessionOpsLike> = Parameters<SessionOpsLike[K]>[0];

/**
 * The resolved envelope of one ops method, taken from the contract. Annotating
 * each closure with it is what CONTEXTUALLY types the `return { success: … }`
 * literals inside — without it TypeScript widens `success: true` to `boolean`
 * and no envelope shape would be checked at all.
 */
type OpsResult<K extends keyof SessionOpsLike> = Awaited<ReturnType<SessionOpsLike[K]>>;

export function createSessionOps(services: AppServices): SessionOpsLike {
  const {
    sessionManager,
    databaseService,
    worktreeManager,
    interactiveCliManager, // PTY substrate sibling — supplies the board's awaiting-input gate set
    gitStatusManager,
    gitDiffManager, // git-derived session file stats for getStatistics
    archiveProgressManager,
    configManager, // session-summary feature toggle (getSummary / listQuick)
  } = services;

  const getAll = async (): Promise<OpsResult<'getAll'>> => {
    try {
      const sessions = await sessionManager.getAllSessions();
      return { success: true, data: sessions };
    } catch (error) {
      console.error('Failed to get sessions:', error);
      return { success: false, error: 'Failed to get sessions' };
    }
  };

  const get = async ({ sessionId }: OpsInput<'get'>): Promise<OpsResult<'get'>> => {
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
  };

  const getAllWithProjects = async (): Promise<OpsResult<'getAllWithProjects'>> => {
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
  };

  // catch-up kick — fire-and-forget, bounded by the scheduler's own cooldown so
  // the renderer's 30s poll cannot become a hot retry loop. `catchUp`
  // (default true, matching every existing caller) can be set to `false` to
  // skip that kick entirely and make this a pure read with no side effect —
  // for a caller (e.g. a board-wide batch read) that wants the summary without
  // risking triggering a summarizer run.
  const getSummary = async ({ sessionId, catchUp: catchUpOpt }: OpsInput<'getSummary'>): Promise<OpsResult<'getSummary'>> => {
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
      const catchUp = catchUpOpt ?? true;
      const watermark = summaryRow?.last_turn_id ?? 0;
      const hasNewerContent = databaseService.getConversationMessagesAfter(sessionId, watermark).length > 0;
      if (enabled && hasNewerContent && catchUp) {
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
  };

  const markViewed = async ({ sessionId }: OpsInput<'markViewed'>): Promise<OpsResult<'markViewed'>> => {
    try {
      await sessionManager.markSessionAsViewed(sessionId);
      return { success: true };
    } catch (error) {
      console.error('Failed to mark session as viewed:', error);
      return { success: false, error: 'Failed to mark session as viewed' };
    }
  };

  // TASK-225: manual "Dismiss" on a quick-session ask card. Delegates to
  // DatabaseService.dismissSessionAsk (clear + dismissal-hash stamp); the
  // next `listQuick` poll (kicked immediately by the frontend after this
  // resolves) is what actually drops the card from the board. Like `rename`
  // and `markViewed`, a successful write also emits the existing
  // 'session-updated' signal so every other mounted consumer (the sidebar's
  // session row, a second window) learns the session changed instead of
  // waiting on its own poll.
  const dismissAsk = async ({ sessionId }: OpsInput<'dismissAsk'>): Promise<OpsResult<'dismissAsk'>> => {
    try {
      const sessionValidation = validateSessionExists(sessionId);
      if (!sessionValidation.valid) {
        logValidationFailure('sessions:dismiss-ask', sessionValidation);
        return createValidationError(sessionValidation);
      }

      const dismissed = databaseService.dismissSessionAsk(sessionId);
      if (!dismissed) {
        return { success: false, error: 'Session not found' };
      }
      const session = sessionManager.getSession(sessionId);
      if (session) {
        sessionManager.emit('session-updated', session);
      }
      return { success: true };
    } catch (error) {
      console.error('Failed to dismiss session ask:', error);
      return { success: false, error: 'Failed to dismiss session ask' };
    }
  };

  // Throttle state for the listQuick git-cache warm (seam item (3) below).
  // Factory-scoped: one warm window per createSessionOps call, i.e. per app run.
  const QUICK_GIT_WARM_INTERVAL_MS = 60_000;
  const QUICK_GIT_WARM_MAX_SESSIONS = 20;
  let lastQuickGitWarmMs = 0;

  // Live quick-session status board (replaces the old idle-session review_item
  // mint). Derives each quick session's state on read: `blocked` when its chat
  // run has a pending AskUserQuestion / permission gate (SDK gates via the
  // Question/Approval routers; PTY gates via the interactive manager's
  // awaiting-input flag), else `running`/`idle` from the DB status. `projectId`
  // scopes to one project; omit for the cross-project review home. Three things
  // happen ONLY at this seam (never in the pure listing module): (1) a
  // cache-only git snapshot is attached from GitStatusManager.peekCachedStatus
  // — never a fresh fetch, so the 3s poll can't spawn git subprocesses; (2)
  // when the session-summary feature toggle is off, summary/summaryState/
  // waitingOn are nulled so a toggle-off can't leak a persisted summary onto
  // the board (mirrors getSummary's `enabled` contract); (3) at most
  // once per QUICK_GIT_WARM_INTERVAL_MS, a fire-and-forget cache WARM kicks
  // getGitStatus (TTL-aware, coalesced, concurrency-bounded) for the resting
  // rows — the git watcher pipeline (badge auto-refresh) is disabled in
  // production (GIT_STATUS_BADGE_ENABLED=false), so the cache this seam reads
  // would otherwise stay cold. The warm deliberately rides the POLL rather than
  // a dedicated endpoint of its own — that scopes warming to exactly "while a
  // board is polling", and it stayed that way when the listing moved onto the
  // cyboflow.sessions tRPC router.
  const listQuick = async ({ projectId }: OpsInput<'listQuick'>): Promise<OpsResult<'listQuick'>> => {
    try {
      const blockedRunIds = new Set<string>();
      for (const q of QuestionRouter.getInstance().getPending()) blockedRunIds.add(q.runId);
      for (const a of ApprovalRouter.getInstance().getPending()) blockedRunIds.add(a.runId);
      for (const runId of interactiveCliManager.getAwaitingInputRunIds()) blockedRunIds.add(runId);

      const summaryEnabled = configManager.isSessionSummaryEnabled();
      const rows = listQuickSessions(
        makeDatabaseLike(databaseService),
        blockedRunIds,
        typeof projectId === 'number' ? projectId : undefined,
      ).map((row): QuickSessionRow => {
        const cached = gitStatusManager.peekCachedStatus(row.sessionId);
        const git: QuickSessionGitSnapshot | null = cached
          ? {
              isReadyToMerge: cached.status.isReadyToMerge ?? false,
              hasUncommittedChanges: cached.status.hasUncommittedChanges ?? false,
              hasUntrackedFiles: cached.status.hasUntrackedFiles ?? false,
              ahead: cached.status.ahead ?? 0,
              behind: cached.status.behind ?? 0,
              lastCheckedIso: new Date(cached.lastChecked).toISOString(),
            }
          : null;
        return {
          ...row,
          git,
          summary: summaryEnabled ? row.summary : null,
          summaryState: summaryEnabled ? row.summaryState : null,
          waitingOn: summaryEnabled ? row.waitingOn : null,
        };
      });

      // (3) Throttled cache warm — see the seam comment above. Never awaited:
      // the poll's response must not wait on git subprocesses.
      const nowMs = Date.now();
      if (nowMs - lastQuickGitWarmMs >= QUICK_GIT_WARM_INTERVAL_MS) {
        lastQuickGitWarmMs = nowMs;
        for (const row of rows.filter((r) => r.state !== 'running').slice(0, QUICK_GIT_WARM_MAX_SESSIONS)) {
          void gitStatusManager.getGitStatus(row.sessionId).catch((error) => {
            console.error(`Failed to warm git status for session ${row.sessionId}:`, error);
          });
        }
      }

      return { success: true, data: rows };
    } catch (error) {
      console.error('Failed to list quick sessions:', error);
      return { success: false, error: 'Failed to list quick sessions' };
    }
  };

  const rename = async ({ sessionId, newName }: OpsInput<'rename'>): Promise<OpsResult<'rename'>> => {
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
  };

  const toggleFavorite = async ({ sessionId }: OpsInput<'toggleFavorite'>): Promise<OpsResult<'toggleFavorite'>> => {
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
  };

  // Update the per-session agent permission mode (4-mode) mid-session — driven by
  // the composer permission pill. resolveSessionAgentPermissionMode re-reads
  // sessions.agent_permission_mode on each SDK spawn, so the change takes effect
  // on the next turn (no respawn). Mirrors toggleFavorite for the
  // persist + runtime-session mutate + 'session-updated' emit.
  const updateAgentPermissionMode = async ({
    sessionId,
    mode,
  }: OpsInput<'updateAgentPermissionMode'>): Promise<OpsResult<'updateAgentPermissionMode'>> => {
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
  };

  // Per-session MCP DENY list (migration 037). Persists the disabled-server set
  // to sessions.disabled_mcp_servers_json; claudeCodeManager.resolveSessionDisabledMcps
  // re-reads the column on each SDK spawn so the change applies on the next turn
  // (no respawn). Mirrors updateAgentPermissionMode: persist + mutate
  // the runtime session + 'session-updated' emit. An empty [] is byte-identical
  // to the prior all-servers-load default.
  const updateSessionMcps = async ({
    sessionId,
    disabledMcpServers,
  }: OpsInput<'updateSessionMcps'>): Promise<OpsResult<'updateSessionMcps'>> => {
    try {
      // Defense-in-depth for DIRECT ops callers only: via the tRPC router this
      // branch is unreachable — its z.array(z.string()) schema throws
      // BAD_REQUEST before ops is called.
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
  };

  // Per-session plugin ALLOW list (migration 037). Persists the force-enabled
  // plugin-id set to sessions.enabled_plugins_json; resolveSessionEnabledPlugins
  // re-reads it on each SDK spawn (next-turn apply). Same persist + runtime mirror
  // + emit shape; an empty [] inherits the user's file plugins (byte-identical).
  const updateSessionPlugins = async ({
    sessionId,
    enabledPlugins,
  }: OpsInput<'updateSessionPlugins'>): Promise<OpsResult<'updateSessionPlugins'>> => {
    try {
      // Defense-in-depth for DIRECT ops callers only — see updateSessionMcps.
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
  };

  const reorder = async ({ sessionOrders }: OpsInput<'reorder'>): Promise<OpsResult<'reorder'>> => {
    try {
      databaseService.reorderSessions(sessionOrders);
      return { success: true };
    } catch (error) {
      console.error('Failed to reorder sessions:', error);
      return { success: false, error: 'Failed to reorder sessions' };
    }
  };

  // Archive progress handler
  const getArchiveProgress = async (): Promise<OpsResult<'getArchiveProgress'>> => {
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
  };

  // Session statistics handler
  const getStatistics = async ({ sessionId, baseRef }: OpsInput<'getStatistics'>): Promise<OpsResult<'getStatistics'>> => {
    try {
      console.log('[IPC] sessions:get-statistics called for sessionId:', sessionId);

      // Get session details
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      // Resolve the LIVE worktree branch once per session (worktree-level,
      // not per-panel) — falls back to the stored baseBranch only when the
      // worktree is unreadable or has no resolvable ref (getCurrentBranch
      // returns null — a detached HEAD does NOT: it resolves to the short
      // commit sha). baseBranch itself is untouched below.
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
        // TASK-278: the caller's persisted BaseSelector selection (when any)
        // wins over the recorded branch point, so the card agrees with
        // whatever base the Diff panel beside it is showing.
        baseRef,
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
          // baseBranch only when no ref resolves / unreadable worktree.
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
  };

  // Set active session for smart git status polling
  const setActiveSession = async ({ sessionId }: OpsInput<'setActiveSession'>): Promise<OpsResult<'setActiveSession'>> => {
    try {
      // Notify GitStatusManager about the active session change
      gitStatusManager.setActiveSession(sessionId);
      return { success: true };
    } catch (error) {
      console.error('Failed to set active session:', error);
      return { success: false, error: 'Failed to set active session' };
    }
  };

  return {
    getAll,
    get,
    getAllWithProjects,
    getSummary,
    listQuick,
    getStatistics,
    getArchiveProgress,
    markViewed,
    dismissAsk,
    rename,
    toggleFavorite,
    updateAgentPermissionMode,
    updateSessionMcps,
    updateSessionPlugins,
    reorder,
    setActiveSession,
  };
}
