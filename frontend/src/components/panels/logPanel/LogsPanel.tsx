import React from 'react';
import { LogsView } from './LogsView';
import { LogsPanelState, ToolPanel } from '../../../../../shared/types/panels';
import { Square } from 'lucide-react';

interface LogsPanelProps {
  panel: ToolPanel;
  isActive: boolean;
}

const LogsPanel: React.FC<LogsPanelProps> = ({ panel, isActive }) => {
  const logsState = panel.state?.customState as LogsPanelState;
  const isRunning = logsState?.isRunning ?? false;

  const handleStop = async () => {
    try {
      await window.electronAPI.logs.stopScript(panel.id);
    } catch (error) {
      console.error('Failed to stop script:', error);
    }
  };
  
  return (
    <div className="h-full flex flex-col bg-bg-primary">
      {/* Header with run status */}
      {logsState && (
        <div className="flex items-center justify-between px-4 py-2 bg-surface-secondary border-b border-border-primary">
          <div className="flex items-center gap-2">
            {isRunning ? (
              <>
                <div className="w-2 h-2 bg-status-success rounded-full animate-pulse" />
                <span className="text-sm text-text-secondary">Running: {logsState.command}</span>
              </>
            ) : (
              <>
                <div className="w-2 h-2 bg-text-tertiary rounded-full" />
                <span className="text-sm text-text-secondary">
                  {logsState.exitCode !== undefined 
                    ? `Exited with code ${logsState.exitCode}`
                    : 'Ready'}
                </span>
              </>
            )}
          </div>
          
          {isRunning && (
            <button
              onClick={handleStop}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-status-error text-white rounded hover:bg-status-error/90 transition-colors"
            >
              <Square className="w-3 h-3" />
              Stop
            </button>
          )}
        </div>
      )}
      
      <div className="flex-1 overflow-hidden">
        <LogsView 
          sessionId={panel.sessionId} 
          isVisible={isActive}
        />
      </div>
    </div>
  );
};

export default LogsPanel;