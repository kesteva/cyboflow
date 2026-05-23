import React, { useState, useEffect, useCallback } from 'react';
import { Session } from '../types/session';
import { PanelTabBar } from './panels/PanelTabBar';
import { PanelContainer } from './panels/PanelContainer';
import { SessionProvider } from '../contexts/SessionContext';
import { useAddTerminalShortcut } from '../hooks/useAddTerminalShortcut';
import { useAddTerminalPanel } from '../hooks/useAddTerminalPanel';
import { useEnsureClaudePanel } from '../hooks/useEnsureClaudePanel';
import { useAddClaudeShortcut } from '../hooks/useAddClaudeShortcut';
import { usePanelSurface } from '../hooks/usePanelSurface';

interface ProjectViewProps {
  projectId: number;
  projectName: string;
  onGitPull: () => void;
  onGitPush: () => void;
  isMerging: boolean;
}

export const ProjectView: React.FC<ProjectViewProps> = ({
  projectId,
  projectName,
  onGitPull,
  onGitPush,
  isMerging
}) => {
  const [isLoadingSession, setIsLoadingSession] = useState(false);

  const {
    mainRepoSession,
    sessionPanels,
    currentActivePanel,
    handlePanelSelect,
    handlePanelClose,
  } = usePanelSurface(projectId, { autoCreatePermanentPanels: true });

  // Derived local — used by hooks that expect a sessionId string.
  const mainRepoSessionId = mainRepoSession?.id ?? null;

  // Clear the loading spinner once the hook has resolved the main-repo session.
  // Session activation is handled inside usePanelSurface — no need to call it here.
  useEffect(() => {
    if (mainRepoSession) {
      setIsLoadingSession(false);
    }
  }, [mainRepoSession]);

  // Show loading indicator while the panel surface hasn't resolved yet.
  useEffect(() => {
    setIsLoadingSession(true);
  }, [projectId]);

  const ensureClaudePanel = useEnsureClaudePanel(mainRepoSession, { logTag: 'ProjectView' });

  const handleAddTerminal = useAddTerminalPanel(mainRepoSession, {
    logTag: 'ProjectView',
  });

  useAddTerminalShortcut(handleAddTerminal);
  useAddClaudeShortcut(ensureClaudePanel);

  // Wrapped git operations
  const handleGitPull = useCallback(() => {
    // Find or create a Claude panel
    const claudePanel = sessionPanels.find(p => p.type === 'claude');
    if (claudePanel) {
      handlePanelSelect(claudePanel);
    } else {
      ensureClaudePanel();
    }
    onGitPull();
  }, [onGitPull, sessionPanels, handlePanelSelect, ensureClaudePanel]);

  const handleGitPush = useCallback(() => {
    // Find or create a Claude panel
    const claudePanel = sessionPanels.find(p => p.type === 'claude');
    if (claudePanel) {
      handlePanelSelect(claudePanel);
    } else {
      ensureClaudePanel();
    }
    onGitPush();
  }, [onGitPush, sessionPanels, handlePanelSelect, ensureClaudePanel]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg-primary">
      {/* Project Header */}
      <div className="bg-surface-primary border-b border-border-primary px-4 py-3 flex-shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0 relative">
            <h2 className="font-bold text-xl text-text-primary truncate">
              {projectName}
            </h2>

            {/* Git Actions for Main Project */}
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <div className="flex flex-wrap items-center gap-2 relative z-20">
                <div className="group relative">
                  <button
                    onClick={handleGitPull}
                    disabled={isMerging}
                    className={`px-3 py-1.5 rounded-full border transition-all flex items-center space-x-2 ${
                      isMerging
                        ? 'bg-surface-secondary border-border-secondary text-text-disabled cursor-not-allowed'
                        : 'bg-surface-secondary border-status-info text-status-info hover:bg-status-info/10 hover:border-status-info/70'
                    }`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 17l-4 4m0 0l-4-4m4 4V3" />
                    </svg>
                    <span className="text-sm font-medium">{isMerging ? 'Pulling...' : 'Pull'}</span>
                  </button>
                </div>
                <div className="group relative">
                  <button
                    onClick={handleGitPush}
                    disabled={isMerging}
                    className={`px-3 py-1.5 rounded-full border transition-all flex items-center space-x-2 ${
                      isMerging
                        ? 'bg-surface-secondary border-border-secondary text-text-disabled cursor-not-allowed'
                        : 'bg-surface-secondary border-status-success text-status-success hover:bg-status-success/10 hover:border-status-success/70'
                    }`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7l4-4m0 0l4 4m-4-4v18" />
                    </svg>
                    <span className="text-sm font-medium">{isMerging ? 'Pushing...' : 'Push'}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tool Panel Bar (Dashboard is now part of the panel system) */}
      {mainRepoSessionId && (
        <SessionProvider session={mainRepoSession as Session} projectName={projectName}>
          <PanelTabBar
            panels={sessionPanels}
            activePanel={currentActivePanel}
            onPanelSelect={handlePanelSelect}
            onPanelClose={handlePanelClose}
            context="project"
            onAddTerminal={handleAddTerminal}
            onAddClaude={ensureClaudePanel}
          />
        </SessionProvider>
      )}

      {/* Content Area */}
      <div className="flex-1 flex relative min-h-0">
        <div className="flex-1 relative">
          {isLoadingSession || !mainRepoSessionId ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-interactive mx-auto mb-4"></div>
                <p className="text-text-secondary">Loading panels...</p>
              </div>
            </div>
          ) : sessionPanels.length > 0 && currentActivePanel ? (
            <SessionProvider session={mainRepoSession as Session} projectName={projectName}>
              {sessionPanels.map(panel => (
                <div
                  key={panel.id}
                  className="absolute inset-0"
                  style={{ display: panel.id === currentActivePanel.id ? 'block' : 'none' }}
                >
                  <PanelContainer
                    panel={panel}
                    isActive={panel.id === currentActivePanel.id}
                    isMainRepo={!!mainRepoSession?.isMainRepo}
                  />
                </div>
              ))}
            </SessionProvider>
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <p className="text-text-secondary mb-4">Loading dashboard...</p>
                <p className="text-text-tertiary text-sm">Setting up project panels</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
