/**
 * KanbanView — one column per VISIBLE unified stage. Buckets arrive pre-built
 * (filterTasks -> unifiedStages -> bucketByStage): cross-project boards are
 * collapsed by stage POSITION, so each column's `stage` is the representative
 * stage row for that position. Each column shows a color bar (the stage's
 * oklch hue), the stage label, its task count, and the hint. Empty columns
 * render a dashed placeholder.
 *
 * Cards are draggable WITHIN their own column (native HTML5 DnD per the
 * DraggableProjectTreeView precedent — no dnd library). A drop calls
 * `onReorder(task, targetIndex)` with the card's POST-DROP index; the rank
 * math + persistence live in BacklogPane's shared reorder core. Cross-column
 * drops are a no-op in v1: dragover/dragenter outside the source column never
 * call preventDefault, so the browser rejects the drop and `drop` never fires.
 * Drag state clears in `dragend` (which fires even on cancelled drags), never
 * in `drop`.
 *
 * The card ⋯ menu's Move up / Move down / Move to top (WCAG 2.5.7 alternative
 * to DnD) are wired here too: the bucket index is at hand, so this layer owns
 * the direction→post-move-index translation and funnels into the SAME
 * `onReorder` — no second write path.
 */
import { Fragment, useState } from 'react';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';
import type { StageBucket } from './backlogSelectors';
import { BoardCard } from './TaskCard';

interface KanbanViewProps {
  buckets: StageBucket[];
  onRun: (task: BacklogTaskItem) => void;
  /**
   * Re-rank `task` to `targetIndex` — its desired POST-MOVE index within its
   * own stage column. DnD-independent: both drag-and-drop and the card menu's
   * Move up / down / to top funnel into this one callback.
   */
  onReorder: (task: BacklogTaskItem, targetIndex: number) => void;
  launchingTaskId: string | null;
  now: number;
}

/** The card being dragged: its column (stage POSITION) + index within it. */
interface DragSource {
  taskId: string;
  columnPosition: number;
  fromIndex: number;
}

/** The insertion slot under the pointer: insert-BEFORE `index` (`tasks.length` = end). */
interface DropSlot {
  columnPosition: number;
  index: number;
}

/** Thin insertion indicator rendered at the active drop slot. */
function DropIndicator(): React.JSX.Element {
  return <div className="h-0.5 rounded-full bg-interactive" data-testid="drop-indicator" aria-hidden />;
}

export function KanbanView({ buckets, onRun, onReorder, launchingTaskId, now }: KanbanViewProps): React.JSX.Element {
  const [drag, setDrag] = useState<DragSource | null>(null);
  const [dropSlot, setDropSlot] = useState<DropSlot | null>(null);

  const handleDragStart = (
    e: React.DragEvent,
    task: BacklogTaskItem,
    index: number,
    columnPosition: number,
  ): void => {
    setDrag({ taskId: task.id, columnPosition, fromIndex: index });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', task.id);
  };

  // dragend fires even on cancelled drags (Escape / dropped outside a target) —
  // the ONLY place the drag source is cleared, so a stale source never lingers.
  const handleDragEnd = (): void => {
    setDrag(null);
    setDropSlot(null);
  };

  // Shared dragenter + dragover: preventDefault in BOTH (the HTML5 contract for
  // marking a valid drop target), restricted to the SOURCE column — elsewhere
  // the default "no drop" stands, making cross-column drops a no-op.
  const handleDragEnterOver = (e: React.DragEvent, columnPosition: number, index: number): void => {
    if (drag === null || drag.columnPosition !== columnPosition) return;
    e.preventDefault();
    e.stopPropagation();
    setDropSlot((s) =>
      s !== null && s.columnPosition === columnPosition && s.index === index
        ? s
        : { columnPosition, index },
    );
  };

  const handleDrop = (
    e: React.DragEvent,
    columnPosition: number,
    index: number,
    tasks: BacklogTaskItem[],
  ): void => {
    e.preventDefault();
    e.stopPropagation();
    setDropSlot(null);
    if (drag === null || drag.columnPosition !== columnPosition) return;
    const task = tasks[drag.fromIndex];
    if (task === undefined || task.id !== drag.taskId) return; // column changed mid-drag
    // Insert-before `index` → post-drop index: removing the card first shifts
    // every later slot down by one.
    const targetIndex = drag.fromIndex < index ? index - 1 : index;
    if (targetIndex === drag.fromIndex) return;
    onReorder(task, targetIndex);
  };

  const isSlot = (columnPosition: number, index: number): boolean =>
    dropSlot !== null && dropSlot.columnPosition === columnPosition && dropSlot.index === index;

  return (
    <div className="flex h-full gap-3 overflow-x-auto pb-2" data-testid="kanban-view">
      {buckets.map(({ stage, tasks }) => (
        <section
          key={stage.id}
          className="flex w-[260px] flex-shrink-0 flex-col"
          data-testid="kanban-column"
          data-stage-id={stage.id}
        >
          {/* Column header */}
          <div className="mb-2 flex flex-col gap-1">
            <div
              className="h-1 w-full rounded-full"
              style={{ backgroundColor: stage.color_oklch }}
              aria-hidden
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-bold text-text-primary">{stage.label}</span>
              <span className="rounded-full bg-bg-tertiary px-1.5 text-[10px] font-bold text-text-tertiary">
                {tasks.length}
              </span>
            </div>
            {stage.hint && <span className="text-[10px] text-text-tertiary">{stage.hint}</span>}
          </div>

          {/* Cards — the container itself is the end-of-column drop target
              (card slots stopPropagation, so it only sees the space below). */}
          <div
            className="flex flex-1 flex-col gap-2"
            onDragEnter={(e) => handleDragEnterOver(e, stage.position, tasks.length)}
            onDragOver={(e) => handleDragEnterOver(e, stage.position, tasks.length)}
            onDrop={(e) => handleDrop(e, stage.position, tasks.length, tasks)}
          >
            {tasks.length === 0 ? (
              <div className="rounded-card border border-dashed border-border-primary px-2 py-6 text-center text-[10.5px] text-text-muted">
                Empty
              </div>
            ) : (
              tasks.map((task, index) => (
                <Fragment key={task.id}>
                  {isSlot(stage.position, index) && <DropIndicator />}
                  <div
                    draggable
                    data-testid="kanban-card-slot"
                    data-task-id={task.id}
                    className={drag !== null && drag.taskId === task.id ? 'opacity-50' : undefined}
                    onDragStart={(e) => handleDragStart(e, task, index, stage.position)}
                    onDragEnd={handleDragEnd}
                    onDragEnter={(e) => handleDragEnterOver(e, stage.position, index)}
                    onDragOver={(e) => handleDragEnterOver(e, stage.position, index)}
                    onDrop={(e) => handleDrop(e, stage.position, index, tasks)}
                  >
                    <BoardCard
                      task={task}
                      onRun={onRun}
                      launchingTaskId={launchingTaskId}
                      now={now}
                      // Menu reorder: translate direction → post-move index here
                      // (the bucket index is at hand) and reuse the DnD callback.
                      onReorder={(t, dir) =>
                        onReorder(t, dir === 'top' ? 0 : dir === 'up' ? index - 1 : index + 1)
                      }
                      canMoveUp={index > 0}
                      canMoveDown={index < tasks.length - 1}
                    />
                  </div>
                </Fragment>
              ))
            )}
            {tasks.length > 0 && isSlot(stage.position, tasks.length) && <DropIndicator />}
          </div>
        </section>
      ))}
    </div>
  );
}
