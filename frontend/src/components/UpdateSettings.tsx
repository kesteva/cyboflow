import { useEffect, useState } from 'react';
import { Download, RefreshCw, CheckCircle, AlertCircle } from 'lucide-react';
import { useUpdater } from '../hooks/useUpdater';
import { CollapsibleCard } from './ui/CollapsibleCard';
import { SettingsSection } from './ui/SettingsSection';

/**
 * Settings → Updates. Shows the current version and drives the manual
 * check → download → restart flow against the main-process AppUpdater. The
 * update feed (stable vs dev) is fixed per app variant at build time — dev is
 * a separate side-by-side app, not an in-app toggle (see docs/UPDATES.md).
 */
export function UpdateSettings() {
  const [currentVersion, setCurrentVersion] = useState<string>('');
  const { state: update, check: checkForUpdates, download: downloadUpdate, install: installUpdate } = useUpdater();

  useEffect(() => {
    void (async () => {
      try {
        const version = await window.electronAPI.getVersionInfo();
        if (version.success) setCurrentVersion(version.data.current);
      } catch {
        /* non-fatal: the section still renders without a version */
      }
    })();
  }, []);

  return (
    <div className="space-y-6">
      <CollapsibleCard
        title="Software Updates"
        subtitle="Keep Cyboflow up to date"
        icon={<Download className="w-5 h-5" />}
        defaultExpanded={true}
      >
        <SettingsSection
          title="Updates"
          description="Check for and install new versions"
          icon={<RefreshCw className="w-4 h-4" />}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-text-secondary">
              Current version{' '}
              <span className="font-mono text-text-primary">{currentVersion || '…'}</span>
            </span>
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
            <div className="space-y-1.5 mt-3">
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
            <p className="flex items-center space-x-1.5 text-xs text-text-tertiary mt-3">
              <CheckCircle className="w-3.5 h-3.5 text-status-success" />
              <span>You're on the latest version.</span>
            </p>
          )}

          {update.status === 'available' && (
            <p className="text-xs text-text-tertiary mt-3">Version {update.version} is available.</p>
          )}

          {update.status === 'downloaded' && (
            <p className="text-xs text-text-tertiary mt-3">
              Version {update.version} is ready. Restart to finish updating.
            </p>
          )}

          {update.status === 'unsupported' && (
            <p className="text-xs text-text-tertiary mt-3">
              Auto-update is available in packaged builds only.
            </p>
          )}

          {update.status === 'error' && (
            <p className="flex items-center space-x-1.5 text-xs text-status-error mt-3">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>{update.message}</span>
            </p>
          )}

          <p className="text-xs text-text-tertiary mt-4 pt-3 border-t border-border-secondary">
            Want early builds? Cyboflow Dev is a separate app you can install alongside this one,
            with its own data and update feed. Download it from the Cyboflow website.
          </p>
        </SettingsSection>
      </CollapsibleCard>
    </div>
  );
}
