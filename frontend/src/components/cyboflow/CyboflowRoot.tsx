/**
 * CyboflowRoot — top-level Cyboflow view.
 *
 * Layout:
 *   header row     — thin bar with "Choose workflow" and "Quick Session" buttons
 *   main content   — three-branch left column:
 *                    1. activeRunId set   → WorkflowCanvas (when phaseState has definition) + RunBottomPane
 *                    2. mainRepoSession   → RunBottomPane (panels stay alive after run completion)
 *                    3. neither          → empty-state CTA
 *   right rail     — RunRightRail (always rendered, 296 px fixed)
 *   panel surface  — PanelTabBar + PanelContainer anchored below the left+right area
 *                    when a main-repo session exists (Option B)
 *   Modal overlay  — WorkflowPicker mounted inside Modal
 */
import { useState, useCallback, useEffect } from 'react';
import { WorkflowPicker } from './WorkflowPicker';
import { WorkflowCanvas } from './WorkflowCanvas';
import { RunBottomPane } from './RunBottomPane';
import { RunRightRail } from './RunRightRail';
import { Modal } from '../ui/Modal';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useQuestionStore } from '../../stores/questionStore';
import { useWorkflowPhaseState } from '../../hooks/useWorkflowPhaseState';
import { usePanelSurface } from '../../hooks/usePanelSurface';
import { SessionProvider } from '../../contexts/SessionContext';
import { PanelTabBar } from '../panels/PanelTabBar';
import { PanelContainer } from '../panels/PanelContainer';
import { useAddTerminalPanel } from '../../hooks/useAddTerminalPanel';
import { useAddTerminalShortcut } from '../../hooks/useAddTerminalShortcut';
import { useEnsureClaudePanel } from '../../hooks/useEnsureClaudePanel';
import { useAddClaudeShortcut } from '../../hooks/useAddClaudeShortcut';
import { useAddQuickSessionShortcut } from '../../hooks/useAddQuickSessionShortcut';
import { useQuickSession } from '../../hooks/useQuickSession';

interface CyboflowRootProps {
  projectId: number | null;
}

export function CyboflowRoot({ projectId }: CyboflowRootProps) {
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const phaseState = useWorkflowPhaseState(activeRunId);
  const [isPickerOpen, setIsPickerOpen] = useState(false);

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

  const quickSession = useQuickSession({ projectId });

  const handleStartQuickSession = useCallback(() => {
    if (projectId === null) return;
    void quickSession.start();
  }, [projectId, quickSession]);

  useAddQuickSessionShortcut(handleStartQuickSession, { enabled: projectId !== null });

  useEffect(() => useQuestionStore.getState().init(), []);

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

        {/* Quick Session button — starts a Claude session directly */}
        <button
          onClick={handleStartQuickSession}
          disabled={projectId === null || quickSession.isStarting}
          title={projectId === null ? 'Select a project to start a quick session' : undefined}
          className="rounded bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="start-quick-session"
        >
          Quick Session
        </button>
      </div>

      {/* Main content area — two-column flex-row layout */}
      <div className="flex flex-row flex-1 overflow-hidden">
        {/* Left column — fluid; hosts empty-state CTA, RunBottomPane, or Canvas+RunBottomPane */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {activeRunId !== null ? (
            <>
              {phaseState.definition !== null && (
                <div style={{ flexBasis: '46%', overflow: 'hidden', flexShrink: 0 }}>
                  <WorkflowCanvas
                    definition={phaseState.definition}
                    currentStepId={phaseState.currentStepId}
                    runLabel={activeRunId}
                    isRunning={!phaseState.isLoading && phaseState.error === null}
                  />
                </div>
              )}
              <div className="flex-1 overflow-hidden">
                <RunBottomPane />
              </div>
            </>
          ) : mainRepoSession ? (
            <div className="flex-1 overflow-hidden">
              <RunBottomPane />
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 p-4">
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

        {/* Right rail — always rendered as layout shell (296px fixed) */}
        <RunRightRail phaseState={phaseState} />
      </div>

      {/* Panel surface — only when no active run (RunBottomPane owns the run view) */}
      {mainRepoSession && activeRunId === null && (
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
