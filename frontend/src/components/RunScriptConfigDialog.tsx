import { Settings, X, Play, AlertCircle } from 'lucide-react';

interface RunScriptConfigDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenSettings?: () => void;
}

export function RunScriptConfigDialog({
  isOpen,
  onClose,
  onOpenSettings
}: RunScriptConfigDialogProps) {
  if (!isOpen) return null;

  const handleOpenSettings = () => {
    onClose();
    if (onOpenSettings) {
      onOpenSettings();
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-surface-primary rounded-lg shadow-xl max-w-2xl w-full mx-4 p-6">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center space-x-3">
            <div className="flex-shrink-0">
              <Play className="w-6 h-6 text-interactive" />
            </div>
            <h3 className="text-lg font-medium text-text-primary">
              Configure Run Script
            </h3>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-secondary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="mb-6 space-y-4">
          <div className="bg-status-warning/10 border border-status-warning/30 rounded-lg p-4">
            <div className="flex items-start space-x-2">
              <AlertCircle className="w-5 h-5 text-status-warning flex-shrink-0 mt-0.5" />
              <div className="text-sm text-status-warning">
                <p className="font-semibold mb-1">No run script configured</p>
                <p>A run script is required to test changes in your application.</p>
              </div>
            </div>
          </div>

          <div className="text-text-secondary space-y-3">
            <p>
              <strong>What is a run script?</strong><br />
              A run script contains the commands needed to start your application for testing changes made by Claude Code sessions.
            </p>
            
            <p>
              <strong>How to configure:</strong>
            </p>
            <ol className="list-decimal list-inside space-y-2 ml-4">
              <li>Click the settings icon (⚙️) next to your project name in the sidebar (visible on hover)</li>
              <li>In the "Run Script" field, enter the command(s) to start your application</li>
              <li>Optionally add a "Build Script" that runs when creating new worktrees</li>
            </ol>

            <div className="bg-status-info/10 border border-status-info/30 rounded-lg p-4 mt-4">
              <p className="text-sm text-status-info">
                <strong>💡 Recommendation:</strong> Include commands to kill any existing instances of your application to prevent port conflicts when switching between sessions.
              </p>
              <div className="mt-2 font-mono text-xs bg-bg-primary p-2 rounded border border-status-info/30">
                <div className="text-text-muted"># Example for a Node.js app on port 3000:</div>
                <div>pkill -f "node.*port=3000" || true</div>
                <div>npm run dev</div>
              </div>
            </div>
          </div>
        </div>
        
        <div className="flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-text-secondary bg-bg-tertiary hover:bg-bg-hover rounded-md transition-colors"
          >
            Close
          </button>
          {onOpenSettings && (
            <button
              onClick={handleOpenSettings}
              className="px-4 py-2 text-sm font-medium text-white bg-interactive hover:bg-interactive-hover rounded-md transition-colors flex items-center space-x-2"
              autoFocus
            >
              <Settings className="w-4 h-4" />
              <span>Open Project Settings</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}