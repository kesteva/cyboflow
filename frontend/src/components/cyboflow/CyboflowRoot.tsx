/**
 * CyboflowRoot — top-level Cyboflow view.
 *
 * Layout:
 *   header row     — thin bar with a "Choose workflow" button
 *   main content   — empty-state CTA when activeRunId is null, RunView otherwise
 *   panel surface  — PanelTabBar + PanelContainer when the main-repo session is resolved
 *                    (Option B: secondary surface below the run/empty-state area)
 *   Modal overlay  — WorkflowPicker mounted inside Modal; opened from the
 *                    header button or the empty-state CTA
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import { WorkflowPicker } from './WorkflowPicker';
import { RunView } from './RunView';
import { Modal } from '../ui/Modal';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { API } from '../../utils/api';
import { usePanelStore } from '../../stores/panelStore';
import { panelApi } from '../../services/panelApi';
import type { Session } from '../../types/session';
import type { ToolPanel } from '../../../../shared/types/panels';
import { SessionProvider } from '../../contexts/SessionContext';
import { PanelTabBar } from '../panels/PanelTabBar';
import { PanelContainer } from '../panels/PanelContainer';
import { useAddTerminalPanel } from '../../hooks/useAddTerminalPanel';
import { useAddTerminalShortcut } from '../../hooks/useAddTerminalShortcut';
import { useEnsureClaudePanel } from '../../hooks/useEnsureClaudePanel';
import { useAddClaudeShortcut } from '../../hooks/useAddClaudeShortcut';

interface CyboflowRootProps {
  projectId: number | null;
}

export function CyboflowRoot({ projectId }: CyboflowRootProps) {
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  // --- Main-repo session resolution ---
  const [mainRepoSessionId, setMainRepoSessionId] = useState<string | null>(null);
  const [mainRepoSession, setMainRepoSession] = useState<Session | null>(null);

  const { panels, activePanels, setPanels, setActivePanel: setActivePanelInStore, addPanel, removePanel } = usePanelStore();

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
        }
      } catch (err) {
        console.error('[CyboflowRoot] Failed to resolve main-repo session:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  // Load panels for the resolved session (read-only — do NOT auto-create dashboard/setup-tasks).
  useEffect(() => {
    if (!mainRepoSessionId) return;
    panelApi.loadPanelsForSession(mainRepoSessionId)
      .then((loaded) => setPanels(mainRepoSessionId, loaded))
      .catch((err) => console.error('[CyboflowRoot] Failed to load panels:', err));
  }, [mainRepoSessionId, setPanels]);

  // Subscribe to panel:created events scoped to this session.
  useEffect(() => {
    if (!mainRepoSessionId) return;
    const handler = (panel: ToolPanel) => {
      if (panel.sessionId === mainRepoSessionId) addPanel(panel);
    };
    const unsubscribe = window.electronAPI?.events?.onPanelCreated?.(handler);
    return () => { unsubscribe?.(); };
  }, [mainRepoSessionId, addPanel]);

  const sessionPanels = useMemo(
    () => panels[mainRepoSessionId ?? ''] ?? [],
    [panels, mainRepoSessionId],
  );

  const currentActivePanel = useMemo(
    () => sessionPanels.find((p) => p.id === activePanels[mainRepoSessionId ?? '']),
    [sessionPanels, activePanels, mainRepoSessionId],
  );

  const handlePanelSelect = useCallback(async (panel: ToolPanel) => {
    if (!mainRepoSessionId) return;
    setActivePanelInStore(mainRepoSessionId, panel.id);
    await panelApi.setActivePanel(mainRepoSessionId, panel.id);
  }, [mainRepoSessionId, setActivePanelInStore]);

  const handlePanelClose = useCallback(async (panel: ToolPanel) => {
    if (!mainRepoSessionId) return;
    // CyboflowRoot does not auto-create permanent dashboard/setup-tasks panels, so
    // there is no permanence guard here — every panel created via these affordances
    // is user-initiated and user-closable.
    const idx = sessionPanels.findIndex((p) => p.id === panel.id);
    const next = sessionPanels[idx + 1] ?? sessionPanels[idx - 1];
    removePanel(mainRepoSessionId, panel.id);
    if (next && next.id !== panel.id) {
      setActivePanelInStore(mainRepoSessionId, next.id);
      await panelApi.setActivePanel(mainRepoSessionId, next.id);
    }
    await panelApi.deletePanel(panel.id);
  }, [mainRepoSessionId, sessionPanels, removePanel, setActivePanelInStore]);

  const handleAddTerminal = useAddTerminalPanel(mainRepoSession, { logTag: 'CyboflowRoot' });
  const ensureClaudePanel = useEnsureClaudePanel(mainRepoSession, { logTag: 'CyboflowRoot' });

  useAddTerminalShortcut(handleAddTerminal);
  useAddClaudeShortcut(ensureClaudePanel);

  return (
    <div className="flex h-full flex-col">
      {/* Thin top header row */}
      <div className="flex items-center gap-2 border-b border-border-primary px-4 py-2">
        <button
          onClick={() => setIsPickerOpen(true)}
          className="rounded bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover"
          data-testid="open-workflow-picker"
        >
          Choose workflow
        </button>
      </div>

      {/* Main content area */}
      <div className="flex-1 overflow-auto p-4">
        {activeRunId !== null ? (
          <RunView />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <p className="text-sm text-text-secondary">Choose a workflow to start</p>
            <button
              onClick={() => setIsPickerOpen(true)}
              className="rounded bg-interactive px-4 py-2 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover"
              data-testid="open-workflow-picker-cta"
            >
              Choose a workflow
            </button>
          </div>
        )}
      </div>

      {/* Panel surface — rendered below the run/empty-state area when a main-repo session exists (Option B) */}
      {mainRepoSessionId && (
        <SessionProvider session={mainRepoSession} projectName="">
          <PanelTabBar
            panels={sessionPanels}
            activePanel={currentActivePanel}
            onPanelSelect={handlePanelSelect}
            onPanelClose={handlePanelClose}
            context="project"
            onAddTerminal={handleAddTerminal}
            onAddClaude={ensureClaudePanel}
          />
          {currentActivePanel && (
            <div
              className="flex-shrink-0 border-t border-border-primary relative"
              style={{ minHeight: 200, maxHeight: '50vh', height: '40vh' }}
            >
              <PanelContainer
                panel={currentActivePanel}
                isActive
                isMainRepo={!!mainRepoSession?.isMainRepo}
              />
            </div>
          )}
        </SessionProvider>
      )}

      {/* WorkflowPicker modal — only rendered when projectId is a number */}
      {projectId !== null && (
        <Modal
          isOpen={isPickerOpen}
          onClose={() => setIsPickerOpen(false)}
          size="md"
        >
          <div className="p-6">
            <WorkflowPicker
              projectId={projectId}
              onWorkflowStarted={() => setIsPickerOpen(false)}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
