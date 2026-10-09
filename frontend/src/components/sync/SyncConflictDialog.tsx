import { useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteSyncConflict, RemoteSyncConflictAction } from '../../../../shared/types/remoteSync';
import { trpc } from '../../trpc/client';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { useBacklogStore } from '../../stores/backlogStore';
import { useRemoteSyncConflictsStore } from '../../stores/remoteSyncConflictsStore';
import { diffLines } from '../../utils/lineDiff';
import { cn } from '../../utils/cn';
import { formatValue, isLongText, kindLabel, sideLabel } from './syncConflictText';

const ACTION_LABEL: Record<RemoteSyncConflictAction['kind'], (c: RemoteSyncConflict) => string> = {
  keep: (c) =>
    c.kind === 'field'
      ? 'Keep current'
      : c.kind === 'delete_vs_edit'
        ? 'Keep deleted'
        : c.kind === 'dependency_edge'
          ? 'Keep removed'
          : c.kind === 'orphaned'
            ? 'Keep as is'
            : 'Keep',
  use_other: () => 'Use the other value',
  merge: () => 'Merge…',
  recreate: () => 'Recreate as a new item',
  move: () => 'Move…',
  delete_children: () => 'Delete children',
  swap: () => 'Swap (restore this edge, remove the other)',
};

interface OrphanChild {
  id: string;
  ref: string;
  type: string;
}

function childrenOf(extra: unknown): OrphanChild[] {
  if (typeof extra !== 'object' || extra === null) return [];
  const list = (extra as { children?: unknown }).children;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (c): c is OrphanChild => typeof c === 'object' && c !== null && typeof (c as OrphanChild).id === 'string',
  );
}

function ValuePane({ title, text }: { title: string; text: string }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-xs text-text-tertiary">{title}</div>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap border border-border-primary bg-surface-secondary p-2 font-mono text-xs text-text-primary">
        {text}
      </pre>
    </div>
  );
}

function LineDiff({ before, after }: { before: string; after: string }): React.JSX.Element {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  return (
    <pre
      data-testid="sync-conflict-diff"
      className="max-h-56 overflow-auto border border-border-primary bg-surface-secondary p-2 font-mono text-xs"
    >
      {lines.map((l, i) => (
        <div
          key={i}
          data-diff={l.type}
          className={cn(
            l.type === 'add' && 'text-status-success',
            l.type === 'remove' && 'text-status-error',
            l.type === 'same' && 'text-text-tertiary',
          )}
        >
          {l.type === 'add' ? '+ ' : l.type === 'remove' ? '- ' : '  '}
          {l.text}
        </div>
      ))}
    </pre>
  );
}

function DialogBody({ conflict, onClose }: { conflict: RemoteSyncConflict; onClose: () => void }): React.JSX.Element {
  const refreshConflicts = useRemoteSyncConflictsStore((s) => s.refreshConflicts);
  const tasks = useBacklogStore((s) => s.tasks);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'merge' | 'move' | 'confirm-delete' | null>(null);
  const currentValue = conflict.changedSince ? conflict.currentNow : conflict.current.value;
  const [mergeText, setMergeText] = useState(typeof currentValue === 'string' ? currentValue : formatValue(currentValue));
  const [parentId, setParentId] = useState('');
  const defaultRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    defaultRef.current?.focus();
  }, []);

  const children = childrenOf(conflict.extra);
  const parents = useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.project_id === conflict.projectId &&
          (t.type === 'epic' || t.type === 'idea') &&
          t.id !== conflict.entityId,
      ),
    [tasks, conflict.projectId, conflict.entityId],
  );

  const resolve = async (action: RemoteSyncConflictAction): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await trpc.cyboflow.remoteSync.resolveConflict.mutate({ conflictId: conflict.id, action });
      if (result.ok) {
        await refreshConflicts();
        onClose();
      } else {
        setError(result.message);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const onAction = (kind: RemoteSyncConflictAction['kind']): void => {
    setError(null);
    switch (kind) {
      case 'merge':
        setMode('merge');
        return;
      case 'move':
        setMode('move');
        return;
      case 'delete_children':
        setMode('confirm-delete');
        return;
      case 'keep':
      case 'use_other':
      case 'recreate':
      case 'swap':
        void resolve({ kind });
        return;
    }
  };

  const longText = isLongText(conflict);
  const currentText = formatValue(currentValue);
  const otherText = formatValue(conflict.other.value);
  const lostFields =
    conflict.kind === 'delete_vs_edit' && typeof conflict.other.value === 'object' && conflict.other.value !== null
      ? Object.entries(conflict.other.value as Record<string, unknown>)
      : null;

  return (
    <div data-testid="sync-conflict-dialog" className="flex max-h-[80vh] flex-col gap-3 overflow-auto p-6">
      <h2 className="text-base font-semibold text-text-primary">
        {conflict.entityRef && <span className="mr-2 font-mono text-xs text-text-tertiary">{conflict.entityRef}</span>}
        {conflict.entityTitle ?? 'Deleted item'}
      </h2>
      <p className="text-sm text-text-secondary">{kindLabel(conflict)}</p>

      {conflict.changedSince && (
        <p data-testid="sync-conflict-changed-since" className="text-xs text-status-warning">
          Changed again since — the newest value here is shown as current
        </p>
      )}

      {lostFields !== null ? (
        <div className="space-y-2" data-testid="sync-conflict-lost">
          <div className="text-xs text-text-tertiary">Edited here, then deleted elsewhere ({sideLabel(conflict.other)})</div>
          {lostFields.map(([field, value]) => (
            <ValuePane key={field} title={field} text={formatValue(value)} />
          ))}
        </div>
      ) : conflict.kind === 'orphaned' ? (
        <ul className="text-xs text-text-secondary" data-testid="sync-conflict-children">
          {children.map((c) => (
            <li key={c.id}>
              {c.ref} <span className="text-text-tertiary">({c.type})</span>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <ValuePane title={`Current — ${sideLabel(conflict.current)} · applied`} text={currentText} />
            <ValuePane title={`Other — ${sideLabel(conflict.other)}`} text={otherText} />
          </div>
          {longText && <LineDiff before={otherText} after={currentText} />}
        </>
      )}

      {mode === 'merge' && (
        <div className="space-y-2" data-testid="sync-conflict-merge">
          <textarea
            aria-label="Merged value"
            value={mergeText}
            onChange={(e) => setMergeText(e.target.value)}
            rows={6}
            className="w-full border border-border-primary bg-surface-primary p-2 font-mono text-xs text-text-primary"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void resolve({ kind: 'merge', value: mergeText })}
            >
              Save merged value
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {mode === 'move' && (
        <div className="flex items-center gap-2" data-testid="sync-conflict-move">
          <select
            aria-label="New parent"
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            className="min-w-0 flex-1 border border-border-primary bg-surface-primary px-2 py-1 text-xs text-text-primary"
          >
            <option value="">Choose a parent…</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.ref} {p.title}
              </option>
            ))}
          </select>
          <Button
            type="button"
            size="sm"
            disabled={busy || parentId === ''}
            onClick={() => void resolve({ kind: 'move', parentId })}
          >
            Move children
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}>
            Cancel
          </Button>
        </div>
      )}

      {mode === 'confirm-delete' && (
        <div className="space-y-2 border border-status-error p-3" data-testid="sync-conflict-confirm-delete">
          <p className="text-xs text-text-secondary">
            Delete {children.length} child item{children.length === 1 ? '' : 's'} on all machines? This cannot be undone.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => void resolve({ kind: 'delete_children' })}
            >
              Yes, delete children
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error !== null && (
        <p role="alert" className="text-xs text-status-error">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {conflict.actions.map((kind, i) => (
          <Button
            key={kind}
            ref={i === 0 ? defaultRef : undefined}
            type="button"
            size="sm"
            variant={i === 0 ? 'primary' : 'secondary'}
            disabled={busy}
            onClick={() => onAction(kind)}
          >
            {ACTION_LABEL[kind](conflict)}
          </Button>
        ))}
        {conflict.actions.length === 0 && (
          <Button ref={defaultRef} type="button" size="sm" disabled={busy} onClick={() => onAction('keep')}>
            {ACTION_LABEL.keep(conflict)}
          </Button>
        )}
      </div>
    </div>
  );
}

export function SyncConflictDialog(): React.JSX.Element | null {
  const id = useRemoteSyncConflictsStore((s) => s.dialogConflictId);
  const conflicts = useRemoteSyncConflictsStore((s) => s.conflicts);
  const closeDialog = useRemoteSyncConflictsStore((s) => s.closeDialog);
  const [resolvedCache, setResolvedCache] = useState<RemoteSyncConflict | null>(null);
  const fromOpen = id === null ? undefined : conflicts.find((c) => c.id === id);

  // A resolved conflict opened from the Resolved filter is not in the open list: look it up.
  useEffect(() => {
    if (id === null || fromOpen) return;
    let cancelled = false;
    trpc.cyboflow.remoteSync.listConflicts
      .query({ view: 'resolved' })
      .then((list) => {
        if (!cancelled) setResolvedCache(list.find((c) => c.id === id) ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, fromOpen]);

  const conflict = fromOpen ?? (resolvedCache?.id === id ? resolvedCache : null);
  if (id === null || !conflict) return null;
  const done = conflict.resolvedAt !== null || conflict.pendingResolution !== null;
  return (
    <Modal isOpen onClose={closeDialog} size="lg">
      {done ? (
        <div data-testid="sync-conflict-dialog" className="p-6 text-sm text-text-secondary">
          <p>Already resolved.</p>
          <Button type="button" size="sm" className="mt-3" onClick={closeDialog}>
            Close
          </Button>
        </div>
      ) : (
        <DialogBody key={conflict.id} conflict={conflict} onClose={closeDialog} />
      )}
    </Modal>
  );
}
