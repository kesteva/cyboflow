/**
 * CyboflowRoot — top-level Cyboflow view.
 *
 * Layout:
 *   header row     — thin bar with a "Choose workflow" button and "Quick Session" button
 *   main content   — empty-state CTA when activeRunId is null, RunView otherwise
 *   panel surface  — PanelTabBar + PanelContainer when the main-repo session is resolved
 *                    (Option B: secondary surface below the run/empty-state area)
 *   Modal overlay  — WorkflowPicker mounted inside Modal; opened from the
 *                    header button or the empty-state CTA
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import { WorkflowPicker } from './WorkflowPicker';
import { RunView } from './RunView';
import { Modal } from '../ui/Modal';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { usePanelSurface } from '../../hooks/usePanelSurface';
import { SessionProvider } from '../../contexts/SessionContext';
import { PanelTabBar } from '../panels/PanelTabBar';
import { PanelContainer } from '../panels/PanelContainer';
import { useAddTerminalPanel } from '../../hooks/useAddTerminalPanel';
import { useAddTerminalShortcut } from '../../hooks/useAddTerminalShortcut';
import { useEnsureClaudePanel } from '../../hooks/useEnsureClaudePanel';
import { useAddClaudeShortcut } from '../../hooks/useAddClaudeShortcut';
import { useAddQuickSessionShortcut } from '../../hooks/useAddQuickSessionShortcut';

interface CyboflowRootProps {
  projectId: number | null;
}

export function CyboflowRoot({ projectId }: CyboflowRootProps) {
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isQuickModePickerOpen, setIsQuickModePickerOpen] = useState(false);
  const quickPickerRef = useRef<HTMLDivElement>(null);

  const {
    mainRepoSession,
    sessionPanels,
    currentActivePanel,
    handlePanelSelect,
    handlePanelClose,
  } = usePanelSurface(projectId, { autoCreatePermanentPanels: false });

  const handleAddTerminal = useAddTerminalPanel(mainRepoSession, { logTag: 'CyboflowRoot' });
  const ensureClaudePanel = useEnsureClaudePanel(mainRepoSession, { logTag: 'CyboflowRoot' });

  useAddTerminalShortcut(handleAddTerminal);
  useAddClaudeShortcut(ensureClaudePanel);

  const handlePickQuickMode = useCallback(async (toolType: 'claude' | 'none') => {
    setIsQuickModePickerOpen(false);
    if (projectId === null) return;
    try {
      await window.electronAPI.sessions.createQuick({ prompt: '', projectId, toolType });
    } catch (err) {
      console.error('[CyboflowRoot] createQuick failed', err);
    }
  }, [projectId]);

  const handleOpenQuickPicker = useCallback(() => {
    if (projectId === null) return;
    setIsQuickModePickerOpen((prev) => !prev);
  }, [projectId]);

  useAddQuickSessionShortcut(handleOpenQuickPicker, { enabled: projectId !== null });

  // Escape-key + outside-click dismissal for the inline mode picker
  useEffect(() => {
    if (!isQuickModePickerOpen) return;

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setIsQuickModePickerOpen(false);
      }
    }

    function handleClickOutside(event: MouseEvent): void {
      if (
        quickPickerRef.current &&
        !quickPickerRef.current.contains(event.target as Node)
      ) {
        setIsQuickModePickerOpen(false);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isQuickModePickerOpen]);

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

        {/* Quick Session button + inline mode picker */}
        <div className="relative" ref={quickPickerRef}>
          <button
            onClick={handleOpenQuickPicker}
            disabled={projectId === null}
            title={projectId === null ? 'Select a project to start a quick session' : undefined}
            className="rounded bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="open-quick-session-picker"
          >
            Quick Session
          </button>

          {/* Inline mode picker — shown when isQuickModePickerOpen is true */}
          {isQuickModePickerOpen && (
            <div className="absolute left-0 top-full z-10 mt-1 flex flex-col gap-1 rounded border border-border-primary bg-bg-primary p-2 shadow-md">
              <button
                onClick={() => { void handlePickQuickMode('claude'); }}
                className="rounded px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-secondary"
                data-testid="quick-mode-chat"
              >
                Chat
              </button>
              <button
                onClick={() => { void handlePickQuickMode('none'); }}
                className="rounded px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-secondary"
                data-testid="quick-mode-terminal"
              >
                Terminal
              </button>
            </div>
          )}
        </div>
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
      {mainRepoSession && (
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
