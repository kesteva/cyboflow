import { useCallback } from 'react';
import { panelApi } from '../services/panelApi';
import { usePanelStore } from '../stores/panelStore';
import type { CliSubstrate } from '../../../shared/types/substrate';

/**
 * Minimal session shape the hook needs. Pass `null`/`undefined` to disable
 * the callback (it will warn and no-op when invoked).
 */
export interface UseAddClaudePanelSession {
  id: string;
  worktreePath?: string;
}

export interface UseAddClaudePanelOptions {
  /** Optional side-effect run after the panel is activated. Used to track navigation history. */
  onAfterActivate?: (sessionId: string, panelId: string) => void;
  /** Log tag for the no-session guard's console.warn. Defaults to 'useAddClaudePanel'. */
  logTag?: string;
}

/**
 * Returns a memoized callback that always creates a new Claude panel for the
 * given session, registers it in the panel store, activates it, and fires the
 * optional onAfterActivate side-effect.
 *
 * Accepts an optional per-panel `substrate` override, applied AT CREATION
 * (CreatePanelRequest.substrate) so the picker offered alongside "Add chat"
 * launches the new panel directly in the chosen substrate.
 * Omitted/undefined inherits the session's substrate, unchanged.
 */
export function useAddClaudePanel(
  session: UseAddClaudePanelSession | null | undefined,
  options: UseAddClaudePanelOptions = {},
): (substrate?: CliSubstrate) => Promise<void> {
  const { addPanel, setActivePanel: setActivePanelInStore } = usePanelStore();
  const { onAfterActivate, logTag = 'useAddClaudePanel' } = options;

  return useCallback(async (substrate?: CliSubstrate) => {
    if (!session) {
      console.warn(`[${logTag}] Cannot add chat: missing session`);
      return;
    }

    const newPanel = await panelApi.createPanel({
      sessionId: session.id,
      type: 'claude',
      initialState: { cwd: session.worktreePath },
      ...(substrate ? { substrate } : {}),
    });
    addPanel(newPanel);
    setActivePanelInStore(session.id, newPanel.id);
    await panelApi.setActivePanel(session.id, newPanel.id);
    if (onAfterActivate) {
      onAfterActivate(session.id, newPanel.id);
    }
  }, [session, addPanel, setActivePanelInStore, onAfterActivate, logTag]);
}
