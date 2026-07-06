/**
 * useQuickSession — shared hook for creating a quick session (no workflow run).
 *
 * Lifecycle:
 *   1. Calls API.sessions.createQuick({ prompt: '', projectId })
 *   2. On success, creates both panels in sequence:
 *      a. Claude panel — SKIPPED when the response carries `claudePanelId`
 *         (interactive sessions: the server eagerly created the panel when it
 *         spawned the persistent PTY REPL)
 *      b. Terminal panel (cwd = worktreePath) — always
 *   3. Calls useCyboflowStore.getState().setActiveQuickSession(sessionId, runId)
 *   4. Calls opts.onSuccess?.(sessionId)
 *   5. Clears isStarting (finally)
 *
 * Guards:
 *   - No-ops when projectId is null or a start is already in-flight.
 *
 * This hook replaces the inline handleQuickStart / handlePickQuickMode logic in
 * WorkflowPicker.tsx and CyboflowRoot.tsx, fixing the FIND-SPRINT-037-3 orphan
 * worktree bug where CyboflowRoot skipped panelApi.createPanel and
 * setActiveQuickSession entirely.
 */
import { useState, useCallback } from 'react';
import { API } from '../utils/api';
import { panelApi } from '../services/panelApi';
import { trackEvent } from '../utils/telemetry';
import { useCyboflowStore } from '../stores/cyboflowStore';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { CliSubstrate } from '../../../shared/types/substrate';
import type { QuickSessionWorktreeMode } from '../../../shared/types/worktreeMode';

interface UseQuickSessionOptions {
  projectId: number | null;
  onSuccess?: (sessionId: string) => void;
}

interface UseQuickSessionReturn {
  /**
   * Create the quick session. An optional per-session 4-mode agent-permission
   * override (Session Start Wizard step 3) is threaded into createQuick and
   * persisted on the session; omitted → the session inherits the global default.
   * An optional CLI substrate ('sdk'|'interactive') is likewise threaded and
   * stamped onto sessions.substrate; omitted → SDK (legacy behavior). An optional
   * `effort` ('ultracode') launches the interactive REPL with the ultracode
   * setting (the Ultracode wizard card); omitted → no effort setting.
   *
   * `model` (the Configure model dropdown, e.g. 'opus') and `fastMode` (the
   * fast-mode toggle, default off) are persisted on the claude panel — directly
   * for the frontend-created SDK panel, and via the createQuick request for the
   * interactive eager spawn — so the per-turn respawn (sessions:input) applies them.
   *
   * `worktreeMode` ('worktree' | 'in-place') threads the wizard's Workspace choice
   * into createQuick; omitted → the server floors to the global default. 'in-place'
   * skips worktree creation and works directly in the project checkout (both
   * substrates — the interactive gate needs no checkout writes).
   */
  start: (
    agentPermissionMode?: PermissionMode,
    substrate?: CliSubstrate,
    effort?: 'ultracode',
    model?: string,
    fastMode?: boolean,
    disabledMcpServers?: string[],
    enabledPlugins?: string[],
    worktreeMode?: QuickSessionWorktreeMode,
  ) => Promise<void>;
  isStarting: boolean;
  error: string | null;
}

export function useQuickSession(opts: UseQuickSessionOptions): UseQuickSessionReturn {
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(
    async (
      agentPermissionMode?: PermissionMode,
      substrate?: CliSubstrate,
      effort?: 'ultracode',
      model?: string,
      fastMode?: boolean,
      disabledMcpServers?: string[],
      enabledPlugins?: string[],
      worktreeMode?: QuickSessionWorktreeMode,
    ): Promise<void> => {
      if (opts.projectId === null || isStarting) return;

      setError(null);
      setIsStarting(true);

      try {
        // model + fastMode ride the request as claudeConfig so the INTERACTIVE
        // eager spawn (server-side) receives them; the SDK panel is created on the
        // frontend below and persisted there. Sending both ways is harmless — the
        // SDK create-quick path ignores claudeConfig (no panel to start yet).
        const claudeConfig =
          model !== undefined || fastMode === true
            ? { ...(model !== undefined ? { model } : {}), fastMode: fastMode === true }
            : undefined;

        const result = await API.sessions.createQuick({
          prompt: '',
          projectId: opts.projectId,
          ...(agentPermissionMode ? { agentPermissionMode } : {}),
          ...(substrate ? { substrate } : {}),
          ...(effort ? { effort } : {}),
          ...(claudeConfig ? { claudeConfig } : {}),
          // Per-session MCP deny / plugin selection chosen in the wizard's Advanced
          // section, persisted before the first spawn. MCP is a DENY list → only
          // sent when non-empty (empty = inherit all servers). Plugins are
          // EXCLUSIVE and reflect the current enabled set → the wizard passes
          // `undefined` when unchanged (inherit) and an explicit array otherwise,
          // INCLUDING `[]` ("disable everything"); forward that distinction as-is.
          ...(disabledMcpServers && disabledMcpServers.length > 0 ? { disabledMcpServers } : {}),
          ...(enabledPlugins !== undefined ? { enabledPlugins } : {}),
          // Workspace choice (wizard Advanced) → sessions.in_place (migration 047).
          // Only sent when explicitly chosen; omitted → the server floors to the
          // global quickSessionWorktreeMode default.
          ...(worktreeMode ? { worktreeMode } : {}),
        });

        if (!result.success || !result.data) {
          throw new Error(result.error ?? 'Failed to create quick session');
        }

        const { sessionId, worktreePath, runId, claudePanelId } = result.data;

        // Claude panel first (unless the server eagerly created it — interactive
        // sessions spawn the PTY REPL during create-quick and return its panel id),
        // then Terminal.
        if (claudePanelId === undefined) {
          const claudePanel = await panelApi.createPanel({ sessionId, type: 'claude' });
          // Persist the launch model + fast-mode on the SDK panel so the first
          // (and every) sessions:input turn spawns with them — the request's
          // claudeConfig only reaches the interactive eager spawn, never this
          // frontend-created SDK panel.
          if (model !== undefined) await API.claudePanels.setModel(claudePanel.id, model);
          await API.claudePanels.setFastMode(claudePanel.id, fastMode === true);
        }
        await panelApi.createPanel({
          sessionId,
          type: 'terminal',
          title: 'Terminal',
          initialState: { cwd: worktreePath },
        });

        useCyboflowStore.getState().setActiveQuickSession(sessionId, runId);
        trackEvent('session_created', { kind: 'quick', substrate });
        opts.onSuccess?.(sessionId);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to create quick session');
      } finally {
        setIsStarting(false);
      }
    },
    // opts.projectId and opts.onSuccess are the only external deps; isStarting is
    // read from closure and intentionally excluded to avoid re-creating the callback
    // every time isStarting flips — the guard (`isStarting`) still holds because
    // setIsStarting is synchronous within the render cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts.projectId, opts.onSuccess],
  );

  return { start, isStarting, error };
}
