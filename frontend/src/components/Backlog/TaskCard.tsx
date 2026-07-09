/**
 * TaskCard / TaskChildren — the card (Kanban) and the inner task body shared by
 * both Kanban cards and List rows.
 *
 * A card shows: a project chip row (All-projects view only, above the tag
 * pills); type tag, priority tag, FlowMarker(s) (multiple when parallel runs),
 * ReviewMarker, DoneFlag, the display ref; the title; the summary; and a
 * footer with repo, compact "Nm ago", and the per-card "Run" action. Epics
 * show an expand control ("N tasks") that reveals nested {@link TaskChildren}.
 *
 * Archive-in-place: an archived item (`archived_at` stamped) only reaches a card
 * while the header Archived toggle is on — it then renders dimmed (opacity-60)
 * with an ArchivedChip next to its type tag. Children arrive PRE-FILTERED from
 * filterTasks (archived children already dropped, childCount recomputed), so
 * the card renders `task.children` as given — it never refetches/refilters.
 *
 * The card body itself carries no drag handlers — same-column drag-and-drop
 * lives on the wrapper slot in KanbanView (which sets `draggable`). The
 * breathing-glow on an in-flight card honours prefers-reduced-motion
 * (motion-reduce:* variants in the marker + ring).
 *
 * Launch state is threaded as `launchingTaskId` (not a pre-computed boolean) so
 * nested epic children also reflect their own in-flight launch correctly.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, Play, Loader2, Pencil, Lightbulb } from 'lucide-react';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';
import { trpc } from '../../trpc/client';
import { useBacklogStore } from '../../stores/backlogStore';
import { TypeTag, PriorityTag, ArchivedChip, ProjectChip, FlowMarker, ReviewMarker, DoneFlag } from './markers';
import { compactAgo, isArchived } from './backlogSelectors';
import { CardActionsMenu } from './CardActionsMenu';
import { IdeaDetailEditor } from '../IdeaDetailEditor';
import { EpicDetailEditor } from '../EpicDetailEditor';
import { TaskDetailModal } from '../cyboflow/TaskDetailModal';

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

/** Footer: repo · time · root-idea back-link · Edit · Run. */
function CardFooter({
  task,
  onRun,
  onEdit,
  onOpenRootIdea,
  loadingRootIdea,
  launchingTaskId,
  now,
}: TaskBodyProps & {
  onEdit: (e: React.MouseEvent) => void;
  /** Open the originating idea's detail; rendered only when the card has one. */
  onOpenRootIdea: (e: React.MouseEvent) => void;
  /** True while the root-idea fetch is in flight (spins the back-link icon). */
  loadingRootIdea: boolean;
}): React.JSX.Element {
  const isLaunching = launchingTaskId === task.id;
  return (
    <div className="flex items-center justify-between gap-2 pt-1.5">
      <div className="flex min-w-0 items-center gap-2 text-[10.5px] text-text-tertiary">
        {task.repo && <span className="truncate font-medium">{task.repo}</span>}
        <span className="flex-shrink-0">{compactAgo(task.created_at, now)}</span>
        {/* Back-link to the originating idea — a decomposed idea is off the board
            but still inspectable via its children (epics carry originating_idea_id;
            solo tasks too). Hidden on ideas (originating_idea_id === null). */}
        {task.originating_idea_id !== null && (
          <button
            type="button"
            onClick={onOpenRootIdea}
            disabled={loadingRootIdea}
            data-testid="open-root-idea"
            aria-label={`Open originating idea of ${task.ref}`}
            className="inline-flex flex-shrink-0 items-center gap-1 font-medium text-text-tertiary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loadingRootIdea ? (
              <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
            ) : (
              <Lightbulb className="h-3 w-3" />
            )}
            Idea
          </button>
        )}
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
  // Root-idea back-link: the fetched originating idea (with its decomposition
  // children) shown in a read-only detail modal; null = closed.
  const [rootIdea, setRootIdea] = useState<BacklogTaskItem | null>(null);
  const [loadingRootIdea, setLoadingRootIdea] = useState(false);
  const isEpic = task.type === 'epic';
  const childCount = task.childCount ?? task.children?.length ?? 0;
  // Archive-in-place: archived items only render while the header Archived
  // toggle is on — dim the whole body and badge it next to the type tag.
  const archived = isArchived(task);
  // Read the project filter straight from the store (CardActionsMenu precedent)
  // so the chip needs no prop-drilling through the Kanban/List card tree. The
  // chip only appears in the cross-project view (filter = All AND >1 project).
  const filterProjectId = useBacklogStore((s) => s.filterProjectId);
  const projects = useBacklogStore((s) => s.projects);
  const projectName =
    filterProjectId === null && projects.length > 1
      ? projects.find((p) => p.id === task.project_id)?.name ?? null
      : null;

  // Guard the Edit click from bubbling into the epic-expand toggle / card body.
  const handleEdit = (e: React.MouseEvent): void => {
    e.stopPropagation();
    setEditorOpen(true);
  };

  // Open the originating idea's detail. Fetch via the dedicated decomposition
  // read (selectIdeaDecomposition) so the idea arrives WITH its spawned epics +
  // direct tasks nested — a decomposed idea is off the board but stays
  // inspectable + navigable. Soft-fail: a fetch error just leaves it closed.
  const handleOpenRootIdea = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    const ideaId = task.originating_idea_id;
    if (ideaId === null || loadingRootIdea) return;
    setLoadingRootIdea(true);
    try {
      const idea = await trpc.cyboflow.tasks.ideaDecomposition.query({ ideaId });
      setRootIdea(idea);
    } catch {
      // Convenience affordance — swallow and leave the modal closed.
    } finally {
      setLoadingRootIdea(false);
    }
  };

  return (
    <div
      className={`flex flex-col gap-1.5 ${archived ? 'opacity-60' : ''}`}
      data-archived={archived ? 'true' : 'false'}
    >
      {/* Project chip row — its own line ABOVE the tag pills (All-projects view only). */}
      {projectName !== null && (
        <div className="flex items-center">
          <ProjectChip name={projectName} />
        </div>
      )}

      {/* Tag header row */}
      <div className="flex flex-wrap items-center gap-1.5">
        <TypeTag type={task.type} />
        {archived && <ArchivedChip />}
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

      <CardFooter
        task={task}
        onRun={onRun}
        onEdit={handleEdit}
        onOpenRootIdea={(e) => void handleOpenRootIdea(e)}
        loadingRootIdea={loadingRootIdea}
        launchingTaskId={launchingTaskId}
        now={now}
      />

      {/* Type-appropriate detail editor — opened by the dedicated Edit affordance. */}
      <DetailEditor task={task} isOpen={editorOpen} onClose={() => setEditorOpen(false)} />

      {/* Root-idea detail — opened by the back-link; lists the idea's children. */}
      <TaskDetailModal task={rootIdea} onClose={() => setRootIdea(null)} />

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

/**
 * Nested child tasks of an expanded epic. Rendered exactly as given — archived
 * children were already dropped (and childCount recomputed) by filterTasks
 * upstream when the Archived toggle is off.
 */
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
