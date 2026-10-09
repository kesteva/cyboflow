import { useEffect, useMemo, useState } from 'react';
import type { RemoteSyncConflict } from '../../../../shared/types/remoteSync';
import { trpc } from '../../trpc/client';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { needsReview, useRemoteSyncConflictsStore } from '../../stores/remoteSyncConflictsStore';
import { formatValue, kindLabel, resolutionLabel, sideLabel } from './syncConflictText';

type Filter = 'open' | 'resolved';

interface Group {
  entityId: string;
  ref: string | null;
  title: string | null;
  items: RemoteSyncConflict[];
}

function groupByItem(conflicts: RemoteSyncConflict[]): Group[] {
  const sorted = [...conflicts].sort((a, b) => b.createdAt - a.createdAt);
  const groups = new Map<string, Group>();
  for (const c of sorted) {
    let g = groups.get(c.entityId);
    if (!g) {
      g = { entityId: c.entityId, ref: c.entityRef, title: c.entityTitle, items: [] };
      groups.set(c.entityId, g);
    }
    g.items.push(c);
  }
  return [...groups.values()];
}

function short(value: unknown): string {
  const text = formatValue(value).replace(/\s+/g, ' ');
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

export function SyncConflictsView(): React.JSX.Element | null {
  const viewOpen = useRemoteSyncConflictsStore((s) => s.viewOpen);
  const closeView = useRemoteSyncConflictsStore((s) => s.closeView);
  const openDialog = useRemoteSyncConflictsStore((s) => s.openDialog);
  const conflicts = useRemoteSyncConflictsStore((s) => s.conflicts);
  const [filter, setFilter] = useState<Filter>('open');
  const [resolved, setResolved] = useState<RemoteSyncConflict[]>([]);

  useEffect(() => {
    if (!viewOpen || filter !== 'resolved') return;
    let cancelled = false;
    trpc.cyboflow.remoteSync.listConflicts
      .query({ view: 'resolved' })
      .then((list) => {
        if (!cancelled) setResolved(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [viewOpen, filter, conflicts]);

  const shown = useMemo(() => {
    if (filter === 'open') return needsReview(conflicts);
    const pending = conflicts.filter((c) => c.pendingResolution !== null);
    const seen = new Set(pending.map((c) => c.id));
    return [...pending, ...resolved.filter((c) => !seen.has(c.id))];
  }, [filter, conflicts, resolved]);
  const groups = useMemo(() => groupByItem(shown), [shown]);

  if (!viewOpen) return null;
  return (
    <Modal isOpen onClose={closeView} size="lg">
      <div data-testid="sync-conflicts-view" className="flex max-h-[70vh] flex-col gap-3 p-6">
        <h2 className="text-base font-semibold text-text-primary">Sync conflicts</h2>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={filter === 'open' ? 'primary' : 'secondary'}
            onClick={() => setFilter('open')}
          >
            Open
          </Button>
          <Button
            type="button"
            size="sm"
            variant={filter === 'resolved' ? 'primary' : 'secondary'}
            onClick={() => setFilter('resolved')}
          >
            Resolved (30 days)
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto">
          {groups.length === 0 && (
            <p className="text-sm text-text-tertiary">
              {filter === 'open' ? 'No conflicts need review.' : 'Nothing resolved recently.'}
            </p>
          )}
          {groups.map((g) => (
            <div key={g.entityId} data-testid="sync-conflict-group">
              <h3 className="text-sm font-semibold text-text-primary">
                {g.ref && <span className="mr-2 font-mono text-xs text-text-tertiary">{g.ref}</span>}
                {g.title ?? 'Deleted item'}
              </h3>
              <ul className="mt-1 divide-y divide-border-primary border border-border-primary">
                {g.items.map((c) => (
                  <li key={c.id} data-testid="sync-conflict-row">
                    <button
                      type="button"
                      className="block w-full px-3 py-2 text-left hover:bg-surface-hover"
                      onClick={() => openDialog(c.id)}
                    >
                      <div className="text-xs font-semibold text-text-secondary">{kindLabel(c)}</div>
                      <div className="mt-1 grid grid-cols-2 gap-3 text-xs">
                        <div>
                          <div className="text-text-tertiary">
                            {sideLabel(c.current)} <span className="font-semibold text-status-success">applied</span>
                          </div>
                          <div className="truncate text-text-primary">{short(c.current.value)}</div>
                        </div>
                        <div>
                          <div className="text-text-tertiary">{sideLabel(c.other)}</div>
                          <div className="truncate text-text-primary">{short(c.other.value)}</div>
                        </div>
                      </div>
                      {(c.resolvedAt !== null || c.pendingResolution !== null) && (
                        <div className="mt-1 text-xs text-text-tertiary" data-testid="sync-conflict-resolution">
                          Resolved: {resolutionLabel(c)}
                        </div>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
