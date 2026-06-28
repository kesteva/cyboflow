import { useState, useEffect } from 'react';
import { useIPCEvents } from './hooks/useIPCEvents';
import { useNotifications } from './hooks/useNotifications';
import { useStuckNotifications } from './hooks/useStuckNotifications';
import { useResizable } from './hooks/useResizable';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { CyboflowRoot } from './components/cyboflow/CyboflowRoot';
import { PromptHistoryModal } from './components/PromptHistoryModal';
import Welcome from './components/Welcome';
import { AboutDialog } from './components/AboutDialog';
import { MainProcessLogger } from './components/MainProcessLogger';
import { ErrorDialog } from './components/ErrorDialog';
import { PermissionDialog } from './components/PermissionDialog';
import { useErrorStore } from './stores/errorStore';
import { useSessionStore } from './stores/sessionStore';
import { useConfigStore } from './stores/configStore';
import { useNavigationStore } from './stores/navigationStore';
import { API } from './utils/api';
import { migrateLocalStorageKey } from './utils/migrateLocalStorageKey';
import { ContextMenuProvider } from './contexts/ContextMenuContext';
import { TokenTest } from './components/TokenTest';
import { ErrorBoundary } from './components/ErrorBoundary';
import LandingHome from './components/landing/LandingHome';
import SessionStartWizard from './components/cyboflow/wizard/SessionStartWizard';
import BacklogPane from './components/BacklogPane';
import { InsightsView } from './components/Insights/InsightsView';
import { WorkflowsView } from './components/workflows/WorkflowsView';
import { VerifyQueueView } from './components/cyboflow/VerifyQueueView';
import { StatusBar } from './components/StatusBar';
import { useMcpHealthStore } from './stores/mcpHealthStore';
import { useReviewQueueSlice } from './stores/reviewQueueSlice';
import { useReviewQueueStore } from './stores/reviewQueueStore';
import { useReviewItemsSlice } from './stores/reviewItemsSlice';
import { useBacklogStore } from './stores/backlogStore';
import { useActiveRunsStore } from './stores/activeRunsStore';
import { useLandingStore, useAggregatedReviewItems } from './stores/landingStore';
import type { PermissionInput } from './types/session';

// Type for IPC response
import type { IPCResponse } from './utils/api';

interface PermissionRequest {
  id: string;
  sessionId: string;
  toolName: string;
  input: PermissionInput;
  timestamp: number;
}

function App() {
  const [isWelcomeOpen, setIsWelcomeOpen] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [currentPermissionRequest, setCurrentPermissionRequest] = useState<PermissionRequest | null>(null);
  const [hasCheckedWelcome, setHasCheckedWelcome] = useState(false);
  const [isPromptHistoryOpen, setIsPromptHistoryOpen] = useState(false);
  const [globalSearch, setGlobalSearch] = useState('');
  const view = useNavigationStore((s) => s.view);
  const showHumanReview = useNavigationStore((s) => s.humanReviewOpen);
  const toggleHumanReview = useNavigationStore((s) => s.toggleHumanReview);
  const showBacklog = useNavigationStore((s) => s.backlogOpen);
  const toggleBacklog = useNavigationStore((s) => s.toggleBacklog);
  const showInsights = useNavigationStore((s) => s.insightsOpen);
  const toggleInsights = useNavigationStore((s) => s.toggleInsights);
  const showWorkflows = useNavigationStore((s) => s.workflowsOpen);
  const toggleWorkflows = useNavigationStore((s) => s.toggleWorkflows);
  const showVerifyQueue = useNavigationStore((s) => s.verifyQueueOpen);
  const toggleVerifyQueue = useNavigationStore((s) => s.toggleVerifyQueue);
  // Human-review rail badge: pending PERMISSION approvals (global approval
  // stream) + pending decision/human_task review items aggregated across all
  // projects from the landing store (init'd app-wide below). Approvals alone
  // missed every queue-backed gate — a planner human gate left the chip at 0
  // while the review pane showed the item.
  const pendingApprovalsCount = useReviewQueueStore((s) => s.queue.length);
  const aggregatedReviewItems = useAggregatedReviewItems();
  const reviewQueueCount = pendingApprovalsCount + aggregatedReviewItems.length;
  // Non-done, non-archived task count drives the backlog rail badge (mirrors the
  // review count). Cross-project by design — the board is the overall view now.
  const backlogCount = useBacklogStore(
    (s) => s.tasks.filter((t) => !t.isDone && t.archived_at === null).length,
  );
  // Pending findings drive the Insights rail badge — derived from the SAME
  // source the review-queue findings partition uses (useReviewItemsSlice.items
  // filtered to kind='finding' + status='pending'; see ReviewQueueView), NOT the
  // insights store, so the badge stays decoupled from the Insights view's own
  // fetch lifecycle. The slice is project-scoped: it carries findings only for
  // the project ReviewQueueView last wired, so this badge reflects the active
  // project's findings (0 until a project's review inbox has been opened).
  const insightsCount = useReviewItemsSlice(
    (s) => s.items.filter((it) => it.kind === 'finding' && it.status === 'pending').length,
  );
  const [isTokenTestOpen, setIsTokenTestOpen] = useState(false);
  const { currentError, clearError } = useErrorStore();
  const { sessions, isLoaded } = useSessionStore();
  const { fetchConfig } = useConfigStore();
  const { activeProjectId } = useNavigationStore();
  
  // One-shot migration: move legacy crystal-sidebar-width → cyboflow-sidebar-width (mount only)
  useEffect(() => {
    migrateLocalStorageKey('crystal-sidebar-width', 'cyboflow-sidebar-width');
  }, []);

  const { width: sidebarWidth, startResize } = useResizable({
    defaultWidth: 500,  // Increased to show git status labels without truncation
    minWidth: 200,
    maxWidth: 600,
    storageKey: 'cyboflow-sidebar-width'
  });
  
  useIPCEvents();
  useNotifications();
  useStuckNotifications();

  // Start the MCP health polling subscription on mount.
  const { subscribeToMcpHealth } = useMcpHealthStore();
  useEffect(() => {
    const unsubscribe = subscribeToMcpHealth();
    return unsubscribe;
  }, [subscribeToMcpHealth]);

  // Subscribe to stuck-run events so RunStatusMap stays current for the lifetime
  // of the app shell (not just while ReviewQueueView is mounted).
  const subscribeToStuckEvents = useReviewQueueSlice((s) => s.subscribeToStuckEvents);
  useEffect(() => {
    const unsubscribe = subscribeToStuckEvents();
    return unsubscribe;
  }, [subscribeToStuckEvents]);

  // Initialise the review queue at the app-shell level so the pending count
  // (and the macOS dock badge) stays live even when the human-review pane is
  // not mounted (it now mounts only when the rail item is active).
  useEffect(() => useReviewQueueStore.getState().init(), []);

  // Init the active-runs store at the app-shell level so the landing home's
  // cross-project run aggregation stays live across center-surface switches
  // (init returns an unsubscribe used as the cleanup).
  useEffect(() => useActiveRunsStore.getState().init(), []);

  // Init the landing aggregation (projects + review_items fan-out across
  // projects) so the home surface has data the moment it mounts (idempotent;
  // returns an unsubscribe used as the cleanup).
  useEffect(() => useLandingStore.getState().init(), []);

  // Init the backlog store at the app-shell level so the rail badge shows the
  // real pending-task count on load — not 0 until BacklogPane first mounts on
  // click. The store is GLOBAL (cross-project board): init() takes no project,
  // is idempotent while wired (BacklogPane's own init no-ops), and returns the
  // unsubscribe used as the cleanup.
  useEffect(() => useBacklogStore.getState().init(), []);

  // Load config on app startup
  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // CRITICAL PERFORMANCE FIX: Very aggressive cleanup to prevent V8 array iteration issues
  useEffect(() => {
    // Run cleanup every 30 seconds to prevent array buildup that causes CPU spikes
    const cleanupInterval = setInterval(() => {
      const store = useSessionStore.getState();
      // Always cleanup when we have multiple sessions to prevent memory issues
      if (store.sessions.length > 0) {
        store.cleanupInactiveSessions();
      }
    }, 30 * 1000); // 30 seconds - much more frequent to prevent V8 optimization failures
    
    // Immediate cleanup when switching sessions
    const handleSessionSwitch = () => {
      // Immediate cleanup to free memory right away
      const store = useSessionStore.getState();
      if (store.sessions.length > 0) {
        store.cleanupInactiveSessions();
      }
    };
    
    window.addEventListener('session-switched', handleSessionSwitch);
    
    // Also cleanup on visibility change to free memory when app is in background
    const handleVisibilityChange = () => {
      if (document.hidden) {
        const store = useSessionStore.getState();
        if (store.sessions.length > 0) {
          store.cleanupInactiveSessions();
        }
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      clearInterval(cleanupInterval);
      window.removeEventListener('session-switched', handleSessionSwitch);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // Add keyboard shortcut for prompt history
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + P to open prompt history
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault();
        setIsPromptHistoryOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    // Show welcome screen intelligently based on user state
    // This should only run once when the app is loaded, not when sessions change
    if (!isLoaded || hasCheckedWelcome) {
      return;
    }

    const checkInitialState = async () => {
      if (!window.electron?.invoke) {
        return;
      }

      // Get preferences from database
      const hideWelcomeResult = await window.electron.invoke('preferences:get', 'hide_welcome') as IPCResponse<string>;
      const welcomeShownResult = await window.electron.invoke('preferences:get', 'welcome_shown') as IPCResponse<string>;

      const hideWelcome = hideWelcomeResult?.data === 'true';
      const hasSeenWelcome = welcomeShownResult?.data === 'true';

      // If user explicitly said "don't show again", respect that preference
      if (!hideWelcome) {
        try {
          const projectsResponse = await API.projects.getAll();
          const hasProjects = projectsResponse.success && projectsResponse.data && projectsResponse.data.length > 0;
          // Get sessions from the API to avoid stale closure
          const sessionsResponse = await API.sessions.getAll();
          const hasSessions = sessionsResponse.success && sessionsResponse.data && sessionsResponse.data.length > 0;

          // Show welcome if:
          // 1. First time user (no projects and never seen welcome)
          // 2. Returning user with no active data (no projects and no sessions)
          const isFirstTimeUser = !hasProjects && !hasSeenWelcome;
          const isReturningUserWithNoData = !hasProjects && !hasSessions && hasSeenWelcome;

          if (isFirstTimeUser || isReturningUserWithNoData) {
            setIsWelcomeOpen(true);
            // Mark that welcome has been shown at least once
            await window.electron.invoke('preferences:set', 'welcome_shown', 'true');
          }
        } catch (error) {
          console.error('Error checking initial state:', error);
        }
      }
    };
    
    // Set the flag first to prevent re-runs
    setHasCheckedWelcome(true);
    checkInitialState();
  }, [isLoaded]);

  useEffect(() => {
    // Set up permission request listener
    const handlePermissionRequest = (...args: unknown[]) => {
      const request = args[0] as PermissionRequest;
      setCurrentPermissionRequest(request);
    };
    
    window.electron?.on('permission:request', handlePermissionRequest);
    
    return () => {
      window.electron?.off('permission:request', handlePermissionRequest);
    };
  }, []);

  // Add keyboard shortcut for token test page (Cmd/Ctrl + Shift + T) - Development only
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'T') {
        // Only allow in development mode
        if (process.env.NODE_ENV === 'development') {
          e.preventDefault();
          setIsTokenTestOpen(prev => !prev);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
  
  const handlePermissionResponse = async (requestId: string, behavior: 'allow' | 'deny', _updatedInput?: PermissionInput, message?: string) => {
    try {
      await API.permissions.respond(requestId, {
        allow: behavior === 'allow',
        reason: message
      });
      setCurrentPermissionRequest(null);
    } catch (error) {
      console.error('Failed to respond to permission request:', error);
    }
  };

  return (
    <ContextMenuProvider>
      {/* Outer: h-screen flex-col so StatusBar sits below the main row */}
      <div className="h-screen flex flex-col overflow-hidden bg-bg-primary">
        <MainProcessLogger />
        {/* 38px Protoflow title bar (flowed, drag region with native traffic-light gutter) */}
        <TitleBar
          searchQuery={globalSearch}
          onSearchChange={setGlobalSearch}
          onPromptHistoryClick={() => setIsPromptHistoryOpen(true)}
        />
        {/* Shell geometry: [agent rail | center]. Human review folds into the
            rail as a primary item that swaps the center to a full-width review
            pane (see docs/SHELL-LAYOUT.md). */}
        <div className="flex flex-1 overflow-hidden">
          <Sidebar
            onAboutClick={() => setIsAboutOpen(true)}
            onPromptHistoryClick={() => setIsPromptHistoryOpen(true)}
            width={sidebarWidth}
            onResize={startResize}
            pendingReviewCount={reviewQueueCount}
            humanReviewActive={showHumanReview}
            onToggleHumanReview={toggleHumanReview}
            backlogCount={backlogCount}
            backlogActive={showBacklog}
            onToggleBacklog={toggleBacklog}
            insightsCount={insightsCount}
            insightsActive={showInsights}
            onToggleInsights={toggleInsights}
            workflowsActive={showWorkflows}
            onToggleWorkflows={toggleWorkflows}
            verifyQueueActive={showVerifyQueue}
            onToggleVerifyQueue={toggleVerifyQueue}
          />
          {/* Center-surface state machine, keyed off navigationStore.view:
                • 'session' → CyboflowRoot (the active run/session workspace, the
                  only mount point for the run surface; legacy SessionView retired
                  in TASK-690).
                • 'wizard'  → SessionStartWizard (the new-flow launcher).
                • 'home'    → the rail-driven overlays, checked in priority order:
                  InsightsView when the insights rail item is active, else
                  BacklogPane when the backlog rail item is active, else
                  LandingHome (the cross-project home). The navigationStore
                  mutual-exclusion invariant guarantees at most one overlay flag
                  is set, so the order is just a tiebreaker. focusQueue scrolls
                  LandingHome to its review queue when the user arrived from the
                  human-review rail affordance. */}
          <div className="flex flex-col flex-1 overflow-hidden">
            {view === 'session' ? (
              <CyboflowRoot projectId={activeProjectId} />
            ) : view === 'wizard' ? (
              <ErrorBoundary fallback={(error) => (
                <div className="h-full flex items-center justify-center p-4 bg-bg-secondary">
                  <div className="text-center">
                    <p className="text-sm text-status-error font-semibold mb-2">New-flow wizard error — restart app</p>
                    <p className="text-xs text-text-muted">{error.message}</p>
                  </div>
                </div>
              )}>
                <SessionStartWizard />
              </ErrorBoundary>
            ) : showInsights ? (
              <ErrorBoundary fallback={(error) => (
                <div className="h-full flex items-center justify-center p-4 bg-bg-secondary">
                  <div className="text-center">
                    <p className="text-sm text-status-error font-semibold mb-2">Insights error — restart app</p>
                    <p className="text-xs text-text-muted">{error.message}</p>
                  </div>
                </div>
              )}>
                <InsightsView />
              </ErrorBoundary>
            ) : showWorkflows ? (
              <ErrorBoundary fallback={(error) => (
                <div className="h-full flex items-center justify-center p-4 bg-bg-secondary">
                  <div className="text-center">
                    <p className="text-sm text-status-error font-semibold mb-2">Workflows error — restart app</p>
                    <p className="text-xs text-text-muted">{error.message}</p>
                  </div>
                </div>
              )}>
                <WorkflowsView />
              </ErrorBoundary>
            ) : showVerifyQueue ? (
              <ErrorBoundary fallback={(error) => (
                <div className="h-full flex items-center justify-center p-4 bg-bg-secondary">
                  <div className="text-center">
                    <p className="text-sm text-status-error font-semibold mb-2">Verify Queue error — restart app</p>
                    <p className="text-xs text-text-muted">{error.message}</p>
                  </div>
                </div>
              )}>
                <VerifyQueueView />
              </ErrorBoundary>
            ) : showBacklog ? (
              <ErrorBoundary fallback={(error) => (
                <div className="h-full flex items-center justify-center p-4 bg-bg-secondary">
                  <div className="text-center">
                    <p className="text-sm text-status-error font-semibold mb-2">Task backlog error — restart app</p>
                    <p className="text-xs text-text-muted">{error.message}</p>
                  </div>
                </div>
              )}>
                <BacklogPane projectId={activeProjectId} />
              </ErrorBoundary>
            ) : (
              <ErrorBoundary fallback={(error) => (
                <div className="h-full flex items-center justify-center p-4 bg-bg-secondary">
                  <div className="text-center">
                    <p className="text-sm text-status-error font-semibold mb-2">Home surface error — restart app</p>
                    <p className="text-xs text-text-muted">{error.message}</p>
                  </div>
                </div>
              )}>
                <LandingHome focusQueue={showHumanReview} />
              </ErrorBoundary>
            )}
          </div>
        </div>
        {/* Persistent status bar at the bottom of the app shell */}
        <StatusBar />
        <Welcome isOpen={isWelcomeOpen} onClose={() => setIsWelcomeOpen(false)} />
        <AboutDialog isOpen={isAboutOpen} onClose={() => setIsAboutOpen(false)} />
        <ErrorDialog
          isOpen={!!currentError}
          onClose={clearError}
          title={currentError?.title}
          error={currentError?.error || ''}
          details={currentError?.details}
          command={currentError?.command}
        />
        <PermissionDialog
          request={currentPermissionRequest}
          onRespond={handlePermissionResponse}
          session={currentPermissionRequest ? sessions.find(s => s.id === currentPermissionRequest.sessionId) : undefined}
        />
        <PromptHistoryModal
          isOpen={isPromptHistoryOpen}
          onClose={() => setIsPromptHistoryOpen(false)}
        />
        
        {/* Token Test Modal - Toggle with Cmd/Ctrl + Shift + T (Development Only) */}
        {isTokenTestOpen && process.env.NODE_ENV === 'development' && (
          <div className="fixed inset-0 bg-modal-overlay flex items-center justify-center z-50 p-4 overflow-y-auto">
            <div className="bg-bg-primary w-full max-w-6xl max-h-[90vh] overflow-y-auto rounded-lg relative border border-border-primary shadow-2xl">
              <button
                onClick={() => setIsTokenTestOpen(false)}
                className="absolute top-4 right-4 p-2 hover:bg-surface-hover rounded-lg transition-colors text-text-secondary hover:text-text-primary"
                title="Close Token Test (Cmd/Ctrl + Shift + T)"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <div className="absolute top-4 left-4 text-xs text-text-muted bg-surface-secondary px-2 py-1 rounded">
                DEV ONLY
              </div>
              <TokenTest />
            </div>
          </div>
        )}
      </div>
    </ContextMenuProvider>
  );
}

export default App;