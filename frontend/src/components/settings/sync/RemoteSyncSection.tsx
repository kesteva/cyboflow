/**
 * Settings → Integrations → Sync: cross-machine backlog sync.
 *
 * MACHINE-scoped, unlike the issue-tracker list beside it (which is per project
 * and needs an active project): this section renders without one and will hold
 * the per-project opt-in list itself. It is not a tracker row and not a
 * TrackerProvider.
 *
 * DEV BUILDS ONLY. `cyboflow.remoteSync.getStatus` answers `{ available: false }`
 * in a release build (main wires no facade there), and this renders nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import { RefreshCcw } from 'lucide-react';
import type { RemoteSyncStatus } from '../../../../../shared/types/remoteSync';
import { trpc } from '../../../trpc/client';
import { useConfigStore } from '../../../stores/configStore';
import { Button } from '../../ui/Button';
import { SettingsSection } from '../../ui/SettingsSection';
import { Toggle } from '../../ui/Toggle';

export function RemoteSyncSection(): React.JSX.Element | null {
  const [status, setStatus] = useState<RemoteSyncStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateConfig = useConfigStore((s) => s.updateConfig);

  const refresh = useCallback(async () => {
    try {
      setStatus(await trpc.cyboflow.remoteSync.getStatus.query());
    } catch {
      // Unreachable surface reads as unavailable: render nothing.
      setStatus({ available: false });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      setSaving(true);
      setError(null);
      const ok = await updateConfig({ remoteSync: { enabled } });
      if (!ok) setError('Could not save the sync setting.');
      await refresh();
      setSaving(false);
    },
    [refresh, updateConfig],
  );

  if (status === null || !status.available) return null;

  return (
    <div data-testid="remote-sync-section">
      <SettingsSection
        title="Sync across machines"
        description="Keep this machine's backlog in sync with your other machines. Each project opts in separately; nothing syncs until you turn it on."
        icon={<RefreshCcw className="h-4 w-4" />}
        className="ml-0"
      >
        <div className="flex items-center gap-2">
          <span className="border border-border-primary px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[.08em] text-text-tertiary">
            Dev build
          </span>
          {status.staging && (
            <span
              data-testid="remote-sync-staging-badge"
              className="border border-interactive px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[.08em] text-interactive"
              title={status.serverOrigin}
            >
              Staging
            </span>
          )}
        </div>

        <div className="divide-y divide-border-primary border border-border-primary bg-surface-primary">
          <div className="flex items-start justify-between gap-4 px-4 py-4">
            <div className="min-w-0">
              <h4 className="text-sm font-semibold text-text-primary">Enable sync</h4>
              <p className="mt-1 text-xs leading-relaxed text-text-tertiary">
                Turns on the sync engine for this machine. Available in dev builds only.
              </p>
            </div>
            <Toggle
              checked={status.enabled}
              onChange={(next) => void setEnabled(next)}
              disabled={saving}
              aria-label="Enable sync across machines"
            />
          </div>

          {status.enabled && !status.signedIn && (
            <div className="flex items-start justify-between gap-4 px-4 py-4" data-testid="remote-sync-signed-out">
              <div className="min-w-0">
                <h4 className="text-sm font-semibold text-text-primary">Not signed in</h4>
                <p className="mt-1 text-xs leading-relaxed text-text-tertiary">
                  Sign in with GitHub to register this machine. Synced projects send their
                  backlog (titles, bodies, stages and links) to the sync server; tracker
                  credentials and links never leave this machine.
                </p>
              </div>
              <Button type="button" variant="secondary" size="sm" disabled title="Sign-in is not built yet">
                Sign in
              </Button>
            </div>
          )}
        </div>

        {error !== null && (
          <p role="alert" className="text-xs text-status-error">
            {error}
          </p>
        )}
      </SettingsSection>
    </div>
  );
}
