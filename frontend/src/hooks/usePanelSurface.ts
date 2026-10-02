/**
 * usePanelSurface — CyboflowRoot's central panel surface: resolves the
 * main-repo session, loads its panels, and handles panel select/close.
 *
 * Session priority: when a quick session is active (selectedSessionId in cyboflowStore),
 * panel operations target it instead of mainRepoSession — the quick session's panels are
 * what the user is interacting with.
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import type { Session } from '../types/session';
import type { ToolPanel } from '../../../shared/types/panels';
import { usePanelStore } from '../stores/panelStore';
import { panelApi } from '../services/panelApi';
import { API } from '../utils/api';
import { useSessionStore } from '../stores/sessionStore';
import { useCyboflowStore } from '../stores/cyboflowStore';
import { disposeInteractiveTerminal } from '../components/cyboflow/InteractiveTerminalView';

export interface UsePanelSurfaceResult {
  mainRepoSession: Session | null;
  effectiveSession: Session | null;
  sessionPanels: ToolPanel[];
  currentActivePanel: ToolPanel | undefined;
  handlePanelSelect: (panel: ToolPanel) => Promise<void>;
  handlePanelClose: (panel: ToolPanel) => Promise<void>;
}

export function usePanelSurface(projectId: number | null): UsePanelSurfaceResult {
  // --- Main-repo session resolution ---
  const [mainRepoSessionId, setMainRepoSessionId] = useState<string | null>(null);
  const [mainRepoSession, setMainRepoSession] = useState<Session | null>(null);

  // --- Quick session resolution ---
  const selectedSessionId = useCyboflowStore((s) => s.selectedSessionId);
  const [quickSession, setQuickSession] = useState<Session | null>(null);

  const effectiveSessionId = selectedSessionId ?? mainRepoSessionId;
  const effectiveSession = selectedSessionId ? quickSession : mainRepoSession;

  const {
    panels,
    activePanels,
    setPanels,
    setActivePanel: setActivePanelInStore,
    addPanel,
    removePanel,
  } = usePanelStore();

  // Resolve the main-repo session for the active project.
  useEffect(() => {
    if (projectId === null) {
      setMainRepoSessionId(null);
      setMainRepoSession(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await API.sessions.getOrCreateMainRepoSession(projectId);
        if (cancelled) return;
        if (response.success && response.data) {
          setMainRepoSessionId(response.data.id);
          setMainRepoSession(response.data);
          // Activate the main-repo session for session-scoped panels ONLY when no
          // quick session is selected — otherwise Effect B (below) owns activation.
          // Activating main-repo here while a quick session is selected clobbers
          // activeSessionId, defeating setActiveSession's wasAlreadyActive guard and
          // spuriously re-firing markSessionAsViewed on the quick session every time
          // the surface remounts (e.g. returning from the Human review pane). That
          // false "view" both clears the unviewed badge and resets the idle clock.
          if (!selectedSessionId) {
            await useSessionStore.getState().setActiveSession(response.data.id);
          }
        }
      } catch (err) {
        console.error('[usePanelSurface] Failed to resolve main-repo session:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedSessionId]);

  // Resolve the quick session when one becomes active.
  useEffect(() => {
    if (!selectedSessionId) {
      setQuickSession(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await API.sessions.get(selectedSessionId);
        if (cancelled) return;
        if (response.success && response.data) {
          setQuickSession(response.data as Session);
          await useSessionStore.getState().setActiveSession(selectedSessionId);
        }
      } catch (err) {
        console.error('[usePanelSurface] Failed to resolve quick session:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId]);

  // Load panels when mainRepoSessionId changes.
  useEffect(() => {
    if (!mainRepoSessionId) return;
    const id = mainRepoSessionId;
    panelApi
      .loadPanelsForSession(id)
      // Diff lives in the right rail now — never surface a central 'diff' panel.
      .then((loaded) => setPanels(id, loaded.filter((p) => p.type !== 'diff')))
      .catch((err) => console.error('[usePanelSurface] Failed to load panels:', err));
  }, [mainRepoSessionId, setPanels]);

  // Load panels for quick session when it becomes active.
  useEffect(() => {
    if (!selectedSessionId) return;
    panelApi
      .loadPanelsForSession(selectedSessionId)
      .then((loaded) => {
        // Diff lives in the right rail now — never surface a central 'diff' panel.
        const surfacePanels = loaded.filter((p) => p.type !== 'diff');
        setPanels(selectedSessionId, surfacePanels);
        const firstPanel = surfacePanels[0];
        if (firstPanel) {
          setActivePanelInStore(selectedSessionId, firstPanel.id);
        }
      })
      .catch((err) => console.error('[usePanelSurface] Failed to load quick session panels:', err));
  }, [selectedSessionId, setPanels, setActivePanelInStore]);

  // Subscribe to sessionStore changes to keep mainRepoSession in sync with IPC-driven updates
  // (e.g. updateSession fired by useIPCEvents when the backend emits a session-updated event).
  useEffect(() => {
    if (!mainRepoSessionId) return;
    let previousSession = useSessionStore.getState().sessions.find(
      (s) => s.id === mainRepoSessionId,
    );
    const unsubscribe = useSessionStore.subscribe((state) => {
      const session = state.sessions.find((s) => s.id === mainRepoSessionId);
      if (session && session !== previousSession) {
        previousSession = session;
        setMainRepoSession(session);
      }
    });
    return unsubscribe;
  }, [mainRepoSessionId]);

  // Subscribe to panel:created events scoped to the effective session.
  useEffect(() => {
    if (!effectiveSessionId) return;
    const handler = (panel: ToolPanel) => {
      // Diff lives in the right rail now — never surface a central 'diff' panel.
      if (panel.type === 'diff') return;
      if (panel.sessionId === effectiveSessionId) addPanel(panel);
    };
    const unsubscribe = window.electronAPI?.events?.onPanelCreated?.(handler);
    return () => {
      unsubscribe?.();
    };
  }, [effectiveSessionId, addPanel]);

  const sessionPanels = useMemo(
    () => panels[effectiveSessionId ?? ''] ?? [],
    [panels, effectiveSessionId],
  );

  const currentActivePanel = useMemo(
    () => sessionPanels.find((p) => p.id === activePanels[effectiveSessionId ?? '']),
    [sessionPanels, activePanels, effectiveSessionId],
  );

  const handlePanelSelect = useCallback(
    async (panel: ToolPanel) => {
      if (!effectiveSessionId) return;
      setActivePanelInStore(effectiveSessionId, panel.id);
      await panelApi.setActivePanel(effectiveSessionId, panel.id);
    },
    [effectiveSessionId, setActivePanelInStore],
  );

  const handlePanelClose = useCallback(
    async (panel: ToolPanel) => {
      if (!effectiveSessionId) return;

      const closeAndActivate = async (next: ToolPanel | undefined) => {
        removePanel(effectiveSessionId, panel.id);
        if (next && next.id !== panel.id) {
          setActivePanelInStore(effectiveSessionId, next.id);
          await panelApi.setActivePanel(effectiveSessionId, next.id);
        }
        // Explicit panel close is a REAL end-of-life: the backend kills the PTY
        // (panels:delete → stopPanel + unregisterPanel). Evict the keep-alive
        // xterm cache so the cached terminal does not leak or stale-restore a
        // dead run (ISSUE B). InteractiveTerminalView's cache key is panel.id
        // for a Claude 'interactive' substrate panel (own-identity, TASK-103
        // Add-chat — see ClaudePanel.tsx's interactiveRunId) and the session's
        // chatRunId for a codex-pty panel (unchanged, still session-scoped:
        // Add-chat only creates Claude panels). Try both — disposeInteractiveTerminal
        // is a no-op for a key with no live cache entry, so this is safe
        // regardless of which substrate this panel actually ran on.
        if (panel.type === 'claude') {
          disposeInteractiveTerminal(panel.id);
          const closedSession = useSessionStore
            .getState()
            .sessions.find((s) => s.id === panel.sessionId);
          if (closedSession?.chatRunId) disposeInteractiveTerminal(closedSession.chatRunId);
        }
        await panelApi.deletePanel(panel.id);
      };

      const idx = sessionPanels.findIndex((p) => p.id === panel.id);
      const next: ToolPanel | undefined = sessionPanels[idx + 1] ?? sessionPanels[idx - 1];

      await closeAndActivate(next);
    },
    [effectiveSessionId, sessionPanels, removePanel, setActivePanelInStore],
  );

  return {
    mainRepoSession,
    effectiveSession,
    sessionPanels,
    currentActivePanel,
    handlePanelSelect,
    handlePanelClose,
  };
}
