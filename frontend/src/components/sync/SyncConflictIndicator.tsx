import { AlertTriangle, RefreshCcw, Check } from 'lucide-react';
import { cn } from '../../utils/cn';
import { isSyncActive, needsReview, useRemoteSyncConflictsStore } from '../../stores/remoteSyncConflictsStore';

/** Compact status-bar sync indicator; click opens the Conflicts view. Null unless sync is on. */
export function SyncConflictIndicator(): React.JSX.Element | null {
  const status = useRemoteSyncConflictsStore((s) => s.status);
  const conflicts = useRemoteSyncConflictsStore((s) => s.conflicts);
  const openView = useRemoteSyncConflictsStore((s) => s.openView);
  if (!isSyncActive(status)) return null;
  const synced = status.projects.filter((p) => p.remoteProjectId !== null);
  const errored = synced.some((p) => p.status === 'error' || p.backoffUntil !== null);
  const syncing = synced.some((p) => p.syncing);
  const count = needsReview(conflicts).length;
  const state = errored ? 'error' : syncing ? 'syncing' : 'idle';
  const label = `Sync ${state}${count > 0 ? `, ${count} conflict${count === 1 ? '' : 's'} need review` : ''}`;
  return (
    <button
      type="button"
      data-testid="sync-indicator"
      data-state={state}
      aria-label={label}
      title={label}
      onClick={openView}
      className="flex items-center gap-1 text-text-tertiary hover:text-text-secondary"
    >
      {errored ? (
        <AlertTriangle className="h-3 w-3 text-status-error" />
      ) : syncing ? (
        <RefreshCcw className={cn('h-3 w-3 animate-spin')} />
      ) : (
        <Check className="h-3 w-3" />
      )}
      {count > 0 && (
        <span
          data-testid="sync-indicator-count"
          className="bg-status-warning px-1 text-[10px] font-semibold leading-4 text-text-on-status-error"
        >
          {count}
        </span>
      )}
    </button>
  );
}
