import { useState, useEffect } from 'react';
import { Settings } from './Settings';
import { DraggableProjectTreeView } from './DraggableProjectTreeView';
import { ArchiveProgress } from './ArchiveProgress';
import { Info, Clock, Check, Edit, CircleArrowDown, AlertTriangle, GitMerge, Kanban, Activity, Workflow, ScanEye } from 'lucide-react';
import cyboflowLogo from '../assets/cyboflow-logo.svg';
import { IconButton } from './ui/Button';
import { Modal, ModalHeader, ModalBody } from './ui/Modal';
import { useConfigStore } from '../stores/configStore';
import { trackEvent } from '../utils/telemetry';

interface SidebarProps {
  onAboutClick: () => void;
  onPromptHistoryClick: () => void;
  width: number;
  onResize: (e: React.MouseEvent) => void;
  /** Count of pending human-review approvals (drives the rail badge). */
  pendingReviewCount: number;
  /** Whether the human-review pane is the active center view. */
  humanReviewActive: boolean;
  /** Toggle the human-review center pane. */
  onToggleHumanReview: () => void;
  /**
   * Count of non-done backlog tasks (drives the rail badge). Optional with a
   * safe default so existing render sites (e.g. unit tests predating the
   * backlog) keep compiling; App.tsx always supplies it.
   */
  backlogCount?: number;
  /** Whether the task-backlog pane is the active center view. */
  backlogActive?: boolean;
  /** Toggle the task-backlog center pane. */
  onToggleBacklog?: () => void;
  /**
   * Count of pending findings (drives the Insights rail badge). Optional with a
   * safe default so render sites predating the Insights pane keep compiling;
   * App.tsx always supplies it.
   */
  insightsCount?: number;
  /** Whether the Insights pane is the active center view. */
  insightsActive?: boolean;
  /** Toggle the Insights center pane. */
  onToggleInsights?: () => void;
  /** Whether the Workflows pane is the active center view. */
  workflowsActive?: boolean;
  /** Toggle the Workflows center pane. */
  onToggleWorkflows?: () => void;
  /** Whether the Verify-Queue pane is the active center view. */
  verifyQueueActive?: boolean;
  /** Toggle the Verify-Queue center pane. */
  onToggleVerifyQueue?: () => void;
}

export function Sidebar({
  onAboutClick,
  onPromptHistoryClick,
  width,
  onResize,
  pendingReviewCount,
  humanReviewActive,
  onToggleHumanReview,
  backlogCount = 0,
  backlogActive = false,
  onToggleBacklog,
  insightsCount = 0,
  insightsActive = false,
  onToggleInsights,
  workflowsActive = false,
  onToggleWorkflows,
  verifyQueueActive = false,
  onToggleVerifyQueue,
}: SidebarProps) {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<'general' | 'notifications' | 'updates'>('general');
  const demoModeEnabled = useConfigStore((state) => state.config?.demoMode ?? false);
  const [showStatusGuide, setShowStatusGuide] = useState(false);
  const [version, setVersion] = useState<string>('');
  const [gitCommit, setGitCommit] = useState<string>('');
  const [worktreeName, setWorktreeName] = useState<string>('');
  const [isDev, setIsDev] = useState<boolean>(false);
  useEffect(() => {
    // Fetch version info on component mount
    const fetchVersion = async () => {
      try {
        console.log('[Sidebar Debug] Fetching version info...');
        const result = await window.electronAPI.getVersionInfo();
        console.log('[Sidebar Debug] Version info result:', result);
        if (result.success && result.data) {
          console.log('[Sidebar Debug] Version data:', result.data);
          if (result.data.current) {
            setVersion(result.data.current);
            console.log('[Sidebar Debug] Set version:', result.data.current);
          }
          if (result.data.gitCommit) {
            setGitCommit(result.data.gitCommit);
            console.log('[Sidebar Debug] Set gitCommit:', result.data.gitCommit);
          }
          if (result.data.worktreeName) {
            setWorktreeName(result.data.worktreeName);
            console.log('[Sidebar Debug] Set worktreeName:', result.data.worktreeName);
          } else {
            console.log('[Sidebar Debug] No worktreeName in response');
          }
          setIsDev(result.data.variant === 'dev');
        }
      } catch (error) {
        console.error('Failed to fetch version:', error);
      }
    };

    fetchVersion();
  }, []);

  useEffect(() => {
    // Boot-time schema-version gate: if the user picked "Check for Updates" when
    // an older build opened a DB a newer build had advanced, the main process
    // flags it. Consume the one-shot flag on mount and open Settings → Updates.
    const consumeOpenUpdateSettings = async () => {
      try {
        const open = await window.electronAPI.invoke('app:consume-open-update-settings');
        if (open === true) {
          setSettingsInitialTab('updates');
          setIsSettingsOpen(true);
        }
      } catch (error) {
        console.error('Failed to consume open-update-settings flag:', error);
      }
    };
    consumeOpenUpdateSettings();
  }, []);

  return (
    <>
      <div 
        data-testid="sidebar" 
        className="bg-surface-primary text-text-primary h-full flex flex-col pt-4 relative flex-shrink-0 border-r border-border-primary"
        style={{ width: `${width}px` }}
      >
        {/* Resize handle */}
        <div
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize group z-10"
          onMouseDown={onResize}
        >
          {/* Visual indicator */}
          <div className="absolute inset-0 bg-border-secondary group-hover:bg-interactive transition-colors" />
          {/* Larger grab area */}
          <div className="absolute -left-2 -right-2 top-0 bottom-0" />
          {/* Drag indicator dots */}
          <div className="absolute top-1/2 -translate-y-1/2 right-0 transform translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
            <div className="flex flex-col gap-1">
              <div className="w-1 h-1 bg-interactive rounded-full" />
              <div className="w-1 h-1 bg-interactive rounded-full" />
              <div className="w-1 h-1 bg-interactive rounded-full" />
            </div>
          </div>
        </div>
        <div className="p-4 border-b border-border-primary flex items-center justify-between overflow-hidden">
          <div className="flex items-center space-x-2 min-w-0">
            <img src={cyboflowLogo} alt="Cyboflow" className="h-6 w-6 flex-shrink-0" />
            <h1 className="text-xl font-bold truncate">Cyboflow</h1>
            {isDev && (
              <span
                className="flex-shrink-0 rounded-[4px] border border-interactive px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-interactive"
                title="Dev build"
                data-testid="dev-chip"
              >
                Dev
              </span>
            )}
            {demoModeEnabled && (
              <span
                className="flex-shrink-0 rounded-[4px] border border-interactive px-1.5 py-px text-[10px] font-bold tracking-wide text-interactive"
                title="Demo mode — sandbox project with scripted agents. Turn off in Settings."
                data-testid="demo-mode-chip"
              >
                DEMO
              </span>
            )}
          </div>
          <div className="flex items-center space-x-2 flex-shrink-0">
            <IconButton
              onClick={() => { setSettingsInitialTab('general'); setIsSettingsOpen(true); trackEvent('settings_opened'); }}
              aria-label="Settings"
              data-testid="settings-button"
              size="md"
              icon={
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              }
            />
          </div>
        </div>

        {/* Human review — primary rail item; opens the full-width review pane */}
        <button
          type="button"
          onClick={onToggleHumanReview}
          aria-pressed={humanReviewActive}
          data-testid="human-review-rail-item"
          className={`mx-2 mt-2 flex items-center gap-2.5 border px-3 py-2.5 text-left transition-colors ${
            humanReviewActive
              ? 'border-border-emphasized bg-surface-primary'
              : 'border-border-primary bg-bg-primary hover:border-border-emphasized'
          }`}
          style={humanReviewActive ? { boxShadow: 'inset 3px 0 0 var(--color-interactive-primary)' } : undefined}
        >
          <span
            className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-full text-white"
            style={{ background: 'repeating-linear-gradient(135deg, var(--human) 0 4px, var(--human-hatch) 4px 8px)' }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="4" r="2" />
              <path d="M2 11c.4-2.3 2-3.5 4-3.5s3.6 1.2 4 3.5" />
            </svg>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11.5px] font-bold leading-tight text-text-primary">Human review</span>
            <span className="block text-[10px] text-text-secondary">Pending approvals</span>
          </span>
          <span
            className={`min-w-[20px] flex-shrink-0 rounded-[9px] px-1.5 py-px text-center text-[10px] font-bold text-text-on-interactive ${
              pendingReviewCount > 0 ? 'bg-interactive' : 'bg-text-tertiary'
            }`}
          >
            {pendingReviewCount}
          </span>
        </button>

        {/* Task backlog — primary rail item directly below Human review; opens
            the full-width backlog pane (mirrors the Human-review markup). */}
        <button
          type="button"
          onClick={() => onToggleBacklog?.()}
          aria-pressed={backlogActive}
          data-testid="task-backlog-rail-item"
          className={`mx-2 mt-2 flex items-center gap-2.5 border px-3 py-2.5 text-left transition-colors ${
            backlogActive
              ? 'border-border-emphasized bg-surface-primary'
              : 'border-border-primary bg-bg-primary hover:border-border-emphasized'
          }`}
          style={backlogActive ? { boxShadow: 'inset 3px 0 0 var(--color-interactive-primary)' } : undefined}
        >
          <span className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-full bg-interactive text-text-on-interactive">
            <Kanban className="h-3 w-3" strokeWidth={2} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11.5px] font-bold leading-tight text-text-primary">Task backlog</span>
            <span className="block text-[10px] text-text-secondary">Planning pipeline</span>
          </span>
          <span
            className={`min-w-[20px] flex-shrink-0 rounded-[9px] px-1.5 py-px text-center text-[10px] font-bold text-text-on-interactive ${
              backlogCount > 0 ? 'bg-interactive' : 'bg-text-tertiary'
            }`}
          >
            {backlogCount}
          </span>
        </button>

        {/* Insights — primary rail item directly below Task backlog; opens the
            full-width Insights pane (mirrors the Task-backlog markup). The badge
            counts pending findings. */}
        <button
          type="button"
          onClick={() => onToggleInsights?.()}
          aria-pressed={insightsActive}
          data-testid="insights-rail-item"
          className={`mx-2 mt-2 flex items-center gap-2.5 border px-3 py-2.5 text-left transition-colors ${
            insightsActive
              ? 'border-border-emphasized bg-surface-primary'
              : 'border-border-primary bg-bg-primary hover:border-border-emphasized'
          }`}
          style={insightsActive ? { boxShadow: 'inset 3px 0 0 var(--color-interactive-primary)' } : undefined}
        >
          <span className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-full bg-interactive text-text-on-interactive">
            <Activity className="h-3 w-3" strokeWidth={2} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11.5px] font-bold leading-tight text-text-primary">Insights</span>
            <span className="block text-[10px] text-text-secondary">Findings · stats · quality</span>
          </span>
          <span
            className={`min-w-[20px] flex-shrink-0 rounded-[9px] px-1.5 py-px text-center text-[10px] font-bold text-text-on-interactive ${
              insightsCount > 0 ? 'bg-interactive' : 'bg-text-tertiary'
            }`}
          >
            {insightsCount}
          </span>
        </button>

        {/* Workflows — primary rail item directly below Insights; opens the
            full-width Workflows pane (flows & agents). No badge in v1. */}
        <button
          type="button"
          onClick={() => onToggleWorkflows?.()}
          aria-pressed={workflowsActive}
          data-testid="workflows-rail-item"
          className={`mx-2 mt-2 flex items-center gap-2.5 border px-3 py-2.5 text-left transition-colors ${
            workflowsActive
              ? 'border-border-emphasized bg-surface-primary'
              : 'border-border-primary bg-bg-primary hover:border-border-emphasized'
          }`}
          style={workflowsActive ? { boxShadow: 'inset 3px 0 0 var(--color-interactive-primary)' } : undefined}
        >
          <span className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-full bg-interactive text-text-on-interactive">
            <Workflow className="h-3 w-3" strokeWidth={2} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11.5px] font-bold leading-tight text-text-primary">Workflows</span>
            <span className="block text-[10px] text-text-secondary">Flows &amp; agents</span>
          </span>
        </button>

        {/* Verify Queue — primary rail item directly below Workflows; opens the
            full-width Verify-Queue pane (visual-verification requests). No badge
            in v1. */}
        <button
          type="button"
          onClick={() => onToggleVerifyQueue?.()}
          aria-pressed={verifyQueueActive}
          data-testid="verify-queue-rail-item"
          className={`mx-2 mt-2 flex items-center gap-2.5 border px-3 py-2.5 text-left transition-colors ${
            verifyQueueActive
              ? 'border-border-emphasized bg-surface-primary'
              : 'border-border-primary bg-bg-primary hover:border-border-emphasized'
          }`}
          style={verifyQueueActive ? { boxShadow: 'inset 3px 0 0 var(--color-interactive-primary)' } : undefined}
        >
          <span className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-full bg-interactive text-text-on-interactive">
            <ScanEye className="h-3 w-3" strokeWidth={2} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11.5px] font-bold leading-tight text-text-primary">Verify Queue</span>
            <span className="block text-[10px] text-text-secondary">Visual verification</span>
          </span>
        </button>

        <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
          <div className="px-4 py-2 text-sm uppercase flex items-center justify-between overflow-hidden">
            <span className="truncate text-text-tertiary">Projects & Sessions</span>
            <div className="flex items-center space-x-1">
              <IconButton
                aria-label="View Prompt History (Cmd/Ctrl + P)"
                size="sm"
                onClick={onPromptHistoryClick}
                icon={<Clock className="w-4 h-4" />}
              />
              <IconButton
                aria-label="View status legend"
                size="sm"
                onClick={() => setShowStatusGuide(true)}
                icon={<Info className="w-4 h-4" />}
              />
            </div>
          </div>
          <DraggableProjectTreeView />
        </div>
        
        {/* Bottom section - always visible */}
        <div className="flex-shrink-0">
          {/* Archive progress indicator above version */}
          <ArchiveProgress />
          
          {/* Version display at bottom */}
          {version && (
            <div className="px-4 py-2 border-t border-border-primary">
              <div
                className="text-xs text-text-tertiary text-center cursor-pointer hover:text-text-secondary transition-colors truncate"
                onClick={onAboutClick}
                title="Click to view version details"
              >
                v{version}{worktreeName && ` • ${worktreeName}`}{gitCommit && ` • ${gitCommit}`}
              </div>
            </div>
          )}
        </div>
    </div>

      <Settings isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} initialTab={settingsInitialTab} />
      
      {/* Status Guide Modal */}
      <Modal 
        isOpen={showStatusGuide} 
        onClose={() => setShowStatusGuide(false)}
        size="lg"
      >
        <ModalHeader>Status Indicators Guide</ModalHeader>
        <ModalBody>
            
            <div className="space-y-4">
              {/* Project Indicators */}
              <div className="pb-3 border-b border-border-primary">
                <h4 className="text-sm font-medium text-text-primary mb-2">Project Indicators</h4>
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <svg className="w-4 h-4 text-interactive" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                      <path d="M6 3v12M6 3a9 9 0 0 0 9 9m-9-9a9 9 0 0 1 9 9m0-9h12" />
                    </svg>
                    <div className="absolute -bottom-0.5 -right-0.5 w-2 h-2 bg-status-success rounded-full"></div>
                  </div>
                  <div>
                    <span className="text-text-secondary font-medium">Git Project</span>
                    <p className="text-text-tertiary text-sm">Project connected to a git repository</p>
                  </div>
                </div>
              </div>
              
              {/* Session Status Indicators */}
              <div className="pb-3 border-b border-border-primary">
                <h4 className="text-sm font-medium text-text-primary mb-2">Session Status</h4>
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 bg-status-success rounded-full animate-pulse flex-shrink-0"></div>
                    <div>
                      <span className="text-text-secondary font-medium">Initializing</span>
                      <p className="text-text-tertiary text-sm">Setting up git worktree and environment</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 bg-status-success rounded-full animate-pulse flex-shrink-0"></div>
                    <div>
                      <span className="text-text-secondary font-medium">Running</span>
                      <p className="text-text-tertiary text-sm">Claude is actively processing your request</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 bg-status-warning rounded-full animate-pulse flex-shrink-0"></div>
                    <div>
                      <span className="text-text-secondary font-medium">Waiting</span>
                      <p className="text-text-tertiary text-sm">Claude needs your input to continue</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 bg-status-neutral rounded-full flex-shrink-0"></div>
                    <div>
                      <span className="text-text-secondary font-medium">Completed</span>
                      <p className="text-text-tertiary text-sm">Task finished successfully</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 bg-status-info rounded-full animate-pulse flex-shrink-0"></div>
                    <div>
                      <span className="text-text-secondary font-medium">New Activity</span>
                      <p className="text-text-tertiary text-sm">Session has new unviewed results</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 bg-status-error rounded-full flex-shrink-0"></div>
                    <div>
                      <span className="text-text-secondary font-medium">Error</span>
                      <p className="text-text-tertiary text-sm">Something went wrong with the session</p>
                    </div>
                  </div>
                </div>
              </div>
              
              {/* Git Status Indicators */}
              <div>
                <h4 className="text-sm font-medium text-text-primary mb-2">Git Status Indicators</h4>
                <p className="text-text-tertiary text-sm mb-3">Click any indicator to view detailed changes in the Diff panel</p>
                
                {/* HIGH PRIORITY */}
                <div className="mb-3">
                  <p className="text-xs font-medium text-text-tertiary mb-2">HIGH PRIORITY</p>
                  <div className="space-y-2">
                    <div className="flex items-center gap-3 p-2 rounded">
                      <span className="inline-flex items-center justify-center gap-0.5 w-[5.5ch] px-1.5 py-0.5 text-xs rounded-md border bg-status-success/10 text-status-success border-border-primary">
                        <GitMerge className="w-3.5 h-3.5" strokeWidth={2} />
                        <span className="font-bold">3</span>
                      </span>
                      <span className="text-xs text-text-secondary"><strong>Ready to Merge</strong> - Changes ready to merge cleanly</span>
                    </div>
                    
                    <div className="flex items-center gap-3 p-2 rounded">
                      <span className="inline-flex items-center justify-center gap-0.5 w-[5.5ch] px-1.5 py-0.5 text-xs rounded-md border bg-status-warning/10 text-status-warning border-border-primary">
                        <AlertTriangle className="w-3.5 h-3.5" strokeWidth={2} />
                        <span className="font-bold">2</span>
                      </span>
                      <span className="text-xs text-text-secondary"><strong>Conflict Risk</strong> - Behind main, potential conflicts</span>
                    </div>
                  </div>
                </div>
                
                {/* SPECIAL CASES */}
                <div className="mb-3">
                  <p className="text-xs font-medium text-text-tertiary mb-2">SPECIAL CASES</p>
                  <div className="space-y-2">
                    <div className="flex items-center gap-3 p-2 rounded">
                      <span className="inline-flex items-center justify-center w-[5.5ch] px-1.5 py-0.5 text-xs rounded-md border bg-status-error/10 text-status-error border-border-primary">
                        <AlertTriangle className="w-3.5 h-3.5" strokeWidth={2} />
                      </span>
                      <span className="text-xs text-text-secondary"><strong>Conflicts</strong> - Active merge conflicts need resolution</span>
                    </div>
                    
                    <div className="flex items-center gap-3 p-2 rounded">
                      <span className="inline-flex items-center justify-center gap-0.5 w-[5.5ch] px-1.5 py-0.5 text-xs rounded-md border bg-status-info/10 text-status-info border-border-primary">
                        <Edit className="w-3.5 h-3.5" strokeWidth={2} />
                        <span className="font-bold">2</span>
                      </span>
                      <span className="text-xs text-text-secondary"><strong>Uncommitted</strong> - Work in progress</span>
                    </div>
                  </div>
                </div>
                
                {/* LOW PRIORITY */}
                <div>
                  <p className="text-xs font-medium text-text-tertiary mb-2">LOW PRIORITY</p>
                  <div className="space-y-2">
                    <div className="flex items-center gap-3 p-2 rounded">
                      <span className="inline-flex items-center justify-center gap-0.5 w-[5.5ch] px-1.5 py-0.5 text-xs rounded-md border bg-bg-tertiary text-text-tertiary border-border-primary">
                        <CircleArrowDown className="w-3.5 h-3.5" strokeWidth={2} />
                        <span className="font-bold">2</span>
                      </span>
                      <span className="text-xs text-text-secondary"><strong>Behind Only</strong> - No unique changes</span>
                    </div>
                    
                    <div className="flex items-center gap-3 p-2 rounded">
                      <span className="inline-flex items-center justify-center w-[5.5ch] px-1.5 py-0.5 text-xs rounded-md border bg-bg-tertiary text-text-tertiary border-border-primary">
                        <Check className="w-3.5 h-3.5" strokeWidth={2} />
                      </span>
                      <span className="text-xs text-text-secondary"><strong>Up to Date</strong> - Safe to remove</span>
                    </div>
                  </div>
                </div>
                
                <div className="mt-4 p-3 bg-status-info/10 border border-status-info/20 rounded-lg">
                  <p className="font-medium text-status-info text-xs mb-2">Tips</p>
                  <ul className="list-disc list-inside space-y-1 text-xs text-text-secondary">
                    <li>Focus on <strong>High Priority</strong> branches first</li>
                    <li>Numbers show commit count or file changes</li>
                    <li>Star (★) indicates counts above 9</li>
                    <li>Gray indicators are low priority - often safe to remove</li>
                    <li>Click any indicator to view detailed diff</li>
                  </ul>
                </div>
              </div>
            </div>
        </ModalBody>
      </Modal>
    </>
  );
}
