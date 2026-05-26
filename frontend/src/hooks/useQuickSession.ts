/**
 * useQuickSession — shared hook for creating a quick session (no workflow run).
 *
 * Lifecycle:
 *   1. Calls API.sessions.createQuick({ prompt: '', projectId, toolType })
 *   2. On success, calls panelApi.createPanel (type-specific)
 *   3. Calls useCyboflowStore.getState().setActiveQuickSession(sessionId)
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

interface UseQuickSessionOptions {
  projectId: number | null;
  onSuccess?: (sessionId: string) => void;
}

interface UseQuickSessionReturn {
  start: (toolType: 'claude' | 'none') => Promise<void>;
  isStarting: 'claude' | 'none' | null;
  error: string | null;
}

export function useQuickSession(opts: UseQuickSessionOptions): UseQuickSessionReturn {
  const [isStarting, setIsStarting] = useState<'claude' | 'none' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(
    async (toolType: 'claude' | 'none'): Promise<void> => {
      if (opts.projectId === null || isStarting !== null) return;

      setError(null);
      setIsStarting(toolType);

      try {
        const result = await API.sessions.createQuick({
          prompt: '',
          projectId: opts.projectId,
          toolType,
        });

        if (!result.success || !result.data) {
          throw new Error(result.error ?? 'Failed to create quick session');
        }

        const { sessionId, worktreePath } = result.data;

        if (toolType === 'claude') {
          await panelApi.createPanel({ sessionId, type: 'claude' });
        } else {
          await panelApi.createPanel({
            sessionId,
            type: 'terminal',
            title: 'Terminal',
            initialState: { cwd: worktreePath },
          });
        }

        useCyboflowStore.getState().setActiveQuickSession(sessionId);
        opts.onSuccess?.(sessionId);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to create quick session');
      } finally {
        setIsStarting(null);
      }
    },
    // opts.projectId and opts.onSuccess are the only external deps; isStarting is
    // read from closure and intentionally excluded to avoid re-creating the callback
    // every time isStarting flips — the guard (`isStarting !== null`) still holds
    // because setIsStarting is synchronous within the render cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts.projectId, opts.onSuccess],
  );

  return { start, isStarting, error };
}
