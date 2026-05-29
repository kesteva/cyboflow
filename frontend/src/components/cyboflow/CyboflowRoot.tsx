/**
 * CyboflowRoot — top-level Cyboflow view.
 *
 * Layout:
 *   header row     — thin bar with "Choose workflow" and "Quick Session" buttons
 *   main content   — three-branch left column:
 *                    1. activeRunId set   → WorkflowCanvas (when phaseState has definition) + RunBottomPane
 *                    2. mainRepoSession   → PanelTabBar + PanelContainer (session panels fill the area)
 *                    3. neither          → empty-state CTA
 *   right rail     — RunRightRail (always rendered, 296 px fixed)
 *   Modal overlay  — WorkflowPicker mounted inside Modal
 *   Lifecycle      — SessionLifecycleActionBar (header) drives the merge / create-PR /
 *                    dismiss dialogs + success toast, targeting the session resolved
 *                    by useLifecycleSession (active quick session OR opened workflow run)
 */
import { useState, useCallback, useEffect } from 'react';
import { WorkflowPicker } from './WorkflowPicker';
import { WorkflowCanvas } from './WorkflowCanvas';
import { RunBottomPane } from './RunBottomPane';
import { RunRightRail } from './RunRightRail';
import { Modal } from '../ui/Modal';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useQuestionStore } from '../../stores/questionStore';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
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
import { useLifecycleTarget } from '../../hooks/useLifecycleTarget';
import { SessionLifecycleActionBar } from './SessionLifecycleActionBar';
import { SessionMergeDialog } from './SessionMergeDialog';
import { SessionCreatePrDialog } from './SessionCreatePrDialog';
import { SessionDismissDialog } from './SessionDismissDialog';
import { RunMergeDialog } from './RunMergeDialog';
import { RunCreatePrDialog } from './RunCreatePrDialog';
import { RunDismissDialog } from './RunDismissDialog';
import { SessionActionToast } from './SessionActionToast';

interface CyboflowRootProps {
  projectId: number | null;
}

export function CyboflowRoot({ projectId }: CyboflowRootProps) {
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const phaseState = useWorkflowPhaseState(activeRunId);
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  // Resolve the active run's worktree folder + branch for the canvas meta row.
  // Sourced from activeRunsStore (workflow_runs.worktree_path / branch_name);
  // planner runs have no `sessions` row, so useLifecycleSession can't supply these.
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);
  const activeRun =
    projectId !== null && activeRunId !== null
      ? runsByProject[projectId]?.find((r) => r.id === activeRunId)
      : undefined;

  const {
    mainRepoSession,
    effectiveSession,
    sessionPanels,
    currentActivePanel,
    handlePanelSelect,
    handlePanelClose,
  } = usePanelSurface(projectId, { autoCreatePermanentPanels: false });

  const handleAddTerminal = useAddTerminalPanel(effectiveSession ?? mainRepoSession, { logTag: 'CyboflowRoot' });
  const ensureClaudePanel = useEnsureClaudePanel(effectiveSession ?? mainRepoSession, { logTag: 'CyboflowRoot' });

  useAddTerminalShortcut(handleAddTerminal);
  useAddClaudeShortcut(ensureClaudePanel);

  const quickSession = useQuickSession({ projectId });

  const handleStartQuickSession = useCallback(() => {
    if (projectId === null) return;
    void quickSession.start();
  }, [projectId, quickSession]);

  useAddQuickSessionShortcut(handleStartQuickSession, { enabled: projectId !== null });

  // Lifecycle dialogs (TASK-796 / GAP-B) — target either the worktree-backed
  // quick session OR the planner/workflow run resolved from the active selection.
  const lifecycleTarget = useLifecycleTarget();
  const [isMergeOpen, setIsMergeOpen] = useState(false);
  const [isCreatePrOpen, setIsCreatePrOpen] = useState(false);
  const [isDismissOpen, setIsDismissOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const handleActionSuccess = useCallback((message: string) => {
    setToastMessage(message);
    // The session/worktree is gone after merge/PR/dismiss — drop whichever
    // selection pointed at it so the view resets instead of dangling. For runs,
    // also refresh the active-runs rail so the closed-out run drops from it.
    const store = useCyboflowStore.getState();
    if (store.activeQuickSessionId) {
      store.clearActiveQuickSession();
    } else if (store.activeRunId) {
      store.clearActiveRun();
      if (projectId !== null) {
        void useActiveRunsStore.getState().refresh(projectId);
      }
    }
  }, [projectId]);

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

        <div className="flex-1" />

        <SessionLifecycleActionBar
          onMerge={() => setIsMergeOpen(true)}
          onCreatePR={() => setIsCreatePrOpen(true)}
          onDismiss={() => setIsDismissOpen(true)}
        />
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
                    folderPath={activeRun?.worktree_path}
                    branchName={activeRun?.branch_name}
                    // Reflect the run's ACTUAL lifecycle status, not phaseState
                    // load state (which is always "loaded, no error" once ready
                    // and so pinned the badge to RUNNING even after the run
                    // rested in awaiting_review). activeRun.status now stays
                    // fresh via activeRunsStore's onRunStatusChanged subscription.
                    isRunning={activeRun?.status === 'running' || activeRun?.status === 'starting'}
                  />
                </div>
              )}
              <div className="flex-1 overflow-hidden">
                <RunBottomPane />
              </div>
            </>
          ) : effectiveSession ? (
            <SessionProvider session={effectiveSession} projectName="">
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
                <div className="flex-1 overflow-hidden relative">
                  <PanelContainer
                    panel={currentActivePanel}
                    isActive
                    isMainRepo={!!effectiveSession?.isMainRepo}
                  />
                </div>
              )}
              {/* Inline permission prompts now render inside ClaudePanel, directly
                  above the input (see PendingApprovalsForRun in ClaudePanel.tsx). */}
            </SessionProvider>
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

      {/* Lifecycle dialogs — session-scoped for quick sessions, run-scoped for
          planner/workflow runs (GAP-B). Only mounted when a target resolves. */}
      {lifecycleTarget?.kind === 'session' && (
        <>
          <SessionMergeDialog
            isOpen={isMergeOpen}
            onClose={() => setIsMergeOpen(false)}
            sessionId={lifecycleTarget.session.id}
            onSuccess={() => {
              setIsMergeOpen(false);
              handleActionSuccess('Session merged');
            }}
          />
          <SessionCreatePrDialog
            isOpen={isCreatePrOpen}
            onClose={() => setIsCreatePrOpen(false)}
            sessionId={lifecycleTarget.session.id}
            sessionName={lifecycleTarget.session.name}
            onSuccess={() => {
              setIsCreatePrOpen(false);
              handleActionSuccess('Pull request created');
            }}
          />
          <SessionDismissDialog
            isOpen={isDismissOpen}
            onClose={() => setIsDismissOpen(false)}
            sessionId={lifecycleTarget.session.id}
            onSuccess={() => {
              setIsDismissOpen(false);
              handleActionSuccess('Session dismissed');
            }}
          />
        </>
      )}

      {lifecycleTarget?.kind === 'run' && (
        <>
          <RunMergeDialog
            isOpen={isMergeOpen}
            onClose={() => setIsMergeOpen(false)}
            runId={lifecycleTarget.runId}
            onSuccess={() => {
              setIsMergeOpen(false);
              handleActionSuccess('Run merged');
            }}
          />
          <RunCreatePrDialog
            isOpen={isCreatePrOpen}
            onClose={() => setIsCreatePrOpen(false)}
            runId={lifecycleTarget.runId}
            onSuccess={() => {
              setIsCreatePrOpen(false);
              handleActionSuccess('Pull request created');
            }}
          />
          <RunDismissDialog
            isOpen={isDismissOpen}
            onClose={() => setIsDismissOpen(false)}
            runId={lifecycleTarget.runId}
            onSuccess={() => {
              setIsDismissOpen(false);
              handleActionSuccess('Run dismissed');
            }}
          />
        </>
      )}

      {/* Success toast — rendered outside the lifecycleSession gate so it
          survives the session being cleared on action success */}
      {toastMessage !== null && (
        <div className="fixed bottom-4 right-4 z-50">
          <SessionActionToast
            message={toastMessage}
            isVisible
            onDismiss={() => setToastMessage(null)}
          />
        </div>
      )}
    </div>
  );
}
