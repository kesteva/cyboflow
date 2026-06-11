/**
 * CardActionsMenu — the per-card "⋯" overflow menu on backlog cards.
 *
 * Holds the secondary actions (kept out of the footer's primary Edit / Run
 * row): "Change stage…" (opens the warned {@link StageChangeDialog}),
 * "Archive" / "Unarchive" (archive-in-place — Archive confirms via
 * {@link ArchiveConfirmDialog}; Unarchive mutates `tasks.archive
 * {archived:false}` directly, no dialog), and the danger "Delete" (opens
 * {@link DeleteConfirmDialog}). Reads the boards (cross-project store) so it
 * stays a leaf with a single `task` prop — no board prop-drilling through the
 * Kanban/List card tree.
 *
 * Change stage / Archive / Delete are disabled while the card has an active
 * run (the chokepoint rejects each with `active_runs`); Unarchive is never
 * guarded. `isArchived` reads the `archived_at` stamp — archiving no longer
 * moves the item to a terminal stage.
 */
import { useState } from 'react';
import { MoreHorizontal, ArrowRightLeft, Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import { Dropdown, type DropdownItem } from '../ui/Dropdown';
import { useBacklogStore } from '../../stores/backlogStore';
import { trpc } from '../../trpc/client';
import { pickDefaultBoard, friendlyStageError } from './backlogSelectors';
import { StageChangeDialog } from './StageChangeDialog';
import { ArchiveConfirmDialog } from './ArchiveConfirmDialog';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';

interface CardActionsMenuProps {
  task: BacklogTaskItem;
}

export function CardActionsMenu({ task }: CardActionsMenuProps): React.JSX.Element | null {
  const boards = useBacklogStore((s) => s.boards);
  const [stageOpen, setStageOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Dialog-less Unarchive surfaces failures inline next to the trigger.
  const [actionError, setActionError] = useState<string | null>(null);
  const [unarchiving, setUnarchiving] = useState(false);

  // Prefer the task's own board; the fallback narrows to the task's PROJECT
  // before picking a default — the store now holds boards for ALL projects, and
  // offering another project's stage ids to StageChangeDialog would be wrong.
  const board =
    boards.find((b) => b.id === task.board_id) ??
    pickDefaultBoard(boards.filter((b) => b.project_id === task.project_id));
  if (board === null) return null;

  const isArchived = task.archived_at !== null;
  // The chokepoint rejects USER stage moves / archive / delete on a task with ANY
  // non-terminal run (active_runs). BacklogTaskItem only exposes `inFlow` (running)
  // + `awaitingReview` (awaiting_review / pr_open / pending approvals) overlays, so
  // we gate on both to cover the common run + review window; rarer transient states
  // (queued / stuck / awaiting_input) still degrade gracefully via the server
  // rejection + friendly error.
  const hasActiveRun = task.inFlow.length > 0 || task.awaitingReview;
  const runHint = hasActiveRun ? 'Finish or cancel the active run first.' : undefined;

  const handleUnarchive = async (): Promise<void> => {
    if (unarchiving) return;
    setUnarchiving(true);
    setActionError(null);
    try {
      await trpc.cyboflow.tasks.archive.mutate({
        projectId: task.project_id,
        taskId: task.id,
        archived: false,
        expectedVersion: task.version,
      });
    } catch (err: unknown) {
      setActionError(friendlyStageError(err));
    } finally {
      setUnarchiving(false);
    }
  };

  const items: DropdownItem[] = [
    {
      id: 'change-stage',
      label: 'Change stage…',
      icon: ArrowRightLeft,
      disabled: hasActiveRun,
      ...(runHint ? { description: runHint } : {}),
      onClick: () => setStageOpen(true),
    },
  ];
  if (isArchived) {
    // Unarchive is never guarded server-side — no dialog, no active-run gate.
    items.push({
      id: 'unarchive',
      label: 'Unarchive',
      icon: ArchiveRestore,
      disabled: unarchiving,
      onClick: () => void handleUnarchive(),
    });
  } else {
    items.push({
      id: 'archive',
      label: 'Archive',
      icon: Archive,
      variant: 'warning',
      disabled: hasActiveRun,
      ...(runHint ? { description: runHint } : {}),
      onClick: () => setArchiveOpen(true),
    });
  }
  items.push({
    id: 'delete',
    label: 'Delete',
    icon: Trash2,
    variant: 'danger',
    disabled: hasActiveRun,
    ...(runHint ? { description: runHint } : {}),
    onClick: () => setDeleteOpen(true),
  });

  return (
    // Stop clicks from bubbling into the epic-expand toggle / card body (mirrors
    // the dedicated Edit affordance's stopPropagation guard).
    <span onClick={(e) => e.stopPropagation()} className="inline-flex items-center">
      <Dropdown
        position="auto"
        width="sm"
        items={items}
        trigger={
          <button
            type="button"
            data-testid="task-actions-trigger"
            aria-haspopup="menu"
            aria-label={`Actions for ${task.ref}`}
            className="inline-flex items-center rounded-button border border-border-primary px-1.5 py-0.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
        }
      />
      {actionError !== null && (
        <span role="alert" className="ml-1.5 text-[10px] leading-tight text-status-error">
          {actionError}
        </span>
      )}
      <StageChangeDialog
        task={task}
        board={board}
        isOpen={stageOpen}
        onClose={() => setStageOpen(false)}
      />
      <ArchiveConfirmDialog
        task={task}
        isOpen={archiveOpen}
        onClose={() => setArchiveOpen(false)}
      />
      <DeleteConfirmDialog
        task={task}
        isOpen={deleteOpen}
        onClose={() => setDeleteOpen(false)}
      />
    </span>
  );
}
