import React, { useCallback, memo, useState, useRef, useEffect } from 'react';
import { X, Terminal, MessageSquare, GitBranch, FileText, FileCode, MoreVertical, BarChart3, Edit2, Plus } from 'lucide-react';
import { cn } from '../../utils/cn';
import { PanelTabBarProps } from '../../types/panelComponents';
import { ToolPanel, ToolPanelType, LogsPanelState, BaseAIPanelState, PanelStatus } from '../../../../shared/types/panels';
import { Button } from '../ui/Button';
import { Dropdown } from '../ui/Dropdown';
import { useSession } from '../../contexts/SessionContext';
import { StatusDot } from '../ui/StatusDot';

export const PanelTabBar: React.FC<PanelTabBarProps> = memo(({
  panels,
  activePanel,
  onPanelSelect,
  onPanelClose,
  context = 'worktree',  // Default to worktree for backward compatibility
  onAddTerminal,
  onAddClaude
}) => {
  const sessionContext = useSession();
  const { gitBranchActions, isMerging } = sessionContext || {};
  const [editingPanelId, setEditingPanelId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  
  // Memoize event handlers to prevent unnecessary re-renders
  const handlePanelClick = useCallback((panel: ToolPanel) => {
    onPanelSelect(panel);
  }, [onPanelSelect]);

  const handlePanelClose = useCallback((e: React.MouseEvent, panel: ToolPanel) => {
    e.stopPropagation();

    // Prevent closing logs panel while it's running
    if (panel.type === 'logs') {
      const logsState = panel.state?.customState as LogsPanelState;
      if (logsState?.isRunning) {
        alert('Cannot close logs panel while process is running. Please stop the process first.');
        return;
      }
    }

    onPanelClose(panel);
  }, [onPanelClose]);
  
  const handleStartRename = useCallback((e: React.MouseEvent, panel: ToolPanel) => {
    e.stopPropagation();
    if (panel.type === 'diff') {
      return;
    }
    setEditingPanelId(panel.id);
    setEditingTitle(panel.title);
  }, []);
  
  const handleRenameSubmit = useCallback(async () => {
    if (editingPanelId && editingTitle.trim()) {
      try {
        // Update the panel title via IPC
        await window.electron?.invoke('panels:update', editingPanelId, {
          title: editingTitle.trim()
        });
        
        // Update the local panel in the store
        const panel = panels.find(p => p.id === editingPanelId);
        if (panel) {
          panel.title = editingTitle.trim();
        }
      } catch (error) {
        console.error('Failed to rename panel:', error);
      }
    }
    setEditingPanelId(null);
    setEditingTitle('');
  }, [editingPanelId, editingTitle, panels]);
  
  const handleRenameCancel = useCallback(() => {
    setEditingPanelId(null);
    setEditingTitle('');
  }, []);
  
  const handleRenameKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      handleRenameCancel();
    }
  }, [handleRenameSubmit, handleRenameCancel]);

  const handleAddTerminal = useCallback(() => {
    if (!onAddTerminal) return;
    const result = onAddTerminal();
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        console.error('[PanelTabBar] Failed to add terminal:', err);
      });
    }
  }, [onAddTerminal]);

  const handleAddClaude = useCallback(() => {
    if (!onAddClaude) return;
    const result = onAddClaude();
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        console.error('[PanelTabBar] Failed to add claude panel:', err);
      });
    }
  }, [onAddClaude]);

  // Focus input when editing starts
  useEffect(() => {
    if (editingPanelId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingPanelId]);
  
  const getPanelIcon = (type: ToolPanelType) => {
    switch (type) {
      case 'terminal':
        return <Terminal className="w-4 h-4" />;
      case 'claude':
        return <MessageSquare className="w-4 h-4" />;
      case 'diff':
        return <GitBranch className="w-4 h-4" />;
      case 'editor':
        return <FileText className="w-4 h-4" />;
      case 'logs':
        return <FileCode className="w-4 h-4" />;
      case 'dashboard':
        return <BarChart3 className="w-4 h-4" />;
      // Add more icons as panel types are added
      default:
        return null;
    }
  };

  // Get panel status indicator config for AI panels (claude)
  const getPanelStatusConfig = (panel: ToolPanel): { status: 'running' | 'waiting' | 'info' | 'error' | 'default'; animated: boolean; pulse: boolean } | null => {
    // Only show status for AI panels
    if (panel.type !== 'claude') {
      return null;
    }

    const customState = panel.state?.customState as BaseAIPanelState | undefined;
    const panelStatus: PanelStatus | undefined = customState?.panelStatus;
    const hasUnviewedContent = customState?.hasUnviewedContent ?? false;
    const isActivePanel = activePanel?.id === panel.id;

    // Don't show status indicator if panel is active and doesn't have unviewed content
    // (user is actively viewing it)
    if (isActivePanel && !hasUnviewedContent && panelStatus !== 'running' && panelStatus !== 'waiting') {
      return null;
    }

    switch (panelStatus) {
      case 'running':
        return { status: 'running', animated: true, pulse: false };
      case 'waiting':
        return { status: 'waiting', animated: false, pulse: true };
      case 'error':
        return { status: 'error', animated: false, pulse: false };
      case 'completed_unviewed':
        // Show blue dot for completed with unviewed content
        return { status: 'info', animated: false, pulse: true };
      case 'stopped':
      case 'idle':
      default:
        // Only show if there's unviewed content and panel is not active
        if (hasUnviewedContent && !isActivePanel) {
          return { status: 'info', animated: false, pulse: true };
        }
        return null;
    }
  };

  return (
    <div className="panel-tab-bar bg-surface-secondary border-b border-border-primary dark:border-border-hover">
      {/* Flex container that wraps when needed */}
      <div
        className="flex flex-wrap items-center min-h-[2rem] px-2 gap-x-1"
        role="tablist"
        aria-label="Panel Tabs"
      >
        {/* Render panel tabs */}
        {panels.map((panel) => {
          const isPermanent = panel.metadata?.permanent === true;
          const isEditing = editingPanelId === panel.id;
          const isDiffPanel = panel.type === 'diff';
          const displayTitle = isDiffPanel ? 'Diff' : panel.title;
          const statusConfig = getPanelStatusConfig(panel);

          return (
            <div
              key={panel.id}
              className={cn(
                "group relative inline-flex items-center h-8 px-3 text-sm whitespace-nowrap cursor-pointer select-none",
                "rounded-t-md border border-border-primary dark:border-border-hover border-b-0 -mb-px",
                activePanel?.id === panel.id
                  ? "bg-surface-primary text-text-primary shadow-tactile"
                  : "bg-surface-secondary text-text-secondary hover:bg-surface-hover hover:text-text-primary"
              )}
              onClick={() => !isEditing && handlePanelClick(panel)}
              title={isPermanent ? "This panel cannot be closed" : undefined}
              role="tab"
              aria-selected={activePanel?.id === panel.id}
              tabIndex={activePanel?.id === panel.id ? 0 : -1}
              onKeyDown={(e) => {
                if (isEditing) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handlePanelClick(panel);
                }
              }}
            >
              {/* Status indicator for AI panels */}
              {statusConfig && (
                <StatusDot
                  status={statusConfig.status}
                  size="sm"
                  animated={statusConfig.animated}
                  pulse={statusConfig.pulse}
                  className="mr-1"
                />
              )}
              {getPanelIcon(panel.type)}
              
              {isEditing ? (
                <input
                  ref={editInputRef}
                  type="text"
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onKeyDown={handleRenameKeyDown}
                  onBlur={handleRenameSubmit}
                  className="ml-2 px-1 text-sm bg-bg-primary border border-border-primary dark:border-border-hover rounded outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus text-text-primary"
                  onClick={(e) => e.stopPropagation()}
                  style={{ width: `${Math.max(50, editingTitle.length * 8)}px` }}
                />
              ) : (
                <>
                  <span className="ml-2 text-sm">{displayTitle}</span>
                  {!isPermanent && !isDiffPanel && (
                    <button
                      className="ml-1 p-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity transition-colors text-text-muted hover:bg-surface-hover hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
                      onClick={(e) => handleStartRename(e, panel)}
                      title="Rename panel"
                    >
                      <Edit2 className="w-3 h-3" />
                    </button>
                  )}
                </>
              )}
              
              {!isPermanent && !isEditing && (
                <button
                  className="ml-1 p-0.5 rounded transition-colors text-text-muted hover:bg-surface-hover hover:text-status-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
                  onClick={(e) => handlePanelClose(e, panel)}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}
        
        {/* Trailing actions: Add Terminal button + Add Claude button + Branch Actions (worktree only) */}
        {(onAddTerminal || onAddClaude || (context === 'worktree' && gitBranchActions && gitBranchActions.length > 0)) && (
          <div className="ml-auto flex items-center gap-2 pr-2 h-8">
            {onAddTerminal && (
              <button
                type="button"
                onClick={handleAddTerminal}
                aria-label="Add terminal panel"
                title="Add terminal panel"
                className="inline-flex items-center gap-1 h-7 px-2 rounded text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
              >
                <Plus className="w-4 h-4" />
                <Terminal className="w-4 h-4" />
                <span className="sr-only">Add terminal panel</span>
              </button>
            )}
            {onAddClaude && (
              <button
                type="button"
                onClick={handleAddClaude}
                aria-label="Add Claude panel"
                title="Add Claude panel"
                className="inline-flex items-center gap-1 h-7 px-2 rounded text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
              >
                <Plus className="w-4 h-4" />
                <MessageSquare className="w-4 h-4" />
                <span className="sr-only">Add Claude panel</span>
              </button>
            )}
            {context === 'worktree' && gitBranchActions && gitBranchActions.length > 0 && (
              <Dropdown
                trigger={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex items-center gap-2 px-3 py-1 h-7"
                    disabled={isMerging}
                  >
                    <GitBranch className="w-4 h-4" />
                    <span className="text-sm">Git Branch Actions</span>
                    <MoreVertical className="w-3 h-3" />
                  </Button>
                }
                items={gitBranchActions}
                position="bottom-right"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
});

PanelTabBar.displayName = 'PanelTabBar';
