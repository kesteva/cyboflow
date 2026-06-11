/**
 * StageChangeDialog — manual "Change stage…" picker for a backlog item.
 *
 * Opened from the per-card ⋯ actions menu. Lets the user move an idea / epic /
 * task to any USER-settable stage (see {@link selectableStages}: asserted, not
 * the current one, not the auto-only Decomposed terminal). Always shows a
 * warning that hand-setting a stage skips the normal flow and can leave
 * downstream steps without their inputs.
 *
 * Saves through `cyboflow.tasks.setStage` → the TaskChangeRouter.applyChange
 * chokepoint (actor:'user'), which enforces stage authority, the active-run
 * guard, and optimistic concurrency. The moved row arrives back in the
 * backlogStore via the onTaskChanged subscription — no optimistic write here.
 *
 * Pure (board passed in as a prop) so it unit-tests without the store.
 */
import { useEffect, useState } from 'react';
import { ArrowRightLeft, AlertTriangle } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../ui/Modal';
import { trpc } from '../../trpc/client';
import { selectableStages, findStageById, friendlyStageError } from './backlogSelectors';
import type { BacklogTaskItem, Board } from '../../../../shared/types/tasks';

interface StageChangeDialogProps {
  /** The item being moved — its current stage + version seed the dialog. */
  task: BacklogTaskItem;
  /** The board whose stages back the picker. */
  board: Board;
  isOpen: boolean;
  onClose: () => void;
}

export function StageChangeDialog({
  task,
  board,
  isOpen,
  onClose,
}: StageChangeDialogProps): React.JSX.Element {
  const options = selectableStages(board, task.stage_id);
  const current = findStageById(board, task.stage_id);
  const [selectedStageId, setSelectedStageId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset whenever a different item (or stage) opens the dialog.
  useEffect(() => {
    if (!isOpen) return;
    setSelectedStageId('');
    setSubmitting(false);
    setError(null);
  }, [isOpen, task.id, task.stage_id]);

  const handleSubmit = async (): Promise<void> => {
    if (selectedStageId.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await trpc.cyboflow.tasks.setStage.mutate({
        projectId: task.project_id,
        taskId: task.id,
        stageId: selectedStageId,
        expectedVersion: task.version,
      });
      onClose();
    } catch (err: unknown) {
      setError(friendlyStageError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const target = options.find((s) => s.id === selectedStageId) ?? null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="md" showCloseButton={false}>
      <ModalHeader title={`Change stage · ${task.ref}`} onClose={onClose} />
      <ModalBody className="space-y-4">
        <div className="flex flex-col gap-3" data-testid="stage-change-dialog">
          <div className="text-sm text-text-secondary">
            Current stage:{' '}
            <span className="font-semibold text-text-primary">{current?.label ?? 'Unknown'}</span>
          </div>

          <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
            Move to
            <select
              value={selectedStageId}
              onChange={(e) => setSelectedStageId(e.target.value)}
              className="rounded-input border border-border-primary bg-input-bg px-2 py-1.5 text-sm text-input-text"
              aria-label="Target stage"
              data-testid="stage-change-select"
            >
              <option value="">Select a stage…</option>
              {options.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          <div
            className="flex items-start gap-2 rounded-md border border-status-warning/30 bg-status-warning/10 p-3"
            data-testid="stage-change-warning"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-status-warning" />
            <p className="text-xs leading-snug text-status-warning">
              <span className="font-semibold">Heads up:</span> manually setting a stage skips the
              normal flow. Stages normally advance as the planner or sprint runs and produces what
              each one needs (research, the idea spec, epics, tasks, approvals). Moving an item here
              by hand can leave later steps without those inputs
              {target ? ` — only do this if the work for “${target.label}” is genuinely done.` : '.'}
            </p>
          </div>

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
          onClick={() => void handleSubmit()}
          disabled={selectedStageId.length === 0 || submitting}
          data-testid="stage-change-confirm"
          className="inline-flex items-center gap-1 rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ArrowRightLeft className="h-3.5 w-3.5" />
          {submitting ? 'Moving…' : 'Move'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
