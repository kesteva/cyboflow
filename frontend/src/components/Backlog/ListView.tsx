/**
 * ListView — one group per NON-EMPTY visible unified stage, each group a stack
 * of full-width list rows. Buckets arrive pre-built (filterTasks ->
 * unifiedStages -> bucketByStage, collapsed by stage POSITION across project
 * boards) and mirror the Kanban content in a vertical layout. Read-only (no
 * drag-and-drop).
 */
import type { BacklogTaskItem } from '../../../../shared/types/tasks';
import type { StageBucket } from './backlogSelectors';
import { TaskBody } from './TaskCard';

interface ListViewProps {
  buckets: StageBucket[];
  onRun: (task: BacklogTaskItem) => void;
  launchingTaskId: string | null;
  now: number;
}

export function ListView({ buckets, onRun, launchingTaskId, now }: ListViewProps): React.JSX.Element {
  const nonEmpty = buckets.filter((b) => b.tasks.length > 0);
  return (
    <div className="flex flex-col gap-5" data-testid="list-view">
      {nonEmpty.map(({ stage, tasks }) => (
        <section key={stage.id} data-testid="list-group" data-stage-id={stage.id}>
          <div className="mb-2 flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
              style={{ backgroundColor: stage.color_oklch }}
              aria-hidden
            />
            <span className="text-[12px] font-bold text-text-primary">{stage.label}</span>
            <span className="rounded-full bg-bg-tertiary px-1.5 text-[10px] font-bold text-text-tertiary">
              {tasks.length}
            </span>
          </div>
          <ul className="flex flex-col gap-2">
            {tasks.map((task) => {
              const breathing = task.inFlow.length > 0;
              return (
                <li
                  key={task.id}
                  data-testid="list-row"
                  data-in-flow={breathing ? 'true' : 'false'}
                  className={`rounded-card border bg-card-bg px-3 py-2 ${
                    breathing
                      ? 'border-interactive/60 ring-1 ring-interactive/30 animate-pulse motion-reduce:animate-none'
                      : 'border-card-border'
                  }`}
                >
                  <TaskBody
                    task={task}
                    onRun={onRun}
                    launchingTaskId={launchingTaskId}
                    now={now}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
