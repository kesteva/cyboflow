/**
 * TaskCard / TaskChildren — the card (Kanban) and the inner task body shared by
 * both Kanban cards and List rows.
 *
 * A card shows: type tag, priority tag, FlowMarker(s) (multiple when parallel
 * runs), ReviewMarker, DoneFlag, the display ref; the title; the summary; and a
 * footer with repo, compact "Nm ago", and the per-card "Run" action. Epics show
 * an expand control ("N tasks") that reveals nested {@link TaskChildren}.
 *
 * Read-only: no drag-and-drop. The breathing-glow on an in-flight card honours
 * prefers-reduced-motion (motion-reduce:* variants in the marker + ring).
 *
 * Launch state is threaded as `launchingTaskId` (not a pre-computed boolean) so
 * nested epic children also reflect their own in-flight launch correctly.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, Play, Loader2, Pencil } from 'lucide-react';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';
import { TypeTag, PriorityTag, FlowMarker, ReviewMarker, DoneFlag } from './markers';
import { compactAgo } from './backlogSelectors';
import { CardActionsMenu } from './CardActionsMenu';
import { IdeaDetailEditor } from '../IdeaDetailEditor';
import { EpicDetailEditor } from '../EpicDetailEditor';

interface TaskBodyProps {
  task: BacklogTaskItem;
  /** Launch a run for this task. */
  onRun: (task: BacklogTaskItem) => void;
  /** Task id whose run launch is currently in flight (or null). */
  launchingTaskId: string | null;
  /** Compact "now" basis so all cards share one clock tick. */
  now: number;
}

/** The marker row (flow / review / done) — only renders when something applies. */
function MarkerRow({ task }: { task: BacklogTaskItem }): React.JSX.Element | null {
  const hasAny = task.inFlow.length > 0 || task.awaitingReview || task.isDone;
  if (!hasAny) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {task.inFlow.map((flow) => (
        <FlowMarker key={flow.runId} flow={flow} />
      ))}
      {task.awaitingReview && <ReviewMarker />}
      {task.isDone && <DoneFlag />}
    </div>
  );
}

/** Footer: repo · time · Edit · Run. */
function CardFooter({
  task,
  onRun,
  onEdit,
  launchingTaskId,
  now,
}: TaskBodyProps & { onEdit: (e: React.MouseEvent) => void }): React.JSX.Element {
  const isLaunching = launchingTaskId === task.id;
  return (
    <div className="flex items-center justify-between gap-2 pt-1.5">
      <div className="flex min-w-0 items-center gap-2 text-[10.5px] text-text-tertiary">
        {task.repo && <span className="truncate font-medium">{task.repo}</span>}
        <span className="flex-shrink-0">{compactAgo(task.created_at, now)}</span>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1.5">
        {/* Dedicated Edit affordance — opens the type-appropriate detail editor.
            stopPropagation guards against the click bubbling into the
            epic-expand toggle or any future full-card handler. */}
        <button
          type="button"
          onClick={onEdit}
          data-testid="task-edit-button"
          aria-label={`Edit ${task.ref}`}
          className="inline-flex items-center gap-1 rounded-button border border-border-primary px-2 py-0.5 text-[10.5px] font-semibold text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <Pencil className="h-3 w-3" strokeWidth={2.5} />
          Edit
        </button>
        <button
          type="button"
          onClick={() => onRun(task)}
          disabled={isLaunching}
          data-testid="task-run-button"
          className="inline-flex items-center gap-1 rounded-button border border-interactive/50 px-2 py-0.5 text-[10.5px] font-semibold text-interactive transition-colors hover:bg-interactive hover:text-text-on-interactive disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isLaunching ? (
            <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
          ) : (
            <Play className="h-3 w-3" strokeWidth={2.5} />
          )}
          Run
        </button>
        {/* Secondary actions (Change stage… / Archive) tucked behind a ⋯ menu. */}
        <CardActionsMenu task={task} />
      </div>
    </div>
  );
}

/**
 * Render the type-appropriate detail editor for a card. Ideas open the
 * IdeaDetailEditor (with the scope hint); epics and solo tasks open the
 * EpicDetailEditor (title / summary / priority / markdown body).
 */
function DetailEditor({
  task,
  isOpen,
  onClose,
}: {
  task: BacklogTaskItem;
  isOpen: boolean;
  onClose: () => void;
}): React.JSX.Element {
  if (task.type === 'idea') {
    return <IdeaDetailEditor idea={task} isOpen={isOpen} onClose={onClose} />;
  }
  return <EpicDetailEditor epic={task} isOpen={isOpen} onClose={onClose} />;
}

/**
 * The shared inner body of a task (used by both the Kanban card and the List
 * row).
 */
export function TaskBody({ task, onRun, launchingTaskId, now }: TaskBodyProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const isEpic = task.type === 'epic';
  const childCount = task.childCount ?? task.children?.length ?? 0;

  // Guard the Edit click from bubbling into the epic-expand toggle / card body.
  const handleEdit = (e: React.MouseEvent): void => {
    e.stopPropagation();
    setEditorOpen(true);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {/* Tag header row */}
      <div className="flex flex-wrap items-center gap-1.5">
        <TypeTag type={task.type} />
        <PriorityTag priority={task.priority} />
        <span className="ml-auto font-mono text-[10px] text-text-tertiary">{task.ref}</span>
      </div>

      <MarkerRow task={task} />

      {/* Title */}
      <div className="text-[13px] font-semibold leading-snug text-text-primary">{task.title}</div>

      {/* Summary */}
      {task.summary && (
        <p className="line-clamp-3 text-[11.5px] leading-snug text-text-secondary">{task.summary}</p>
      )}

      <CardFooter task={task} onRun={onRun} onEdit={handleEdit} launchingTaskId={launchingTaskId} now={now} />

      {/* Type-appropriate detail editor — opened by the dedicated Edit affordance. */}
      <DetailEditor task={task} isOpen={editorOpen} onClose={() => setEditorOpen(false)} />

      {/* Epic expand → nested children */}
      {isEpic && childCount > 0 && (
        <div className="mt-1 border-t border-border-tertiary pt-1.5">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            data-testid="epic-expand"
            className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-text-secondary hover:text-text-primary"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {childCount} {childCount === 1 ? 'task' : 'tasks'}
          </button>
          {expanded && task.children && task.children.length > 0 && (
            <TaskChildren tasks={task.children} onRun={onRun} launchingTaskId={launchingTaskId} now={now} />
          )}
        </div>
      )}
    </div>
  );
}

interface TaskChildrenProps {
  tasks: BacklogTaskItem[];
  onRun: (task: BacklogTaskItem) => void;
  launchingTaskId: string | null;
  now: number;
}

/** Nested child tasks of an expanded epic. */
export function TaskChildren({ tasks, onRun, launchingTaskId, now }: TaskChildrenProps): React.JSX.Element {
  return (
    <ul className="mt-1.5 flex flex-col gap-1.5" data-testid="task-children">
      {tasks.map((child) => (
        <li
          key={child.id}
          className="rounded-card border border-border-tertiary bg-bg-tertiary px-2 py-1.5"
        >
          <TaskBody task={child} onRun={onRun} launchingTaskId={launchingTaskId} now={now} />
        </li>
      ))}
    </ul>
  );
}

/** The Kanban board card. */
export function BoardCard({ task, onRun, launchingTaskId, now }: TaskBodyProps): React.JSX.Element {
  const breathing = task.inFlow.length > 0;
  return (
    <div
      data-testid="board-card"
      data-in-flow={breathing ? 'true' : 'false'}
      className={`rounded-card border bg-card-bg p-2.5 shadow-sm transition-shadow ${
        breathing
          ? 'border-interactive/60 ring-1 ring-interactive/30 animate-pulse motion-reduce:animate-none'
          : 'border-card-border hover:border-border-hover'
      }`}
    >
      <TaskBody task={task} onRun={onRun} launchingTaskId={launchingTaskId} now={now} />
    </div>
  );
}
