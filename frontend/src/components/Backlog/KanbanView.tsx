/**
 * KanbanView — one column per VISIBLE stage. Each column shows a color bar
 * (the stage's oklch hue), the stage label, its task count, and the hint.
 * Empty columns render a dashed placeholder. Read-only (no drag-and-drop).
 */
import type { BacklogTaskItem } from '../../../../shared/types/tasks';
import type { StageBucket } from './backlogSelectors';
import { BoardCard } from './TaskCard';

interface KanbanViewProps {
  buckets: StageBucket[];
  onRun: (task: BacklogTaskItem) => void;
  launchingTaskId: string | null;
  now: number;
}

export function KanbanView({ buckets, onRun, launchingTaskId, now }: KanbanViewProps): React.JSX.Element {
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

          {/* Cards */}
          <div className="flex flex-col gap-2">
            {tasks.length === 0 ? (
              <div className="rounded-card border border-dashed border-border-primary px-2 py-6 text-center text-[10.5px] text-text-muted">
                Empty
              </div>
            ) : (
              tasks.map((task) => (
                <BoardCard
                  key={task.id}
                  task={task}
                  onRun={onRun}
                  launchingTaskId={launchingTaskId}
                  now={now}
                />
              ))
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
