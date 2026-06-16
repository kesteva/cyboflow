import { useEffect, useState } from 'react';
import { X, ExternalLink, Download, RefreshCw, CheckCircle, AlertCircle } from 'lucide-react';
import cyboflowWordmark from '../assets/cyboflow-wordmark.svg';

// Mirrors the lifecycle of the in-app auto-updater (see shared/types/updater).
// 'unsupported' = dev / unpackaged build where the updater is a no-op.
type UpdateUiState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; percent: number }
  | { status: 'downloaded'; version: string }
  | { status: 'up-to-date' }
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

interface VersionInfo {
  current: string;
  workingDirectory?: string;
  cyboflowDirectory?: string;
  buildDate?: string;
  gitCommit?: string;
  buildTimestamp?: number;
  worktreeName?: string;
}

interface AboutDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AboutDialog({ isOpen, onClose }: AboutDialogProps) {
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [update, setUpdate] = useState<UpdateUiState>({ status: 'idle' });

  useEffect(() => {
    if (isOpen) {
      // Get current version info immediately
      loadCurrentVersion();
    } else {
      setUpdate({ status: 'idle' });
    }
  }, [isOpen]);

  // Stream the async download lifecycle (progress/downloaded/error) while open.
  // The discrete check verdict is settled by checkForUpdates() below.
  useEffect(() => {
    if (!isOpen) return;
    return window.electronAPI.updater.onEvent((event) => {
      switch (event.kind) {
        case 'download-progress':
          setUpdate({ status: 'downloading', percent: Math.round(event.percent) });
          break;
        case 'downloaded':
          setUpdate({ status: 'downloaded', version: event.version });
          break;
        case 'error':
          setUpdate({ status: 'error', message: event.message });
          break;
        case 'available':
          setUpdate((prev) => (prev.status === 'idle' ? { status: 'available', version: event.version } : prev));
          break;
      }
    });
  }, [isOpen]);

  const checkForUpdates = async () => {
    setUpdate({ status: 'checking' });
    try {
      const result = await window.electronAPI.updater.check();
      if (!result.success || !result.data) {
        setUpdate({ status: 'error', message: result.error || 'Update check failed' });
        return;
      }
      if (!result.data.supported) {
        setUpdate({ status: 'unsupported' });
      } else if (result.data.updateAvailable && result.data.latestVersion) {
        setUpdate({ status: 'available', version: result.data.latestVersion });
      } else {
        setUpdate({ status: 'up-to-date' });
      }
    } catch (error) {
      setUpdate({ status: 'error', message: error instanceof Error ? error.message : 'Update check failed' });
    }
  };

  const downloadUpdate = async () => {
    setUpdate({ status: 'downloading', percent: 0 });
    const result = await window.electronAPI.updater.download();
    if (!result.success) {
      setUpdate({ status: 'error', message: result.error || 'Update download failed' });
    }
    // progress + 'downloaded' arrive via the event stream
  };

  const installUpdate = () => {
    void window.electronAPI.updater.install();
  };

  const loadCurrentVersion = async () => {
    try {
      const result = await window.electronAPI.getVersionInfo();
      if (result.success) {
        setVersionInfo({
          current: result.data.current,
          workingDirectory: result.data.workingDirectory,
          cyboflowDirectory: result.data.cyboflowDirectory,
          buildDate: result.data.buildDate,
          gitCommit: result.data.gitCommit,
          buildTimestamp: result.data.buildTimestamp,
          worktreeName: result.data.worktreeName
        });
      }
    } catch (error) {
      console.error('Failed to get version info:', error);
    }
  };

  const formatDateTime = (dateString: string) => {
    try {
      return new Date(dateString).toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short'
      });
    } catch {
      return dateString;
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-modal-overlay flex items-center justify-center z-50">
      <div className="bg-surface-primary rounded-lg shadow-xl max-w-md w-full mx-4 max-h-[80vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border-primary">
          <div className="flex items-center space-x-3">
            <img
              src={cyboflowWordmark}
              alt="Cyboflow"
              className="h-7 w-auto"
            />
            <h2 className="text-xl font-semibold text-text-primary">
              About
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-text-tertiary hover:text-text-secondary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* App Info */}
          <div className="text-center space-y-2">
            <h3 className="text-lg font-medium text-text-primary">
              Cyboflow
            </h3>
            <p className="text-sm text-text-secondary">
              Multi-Session AI Code Assistant Manager
            </p>
            <p className="text-xs text-text-tertiary">
              Built by Cyboflow
            </p>
          </div>

          {/* Version Info */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-text-secondary">
                Current Version
              </span>
              <span className="text-sm text-text-primary font-mono">
                {versionInfo?.current || 'Loading...'}
              </span>
            </div>

            {versionInfo?.cyboflowDirectory && (
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-text-secondary">
                  Data Directory
                </span>
                <span className="text-sm text-text-primary font-mono truncate max-w-[200px]" title={versionInfo.cyboflowDirectory}>
                  {versionInfo.cyboflowDirectory.replace(/^\/Users\/[^/]+/, '~')}
                </span>
              </div>
            )}

            {versionInfo?.workingDirectory && (
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-text-secondary">
                  Working Directory
                </span>
                <span className="text-sm text-text-primary font-mono truncate max-w-[200px]" title={versionInfo.workingDirectory}>
                  {versionInfo.workingDirectory.split('/').pop() || versionInfo.workingDirectory}
                </span>
              </div>
            )}

            {versionInfo?.worktreeName && (
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-text-secondary">
                  Worktree
                </span>
                <span className="text-sm text-text-primary font-mono">
                  {versionInfo.worktreeName}
                </span>
              </div>
            )}

            {versionInfo?.gitCommit && (
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-text-secondary">
                  Git Commit
                </span>
                <span className="text-sm text-text-primary font-mono">
                  {versionInfo.gitCommit}
                </span>
              </div>
            )}

            {versionInfo?.buildDate && (
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-text-secondary">
                  Build Date
                </span>
                <span className="text-sm text-text-primary">
                  {formatDateTime(versionInfo.buildDate)}
                </span>
              </div>
            )}

          </div>

          {/* Software Updates */}
          <div className="pt-4 border-t border-border-primary space-y-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-text-secondary">Software Updates</span>
              {update.status === 'available' ? (
                <button
                  onClick={downloadUpdate}
                  className="flex items-center space-x-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-interactive text-interactive-on-dark hover:bg-interactive-hover transition-colors"
                >
                  <Download className="w-4 h-4" />
                  <span>Download {update.version}</span>
                </button>
              ) : update.status === 'downloaded' ? (
                <button
                  onClick={installUpdate}
                  className="flex items-center space-x-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-interactive text-interactive-on-dark hover:bg-interactive-hover transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                  <span>Restart to update</span>
                </button>
              ) : (
                <button
                  onClick={checkForUpdates}
                  disabled={update.status === 'checking' || update.status === 'downloading'}
                  className="flex items-center space-x-1.5 px-3 py-1.5 text-sm font-medium rounded-md border border-border-primary text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <RefreshCw className={`w-4 h-4 ${update.status === 'checking' ? 'animate-spin' : ''}`} />
                  <span>{update.status === 'checking' ? 'Checking…' : 'Check for updates'}</span>
                </button>
              )}
            </div>

            {update.status === 'downloading' && (
              <div className="space-y-1.5">
                <div className="h-1.5 w-full rounded-full bg-surface-secondary overflow-hidden">
                  <div
                    className="h-full bg-interactive transition-all duration-200"
                    style={{ width: `${update.percent}%` }}
                  />
                </div>
                <p className="text-xs text-text-tertiary">Downloading update… {update.percent}%</p>
              </div>
            )}

            {update.status === 'up-to-date' && (
              <p className="flex items-center space-x-1.5 text-xs text-text-tertiary">
                <CheckCircle className="w-3.5 h-3.5 text-status-success" />
                <span>You're on the latest version.</span>
              </p>
            )}

            {update.status === 'available' && (
              <p className="text-xs text-text-tertiary">Version {update.version} is available.</p>
            )}

            {update.status === 'downloaded' && (
              <p className="text-xs text-text-tertiary">
                Version {update.version} is ready. Restart to finish updating.
              </p>
            )}

            {update.status === 'unsupported' && (
              <p className="text-xs text-text-tertiary">
                Auto-update is available in packaged builds only.
              </p>
            )}

            {update.status === 'error' && (
              <p className="flex items-center space-x-1.5 text-xs text-status-error">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{update.message}</span>
              </p>
            )}
          </div>

          {/* Discord Community Button */}
          <div className="pt-4 border-t border-border-primary">
            <a
              href="https://discord.gg/XrVa6q7DPY"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full flex items-center justify-center space-x-2 px-4 py-2.5 bg-[#5865F2] hover:bg-[#4752C4] text-white font-medium rounded-lg transition-colors mb-4"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.64 12.64 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028a14.09 14.09 0 0 0 1.226-1.994a.076.076 0 0 0-.041-.106a13.107 13.107 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127a12.299 12.299 0 0 1-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.839 19.839 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z"/>
              </svg>
              <span>Join our Discord Community</span>
            </a>
          </div>

          {/* Links */}
          <div className="space-y-2">
            <a
              href="https://github.com/cyboflow/cyboflow"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between w-full text-sm text-text-secondary hover:text-text-primary transition-colors">
              <span>View on GitHub</span>
              <ExternalLink className="w-4 h-4" />
            </a>
            <a
              href="https://docs.anthropic.com/en/docs/claude-code"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between w-full text-sm text-text-secondary hover:text-text-primary transition-colors">
              <span>Claude Code Documentation</span>
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>

          {/* Disclaimer */}
          <div className="pt-4 border-t border-border-primary">
            <p className="text-xs text-text-tertiary leading-relaxed">
              Cyboflow is an independent project forked from Crystal (by Stravu). Claude™ is a trademark of Anthropic, PBC.
              Cyboflow is not affiliated with, endorsed by, or sponsored by Anthropic.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}