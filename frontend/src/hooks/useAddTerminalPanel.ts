import { useCallback } from 'react';
import { panelApi } from '../services/panelApi';
import { usePanelStore } from '../stores/panelStore';

/**
 * Minimal session shape the hook needs. Pass `null`/`undefined` to disable
 * the callback (it will warn and no-op when invoked).
 */
export interface UseAddTerminalPanelSession {
  id: string;
  worktreePath?: string;
}

export interface UseAddTerminalPanelOptions {
  /** Optional side-effect run after the panel is activated. Used to track navigation history. */
  onAfterActivate?: (sessionId: string, panelId: string) => void;
  /** Log tag for the no-session guard's console.warn. Defaults to 'useAddTerminalPanel'. */
  logTag?: string;
}

/**
 * Returns a memoized callback that creates a new terminal panel for the given session,
 * registers it in the panel store, marks it active, and fires the optional onAfterActivate
 * side-effect. The callback is a no-op (with a console.warn) when session is null/undefined.
 *
 * Shared by ProjectView and other views so future changes to panelApi.createPanel's
 * input shape (or to the post-create activation sequence) propagate to all call sites.
 */
export function useAddTerminalPanel(
  session: UseAddTerminalPanelSession | null | undefined,
  options: UseAddTerminalPanelOptions = {}
): () => Promise<void> {
  const { addPanel, setActivePanel: setActivePanelInStore } = usePanelStore();
  const { onAfterActivate, logTag = 'useAddTerminalPanel' } = options;

  return useCallback(async () => {
    if (!session) {
      console.warn(`[${logTag}] Cannot add terminal: missing session`);
      return;
    }
    const newPanel = await panelApi.createPanel({
      sessionId: session.id,
      type: 'terminal',
      title: 'Terminal',
      initialState: { cwd: session.worktreePath },
    });
    addPanel(newPanel);
    setActivePanelInStore(session.id, newPanel.id);
    await panelApi.setActivePanel(session.id, newPanel.id);
    if (onAfterActivate) {
      onAfterActivate(session.id, newPanel.id);
    }
  }, [session, addPanel, setActivePanelInStore, onAfterActivate, logTag]);
}
