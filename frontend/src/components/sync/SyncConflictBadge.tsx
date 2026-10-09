import { needsReview, useRemoteSyncConflictsStore } from '../../stores/remoteSyncConflictsStore';

/** Amber chip for a backlog card/row whose item has an open sync conflict. Renders null otherwise. */
export function SyncConflictBadge({ entityId }: { entityId: string }): React.JSX.Element | null {
  const conflicts = useRemoteSyncConflictsStore((s) => s.conflicts);
  const count = needsReview(conflicts).filter((c) => c.entityId === entityId).length;
  if (count === 0) return null;
  return (
    <span
      data-testid="sync-conflict-badge"
      title="Edited on two computers: review the sync conflict"
      className="inline-flex items-center border border-status-warning px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[.06em] text-status-warning"
    >
      Conflict{count > 1 ? ` ×${count}` : ''}
    </span>
  );
}
