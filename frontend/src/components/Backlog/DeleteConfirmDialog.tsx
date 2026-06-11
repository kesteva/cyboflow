/**
 * DeleteConfirmDialog — confirm step for the per-card danger "Delete" action.
 *
 * Deleting is PERMANENT (hard delete with cascade): confirming calls
 * `cyboflow.tasks.delete` → TaskChangeRouter.applyDelete (actor:'user'), which
 * removes the entity plus its lineage (idea → its epics + their tasks; epic →
 * its child tasks), purges their entity_events and dismisses linked pending
 * review_items. Blocked server-side while any affected task has a non-terminal
 * run (`active_runs`), surfaced here via friendlyStageError. The 'deleted'
 * events arrive back in the backlogStore via the onTaskChanged subscription.
 *
 * Pure (single `task` prop) so it unit-tests without the store.
 */
import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';
import { trpc } from '../../trpc/client';
import { friendlyStageError } from './backlogSelectors';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';

interface DeleteConfirmDialogProps {
  task: BacklogTaskItem;
  isOpen: boolean;
  onClose: () => void;
}

export function DeleteConfirmDialog({
  task,
  isOpen,
  onClose,
}: DeleteConfirmDialogProps): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setSubmitting(false);
    setError(null);
  }, [isOpen, task.id]);

  const handleDelete = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await trpc.cyboflow.tasks.delete.mutate({
        projectId: task.project_id,
        taskId: task.id,
      });
      onClose();
    } catch (err: unknown) {
      setError(friendlyStageError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const entityLabel = task.type === 'idea' ? 'idea' : task.type === 'epic' ? 'epic' : 'task';
  // Cascade phrasing: epics know their child count from the read model; ideas
  // get the generic clause (the cascade set — epics + their tasks — is computed
  // server-side in applyDelete, not carried on the item).
  const childCount = task.childCount ?? task.children?.length ?? 0;
  const cascade =
    task.type === 'idea'
      ? 'Any epics and tasks created from this idea will be deleted too.'
      : task.type === 'epic' && childCount > 0
        ? `Its ${childCount} child task${childCount === 1 ? '' : 's'} will be deleted too.`
        : null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm">
      <ModalHeader title={`Delete ${task.ref}?`} onClose={onClose} />
      <ModalBody className="space-y-3">
        <div className="flex flex-col gap-2" data-testid="delete-confirm-dialog">
          <p className="text-sm text-text-secondary">
            This permanently deletes the {entityLabel}{' '}
            <span className="font-semibold text-text-primary">{task.title}</span>. This cannot be
            undone.
          </p>
          {cascade !== null && (
            <p className="text-sm font-medium text-status-error" data-testid="delete-cascade-note">
              {cascade}
            </p>
          )}
          <p className="text-xs text-text-tertiary">
            If this {entityLabel} (or anything it would delete) has an active run, deletion is
            blocked until the run finishes.
          </p>
          {error && (
            <p className="text-xs text-status-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          type="button"
          onClick={onClose}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleDelete()}
          disabled={submitting}
          data-testid="delete-confirm-button"
          className="inline-flex items-center gap-1 rounded-button bg-status-error px-3 py-1.5 text-sm font-medium text-white hover:bg-status-error/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {submitting ? 'Deleting…' : 'Delete'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
