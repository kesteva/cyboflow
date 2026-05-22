import { useCallback } from 'react';
import { panelApi } from '../services/panelApi';
import { usePanelStore } from '../stores/panelStore';

/**
 * Minimal session shape the hook needs. Pass `null`/`undefined` to disable
 * the callback (it will warn and no-op when invoked).
 */
export interface UseEnsureClaudePanelSession {
  id: string;
}

export interface UseEnsureClaudePanelOptions {
  /** Log tag for the no-session guard's console.warn. Defaults to 'useEnsureClaudePanel'. */
  logTag?: string;
}

/**
 * Returns a memoized callback that finds an existing Claude panel for the given
 * session and activates it, or creates a new one if none exists. The callback is
 * a no-op (with a console.warn) when session is null/undefined.
 *
 * Find-or-create semantics ("ensure"):
 *   - If a Claude panel already exists: activates it via setActivePanelInStore +
 *     panelApi.setActivePanel and returns — does NOT create a duplicate.
 *   - If no Claude panel exists: calls panelApi.createPanel with { sessionId, type: 'claude' },
 *     registers it via addPanel, marks it active via setActivePanelInStore. Does NOT call
 *     panelApi.setActivePanel after creation — relies on the panel:created event for backend
 *     activation, matching the original ProjectView.ensureClaudePanel contract.
 *
 * Panels are read inside the callback via usePanelStore.getState() to avoid
 * re-creating the callback on every panel-store mutation.
 *
 * Shared by ProjectView (migration) and CyboflowRoot so future changes to the
 * find-or-create logic propagate to both call sites.
 */
export function useEnsureClaudePanel(
  session: UseEnsureClaudePanelSession | null | undefined,
  options: UseEnsureClaudePanelOptions = {},
): () => Promise<void> {
  const { addPanel, setActivePanel: setActivePanelInStore } = usePanelStore();
  const { logTag = 'useEnsureClaudePanel' } = options;

  return useCallback(async () => {
    if (!session) {
      console.warn(`[${logTag}] Cannot ensure Claude panel: missing session`);
      return;
    }

    // Read panels inside the callback to avoid stale closure — we don't want the
    // callback to re-create just because the panel list changed.
    const panels = usePanelStore.getState().panels;
    const existing = (panels[session.id] ?? []).find((p) => p.type === 'claude');

    if (existing) {
      // Activate the existing Claude panel — no creation.
      setActivePanelInStore(session.id, existing.id);
      await panelApi.setActivePanel(session.id, existing.id);
      return;
    }

    // No Claude panel yet — create one.
    const newPanel = await panelApi.createPanel({
      sessionId: session.id,
      type: 'claude',
    });
    addPanel(newPanel);
    setActivePanelInStore(session.id, newPanel.id);
    // NOTE: panelApi.setActivePanel is intentionally NOT called here.
    // The original ProjectView.ensureClaudePanel relied on the panel:created
    // event for backend activation. This hook preserves that contract so the
    // ProjectView migration (step 8) is behavior-equivalent.
  }, [session, addPanel, setActivePanelInStore, logTag]);
}
