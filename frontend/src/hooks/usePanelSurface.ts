/**
 * usePanelSurface — unified panel-surface hook.
 *
 * Consolidates the ~90-line panel-surface scaffolding that was duplicated between
 * CyboflowRoot and ProjectView (FIND-SPRINT-032-3).
 *
 * Two modes:
 *   autoCreatePermanentPanels: false  (CyboflowRoot)
 *     – Just loads panels; never auto-creates dashboard/setup-tasks; no permanence guard on close.
 *   autoCreatePermanentPanels: true   (ProjectView)
 *     – Ensures dashboard + setup-tasks permanent panels exist; guards their close; falls back to
 *       dashboard on close of the last non-permanent panel.
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import type { Session } from '../types/session';
import type { ToolPanel } from '../../../shared/types/panels';
import { usePanelStore } from '../stores/panelStore';
import { panelApi } from '../services/panelApi';
import { API } from '../utils/api';
import { useSessionStore } from '../stores/sessionStore';

export interface UsePanelSurfaceOptions {
  autoCreatePermanentPanels: boolean;
}

export interface UsePanelSurfaceResult {
  mainRepoSession: Session | null;
  sessionPanels: ToolPanel[];
  currentActivePanel: ToolPanel | undefined;
  handlePanelSelect: (panel: ToolPanel) => Promise<void>;
  handlePanelClose: (panel: ToolPanel) => Promise<void>;
}

export function usePanelSurface(
  projectId: number | null,
  options: UsePanelSurfaceOptions,
): UsePanelSurfaceResult {
  const { autoCreatePermanentPanels } = options;

  // --- Main-repo session resolution ---
  const [mainRepoSessionId, setMainRepoSessionId] = useState<string | null>(null);
  const [mainRepoSession, setMainRepoSession] = useState<Session | null>(null);

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
          // Activate this session in the session store so session-scoped panels
          // (ClaudePanel → useClaudePanel reads from useSessionStore) see it as active.
          await useSessionStore.getState().setActiveSession(response.data.id);
        }
      } catch (err) {
        console.error('[usePanelSurface] Failed to resolve main-repo session:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Load panels when mainRepoSessionId changes, optionally auto-creating permanent panels.
  useEffect(() => {
    if (!mainRepoSessionId) return;

    const id = mainRepoSessionId;

    if (!autoCreatePermanentPanels) {
      // CyboflowRoot mode: just load, no auto-creation.
      panelApi
        .loadPanelsForSession(id)
        .then((loaded) => setPanels(id, loaded))
        .catch((err) => console.error('[usePanelSurface] Failed to load panels:', err));
      return;
    }

    // ProjectView mode: load, ensure permanent panels, reload, set initial active panel.
    (async () => {
      try {
        const loadedPanels = await panelApi.loadPanelsForSession(id);

        const dashboardPanel = loadedPanels.find((p) => p.type === 'dashboard');
        const setupTasksPanel = loadedPanels.find((p) => p.type === 'setup-tasks');

        let panelsCreated = false;

        if (!dashboardPanel) {
          await panelApi.createPanel({
            sessionId: id,
            type: 'dashboard',
            title: 'Dashboard',
            metadata: { permanent: true },
          });
          panelsCreated = true;
        }

        if (!setupTasksPanel) {
          await panelApi.createPanel({
            sessionId: id,
            type: 'setup-tasks',
            title: 'Setup',
            metadata: { permanent: true },
          });
          panelsCreated = true;
        }

        const finalPanels = panelsCreated
          ? await panelApi.loadPanelsForSession(id)
          : loadedPanels;

        setPanels(id, finalPanels);

        const activePanel = await panelApi.getActivePanel(id);
        const setupPanel = finalPanels.find((p) => p.type === 'setup-tasks');
        const dashPanel = finalPanels.find((p) => p.type === 'dashboard');

        if (!activePanel) {
          // No active panel — prioritize setup-tasks over dashboard.
          const panelToActivate = setupPanel ?? dashPanel;
          if (panelToActivate) {
            setActivePanelInStore(id, panelToActivate.id);
            await panelApi.setActivePanel(id, panelToActivate.id);
          }
        } else {
          setActivePanelInStore(id, activePanel.id);
        }
      } catch (err) {
        console.error('[usePanelSurface] Failed to load/create panels:', err);
      }
    })();
  }, [mainRepoSessionId, setPanels, setActivePanelInStore, autoCreatePermanentPanels]);

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

  // Subscribe to panel:created events scoped to this session.
  useEffect(() => {
    if (!mainRepoSessionId) return;
    const handler = (panel: ToolPanel) => {
      if (panel.sessionId === mainRepoSessionId) addPanel(panel);
    };
    const unsubscribe = window.electronAPI?.events?.onPanelCreated?.(handler);
    return () => {
      unsubscribe?.();
    };
  }, [mainRepoSessionId, addPanel]);

  const sessionPanels = useMemo(
    () => panels[mainRepoSessionId ?? ''] ?? [],
    [panels, mainRepoSessionId],
  );

  const currentActivePanel = useMemo(
    () => sessionPanels.find((p) => p.id === activePanels[mainRepoSessionId ?? '']),
    [sessionPanels, activePanels, mainRepoSessionId],
  );

  const handlePanelSelect = useCallback(
    async (panel: ToolPanel) => {
      if (!mainRepoSessionId) return;
      setActivePanelInStore(mainRepoSessionId, panel.id);
      await panelApi.setActivePanel(mainRepoSessionId, panel.id);
    },
    [mainRepoSessionId, setActivePanelInStore],
  );

  const handlePanelClose = useCallback(
    async (panel: ToolPanel) => {
      if (!mainRepoSessionId) return;

      const closeAndActivate = async (next: ToolPanel | undefined) => {
        removePanel(mainRepoSessionId, panel.id);
        if (next && next.id !== panel.id) {
          setActivePanelInStore(mainRepoSessionId, next.id);
          await panelApi.setActivePanel(mainRepoSessionId, next.id);
        }
        await panelApi.deletePanel(panel.id);
      };

      const idx = sessionPanels.findIndex((p) => p.id === panel.id);
      let next: ToolPanel | undefined = sessionPanels[idx + 1] ?? sessionPanels[idx - 1];

      if (autoCreatePermanentPanels) {
        // ProjectView mode: permanent panels are not closeable.
        if (panel.type === 'dashboard' || panel.type === 'setup-tasks') {
          return;
        }
        // If no adjacent panel or it resolves to the same panel, fall back to dashboard.
        if (!next || next.id === panel.id) {
          next = sessionPanels.find((p) => p.type === 'dashboard') ?? sessionPanels[0];
        }
      }

      await closeAndActivate(next);
    },
    [mainRepoSessionId, sessionPanels, removePanel, setActivePanelInStore, autoCreatePermanentPanels],
  );

  return {
    mainRepoSession,
    sessionPanels,
    currentActivePanel,
    handlePanelSelect,
    handlePanelClose,
  };
}
