import { useEffect } from 'react';
import { SessionActionToast } from '../cyboflow/SessionActionToast';
import { isSyncActive, useRemoteSyncConflictsStore } from '../../stores/remoteSyncConflictsStore';
import { SyncConflictIndicator } from './SyncConflictIndicator';
import { SyncConflictsView } from './SyncConflictsView';
import { SyncConflictDialog } from './SyncConflictDialog';

/**
 * Owns the single sync-status subscription and mounts the indicator, the
 * Conflicts view, the dialog and the toast. Renders nothing when sync is not
 * available/enabled (release builds, unsynced projects).
 */
export function SyncConflictsHost(): React.JSX.Element | null {
  const init = useRemoteSyncConflictsStore((s) => s.init);
  const status = useRemoteSyncConflictsStore((s) => s.status);
  const toast = useRemoteSyncConflictsStore((s) => s.toast);
  const dismissToast = useRemoteSyncConflictsStore((s) => s.dismissToast);
  const openView = useRemoteSyncConflictsStore((s) => s.openView);

  useEffect(() => init(), [init]);

  if (!isSyncActive(status)) return null;
  return (
    <>
      <SyncConflictIndicator />
      <SyncConflictsView />
      <SyncConflictDialog />
      {toast !== null && (
        <div className="pointer-events-none fixed inset-x-0 bottom-10 z-50 flex justify-center">
          <div className="pointer-events-auto">
            <SessionActionToast
              message={toast}
              isVisible
              onDismiss={dismissToast}
              actionLabel="Review"
              onAction={() => {
                dismissToast();
                openView();
              }}
              durationMs={6000}
            />
          </div>
        </div>
      )}
    </>
  );
}
