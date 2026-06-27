import { IpcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import type { AppServices } from './types';
import type { CreateSessionRequest } from '../types/session';
import { getCyboflowSubdirectory } from '../utils/cyboflowDirectory';
import { convertDbFolderToFolder } from './folders';
import { panelManager } from '../services/panelManager';
import { trackUsage } from '../services/telemetry';
import {
  validateSessionExists,
  validatePanelSessionOwnership,
  validatePanelExists,
  validateSessionIsActive,
  logValidationFailure,
  createValidationError
} from '../utils/sessionValidation';
import type { SerializedArchiveTask } from '../services/archiveProgressManager';
import { MessageProjection, TypedEventNarrowing } from '../services/streamParser';
import type { UnifiedMessage } from '../../../shared/types/unifiedMessage';
import type { SessionOutput } from '../types/session';
import type { Logger } from '../utils/logger';
import { transitionToRunning } from '../services/cyboflow/transitions';
import { assertTransitionAllowed } from '../services/cyboflow/stateMachine';
import { isPermissionMode, type PermissionMode } from '../../../shared/types/workflows';
import { stampSessionRunsOutcome } from '../orchestrator/runRecovery';
import { makeDatabaseLike } from '../orchestrator/loggerAdapter';
import { selectSessionRunTokenTotals } from '../orchestrator/insightsQueries';
import { pruneSessionOnlyArtifacts } from '../orchestrator/artifactLifecycle';
import { isCliSubstrate } from '../../../shared/types/substrate';
import { DynamicWorkflowTracker } from '../orchestrator/dynamicWorkflows';
import { InteractiveSettingsWriter } from '../services/panels/claude/interactiveSettingsWriter';

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

    const event = narrower.narrow(raw);
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

/**
 * Generate a UTC-based worktree branch name for quick sessions.
 *
 * Format: `quick-YYYYMMDD-HHmmss` (all UTC components, zero-padded).
 * The `now` parameter exists so callers and tests can inject a fixed Date
 * for deterministic output; the default is the wall-clock instant at call
 * time.
 */
export function generateQuickWorktreeBranchName(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = now.getUTCFullYear();
  const mo = pad(now.getUTCMonth() + 1);
  const d = pad(now.getUTCDate());
  const h = pad(now.getUTCHours());
  const mi = pad(now.getUTCMinutes());
  const s = pad(now.getUTCSeconds());
  return `quick-${y}${mo}${d}-${h}${mi}${s}`;
}

/**
 * First prompt written into the persistent interactive REPL when a quick session
 * opts into the PTY substrate (sessions:create-quick eager spawn). A minimal
 * context briefing — NOT a workflow prompt: it must never instruct the agent to
 * start work. NOTE: this text must NEVER contain the word "ultracode" — that
 * keyword is reserved for the USER to type (it is what the passive
 * dynamic-workflow detection at the EventRouter seam keys off).
 */
const QUICK_PTY_BRIEFING = `You are running inside cyboflow, a desktop app that manages parallel AI coding sessions in isolated git worktrees.

Session context:
- This is a user-driven quick session: no predefined workflow, no step ceremony — just you and the user.
- Your working directory is a dedicated git worktree for this session. Commits stay local to its branch; the user merges or dismisses the session's work from the cyboflow UI when done.
- A "cyboflow" MCP server is connected; its tools write to cyboflow's project database (tasks/backlog). Use them only when the user asks you to interact with the cyboflow backlog.

Acknowledge briefly and wait for the user's instructions.`;

export function registerSessionHandlers(ipcMain: IpcMain, services: AppServices): void {
  const {
    sessionManager,
    databaseService,
    taskQueue,
    worktreeManager,
    cliManagerFactory,
    claudeCodeManager, // For backward compatibility
    interactiveCliManager, // PTY substrate sibling (quick-session relay/spawn)
    killLiveSession, // hard-kill seam for a dismissed PTY quick session's REPL
    registerLivePanel, // at-spawn runId→panelId seed for the facade's relay translation
    gitStatusManager,
    archiveProgressManager,
    configManager, // demo-mode probe — gates the real interactive PTY spawn/relay
    cyboflow
  } = services;

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

      const count = request.count || 1;

      if (count > 1) {
        const jobs = await taskQueue.createMultipleSessions(
          request.prompt,
          request.worktreeTemplate || '',
          count,
          request.permissionMode,
          targetProject.id,
          request.baseBranch,
          request.autoCommit,
          request.toolType,
          request.commitMode,
          request.commitModeSettings,
          request.claudeConfig,
          request.folderId
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
          autoCommit: request.autoCommit,
          toolType: request.toolType,
          commitMode: request.commitMode,
          commitModeSettings: request.commitModeSettings,
          claudeConfig: request.claudeConfig
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

      const branchName = request.branchName ?? generateQuickWorktreeBranchName();
      const toolType: 'claude' | 'none' = request.toolType ?? 'claude';

      // Per-session 4-mode agent-permission override (Session Start Wizard step 3 /
      // quick-session config). Validate the untyped IPC value; an absent/invalid
      // value leaves the session on the global default (byte-identical to before).
      const requestedAgentMode = isPermissionMode(request.agentPermissionMode)
        ? request.agentPermissionMode
        : undefined;

      // Opt-in CLI substrate for the quick session (migration 027). Validate the
      // untyped IPC value; an absent/invalid value leaves the run + session on
      // the SDK default (byte-identical to before).
      const requestedSubstrate = isCliSubstrate(request.substrate) ? request.substrate : undefined;

      // Opt-in agent effort (the "Ultracode" wizard card). 'ultracode' launches
      // the interactive REPL with the ultracode setting; any other value is
      // ignored. Demo mode never spawns a real REPL — it drives a canned dynamic
      // workflow instead (below) — so the setting only reaches the live spawn.
      const requestedEffort = request.effort === 'ultracode' ? 'ultracode' : undefined;

      // Per-launch Claude config for the quick session (Configure model dropdown +
      // fast-mode toggle). `claudeConfig.model` is the bare alias (pinned to a
      // concrete snapshot at the spawn seam); `fastMode` opts THIS session into the
      // premium Opus fast-mode preview (default off). For the interactive substrate
      // both are passed to the eager spawn AND persisted on the panel below; for
      // SDK the frontend persists them on the panel it creates. Either way the
      // sessions:input respawn re-reads them from panel settings.
      const requestedModel = typeof request.claudeConfig?.model === 'string' ? request.claudeConfig.model : undefined;
      const requestedFastMode = request.claudeConfig?.fastMode === true;

      const job = await taskQueue.createSession({
        prompt: '',
        worktreeTemplate: branchName,
        projectId: targetProject.id,
        folderId: request.folderId,
        baseBranch: request.baseBranch,
        autoCommit: request.autoCommit,
        toolType,
        commitMode: request.commitMode,
        commitModeSettings: request.commitModeSettings,
        claudeConfig: request.claudeConfig
      });

      // Await the session row by listening for session-created events on the
      // SessionManager. Concurrent sessions:create-quick calls share the same
      // emitter, so we filter by worktreePath: TaskQueue's ensureUniqueNames may
      // append a `-<counter>` suffix to resolve same-second name collisions, so
      // accept both `/{branchName}` and `/{branchName}-<n>` tails. Non-matching
      // events are ignored — the listener is left in place via `on` (not `once`)
      // until the matching session arrives or the timeout fires.
      const session = await new Promise<import('../types/session').Session>((resolve, reject) => {
        const suffixed = new RegExp(`/${branchName}-\\d+$`);
        const onCreated = (createdSession: import('../types/session').Session) => {
          const wt = createdSession.worktreePath ?? '';
          const matches = wt.endsWith(`/${branchName}`) || suffixed.test(wt);
          if (!matches) return;
          clearTimeout(timeout);
          sessionManager.removeListener('session-created', onCreated);
          resolve(createdSession);
        };
        const timeout = setTimeout(() => {
          sessionManager.removeListener('session-created', onCreated);
          reject(new Error('Timed out waiting for quick session to be created'));
        }, 30_000);

        sessionManager.on('session-created', onCreated);
      });

      // Wire the quick session to a workflow_runs row so ApprovalRouter can
      // work for quick sessions.
      //
      // 1. Ensure the __quick__ sentinel workflow exists for this project.
      // 2. Create a workflow_runs row (status='queued').
      // 3. Advance: queued -> starting -> running.
      // 4. Backfill sessions.run_id with the new runId.
      const sentinelWorkflowId = cyboflow.workflowRegistry.ensureQuickWorkflow(targetProject.id);
      // Stamp the chosen 4-mode onto the sentinel run's permission_mode_snapshot too,
      // so the run row is truthful (the quick PANEL reads the session column below,
      // but workflow-world tooling that inspects the run sees the right value).
      // createRun resolves the substrate through the FULL ladder (requested →
      // global default → CYBOFLOW_SUBSTRATE env → 'sdk') and returns the value it
      // stamped onto workflow_runs.substrate — everything below (the session
      // stamp + the eager spawn gate) keys off that RESOLVED value, never the
      // requested one, so the run row and the session can never diverge.
      const { runId, substrate: resolvedSubstrate } = cyboflow.workflowRegistry.createRun(
        sentinelWorkflowId,
        requestedSubstrate,
        undefined,
        requestedAgentMode,
      );

      const db = databaseService.getDb();

      // queued -> starting (no helper exists; do guarded UPDATE directly).
      assertTransitionAllowed('queued', 'starting', runId);
      const startingResult = db.prepare(
        `UPDATE workflow_runs
            SET status = 'starting', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'queued'`,
      ).run(runId);
      if (startingResult.changes === 0) {
        throw new Error(`Failed to advance run ${runId} from queued to starting`);
      }

      // starting -> running via the guarded helper in transitions.ts.
      transitionToRunning(db, { runId });

      // Stamp the session's worktree onto the sentinel run (ALL quick sessions).
      // Sentinel runs never pass through RunLauncher (which stamps
      // workflow_runs.worktree_path for workflow runs at launch), so without
      // this the column stays NULL and mcpQueryHandler.resolveRunWorktree
      // returns null — short-circuiting the per-run worktree allow-list for
      // quick-session MCP writes. Mirror of the runLauncher.ts UPDATE, minus
      // status/branch (the transitions above own status).
      db.prepare(
        `UPDATE workflow_runs SET worktree_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ).run(session.worktreePath, runId);

      // Backfill sessions.run_id.
      db.prepare(`UPDATE sessions SET run_id = ? WHERE id = ?`).run(runId, session.id);

      // INTERACTIVE ONLY: stamp the sentinel run's session_id so the live session
      // meter counts its tokens. An interactive (PTY) quick session never writes
      // session_outputs (its Claude panel is deliberately NOT registered with
      // ClaudePanelManager — see the eager-spawn note below), so its chat tokens
      // live ONLY in the sentinel run's `assistant` raw_events. The session meter
      // sums getSessionTokenUsage (session_outputs) + selectSessionRunTokenTotals
      // (workflow_runs WHERE session_id → raw_events); with session_id NULL the
      // sentinel is never scanned and PTY quick-chat tokens read 0.
      //
      // SDK quick sessions DELIBERATELY leave session_id NULL: they write BOTH
      // session_outputs AND sentinel raw_events, so counting the run would
      // DOUBLE-COUNT against getSessionTokenUsage. The two token sources are only
      // disjoint (per selectSessionRunTokenTotals' contract) while the SDK
      // sentinel stays unstamped — so gate this stamp on the resolved substrate.
      if (resolvedSubstrate === 'interactive') {
        db.prepare(`UPDATE workflow_runs SET session_id = ? WHERE id = ?`).run(session.id, runId);
      }

      // Persist the per-session agent-permission override (migration 021) so the
      // quick Claude panel spawn (resolveSessionAgentPermissionMode → getDbSession)
      // and any restart read it. Only written when explicitly chosen — NULL keeps
      // the session on the global default.
      if (requestedAgentMode !== undefined) {
        db.prepare(`UPDATE sessions SET agent_permission_mode = ? WHERE id = ?`).run(
          requestedAgentMode,
          session.id,
        );
      }

      // Persist the per-session CLI substrate (migration 027) so the
      // sessions:input relay branch, frontend substrate gates, and any REPL
      // re-spawn read it. ALWAYS stamp the RESOLVED value from createRun — a
      // request without an explicit substrate can still resolve 'interactive'
      // via the global default or CYBOFLOW_SUBSTRATE, and stamping only on
      // explicit request would leave the run row saying interactive while the
      // session behaved SDK. NULL remains the legacy/SDK meaning for
      // pre-migration rows only; new quick sessions always carry the resolved
      // value.
      db.prepare(`UPDATE sessions SET substrate = ? WHERE id = ?`).run(
        resolvedSubstrate,
        session.id,
      );

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

      // EAGER PTY SPAWN (interactive substrate only): create the claude panel
      // server-side (same pattern sessions:input uses) and boot the persistent
      // REPL now, with the cyboflow context briefing as its first prompt, so the
      // live terminal is alive before the user's first message.
      // ⚠️ NEVER await startPanel here: the interactive spawn promise resolves
      // only when the REPL EXITS (persistent-session contract) — awaiting would
      // deadlock create-quick until the session ends.
      let claudePanelId: string | undefined;
      if (resolvedSubstrate === 'interactive' && configManager.isDemoMode()) {
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
            title: 'Claude',
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
            title: 'Claude'
          });
          claudePanelId = panel.id;
          // Persist the launch model + fast-mode on the panel so a later
          // sessions:input respawn re-applies them (the eager spawn below already
          // receives them directly).
          if (requestedModel !== undefined || requestedFastMode) {
            databaseService.updatePanelSettings(panel.id, {
              ...(requestedModel !== undefined ? { model: requestedModel } : {}),
              fastMode: requestedFastMode,
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
            )
            .catch((err: unknown) => {
              // Fail-soft: a spawn failure leaves the session usable — the next
              // sessions:input re-spawns the REPL with the user's prompt.
              console.error(`[IPC] Eager interactive REPL spawn failed for session ${session.id}:`, err);
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
          jobId: job.id,
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

      // Drop this session's session-only (uncommitted) run artifacts — the tabbed
      // center pane's "session-only artifacts clear on close unless committed"
      // contract. Runs are canceled first (above); committed artifacts persist.
      // Fail-soft: a prune failure must never block the dismiss.
      try {
        await pruneSessionOnlyArtifacts(makeDatabaseLike(databaseService), sessionId, {
          warn: (m, meta) => console.warn(m, meta),
          debug: (m) => console.log(m),
        });
      } catch (pruneError) {
        console.error(`[Main] Failed to prune session-only artifacts for session ${sessionId}:`, pruneError);
      }

      // Add a message to session output about archiving
      const timestamp = new Date().toLocaleTimeString();
      let archiveMessage = `\r\n\x1b[36m[${timestamp}]\x1b[0m \x1b[1m\x1b[44m\x1b[37m 📦 ARCHIVING SESSION \x1b[0m\r\n`;
      archiveMessage += `\x1b[90mSession will be archived and removed from the active sessions list.\x1b[0m\r\n`;

      // PTY quick-session close-out: a live interactive REPL must not be
      // orphaned when its session is dismissed/archived. HARD kill (not the
      // graceful EOF/`/exit` end — a dismissed session's claude may be mid-turn
      // and never read PTY stdin) BEFORE the worktree-removal cleanup below
      // tears the cwd out from under it. The facade translates the sentinel
      // runId to the live panelId and NO-OPs for the SDK substrate. Fail-soft:
      // a kill failure must never block the dismiss.
      if (dbSession.substrate === 'interactive' && dbSession.run_id) {
        try {
          await killLiveSession(dbSession.run_id);
        } catch (err) {
          console.warn(`[IPC:session] Failed to kill live interactive REPL for dismissed session ${sessionId}:`, err);
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

      // Auto-resolve any open dynamic-workflow review items for this session —
      // dismissing the session IS the human's close-out action. Fire-and-forget:
      // a resolve failure must never fail the dismiss itself.
      void DynamicWorkflowTracker.tryGetInstance()
        ?.resolveReviewItemsForSession(sessionId, 'user')
        .catch((err: unknown) => {
          console.warn(`[IPC:session] Failed to auto-resolve dynamic-workflow review items for session ${sessionId}:`, err);
        });

      // Add the archive message to session output
      sessionManager.addSessionOutput(sessionId, {
        type: 'stdout',
        data: archiveMessage,
        timestamp: new Date()
      });

      // Create cleanup callback for background operations
      const cleanupCallback = async () => {
        let cleanupMessage = '';
        
        // Clean up the worktree if session has one (but not for main repo sessions)
        if (dbSession.worktree_name && dbSession.project_id && !dbSession.is_main_repo) {
          const project = databaseService.getProject(dbSession.project_id);
          if (project) {
            try {
              // Update progress: removing worktree
              if (archiveProgressManager) {
                archiveProgressManager.updateTaskStatus(sessionId, 'removing-worktree');
              }

              await worktreeManager.removeWorktree(project.path, dbSession.worktree_name, project.worktree_folder || undefined);

              cleanupMessage += `\x1b[32m✓ Worktree removed successfully\x1b[0m\r\n`;
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

      // Queue the cleanup task if we have worktree cleanup to do
      if (dbSession.worktree_name && dbSession.project_id && !dbSession.is_main_repo) {
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
    try {
      // Validate session exists and is active
      const sessionValidation = validateSessionIsActive(sessionId);
      if (!sessionValidation.valid) {
        logValidationFailure('sessions:input', sessionValidation);
        return createValidationError(sessionValidation);
      }

      // Update session status back to running when user sends input
      const currentSession = await sessionManager.getSession(sessionId);
      if (currentSession && currentSession.status === 'waiting') {
        console.log(`[Main] User sent input to session ${sessionId}, updating status to 'running'`);
        await sessionManager.updateSession(sessionId, { status: 'running' });
      }

      // Store user input in session outputs for persistence
      const userInputDisplay = `> ${input.trim()}\n`;
      await sessionManager.addSessionOutput(sessionId, {
        type: 'stdout',
        data: userInputDisplay,
        timestamp: new Date()
      });

      // Check if session uses structured commit mode and enhance the input
      let finalInput = input;
      const dbSession = databaseService.getSession(sessionId);
      if (dbSession?.commit_mode === 'structured') {
        console.log(`[IPC] Session ${sessionId} uses structured commit mode, enhancing input`);
        
        // Parse commit mode settings
        let commitModeSettings;
        try {
          commitModeSettings = dbSession.commit_mode_settings ? 
            JSON.parse(dbSession.commit_mode_settings) : 
            { mode: 'structured' };
        } catch (e) {
          console.error(`[IPC] Failed to parse commit mode settings:`, e);
          commitModeSettings = { mode: 'structured' };
        }
        
        // Get structured prompt template from settings or use default
        const { DEFAULT_STRUCTURED_PROMPT_TEMPLATE } = require('../../../shared/types');
        const structuredPromptTemplate = commitModeSettings?.structuredPromptTemplate || DEFAULT_STRUCTURED_PROMPT_TEMPLATE;
        
        // Add structured commit instructions to the input
        finalInput = `${input}\n\n${structuredPromptTemplate}`;
        console.log(`[IPC] Added structured commit instructions to input`);
      }

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
            title: 'Claude'
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
          // REPL died or the app restarted — re-spawn with the user's input as
          // the first prompt. ⚠️ NEVER await startPanel: the interactive spawn
          // promise resolves only when the REPL EXITS (persistent-session
          // contract) — awaiting would deadlock sessions:input until the
          // session ends.
          console.log(`[IPC] Interactive REPL not running for panel ${claudePanel.id}, re-spawning...`);
          // Deterministic at-spawn registration (mirrors the create-quick eager
          // spawn): seed the facade's runId→panelId translation BEFORE the PTY
          // spawn so a relay/close-out racing the first PTY byte never falls
          // back to the sentinel runId.
          if (dbSession?.run_id) {
            registerLivePanel(dbSession.run_id, claudePanel.id);
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
        await claudeCodeManager.startPanel(claudePanel.id, sessionId, session.worktreePath, finalInput, session.permissionMode, panelModel, panelFastMode);
        
        // Update session status to running
        await sessionManager.updateSession(sessionId, { status: 'running' });
      } else {
        // Claude Code is already running, just send the input to the panel
        claudeCodeManager.sendInput(claudePanel.id, finalInput);
      }
      
      return { success: true };
    } catch (error) {
      console.error('Failed to send input:', error);
      return { success: false, error: 'Failed to send input' };
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
              title: 'Claude'
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
                title: 'Claude'
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
            return { success: false, error: 'Failed to send input to Claude panel' };
          }
        case 'terminal':
          // Terminal panels don't have input handlers - they use runTerminalCommand
          return { success: false, error: 'Terminal panels use different input methods' };
        default:
          return { success: false, error: `Unsupported panel type: ${panel.type}` };
      }
    } catch (error) {
      console.error('Failed to send input to panel:', error);
      return { success: false, error: 'Failed to send input to panel' };
    }
  });

  ipcMain.handle('panels:continue', async (_event, panelId: string, input: string, model?: string) => {
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
            const { claudePanelManager } = require('./claudePanel');
            if (!claudePanelManager) {
              return { success: false, error: 'Claude panel manager not available' };
            }

            // Get session to retrieve worktreePath and determine resume behavior
            const session = await sessionManager.getSession(panel.sessionId);
            if (!session) {
              return { success: false, error: 'Session not found' };
            }

            // Save the user input as a conversation message
            if (input) {
              sessionManager.addPanelConversationMessage(panelId, 'user', input);
            }

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
                model
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
              model
            );
            return { success: true };
          } catch (err) {
            console.error('Failed to continue Claude panel:', err);
            return { success: false, error: 'Failed to continue Claude panel' };
          }
        default:
          return { success: false, error: `Panel type ${panel.type} does not support continue operation` };
      }
    } catch (error) {
      console.error('Failed to continue panel conversation:', error);
      return { success: false, error: 'Failed to continue panel conversation' };
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

  ipcMain.handle('sessions:stop', async (_event, sessionId: string) => {
    try {
      // Get Claude panels for this session and stop them
      const stopPanels = panelManager.getPanelsForSession(sessionId);
      const stopClaudePanels = stopPanels.filter(p => p.type === 'claude');
      
      if (stopClaudePanels.length > 0) {
        // Stop all Claude panels for this session
        console.log(`[IPC] Stopping ${stopClaudePanels.length} Claude panel(s) for session ${sessionId}`);
        for (const claudePanel of stopClaudePanels) {
          await claudeCodeManager.stopPanel(claudePanel.id);
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
            sessionManager.emit('session-output-available', { sessionId, panelId: claudePanel.id });
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
      const updated = databaseService.updateSession(sessionId, { agent_permission_mode: mode });
      if (!updated) {
        return { success: false, error: 'Session not found' };
      }
      const session = sessionManager.getSession(sessionId);
      if (session) {
        session.agentPermissionMode = mode;
        sessionManager.emit('session-updated', session);
      }

      // INTERACTIVE substrate (sessions.substrate, migration 027): the live PTY
      // `claude` reads its gating from the worktree's .claude/settings.json at
      // SPAWN only — relayUserTurn/submitToRepl never re-read it — so the SDK
      // next-turn re-read (resolveSessionAgentPermissionMode) does NOT apply. To
      // make the change effective on the NEXT spawn (terminal restart), prime the
      // settings file now: default/acceptEdits keep the wildcard PreToolUse hook;
      // auto/dontAsk remove it (auto hands gating to native Claude, dontAsk opts
      // out). Demo mode never spawns a real REPL, so skip it. Fully fail-soft:
      // never throw across the IPC boundary, and guard the teardown race (a
      // dismissed session's worktree is gone) by requiring the worktree to exist.
      try {
        if (!configManager.isDemoMode()) {
          const dbSession = databaseService.getSession(sessionId);
          const worktreePath = dbSession?.worktree_path;
          if (
            dbSession?.substrate === 'interactive' &&
            typeof worktreePath === 'string' &&
            worktreePath.length > 0 &&
            existsSync(worktreePath)
          ) {
            const writer = new InteractiveSettingsWriter();
            if (mode === 'auto' || mode === 'dontAsk') {
              writer.remove(worktreePath);
            } else {
              writer.write(worktreePath, { permissionMode: mode });
            }
          }
        }
      } catch (settingsErr) {
        // Priming the interactive hook is best-effort: a failure leaves the prior
        // mode in effect for the next spawn but must not fail the persist.
        console.warn('[IPC] Failed to prime interactive .claude/settings.json for permission mode:', settingsErr);
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

  ipcMain.handle('sessions:toggle-auto-commit', async (_event, sessionId: string) => {
    try {
      console.log('[IPC] sessions:toggle-auto-commit called for sessionId:', sessionId);
      
      // Get current session to check current auto_commit status
      const currentSession = databaseService.getSession(sessionId);
      if (!currentSession) {
        console.error('[IPC] Session not found in database:', sessionId);
        return { success: false, error: 'Session not found' };
      }
      
      console.log('[IPC] Current session auto_commit status:', currentSession.auto_commit);

      // Toggle the auto_commit status
      const newAutoCommitStatus = !(currentSession.auto_commit ?? true); // Default to true if not set
      console.log('[IPC] Toggling auto_commit status to:', newAutoCommitStatus);
      
      const updatedSession = databaseService.updateSession(sessionId, { auto_commit: newAutoCommitStatus });
      if (!updatedSession) {
        console.error('[IPC] Failed to update session in database');
        return { success: false, error: 'Failed to update session' };
      }
      
      console.log('[IPC] Database updated successfully. Updated session auto_commit:', updatedSession.auto_commit);

      // Emit update event so frontend gets notified
      const session = sessionManager.getSession(sessionId);
      if (session) {
        session.autoCommit = newAutoCommitStatus;
        console.log('[IPC] Emitting session-updated event with auto_commit status:', session.autoCommit);
        sessionManager.emit('session-updated', session);
      } else {
        console.warn('[IPC] Session not found in session manager:', sessionId);
      }

      return { success: true, data: { autoCommit: newAutoCommitStatus } };
    } catch (error) {
      console.error('Failed to toggle auto-commit status:', error);
      if (error instanceof Error) {
        console.error('Error stack:', error.stack);
      }
      return { success: false, error: 'Failed to toggle auto-commit status' };
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

      // Get execution diffs for file changes
      const executionDiffs = databaseService.getExecutionDiffs(sessionId);
      
      // Calculate file statistics
      let totalFilesChanged = 0;
      let totalLinesAdded = 0;
      let totalLinesDeleted = 0;
      const filesModified = new Set<string>();
      
      executionDiffs.forEach(diff => {
        totalFilesChanged += diff.stats_files_changed || 0;
        totalLinesAdded += diff.stats_additions || 0;
        totalLinesDeleted += diff.stats_deletions || 0;
        
        // Track unique files
        if (diff.files_changed) {
          try {
            const files = Array.isArray(diff.files_changed) 
              ? diff.files_changed 
              : JSON.parse(diff.files_changed);
            files.forEach((file: string) => filesModified.add(file));
          } catch (e) {
            // Ignore parse errors
          }
        }
      });

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
          branch: session.baseBranch || 'main'
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
          totalFilesChanged: filesModified.size,
          totalLinesAdded,
          totalLinesDeleted,
          filesModified: Array.from(filesModified),
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
