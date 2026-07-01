import { useEffect, useState } from 'react';
import { X, ExternalLink, Download, RefreshCw, CheckCircle, AlertCircle } from 'lucide-react';
import cyboflowWordmark from '../assets/cyboflow-wordmark.svg';
import { useUpdater } from '../hooks/useUpdater';

interface VersionInfo {
  current: string;
  workingDirectory?: string;
  cyboflowDirectory?: string;
  buildDate?: string;
  gitCommit?: string;
  buildTimestamp?: number;
  worktreeName?: string;
  variant?: 'stable' | 'dev';
}

interface AboutDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AboutDialog({ isOpen, onClose }: AboutDialogProps) {
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const { state: update, check: checkForUpdates, download: downloadUpdate, install: installUpdate, reset } = useUpdater();

  useEffect(() => {
    if (isOpen) {
      // Get current version info immediately
      loadCurrentVersion();
    } else {
      reset();
    }
    // reset is stable across renders; intentionally keyed on open state only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

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
          worktreeName: result.data.worktreeName,
          variant: result.data.variant
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
            <h3 className="text-lg font-medium text-text-primary flex items-center justify-center gap-2">
              {versionInfo?.variant === 'dev' ? 'Cyboflow Dev' : 'Cyboflow'}
              {versionInfo?.variant === 'dev' && (
                <span className="rounded-[4px] border border-interactive px-1.5 py-px text-[10px] font-bold tracking-wide text-interactive">
                  DEV
                </span>
              )}
            </h3>
            <p className="text-sm text-text-secondary">
              A human-first agentic development environment
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

          {/* Software Updates (channel selection lives in Settings → Updates) */}
          <div className="pt-4 border-t border-border-primary space-y-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-text-secondary">Software Updates</span>
              {update.status === 'available' ? (
                <button
                  onClick={downloadUpdate}
                  className="flex items-center space-x-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-interactive text-text-on-interactive hover:bg-interactive-hover transition-colors"
                >
                  <Download className="w-4 h-4" />
                  <span>Download {update.version}</span>
                </button>
              ) : update.status === 'downloaded' ? (
                <button
                  onClick={installUpdate}
                  className="flex items-center space-x-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-interactive text-text-on-interactive hover:bg-interactive-hover transition-colors"
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

          {/* Links */}
          <div className="space-y-2 pt-4 border-t border-border-primary">
            <a
              href="https://github.com/kesteva/cyboflow"
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