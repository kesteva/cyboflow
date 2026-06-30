/**
 * CyboflowRoot — top-level Cyboflow view.
 *
 * Layout:
 *   header row     — thin bar with the back-to-home pill plus the run / session
 *                    action bars (the workflow / quick-session / edit-flow
 *                    launchers were removed; those actions live on other surfaces)
 *   main content   — three-branch left column:
 *                    1. activeRunId set   → WorkflowSummaryPanel card (run ended) or RunCenterPane (tabbed Flow + dock)
 *                    2. mainRepoSession   → PanelTabBar + PanelContainer (session panels fill the area)
 *                    3. neither          → empty-state CTA
 *   right rail     — RunRightRail (always rendered; user-resizable width, or a thin collapsed strip)
 *   Modal overlay  — WorkflowPicker mounted inside Modal
 *   Lifecycle      — SessionLifecycleActionBar (header) drives the merge / create-PR /
 *                    dismiss dialogs + success toast, targeting the session resolved
 *                    by useLifecycleSession (active quick session OR opened workflow run).
 *   Run controls   — RunActionBar (header, when a run is active) drives the
 *                    git-neutral run Cancel (RunCancelDialog) — SEPARATE from the
 *                    session close-out; it stops the agent without touching git.
 */
import { useState, useCallback, useEffect } from 'react';
import { WorkflowPicker } from './WorkflowPicker';
import { GRAPH_PAPER_BACKGROUND } from './WorkflowCanvas';
import { WorkflowSummaryPanel } from './WorkflowSummaryPanel';
import { QuickSessionCenterPane } from './QuickSessionCenterPane';
import { WorkflowEditorModal } from './WorkflowEditorModal';
import { RunCenterPane } from './RunCenterPane';
import { RunRightRail } from './RunRightRail';
import { Modal } from '../ui/Modal';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useLandingStore } from '../../stores/landingStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useQuestionStore } from '../../stores/questionStore';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
import { useWorkflowPhaseState } from '../../hooks/useWorkflowPhaseState';
import { usePanelSurface } from '../../hooks/usePanelSurface';
import { SessionProvider } from '../../contexts/SessionContext';
import { PanelTabBar } from '../panels/PanelTabBar';
import { PanelContainer } from '../panels/PanelContainer';
import { useAddTerminalPanel } from '../../hooks/useAddTerminalPanel';
import { useAddTerminalShortcut } from '../../hooks/useAddTerminalShortcut';
import { useEditWorkflowShortcut } from '../../hooks/useEditWorkflowShortcut';
import { useEnsureClaudePanel } from '../../hooks/useEnsureClaudePanel';
import { useAddClaudeShortcut } from '../../hooks/useAddClaudeShortcut';
import { useAddQuickSessionShortcut } from '../../hooks/useAddQuickSessionShortcut';
import { useQuickSession } from '../../hooks/useQuickSession';
import { useLifecycleTarget } from '../../hooks/useLifecycleTarget';
import { SessionLifecycleActionBar } from './SessionLifecycleActionBar';
import { SessionMergeDialog } from './SessionMergeDialog';
import { SessionCreatePrDialog } from './SessionCreatePrDialog';
import { SessionDismissDialog } from './SessionDismissDialog';
import { RunActionBar } from './RunActionBar';
import { RunCancelDialog } from './RunCancelDialog';
import { disposeInteractiveTerminal } from './InteractiveTerminalView';
import { RunEndDialog } from './RunEndDialog';
import { ConfirmDialog } from '../ConfirmDialog';
import { useErrorStore } from '../../stores/errorStore';
import { useRunEndEligibility } from '../../hooks/useRunEndEligibility';
import { trpc } from '../../trpc/client';
import { SessionActionToast } from './SessionActionToast';

interface CyboflowRootProps {
  projectId: number | null;
}

/** localStorage key for the right-rail collapsed state. Brand-new key — no migration. */
const RAIL_COLLAPSED_KEY = 'cyboflow.runRightRail.collapsed';

export function CyboflowRoot({ projectId }: CyboflowRootProps) {
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const phaseState = useWorkflowPhaseState(activeRunId);
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  // Whole-rail collapse — lifted here (the parent that sizes the rail) and
  // persisted to localStorage so it survives reloads. (Brand-new key — no
  // migrateLocalStorageKey needed.)
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(RAIL_COLLAPSED_KEY) === 'true';
  });
  const handleToggleRail = useCallback(() => {
    setRailCollapsed((prev) => {
      const next = !prev;
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(RAIL_COLLAPSED_KEY, next ? 'true' : 'false');
      }
      return next;
    });
  }, []);
  // "Add a workflow" on an interactive (PTY) session: a second workflow can't run
  // in the live-REPL session (descoped), so the affordance first confirms it will
  // launch in a SEPARATE session, then opens the picker with forceNewSession set.
  const [addWorkflowConfirmOpen, setAddWorkflowConfirmOpen] = useState(false);
  const [pickerForceNew, setPickerForceNew] = useState(false);

  // Resolve the active run's worktree folder + branch for the canvas meta row.
  // Sourced from activeRunsStore (workflow_runs.worktree_path / branch_name);
  // planner runs have no `sessions` row, so useLifecycleSession can't supply these.
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);
  const activeRun =
    projectId !== null && activeRunId !== null
      ? runsByProject[projectId]?.find((r) => r.id === activeRunId)
      : undefined;

  // Repo (project) name for the resting-view session node sub-line. Resolved
  // from the cross-project landing store, which loads the project list on init.
  const projectName = useLandingStore((s) =>
    projectId === null ? '' : (s.projects.find((p) => p.id === projectId)?.name ?? ''),
  );

  // Session-hosted runs (migration 019): the launch path calls setActiveRun(runId)
  // before the run's parent session is known, so selectedSessionId starts null —
  // which flips the File Explorer / Diff to the main repo and hides the session
  // close-out (Merge / PR / Dismiss, gated by useLifecycleSession→selectedSessionId).
  // The run's session_id arrives via activeRunsStore; mirror it into selectedSessionId
  // once it resolves (setRunParentSession does NOT touch the run subscription /
  // streamEvents, unlike setActiveRun). Only sets — never clears — so the session
  // stays selected for close-out after the run ends.
  const activeRunSessionId = activeRun?.session_id ?? null;
  useEffect(() => {
    if (activeRunId === null || activeRunSessionId === null) return;
    const store = useCyboflowStore.getState();
    if (store.selectedSessionId !== activeRunSessionId) {
      store.setRunParentSession(activeRunSessionId);
    }
  }, [activeRunId, activeRunSessionId]);

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

  // The quick-session panel surface (tab bar + active panel). Rendered as
  // flex-column children of either the TerminalDock body (worktree sessions —
  // dock body is already display:flex/flex-col) or the bare center column
  // (main-repo). PanelTabBar sits above; the active panel fills the rest.
  const quickPanelSurface = (
    <>
      <PanelTabBar
        panels={sessionPanels}
        activePanel={currentActivePanel}
        onPanelSelect={handlePanelSelect}
        onPanelClose={handlePanelClose}
        context="project"
        onAddTerminal={handleAddTerminal}
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
    </>
  );

  const quickSession = useQuickSession({ projectId });

  const handleStartQuickSession = useCallback(() => {
    if (projectId === null) return;
    void quickSession.start();
  }, [projectId, quickSession]);

  useAddQuickSessionShortcut(handleStartQuickSession, { enabled: projectId !== null });

  // Blueprint editor — open for the active run's workflow (header button + ⌘E).
  // Only meaningful when a run with a resolvable workflow_id is active.
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const editWorkflowId = activeRun?.workflow_id ?? null;
  const canEditWorkflow = projectId !== null && editWorkflowId !== null;

  const handleOpenEditor = useCallback(() => {
    if (!canEditWorkflow) return;
    setIsEditorOpen(true);
  }, [canEditWorkflow]);

  useEditWorkflowShortcut(handleOpenEditor, { enabled: canEditWorkflow });

  const handleEditorSaved = useCallback(() => {
    setIsEditorOpen(false);
    // Force the canvas to re-resolve its phase state: clear + reselect the run so
    // useWorkflowPhaseState re-runs getPhaseState (which re-reads spec_json).
    // Preserve the run's parent session (Phase 3) across the reselect — otherwise
    // setActiveRun(runId) would null selectedSessionId and the Diff / File-Explorer
    // (which read it) would flip to the empty state while the run is still executing
    // in the session worktree.
    if (activeRunId !== null) {
      const store = useCyboflowStore.getState();
      const parentSessionId = store.selectedSessionId;
      store.clearActiveRun();
      store.setActiveRun(activeRunId, parentSessionId);
    }
  }, [activeRunId]);

  // Session close-out dialogs (TASK-796) — Merge / Create-PR / Dismiss always
  // target the worktree-backed SESSION (an active quick session OR an opened
  // workflow run mapped to its parent session by useLifecycleSession). The
  // run-scoped close-out was removed in Phase 4a: every workflow run is now
  // session-hosted, so its git lifecycle is the session's job.
  const lifecycleTarget = useLifecycleTarget();
  const [isMergeOpen, setIsMergeOpen] = useState(false);
  const [isCreatePrOpen, setIsCreatePrOpen] = useState(false);
  const [isDismissOpen, setIsDismissOpen] = useState(false);
  // Run-scoped git-neutral Cancel (Phase 4a) — separate from the session
  // close-out above. Opened from RunActionBar; mounts RunCancelDialog.
  const [isCancelOpen, setIsCancelOpen] = useState(false);
  // End-workflow confirm — the human gate that returns a finished (completed /
  // failed) run's centre pane to the session's resting QuickSessionCanvas.
  const [isEndOpen, setIsEndOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Return the centre pane to the session's resting view (QuickSessionCanvas):
  // drop the active-run overlay while preserving its parent session selection
  // (clearActiveRun does NOT touch selectedSessionId), so the effectiveSession
  // branch re-surfaces. Refresh the rail so the now-terminal run un-pins. Shared
  // by the Cancel success path and the End-workflow confirm — every workflow
  // exit is human-gated (Cancel dialog / RunEndDialog).
  const returnToRestingSession = useCallback(() => {
    useCyboflowStore.getState().clearActiveRun();
    if (projectId !== null) {
      void useActiveRunsStore.getState().refresh(projectId);
    }
  }, [projectId]);

  const handleActionSuccess = useCallback((message: string) => {
    setToastMessage(message);
    // The session/worktree is gone after merge/PR/dismiss — drop whichever
    // selection pointed at it so the view resets instead of dangling. For runs,
    // also refresh the active-runs rail so the closed-out run drops from it.
    const store = useCyboflowStore.getState();
    if (store.selectedSessionId) {
      // Quick session retired by merge/PR/dismiss — its worktree + PTY are gone,
      // so evict the keep-alive xterm cache for the session's interactive run id
      // (resolved from the session store). Without this the cached terminal would
      // leak past close-out. The backend PTY kill is owned by the close-out route.
      const closedSession = useSessionStore
        .getState()
        .sessions.find((s) => s.id === store.selectedSessionId);
      if (closedSession?.runId) disposeInteractiveTerminal(closedSession.runId);
      store.clearActiveQuickSession();
    } else if (store.activeRunId) {
      // Workflow run retired — evict its keep-alive xterm cache (the worktree is
      // gone after merge/PR/dismiss). Capture before clearActiveRun nulls it.
      disposeInteractiveTerminal(store.activeRunId);
      store.clearActiveRun();
      if (projectId !== null) {
        void useActiveRunsStore.getState().refresh(projectId);
      }
    }
    // Clearing the selection alone leaves the center surface on the now-dead
    // session view (stale chat + Continue composer). The session's work has been
    // resolved, so transition the center pane back to the landing/human-review
    // home — the same surface the "← Cyboflow home" pill returns to.
    useNavigationStore.getState().goHome();
  }, [projectId]);

  useEffect(() => useQuestionStore.getState().init(), []);

  // In-canvas completion banner: the SAME eligibility the RunActionBar End
  // button uses (shared hook), surfaced prominently in the flow window so a
  // finished run's exit is not hidden in the top bar.
  const runEndEligible = useRunEndEligibility(activeRunId, activeRun?.status);

  return (
    <div className="flex h-full flex-col">
      {/* Thin top header row */}
      <div className="flex items-center gap-2 border-b border-border-primary px-4 py-2">
        {/* Back-to-home pill — returns the center surface to the cross-project
            landing home (ghost styled, square, uppercase tiny). */}
        <button
          onClick={() => useNavigationStore.getState().goHome()}
          className="border border-border-primary px-2 py-1 text-[10px] uppercase tracking-wider text-text-secondary hover:text-text-primary hover:border-border-emphasized"
          data-testid="back-to-home"
        >
          ← Cyboflow home
        </button>

        {/* The top-bar "Choose workflow" / "Quick Session" launchers and the
            "Edit flow" button were removed — those actions now live on their
            own surfaces (sidebar, backlog, the wizard, the in-session
            "Add a workflow" affordance) and the keyboard shortcuts (⌘E to edit
            the active flow, the quick-session shortcut) still drive the same
            handlers, so nothing here is orphaned. */}
        <div className="flex-1" />

        {/* Run-scoped controls (Phase 4a) — git-neutral Cancel only, a distinct
            RUN grouping (with its own trailing divider) clearly separated from
            the SESSION close-out (Merge / PR / Dismiss). RunActionBar self-hides
            when there is no active, non-terminal run selected. */}
        <RunActionBar
          onCancel={() => setIsCancelOpen(true)}
          onEndWorkflow={() => setIsEndOpen(true)}
        />

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
            // Tabbed center surface (pinned Flow tab hosting the WorkflowCanvas,
            // or SprintSwimlaneCanvas for sprint runs) over a collapsible terminal
            // dock, plus file/diff + artifact tabs. RunCenterPane owns the
            // per-session tab state and the xterm-keep-alive dock collapse.
            //
            // At end of workflow (run rested with no open gate, or self-terminated)
            // the Flow tab renders the summary module — token usage by category +
            // the two close-out CTAs (Complete / interactive-only Request changes)
            // — INSTEAD of the phase canvas, passed in as `flowEndSummary`. It is
            // the Flow-tab content (not a replacement for the whole pane) so the
            // tab strip and the terminal dock (chat) stay mounted: completion no
            // longer hides the chat.
            <RunCenterPane
              activeRunId={activeRunId}
              phaseState={phaseState}
              activeRun={activeRun}
              flowEndSummary={
                runEndEligible ? (
                  <div
                    style={{ background: GRAPH_PAPER_BACKGROUND }}
                    className="flex h-full items-start justify-center overflow-auto p-6"
                    data-testid="run-summary-canvas"
                  >
                    <WorkflowSummaryPanel
                      runId={activeRunId}
                      status={activeRun?.status}
                      substrate={activeRun?.substrate}
                      workflowLabel={activeRun?.workflowName ?? activeRunId}
                      onComplete={() => setIsEndOpen(true)}
                    />
                  </div>
                ) : undefined
              }
            />
          ) : effectiveSession ? (
            <SessionProvider session={effectiveSession} projectName={projectName}>
              {/* Resting view — a worktree-backed session with NO active run
                  (a fresh quick session, or one a finished run handed back).
                  QuickSessionCenterPane gives it the SAME tabbed center surface a
                  run gets: the resting QuickSessionCanvas as the pinned home tab,
                  file/diff tabs opened from the right-rail Diff list as secondary
                  tabs, over the collapsible TerminalDock (chat) below — SAME ▴▾
                  arrows as a run. The bare main-repo session keeps its panels-only
                  layout (no worktree node to show, so no dock / tabs). */}
              {!effectiveSession.isMainRepo && projectId !== null ? (
                <QuickSessionCenterPane
                  session={effectiveSession}
                  projectId={projectId}
                  projectName={projectName}
                  onBrowseAll={() => {
                    // "Browse all" is the in-session add-a-workflow path (only
                    // reached for SDK sessions; PTY routes to the confirm below),
                    // so it REUSES this session — explicit forceNew=false.
                    setPickerForceNew(false);
                    setIsPickerOpen(true);
                  }}
                  onAddWorkflowToNewSession={() => setAddWorkflowConfirmOpen(true)}
                  dockContent={quickPanelSurface}
                />
              ) : (
                quickPanelSurface
              )}
              {/* Inline permission prompts now render inside ClaudePanel, directly
                  above the input (see PendingApprovalsForRun in ClaudePanel.tsx). */}
            </SessionProvider>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 p-4">
              <p className="text-sm text-text-secondary">Choose a workflow to start</p>
              <button
                onClick={() => {
                  setPickerForceNew(true);
                  setIsPickerOpen(true);
                }}
                className="rounded-button bg-interactive px-4 py-2 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover"
                data-testid="open-workflow-picker-cta"
              >
                Choose a workflow
              </button>
            </div>
          )}
        </div>

        {/* Right rail — always rendered as layout shell (296px fixed, or a thin
            collapsed strip). Collapse state is lifted here + persisted. */}
        <RunRightRail
          phaseState={phaseState}
          collapsed={railCollapsed}
          onToggleCollapse={handleToggleRail}
        />
      </div>

      {/* WorkflowPicker modal — only rendered when projectId is a number */}
      {projectId !== null && (
        <Modal
          isOpen={isPickerOpen}
          onClose={() => {
            setIsPickerOpen(false);
            setPickerForceNew(false);
          }}
          size="md"
        >
          <div className="p-6">
            <WorkflowPicker
              projectId={projectId}
              forceNewSession={pickerForceNew}
              onWorkflowStarted={() => {
                setIsPickerOpen(false);
                setPickerForceNew(false);
              }}
            />
          </div>
        </Modal>
      )}

      {/* Add-a-workflow confirm (interactive/PTY session) — a second workflow is
          descoped from the live-REPL session, so confirm the launch will be in a
          new, separate session, then open the picker with forceNewSession set. */}
      <ConfirmDialog
        isOpen={addWorkflowConfirmOpen}
        onClose={() => setAddWorkflowConfirmOpen(false)}
        onConfirm={() => {
          setAddWorkflowConfirmOpen(false);
          setPickerForceNew(true);
          setIsPickerOpen(true);
        }}
        title="Start workflow in a new session?"
        message="This is an interactive (PTY) session, which can't host a second workflow alongside its live terminal. The workflow will start in a new, separate session — this one stays open and untouched. Next you'll choose the workflow and its settings (permissions, SDK vs. PTY)."
        confirmText="Choose workflow"
        cancelText="Cancel"
        confirmButtonClass="bg-interactive hover:bg-interactive-hover text-text-on-interactive"
      />

      {/* Workflow blueprint editor — opened from the "Edit flow" header button /
          ⌘E for the active run's workflow. Only mounted when a run with a
          resolvable workflow_id is active. */}
      {projectId !== null && editWorkflowId !== null && (
        <WorkflowEditorModal
          isOpen={isEditorOpen}
          mode="edit"
          workflowId={editWorkflowId}
          projectId={projectId}
          onClose={() => setIsEditorOpen(false)}
          onSaved={handleEditorSaved}
        />
      )}

      {/* Session close-out dialogs — always session-scoped (Phase 4a removed the
          run close-out). Only mounted when a closable session resolves. */}
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

      {/* Run-scoped git-neutral Cancel (Phase 4a). Mounted whenever a run is
          active — the dialog itself self-gates on isCancelOpen. Cancel is
          git-neutral (the session + worktree persist); on success we return the
          centre pane to the session's resting QuickSessionCanvas. */}
      {activeRunId !== null && (
        <RunCancelDialog
          isOpen={isCancelOpen}
          onClose={() => setIsCancelOpen(false)}
          runId={activeRunId}
          onSuccess={() => {
            setIsCancelOpen(false);
            returnToRestingSession();
          }}
        />
      )}

      {/* End-workflow confirm — the human gate for a run that reached a terminal
          status on its own (completed / failed) OR rested at awaiting_review
          with no open gates. For a rested run, confirming first completes it
          via runs.end (git-neutral; the session keeps the worktree); for an
          already-terminal run it is pure navigation. Either way the run
          overlay drops back to the session's resting QuickSessionCanvas. */}
      {activeRunId !== null && (
        <RunEndDialog
          isOpen={isEndOpen}
          onClose={() => setIsEndOpen(false)}
          status={activeRun?.status}
          onConfirm={() => {
            setIsEndOpen(false);
            if (activeRun?.status === 'awaiting_review') {
              trpc.cyboflow.runs.end
                .mutate({ runId: activeRunId })
                .then((result) => {
                  if ('noOp' in result && result.reason === 'blocking_items_pending') {
                    useErrorStore.getState().showError({
                      title: 'Cannot end workflow',
                      error: 'This run still has pending review items — resolve them in the Human review queue first.',
                    });
                    return;
                  }
                  returnToRestingSession();
                })
                .catch((err: unknown) => {
                  useErrorStore.getState().showError({
                    title: 'End workflow failed',
                    error: err instanceof Error ? err.message : String(err),
                  });
                });
              return;
            }
            returnToRestingSession();
          }}
        />
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
