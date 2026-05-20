import { useState, useEffect } from 'react';
import { useIPCEvents } from './hooks/useIPCEvents';
import { useNotifications } from './hooks/useNotifications';
import { useStuckNotifications } from './hooks/useStuckNotifications';
import { useResizable } from './hooks/useResizable';
import { Sidebar } from './components/Sidebar';
import { SessionView } from './components/SessionView';
import { CyboflowRoot } from './components/cyboflow/CyboflowRoot';
import { PromptHistoryModal } from './components/PromptHistoryModal';
import Help from './components/Help';
import Welcome from './components/Welcome';
import AnalyticsConsentDialog from './components/AnalyticsConsentDialog';
import { AboutDialog } from './components/AboutDialog';
import { UpdateDialog } from './components/UpdateDialog';
import { MainProcessLogger } from './components/MainProcessLogger';
import { ErrorDialog } from './components/ErrorDialog';
import { PermissionDialog } from './components/PermissionDialog';
import { DiscordPopup } from './components/DiscordPopup';
import { useErrorStore } from './stores/errorStore';
import { useSessionStore } from './stores/sessionStore';
import { useConfigStore } from './stores/configStore';
import { useNavigationStore } from './stores/navigationStore';
import { API } from './utils/api';
import { migrateLocalStorageKey } from './utils/migrateLocalStorageKey';
import { ContextMenuProvider } from './contexts/ContextMenuContext';
import { TokenTest } from './components/TokenTest';
import { ErrorBoundary } from './components/ErrorBoundary';
import ReviewQueueView from './components/ReviewQueueView';
import { StatusBar } from './components/StatusBar';
import { useMcpHealthStore } from './stores/mcpHealthStore';
import { useReviewQueueSlice } from './stores/reviewQueueSlice';
import type { VersionUpdateInfo, PermissionInput } from './types/session';

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
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isWelcomeOpen, setIsWelcomeOpen] = useState(false);
  const [isAnalyticsConsentOpen, setIsAnalyticsConsentOpen] = useState(false);
  const [hasCheckedAnalyticsConsent, setHasCheckedAnalyticsConsent] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [isUpdateDialogOpen, setIsUpdateDialogOpen] = useState(false);
  const [updateVersionInfo, setUpdateVersionInfo] = useState<VersionUpdateInfo | null>(null);
  const [currentPermissionRequest, setCurrentPermissionRequest] = useState<PermissionRequest | null>(null);
  const [isDiscordOpen, setIsDiscordOpen] = useState(false);
  const [hasCheckedWelcome, setHasCheckedWelcome] = useState(false);
  const [isPromptHistoryOpen, setIsPromptHistoryOpen] = useState(false);
  const [isTokenTestOpen, setIsTokenTestOpen] = useState(false);
  // Toggle between the new CyboflowRoot view and the legacy SessionView.
  // Default is the new Cyboflow view; the legacy toggle lets users fall back.
  const [useLegacyCrystalView, setUseLegacyCrystalView] = useState(false);
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
  const { showNotification } = useNotifications();
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

  // Load config on app startup
  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // Check if analytics consent dialog should be shown (before other dialogs)
  useEffect(() => {
    if (hasCheckedAnalyticsConsent) {
      return;
    }

    const checkAnalyticsConsent = async () => {
      if (!window.electron?.invoke) {
        return;
      }

      try {
        // Check if consent has already been shown
        const consentResult = await window.electron.invoke('preferences:get', 'analytics_consent_shown') as IPCResponse<string>;
        const hasShownConsent = consentResult?.data === 'true';

        if (!hasShownConsent) {
          // Show consent dialog
          setIsAnalyticsConsentOpen(true);
        }
      } catch (error) {
        console.error('[App] Error checking analytics consent:', error);
      }
    };

    setHasCheckedAnalyticsConsent(true);
    checkAnalyticsConsent();
  }, [hasCheckedAnalyticsConsent]);

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
    // Show welcome screen and Discord popup intelligently based on user state
    // This should only run once when the app is loaded, not when sessions change
    // Don't show welcome while analytics consent dialog is open
    if (!isLoaded || hasCheckedWelcome || isAnalyticsConsentOpen) {
      return;
    }

    const checkInitialState = async () => {
      if (!window.electron?.invoke) {
        return;
      }

      // Get preferences from database
      const hideWelcomeResult = await window.electron.invoke('preferences:get', 'hide_welcome') as IPCResponse<string>;
      const welcomeShownResult = await window.electron.invoke('preferences:get', 'welcome_shown') as IPCResponse<string>;
      const hideDiscordResult = await window.electron.invoke('preferences:get', 'hide_discord') as IPCResponse<string>;
      
      const hideWelcome = hideWelcomeResult?.data === 'true';
      const hasSeenWelcome = welcomeShownResult?.data === 'true';
      const hideDiscord = hideDiscordResult?.data === 'true';
      
      
      // Track whether we're showing the welcome screen
      let welcomeScreenShown = false;
      
      // If user explicitly said "don't show again", respect that preference
      if (hideWelcome) {
        welcomeScreenShown = false;
      } else {
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
            welcomeScreenShown = true;
            // Mark that welcome has been shown at least once
            await window.electron.invoke('preferences:set', 'welcome_shown', 'true');
          } else {
            welcomeScreenShown = false;
          }
        } catch (error) {
          console.error('Error checking initial state:', error);
          welcomeScreenShown = false;
        }
      }
      
      // If welcome screen is not shown and Discord hasn't been hidden, check if we should show Discord popup
      if (!welcomeScreenShown && !hideDiscord) {
        
        try {
          // Get the last app open to see if Discord was already shown
          const result = await window.electron.invoke('app:get-last-open') as IPCResponse<{ discord_shown?: boolean }>;
          
          if (result?.success && result.data) {
            const lastOpen = result.data;
            
            // Show Discord popup if it hasn't been shown yet
            if (!lastOpen.discord_shown) {
              setIsDiscordOpen(true);
              // Mark that we're showing the Discord popup
              if (window.electron?.invoke) {
                await window.electron.invoke('app:update-discord-shown');
              }
            } else {
              // Discord already shown
            }
          } else {
            // No previous app open - show Discord popup
            setIsDiscordOpen(true);
            // Will update discord shown status after recording app open
          }
        } catch (error) {
          // Error checking Discord popup
        }
        
        // Record this app open
        if (window.electron?.invoke) {
          await window.electron.invoke('app:record-open', hideWelcome, false);
          
          // If we showed Discord popup and there was no previous app open, update the status
          const result = await window.electron.invoke('app:get-last-open') as IPCResponse<{ discord_shown?: boolean }>;
          if (!result?.data?.discord_shown && isDiscordOpen) {
            await window.electron.invoke('app:update-discord-shown');
          }
        }
      }
    };
    
    // Set the flag first to prevent re-runs
    setHasCheckedWelcome(true);
    checkInitialState();
  }, [isLoaded, isAnalyticsConsentOpen]); // Also wait for analytics consent dialog to close

  // Discord popup logic is now combined with welcome screen logic above
  
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

  useEffect(() => {
    // Set up version update listener
    if (!window.electronAPI?.events) return;
    
    const handleVersionUpdate = (versionInfo: VersionUpdateInfo) => {
      console.log('[App] Version update available:', versionInfo);
      setUpdateVersionInfo(versionInfo);
      setIsUpdateDialogOpen(true);
      showNotification(
        `🚀 Update Available - Cyboflow v${versionInfo.latest}`,
        'A new version of Cyboflow is available!',
        '/favicon.ico',
        'version_update',
        `update:${versionInfo.latest}` // Deduplicate by version - only track once per version
      );
    };
    
    // Set up the listener using the events API
    const removeListener = window.electronAPI.events.onVersionUpdateAvailable(handleVersionUpdate);
    
    return () => {
      if (removeListener) {
        removeListener();
      }
    };
  }, [showNotification]);

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
        {/* Draggable title bar area */}
        <div
          className="fixed top-0 left-0 right-0 h-8 z-50 flex items-center justify-end pr-4"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
        </div>
        {/* Main content row: review queue + sidebar + primary panel */}
        <div className="flex flex-1 overflow-hidden">
          <ErrorBoundary fallback={(error) => (
            <div className="w-[360px] h-full flex items-center justify-center p-4 border-r border-border-primary bg-bg-secondary">
              <div className="text-center">
                <p className="text-sm text-status-error font-semibold mb-2">Review queue error — restart app</p>
                <p className="text-xs text-text-muted">{error.message}</p>
              </div>
            </div>
          )}>
            <ReviewQueueView />
          </ErrorBoundary>
          <Sidebar
            onHelpClick={() => setIsHelpOpen(true)}
            onAboutClick={() => setIsAboutOpen(true)}
            onPromptHistoryClick={() => setIsPromptHistoryOpen(true)}
            width={sidebarWidth}
            onResize={startResize}
          />
          {/* Primary content area: CyboflowRoot when a project is active, else SessionView.
              The "Legacy Cyboflow view" toggle lets users fall back to the legacy surface.
              Deeper UI surgery is deferred to the crystal-cuts-and-rebrand epic. */}
          {activeProjectId !== null && !useLegacyCrystalView ? (
            <div className="flex flex-col flex-1 overflow-hidden">
              <div
                className="flex justify-end px-4 py-1 border-b border-border-primary"
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              >
                <button
                  onClick={() => setUseLegacyCrystalView(true)}
                  className="text-xs text-text-secondary hover:text-text-primary"
                  title="Switch back to the legacy session view"
                >
                  Legacy view
                </button>
              </div>
              <div className="flex-1 overflow-hidden">
                <CyboflowRoot projectId={activeProjectId} />
              </div>
            </div>
          ) : (
            <div className="flex flex-col flex-1 overflow-hidden">
              {useLegacyCrystalView && (
                <div
                  className="flex justify-end px-4 py-1 border-b border-border-primary"
                  style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                >
                  <button
                    onClick={() => setUseLegacyCrystalView(false)}
                    className="text-xs text-text-secondary hover:text-text-primary"
                    title="Switch to the new Cyboflow view"
                  >
                    Cyboflow view
                  </button>
                </div>
              )}
              <SessionView />
            </div>
          )}
        </div>
        {/* Persistent status bar at the bottom of the app shell */}
        <StatusBar />
        <Help isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />
        <AnalyticsConsentDialog
          isOpen={isAnalyticsConsentOpen}
          onClose={() => setIsAnalyticsConsentOpen(false)}
        />
        <Welcome isOpen={isWelcomeOpen} onClose={() => setIsWelcomeOpen(false)} />
        <AboutDialog isOpen={isAboutOpen} onClose={() => setIsAboutOpen(false)} />
        <UpdateDialog 
          isOpen={isUpdateDialogOpen} 
          onClose={() => setIsUpdateDialogOpen(false)}
          versionInfo={updateVersionInfo || undefined}
        />
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
        <DiscordPopup 
          isOpen={isDiscordOpen} 
          onClose={() => setIsDiscordOpen(false)} 
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