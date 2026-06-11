/**
 * ArchiveConfirmDialog — confirm step for the per-card "Archive" action.
 *
 * Archiving is IN PLACE (migration 024): confirming calls
 * `cyboflow.tasks.archive {archived:true}` → TaskChangeRouter.applyChange
 * (actor:'user'), which stamps `archived_at = now` on the row. The item KEEPS
 * its current stage/column — it is simply hidden until the header "Archived"
 * toggle reveals it, and is reversible via the menu's Unarchive action (there
 * is no terminal Archived stage anymore). The updated row arrives back in the
 * backlogStore via the onTaskChanged subscription.
 *
 * Pure (single `task` prop) so it unit-tests without the store.
 */
import { useEffect, useState } from 'react';
import { Archive } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';
import { trpc } from '../../trpc/client';
import { friendlyStageError } from './backlogSelectors';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';

interface ArchiveConfirmDialogProps {
  task: BacklogTaskItem;
  isOpen: boolean;
  onClose: () => void;
}

export function ArchiveConfirmDialog({
  task,
  isOpen,
  onClose,
}: ArchiveConfirmDialogProps): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setSubmitting(false);
    setError(null);
  }, [isOpen, task.id]);

  const handleArchive = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await trpc.cyboflow.tasks.archive.mutate({
        projectId: task.project_id,
        taskId: task.id,
        archived: true,
        expectedVersion: task.version,
      });
      onClose();
    } catch (err: unknown) {
      setError(friendlyStageError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const entityLabel = task.type === 'idea' ? 'idea' : task.type === 'epic' ? 'epic' : 'task';

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm">
      <ModalHeader title={`Archive ${task.ref}?`} onClose={onClose} />
      <ModalBody className="space-y-3">
        <div className="flex flex-col gap-2" data-testid="archive-confirm-dialog">
          <p className="text-sm text-text-secondary">
            This hides the {entityLabel}{' '}
            <span className="font-semibold text-text-primary">{task.title}</span>. It keeps its
            current column, but stays hidden unless you toggle{' '}
            <span className="font-medium">Archived</span> in the header. You can bring it back
            anytime with <span className="font-medium">Unarchive</span>.
          </p>
          <p className="text-xs text-text-tertiary">
            If this {entityLabel} has an active run, archiving is blocked until the run finishes.
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
          onClick={() => void handleArchive()}
          disabled={submitting}
          data-testid="archive-confirm-button"
          className="inline-flex items-center gap-1 rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Archive className="h-3.5 w-3.5" />
          {submitting ? 'Archiving…' : 'Archive'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
