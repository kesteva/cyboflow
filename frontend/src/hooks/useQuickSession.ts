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
import { useCyboflowStore } from '../stores/cyboflowStore';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { CliSubstrate } from '../../../shared/types/substrate';

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
   */
  start: (
    agentPermissionMode?: PermissionMode,
    substrate?: CliSubstrate,
    effort?: 'ultracode',
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
    ): Promise<void> => {
      if (opts.projectId === null || isStarting) return;

      setError(null);
      setIsStarting(true);

      try {
        const result = await API.sessions.createQuick({
          prompt: '',
          projectId: opts.projectId,
          ...(agentPermissionMode ? { agentPermissionMode } : {}),
          ...(substrate ? { substrate } : {}),
          ...(effort ? { effort } : {}),
        });

        if (!result.success || !result.data) {
          throw new Error(result.error ?? 'Failed to create quick session');
        }

        const { sessionId, worktreePath, runId, claudePanelId } = result.data;

        // Claude panel first (unless the server eagerly created it — interactive
        // sessions spawn the PTY REPL during create-quick and return its panel id),
        // then Terminal.
        if (claudePanelId === undefined) {
          await panelApi.createPanel({ sessionId, type: 'claude' });
        }
        await panelApi.createPanel({
          sessionId,
          type: 'terminal',
          title: 'Terminal',
          initialState: { cwd: worktreePath },
        });

        useCyboflowStore.getState().setActiveQuickSession(sessionId, runId);
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
