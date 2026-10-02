import type { BrowserWindow } from 'electron';
import type { AppServices } from './ipc/types';
import { panelManager } from './services/panelManager';
import type { ToolPanel, ClaudePanelState, BaseAIPanelState, PanelStatus } from '../../shared/types/panels';
import type { SessionOutput } from './types/session';
import {
  validateEventContext,
  validatePanelEventContext,
  logValidationFailure
} from './utils/sessionValidation';
import { ModelAvailabilityService } from './services/modelAvailabilityService';
import type { ModelAvailabilityMap, ModelFallbackNotice } from '../../shared/types/modelAvailability';
import type { FastModeStateNotice } from '../../shared/types/panels';
import type { Project } from './database/models';
import { DEFAULT_PERMISSION_MODE } from '../../shared/types/permissionMode';
import { deriveLiveContextUsage } from './utils/liveContextUsage';
import { primaryModelUsageEntry } from '../../shared/utils/primaryModelUsage';
import { isAgentThreadSpawnId } from '../../shared/types/agentThread';

/**
 * Crystal session IDs are 36-char dashed UUIDs (e.g. `91e56989-0674-...`).
 * cyboflow workflow run IDs are 32-char no-dash hex (e.g. `0d33e5082da8...`)
 * — the same value is used as panelId / sessionId per the TASK-663 invariant.
 *
 * Returns true for cyboflow run IDs so Crystal-era listeners can short-circuit
 * before logging "Session X not found" validation failures against the
 * `sessions` table, which cyboflow runs never write to.  Crystal pipelines
 * still validate their own events normally.
 */
function isCyboflowRunId(id: string | undefined): boolean {
  return typeof id === 'string' && /^[0-9a-f]{32}$/i.test(id);
}

/**
 * Event identities with no `sessions` / `tool_panels` row behind them: cyboflow
 * workflow run ids (owned by runEventBridge) and the global-agent thread's
 * synthetic `agent:<threadId>` spawn identity (panelId === sessionId). Session
 * validation would only log "Session not found" for these, so listeners skip
 * them up front.
 */
function isSyntheticEventIdentity(panelId: string | undefined, sessionId: string | undefined): boolean {
  return (
    isCyboflowRunId(panelId) ||
    isCyboflowRunId(sessionId) ||
    isAgentThreadSpawnId(panelId) ||
    isAgentThreadSpawnId(sessionId)
  );
}

export function setupEventListeners(services: AppServices, getMainWindow: () => BrowserWindow | null): void {
  const {
    sessionManager,
    claudeCodeManager,
    executionTracker,
    gitStatusManager,
    databaseService
  } = services;

  // Guarded-model availability (Fable 5.1): forward status flips to the renderer so
  // the model pickers can grey out a pulled model live (no reload needed). The
  // service is initialized before this runs (see main/src/index.ts).
  ModelAvailabilityService.tryGetInstance()?.on('changed', (map: ModelAvailabilityMap) => {
    const mw = getMainWindow();
    if (mw && !mw.isDestroyed()) {
      try {
        mw.webContents.send('model-availability-changed', map);
      } catch {
        /* window torn down mid-send — ignore */
      }
    }
  });

  // eslint-disable-next-line no-control-regex
  const ANSI_ESCAPE_REGEX = /\x1B\[[0-9;]*m/g;
  // Original format: "76k/200k tokens (38%)"
  const CONTEXT_USAGE_REGEX = /([0-9]+(?:\.[0-9]+)?k?\s*\/\s*[0-9]+(?:\.[0-9]+)?k?\s+tokens?\s*\(\d+%[^)]*\))/i;
  // Alternative format: "Context: 76000/200000 tokens" or similar
  const CONTEXT_USAGE_ALT_REGEX = /context[:\s]+([0-9,]+)\s*(?:\/|of)\s*([0-9,]+)\s*tokens?/i;

  const extractCandidateStrings = (payload: unknown): string[] => {
    const strings: string[] = [];
    const stack: unknown[] = [payload];
    const visited = new Set<object>();

    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined || current === null) {
        continue;
      }

      if (typeof current === 'string') {
        strings.push(current);
        continue;
      }

      if (typeof current === 'number' || typeof current === 'boolean') {
        strings.push(String(current));
        continue;
      }

      if (Array.isArray(current)) {
        for (const item of current) {
          stack.push(item);
        }
        continue;
      }

      if (typeof current === 'object') {
        const obj = current as Record<string, unknown>;
        if (visited.has(obj)) {
          continue;
        }
        visited.add(obj);
        for (const value of Object.values(obj)) {
          stack.push(value);
        }
      }
    }

    return strings;
  };

  // Helper to format token count (e.g., 76000 -> "76k", 200000 -> "200k")
  const formatTokenCount = (count: number): string => {
    if (count >= 1000) {
      return `${Math.round(count / 1000)}k`;
    }
    return String(count);
  };

  // Try to extract context usage from JSON result message with modelUsage
  const extractContextFromResultJson = (data: Record<string, unknown>): string | null => {
    // Check for result type with modelUsage
    if (data.type !== 'result' || !data.modelUsage) {
      return null;
    }

    // The MAIN model's entry — modelUsage also carries Haiku side queries.
    const model = primaryModelUsageEntry(data.modelUsage);
    if (model) {
      const contextWindow = model.contextWindow as number;

      // Calculate current context usage from cache tokens
      // cacheReadInputTokens represents tokens read from cache (already in context)
      const cacheRead = typeof model.cacheReadInputTokens === 'number' ? model.cacheReadInputTokens : 0;
      const cacheCreation = typeof model.cacheCreationInputTokens === 'number' ? model.cacheCreationInputTokens : 0;
      const inputTokens = typeof model.inputTokens === 'number' ? model.inputTokens : 0;

      // Estimate current context as the input tokens for the most recent turn
      // This is an approximation since we don't have exact current context size
      const estimatedContext = Math.min(inputTokens + cacheRead, contextWindow);

      if (estimatedContext > 0) {
        const percentage = Math.round((estimatedContext / contextWindow) * 100);
        return `${formatTokenCount(estimatedContext)}/${formatTokenCount(contextWindow)} tokens (${percentage}%)`;
      }
    }

    return null;
  };

  // Try to extract context usage from system init message
  const extractContextFromInitJson = (data: Record<string, unknown>): string | null => {
    if (data.type !== 'system' || data.subtype !== 'init') {
      return null;
    }

    // Check for context_tokens field (new format)
    if (typeof data.context_tokens === 'number' && typeof data.context_window === 'number') {
      const used = data.context_tokens;
      const max = data.context_window;
      const percentage = Math.round((used / max) * 100);
      return `${formatTokenCount(used)}/${formatTokenCount(max)} tokens (${percentage}%)`;
    }

    return null;
  };

  const extractContextUsageFromOutputs = (outputs: SessionOutput[]): string | null => {
    // Prefer the LIVE single-turn context (newest assistant usage + window) over
    // the result event's cumulative modelUsage, which otherwise pegs the meter at
    // 100% on long multi-tool turns (deriveLiveContextUsage owns the rationale +
    // tests). Falls through to the legacy result/init/regex extraction when no
    // assistant usage is present (e.g. PTY stdout streams).
    const liveContext = deriveLiveContextUsage(outputs);
    if (liveContext) {
      return liveContext;
    }

    for (const output of outputs) {
      // Handle JSON outputs
      if (output.type === 'json' && output.data && typeof output.data === 'object') {
        const jsonData = output.data as Record<string, unknown>;

        // Try to extract from result message (new format)
        const resultContext = extractContextFromResultJson(jsonData);
        if (resultContext) {
          return resultContext;
        }

        // Try to extract from init message
        const initContext = extractContextFromInitJson(jsonData);
        if (initContext) {
          return initContext;
        }

        // Try original string extraction method
        const candidates = extractCandidateStrings(output.data);
        for (const candidate of candidates) {
          if (typeof candidate !== 'string') continue;

          // Try original regex
          const match = candidate.match(CONTEXT_USAGE_REGEX);
          if (match) {
            return match[1].replace(/\s+/g, ' ').trim();
          }

          // Try alternative format
          const altMatch = candidate.match(CONTEXT_USAGE_ALT_REGEX);
          if (altMatch) {
            const used = parseInt(altMatch[1].replace(/,/g, ''), 10);
            const max = parseInt(altMatch[2].replace(/,/g, ''), 10);
            const percentage = Math.round((used / max) * 100);
            return `${formatTokenCount(used)}/${formatTokenCount(max)} tokens (${percentage}%)`;
          }
        }
        continue;
      }

      // Handle stdout outputs
      if (output.type !== 'stdout' || typeof output.data !== 'string') {
        continue;
      }

      const cleanedLines = output.data
        .replace(ANSI_ESCAPE_REGEX, '')
        .split(/\r?\n/);

      for (const line of cleanedLines) {
        // Try original regex
        const match = line.match(CONTEXT_USAGE_REGEX);
        if (match) {
          return match[1].replace(/\s+/g, ' ').trim();
        }

        // Try alternative format
        const altMatch = line.match(CONTEXT_USAGE_ALT_REGEX);
        if (altMatch) {
          const used = parseInt(altMatch[1].replace(/,/g, ''), 10);
          const max = parseInt(altMatch[2].replace(/,/g, ''), 10);
          const percentage = Math.round((used / max) * 100);
          return `${formatTokenCount(used)}/${formatTokenCount(max)} tokens (${percentage}%)`;
        }
      }
    }

    return null;
  };

  const updateClaudePanelCustomState = async (
    panelId: string,
    mutator: (state: ClaudePanelState) => ClaudePanelState
  ): Promise<ClaudePanelState | undefined> => {
    // Use mutex to prevent read-modify-write race conditions on panel state
    const { withLock } = await import('./utils/mutex');
    return await withLock(`panel-state-${panelId}`, async () => {
      const panel = panelManager.getPanel(panelId);
      if (!panel) {
        return undefined;
      }

      const existing = (panel.state.customState as ClaudePanelState | undefined) ?? {};
      const baseState: ClaudePanelState = { ...existing };

      if (!('contextUsage' in baseState)) {
        baseState.contextUsage = null;
      }

      const nextCustomState = mutator({ ...baseState });
      const nextPanelState = {
        ...panel.state,
        customState: nextCustomState
      };

      await panelManager.updatePanel(panelId, { state: nextPanelState });

      const mw = getMainWindow();
      if (mw && !mw.isDestroyed()) {
        try {
          mw.webContents.send('panel:updated', {
            ...panel,
            state: nextPanelState
          });
        } catch (ipcError) {
          console.error(`[Main] Failed to send panel:updated event for panel ${panelId}:`, ipcError);
        }
      }

      return nextCustomState;
    });
  };

  /**
   * Update the status of an AI panel and notify frontend
   */
  const updateAIPanelStatus = async (
    panelId: string,
    status: PanelStatus,
    hasUnviewedContent?: boolean
  ): Promise<void> => {
    const { withLock } = await import('./utils/mutex');
    return await withLock(`panel-state-${panelId}`, async () => {
      const panel = panelManager.getPanel(panelId);
      if (!panel) {
        return;
      }

      // Only update status for AI panels (claude)
      if (panel.type !== 'claude') {
        return;
      }

      const existing = (panel.state.customState as BaseAIPanelState | undefined) ?? {};
      const nextCustomState: BaseAIPanelState = {
        ...existing,
        panelStatus: status,
        lastActivityTime: new Date().toISOString()
      };

      // Only update hasUnviewedContent if explicitly provided
      if (hasUnviewedContent !== undefined) {
        nextCustomState.hasUnviewedContent = hasUnviewedContent;
      }

      const nextPanelState = {
        ...panel.state,
        customState: nextCustomState
      };

      await panelManager.updatePanel(panelId, { state: nextPanelState });

      const mw = getMainWindow();
      if (mw && !mw.isDestroyed()) {
        try {
          mw.webContents.send('panel:updated', {
            ...panel,
            state: nextPanelState
          });
        } catch (ipcError) {
          console.error(`[Main] Failed to send panel:updated event for panel ${panelId}:`, ipcError);
        }
      }
    });
  };

  /**
   * Check if the panel is currently the active panel for its session
   */
  const isPanelActive = (panelId: string, _sessionId: string): boolean => {
    // Check if this panel is the active panel by looking at the panel's isActive state
    const panel = panelManager.getPanel(panelId);
    if (!panel) return false;

    // Use the panel's state.isActive property which is set when a panel becomes active
    return panel.state.isActive === true;
  };

  /**
   * Shared guard for claudeCodeManager events: drop synthetic identities, then
   * validate the panel/session context. Returns false when the event must be
   * ignored.
   */
  const acceptClaudeEvent = (
    label: string,
    eventData: Record<string, unknown>,
    panelId: string | undefined,
    sessionId: string
  ): boolean => {
    if (isSyntheticEventIdentity(panelId, sessionId)) return false;

    const validation = panelId
      ? validatePanelEventContext(eventData, panelId, sessionId)
      : validateEventContext(eventData, sessionId);

    if (!validation.valid) {
      logValidationFailure(`claudeCodeManager ${label} event`, validation);
      return false;
    }
    return true;
  };

  // Listen to sessionManager events and broadcast to renderer
  sessionManager.on('session-created', async (session) => {
    const mw = getMainWindow();
    if (mw && !mw.isDestroyed()) {
      try {
        mw.webContents.send('session:created', session);
      } catch (error) {
        console.error('[Main] Failed to send session:created event:', error);
      }
    }
    
    // Auto-create AI panel for sessions with prompts
    if (session.prompt && typeof session.prompt === 'string' && session.prompt.trim().length > 0) {
      const inferredToolType: 'claude' | 'none' = session.toolType === 'none' ? 'none' : 'claude';

      if (inferredToolType !== 'none') {
        try {
          // Prepare initial custom state for the Claude panel
          const claudeConfig = session.claudeConfig || {};
          const customState: ClaudePanelState = {
            permissionMode: claudeConfig.permissionMode || DEFAULT_PERMISSION_MODE,
            model: claudeConfig.model || 'auto'
          };

          const panel = await panelManager.createPanel({
            sessionId: session.id,
            type: 'claude',
            title: 'Chat',
            initialState: customState
          });

          // Ensure the panel is set as active
          await panelManager.setActivePanel(session.id, panel.id);

          // Save the config to the settings column for persistence
          databaseService.updatePanelSettings(panel.id, {
            model: customState.model,
            permissionMode: customState.permissionMode
          });

          // Register with the Claude panel manager
          try {
            const { claudePanelManager } = require('./ipc/claudePanel');
            if (claudePanelManager) {
              claudePanelManager.registerPanel(panel.id, session.id, panel.state.customState);
            } else {
              console.warn('[Events] ClaudePanelManager not initialized yet; panel will register later');
            }
          } catch (err) {
            console.error('[Events] Failed to register Claude panel with its manager:', err);
          }
        } catch (error) {
          console.error(`[Events] Failed to auto-create Claude panel for session ${session.id}:`, error);
        }
      }
    }
    
    // Refresh git status for newly created session (non-blocking for UI responsiveness)
    if (session.id && !session.archived) {
      // Add a small delay for newly created sessions to prevent overwhelming git operations
      // when multiple sessions are created rapidly
      setTimeout(() => {
        gitStatusManager.refreshSessionGitStatus(session.id, false).catch(error => {
          console.error(`[Main] Failed to refresh git status for new session ${session.id}:`, error);
        });
      }, 1000); // 1 second delay to allow session creation UI to complete
    }
  });

  sessionManager.on('session-updated', (session) => {
    console.log(`[Main] session-updated event received for ${session.id} with status ${session.status}`);
    const mw = getMainWindow();
    if (mw && !mw.isDestroyed()) {
      console.log(`[Main] Sending session:updated to renderer for ${session.id}`);
      try {
        mw.webContents.send('session:updated', session);
      } catch (error) {
        console.error('[Main] Failed to send session:updated event:', error);
      }
    } else {
      console.error(`[Main] Cannot send session:updated - mainWindow is ${mw ? 'destroyed' : 'null'}`);
    }
  });

  sessionManager.on('session-deleted', (session) => {
    const mw = getMainWindow();
    if (mw && !mw.isDestroyed()) {
      try {
        mw.webContents.send('session:deleted', session);
      } catch (error) {
        console.error('[Main] Failed to send session:deleted event:', error);
      }
    }
  });

  sessionManager.on('sessions-loaded', (sessions) => {
    const mw = getMainWindow();
    if (mw && !mw.isDestroyed()) {
      try {
        mw.webContents.send('sessions:loaded', sessions);
      } catch (error) {
        console.error('[Main] Failed to send sessions:loaded event:', error);
      }
    }
  });

  sessionManager.on('session-output', (output) => {
    // Validate the output has valid session context
    const validation = validateEventContext(output);
    if (!validation.valid) {
      logValidationFailure('session-output event', validation);
      return; // Don't broadcast invalid events
    }

    const mw = getMainWindow();
    if (mw) {
      mw.webContents.send('session:output', output);
    }
  });

  sessionManager.on('session-output-available', (info) => {
    const mw = getMainWindow();
    if (mw) {
      mw.webContents.send('session:output-available', info);
    }
  });

  // Listen for new prompts being added to panels
  sessionManager.on('panel-prompt-added', (data) => {
    const mw = getMainWindow();
    if (mw && !mw.isDestroyed()) {
      try {
        mw.webContents.send('panel:prompt-added', data);
      } catch (error) {
        console.error('[Main] Failed to send panel:prompt-added:', error);
      }
    }
  });

  // Listen for assistant responses being added to panels
  sessionManager.on('panel-response-added', (data) => {
    console.log('[Events] Received panel-response-added event for panel:', data.panelId);
    const mw = getMainWindow();
    if (mw && !mw.isDestroyed()) {
      try {
        console.log('[Events] Sending panel:response-added to renderer for panel:', data.panelId);
        mw.webContents.send('panel:response-added', data);
      } catch (error) {
        console.error('[Main] Failed to send panel:response-added:', error);
      }
    }
  });

  // Listen for project update events from sessionManager (since it extends EventEmitter)
  sessionManager.on('project:updated', (project: Project) => {
    console.log(`[Main] Project updated: ${project.id}`);
    const mw = getMainWindow();
    if (mw && !mw.isDestroyed()) {
      mw.webContents.send('project:updated', project);
    }
  });

  // Guarded-model mid-call fallback (Fable 5.1 pulled): a run's turn discovered its
  // pinned model was unavailable and transparently retried on Opus. Forward to the
  // renderer so the quick-session composer swaps its model pill + shows a toast.
  claudeCodeManager.on('model-fallback', (payload: ModelFallbackNotice) => {
    const mw = getMainWindow();
    if (mw && !mw.isDestroyed()) {
      try {
        mw.webContents.send('model-fallback', payload);
      } catch {
        /* window torn down mid-send — ignore */
      }
    }
  });

  // Per-turn fast-mode report (CLI `fast_mode_state` changed): forward so the
  // composer's Fast pill can warn when a requested opt-in didn't engage (org
  // entitlement / credits / cooldown) instead of silently showing the toggle.
  claudeCodeManager.on('fast-mode-state', (payload: FastModeStateNotice) => {
    const mw = getMainWindow();
    if (mw && !mw.isDestroyed()) {
      try {
        mw.webContents.send('fast-mode-state', payload);
      } catch {
        /* window torn down mid-send — ignore */
      }
    }
  });

  // Listen to claudeCodeManager events
  claudeCodeManager.on('output', async (output: {
    panelId: string;
    sessionId: string;
    type: 'json' | 'stdout' | 'stderr';
    data: unknown;
    timestamp: Date
  }) => {
    if (!acceptClaudeEvent('output', output, output.panelId, output.sessionId)) return;

    // Persist output: let ClaudePanelManager handle panel-based storage to avoid duplicates
    if (!output.panelId) {
      console.log(`[Events] Saving Claude output for session ${output.sessionId} (legacy mode)`);
      
      sessionManager.addSessionOutput(output.sessionId, {
        type: output.type,
        data: output.data,
        timestamp: output.timestamp
      });
    }

    // Check if Claude is waiting for user input
    if (output.type === 'json' && typeof output.data === 'object' && output.data && 'type' in output.data && output.data.type === 'prompt') {
      console.log(`[Main] Claude is waiting for user input in session ${output.sessionId}`);
      // Update panel status to waiting
      if (output.panelId) {
        await updateAIPanelStatus(output.panelId, 'waiting');
      }
      await sessionManager.updateSession(output.sessionId, { status: 'waiting' });
    }

    // Check if Claude has completed (when it sends a result message)
    if (output.type === 'json' && typeof output.data === 'object' && output.data && 'type' in output.data && output.data.type === 'system' && 'subtype' in output.data && output.data.subtype === 'result') {
      console.log(`[Main] Claude completed task in session ${output.sessionId}`);
      // Don't update status here - let the exit handler determine if it should be completed_unviewed
    }

    // Send real-time updates to renderer
    const mw = getMainWindow();
    if (mw) {
      // Always send the output as-is, without formatting
      mw.webContents.send('session:output', output);
    }
  });

  claudeCodeManager.on('spawned', async ({ panelId, sessionId }: { panelId?: string; sessionId: string }) => {
    if (!acceptClaudeEvent('spawned', { panelId, sessionId }, panelId, sessionId)) return;

    // Update panel status to running
    if (panelId) {
      await updateAIPanelStatus(panelId, 'running');
    }

    // Add a small delay to ensure the session is fully initialized
    await new Promise(resolve => setTimeout(resolve, 100));

    await sessionManager.updateSession(sessionId, {
      status: 'running',
      run_started_at: 'CURRENT_TIMESTAMP'
    });

    // Start execution tracking
    try {
      const session = await sessionManager.getSession(sessionId);
      if (session && session.worktreePath) {
        // The latest prompt comes from the session's first Claude panel's prompt
        // markers; a session with no Claude panel (created before its panel, or
        // whose panel create failed) reads the session-scoped markers instead.
        const eventsPanels = panelManager.getPanelsForSession(sessionId);
        const eventsClaudePanels = eventsPanels.filter((p: ToolPanel) => p.type === 'claude');

        const promptMarkers = eventsClaudePanels.length > 0
          ? sessionManager.getPanelPromptMarkers(eventsClaudePanels[0].id)
          : sessionManager.getPromptMarkers(sessionId);

        const latestPrompt = promptMarkers.length > 0
          ? promptMarkers[promptMarkers.length - 1].prompt_text
          : session.prompt;

        await executionTracker.startExecution(sessionId, session.worktreePath, undefined, latestPrompt);

        // NOTE: Run commands are NOT started automatically when Claude spawns
        // They should only run when the user clicks the play button
      }
    } catch (error) {
      console.error(`Failed to start execution tracking for session ${sessionId}:`, error);
    }
  });

  claudeCodeManager.on('exit', async ({ panelId, sessionId, exitCode }: { panelId?: string; sessionId: string; exitCode: number | null; signal: number | null | string }) => {
    if (!acceptClaudeEvent('exit', { panelId, sessionId }, panelId, sessionId)) return;

    // Update panel status to stopped/completed_unviewed
    if (panelId) {
      const isActive = isPanelActive(panelId, sessionId);
      // If panel is not active, mark as having unviewed content
      const panelStatusOnExit: PanelStatus = exitCode === 0 && !isActive ? 'completed_unviewed' : 'stopped';
      await updateAIPanelStatus(panelId, panelStatusOnExit, exitCode === 0 && !isActive);
    }

    if (exitCode !== null && exitCode !== undefined) {
      await sessionManager.setSessionExitCode(sessionId, exitCode);
    }

    const session = sessionManager.getSession(sessionId);
    if (session) {
      const dbSession = sessionManager.getDbSession(sessionId);

      // Check if ALL panels for this session have stopped before updating session status
      const sessionPanels = panelManager.getPanelsForSession(sessionId);
      const aiPanels = sessionPanels.filter((p: ToolPanel) => p.type === 'claude');

      // Check if any AI panel is still running
      const hasRunningPanels = aiPanels.some((p: ToolPanel) => {
        const customState = p.state?.customState as BaseAIPanelState | undefined;
        return customState?.panelStatus === 'running' || customState?.panelStatus === 'waiting';
      });

      // Only update session status if no panels are still running
      if (!hasRunningPanels) {
        // If exit code is 0 (successful completion), mark as completed
        // The updateSession method will handle converting to 'completed_unviewed' if not viewed
        if (exitCode === 0 && dbSession && dbSession.status === 'running') {
          // Update to 'stopped' which will be converted to 'completed_unviewed' by the mapping logic
          // since the database status will be set to 'completed'
          sessionManager.db.updateSession(sessionId, { status: 'completed' });

          // Get the updated session with proper status mapping
          const updatedSession = sessionManager.getSession(sessionId);
          if (updatedSession) {
            // Manually emit the event since we bypassed updateSession for direct DB access
            sessionManager.emit('session-updated', updatedSession);
          }
        }
        // For non-zero exit codes or already completed sessions
        else if (dbSession && dbSession.status !== 'completed') {
          await sessionManager.updateSession(sessionId, { status: 'stopped' });
        }
      }
      // If panels are still running, keep session in running state
      else if (dbSession && dbSession.status !== 'running') {
        await sessionManager.updateSession(sessionId, { status: 'running' });
      }
    }

    try {
      if (executionTracker.isTracking(sessionId)) {
        await executionTracker.endExecution(sessionId);
      }
    } catch (error) {
      console.error(`Failed to end execution tracking for session ${sessionId}:`, error);
    }

    // Refresh the context-% meter on every successful turn from the turn's own
    // SDK usage data: the newest assistant message's usage (input + cache read +
    // cache creation) is the API-reported prompt size for this turn, so no extra
    // probe turn is needed (the old hidden `/context` continuation doubled every
    // turn and is gone). getPanelOutputs is oldest→newest, so reverse to let the
    // NEWEST assistant usage / context window win.
    if (panelId && exitCode === 0) {
      try {
        const recentOutputs = [...sessionManager.getPanelOutputs(panelId, 200)].reverse();
        const turnContextUsage = extractContextUsageFromOutputs(recentOutputs);
        if (turnContextUsage) {
          await updateClaudePanelCustomState(panelId, (state) => ({
            ...state,
            contextUsage: turnContextUsage,
          }));
        }
      } catch (ctxErr) {
        console.warn(`[Main] per-turn context-% refresh failed for panel ${panelId}:`, ctxErr);
      }
    }

    // Refresh git status after Claude exits, as it may have made commits
    try {
      await gitStatusManager.refreshSessionGitStatus(sessionId);
    } catch (error) {
      console.error(`Failed to refresh git status for session ${sessionId} after exit:`, error);
    }
  });

  claudeCodeManager.on('error', async ({ panelId, sessionId, error }: { panelId?: string; sessionId: string; error: string }) => {
    if (!acceptClaudeEvent('error', { panelId, sessionId }, panelId, sessionId)) return;

    if (panelId) {
      console.log(`Panel ${panelId} (session ${sessionId}) encountered an error: ${error}`);
      // Update panel status to error
      await updateAIPanelStatus(panelId, 'error');
    } else {
      console.log(`Session ${sessionId} encountered an error: ${error}`);
    }
    await sessionManager.updateSession(sessionId, { status: 'error', error });

    // Cancel execution tracking on error
    try {
      if (executionTracker.isTracking(sessionId)) {
        executionTracker.cancelExecution(sessionId);
      }
    } catch (trackingError) {
      console.error(`Failed to cancel execution tracking for session ${sessionId}:`, trackingError);
    }
  });

  // OMP fleet runtime (omp-phase4-coexistence-adr.md increment 4). A remote
  // worker with no local child process: its raw text output is projected to the
  // SAME JSON assistant-message shape the SDK transcript projects, so the
  // unified chat renders it with no new frontend surface. The manager is
  // optional (undefined when the bridge config did not resolve) — guard on it.
  const ompSessionManager = services.ompSessionManager;
  if (ompSessionManager) {
    let ompOutputSeq = 0;
    ompSessionManager.on(
      'output',
      async ({ panelId, sessionId, data }: { panelId: string; sessionId: string; data: string }) => {
        if (isCyboflowRunId(panelId) || isCyboflowRunId(sessionId)) return;
        // Project raw worker text to a structured assistant message so the
        // existing projectStoredOutputs → MessageProjection path renders it.
        ompOutputSeq += 1;
        const messageId = `omp-${panelId}-${ompOutputSeq}`;
        sessionManager.addPanelOutput(panelId, {
          type: 'json',
          data: {
            type: 'assistant',
            message: {
              id: messageId,
              model: 'omp-fleet',
              role: 'assistant',
              content: [{ type: 'text', text: data }],
            },
            session_id: sessionId,
          },
          timestamp: new Date(),
        });
        const mw = getMainWindow();
        if (mw && !mw.isDestroyed()) {
          mw.webContents.send('session:output', { panelId, sessionId, type: 'stdout', data });
        }
      },
    );

    ompSessionManager.on('spawned', async ({ panelId, sessionId }: { panelId: string; sessionId: string }) => {
      if (isCyboflowRunId(panelId) || isCyboflowRunId(sessionId)) return;
      await updateAIPanelStatus(panelId, 'running');
      await sessionManager.updateSession(sessionId, { status: 'running' });
    });

    ompSessionManager.on(
      'exit',
      async ({ panelId, sessionId, exitCode }: { panelId: string; sessionId: string; exitCode: number | null }) => {
        if (isCyboflowRunId(panelId) || isCyboflowRunId(sessionId)) return;
        const isActive = isPanelActive(panelId, sessionId);
        const panelStatusOnExit: PanelStatus = exitCode === 0 && !isActive ? 'completed_unviewed' : 'stopped';
        await updateAIPanelStatus(panelId, panelStatusOnExit, exitCode === 0 && !isActive);
        const dbSession = sessionManager.getDbSession(sessionId);
        if (dbSession && dbSession.status === 'running') {
          // Write the DB status raw, then re-fetch + emit 'session-updated' —
          // the same shape as the SDK completion path. 'completed' has no
          // app-level Session status: mapDbStatusToSessionStatus turns it into
          // completed_unviewed when unviewed, so refreshSessionFromDatabase
          // (convert + activeSessions.set + emit) surfaces the right status.
          sessionManager.db.updateSession(sessionId, { status: exitCode === 0 ? 'completed' : 'stopped' });
          sessionManager.refreshSessionFromDatabase(sessionId);
        }
      },
    );

    ompSessionManager.on(
      'error',
      async ({ panelId, sessionId, error, transient }: { panelId: string; sessionId: string; error: string; transient: boolean }) => {
        if (isCyboflowRunId(panelId) || isCyboflowRunId(sessionId)) return;
        console.error(`[Events] OMP worker error for panel ${panelId}: ${error}`);
        // A TRANSIENT error leaves the worker live — one bridge blip must not
        // park the panel in 'error' forever. Nothing ever clears that badge:
        // 'spawned' fires once at spawn, so the panel would read as failed for
        // the rest of a perfectly healthy run. Real termination arrives as
        // 'exit' and is handled above.
        if (transient) return;
        await updateAIPanelStatus(panelId, 'error');
      },
    );
  }
}
