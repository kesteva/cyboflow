/**
 * CardActionsMenu — the per-card "⋯" overflow menu on backlog cards.
 *
 * Holds the two secondary actions (kept out of the footer's primary Edit / Run
 * row): "Change stage…" (opens the warned {@link StageChangeDialog}) and
 * "Archive" (opens {@link ArchiveConfirmDialog}). Reads the board (its stages)
 * from the backlog store so it stays a leaf with a single `task` prop — no board
 * prop-drilling through the Kanban/List card tree.
 *
 * Both items are disabled while the card has an active run (the chokepoint
 * rejects user stage moves on a task with a non-terminal run — `active_runs`),
 * and "Archive" is hidden once the item already sits in the Archived stage.
 */
import { useState } from 'react';
import { MoreHorizontal, ArrowRightLeft, Archive } from 'lucide-react';
import { Dropdown, type DropdownItem } from '../ui/Dropdown';
import { useBacklogStore } from '../../stores/backlogStore';
import { pickDefaultBoard, findStageById, ARCHIVED_POSITION } from './backlogSelectors';
import { StageChangeDialog } from './StageChangeDialog';
import { ArchiveConfirmDialog } from './ArchiveConfirmDialog';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';

interface CardActionsMenuProps {
  task: BacklogTaskItem;
}

export function CardActionsMenu({ task }: CardActionsMenuProps): React.JSX.Element | null {
  const boards = useBacklogStore((s) => s.boards);
  const [stageOpen, setStageOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  // Prefer the task's own board; fall back to the project default (v1 ships a
  // single default board, so these coincide — the by-id lookup just future-proofs).
  const board = boards.find((b) => b.id === task.board_id) ?? pickDefaultBoard(boards);
  if (board === null) return null;

  const currentStage = findStageById(board, task.stage_id);
  const isArchived = currentStage?.position === ARCHIVED_POSITION;
  const hasActiveRun = task.inFlow.length > 0;
  const runHint = hasActiveRun ? 'Cancel the active run first.' : undefined;

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
  if (!isArchived) {
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

  return (
    // Stop clicks from bubbling into the epic-expand toggle / card body (mirrors
    // the dedicated Edit affordance's stopPropagation guard).
    <span onClick={(e) => e.stopPropagation()} className="inline-flex">
      <Dropdown
        position="bottom-right"
        width="sm"
        items={items}
        trigger={
          <span
            data-testid="task-actions-trigger"
            aria-label={`Actions for ${task.ref}`}
            className="inline-flex items-center rounded-button border border-border-primary px-1.5 py-0.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={2.5} />
          </span>
        }
      />
      <StageChangeDialog
        task={task}
        board={board}
        isOpen={stageOpen}
        onClose={() => setStageOpen(false)}
      />
      <ArchiveConfirmDialog
        task={task}
        board={board}
        isOpen={archiveOpen}
        onClose={() => setArchiveOpen(false)}
      />
    </span>
  );
}
