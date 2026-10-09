import { needsReview, useRemoteSyncConflictsStore } from '../../stores/remoteSyncConflictsStore';
import { bannerText } from './syncConflictText';

/** Top-of-detail banner for an item with an open sync conflict. Renders null otherwise. */
export function SyncConflictBanner({ entityId }: { entityId: string }): React.JSX.Element | null {
  const conflicts = useRemoteSyncConflictsStore((s) => s.conflicts);
  const openDialog = useRemoteSyncConflictsStore((s) => s.openDialog);
  const mine = needsReview(conflicts).filter((c) => c.entityId === entityId);
  if (mine.length === 0) return null;
  const first = mine[0];
  return (
    <div
      data-testid="sync-conflict-banner"
      className="flex items-center justify-between gap-3 border-b border-status-warning bg-surface-secondary px-6 py-2 text-xs text-status-warning"
    >
      <span>
        {bannerText(first)}
        {mine.length > 1 ? ` (+${mine.length - 1} more)` : ''}
      </span>
      <button type="button" className="shrink-0 underline" onClick={() => openDialog(first.id)}>
        Review
      </button>
    </div>
  );
}
