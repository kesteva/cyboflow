/**
 * BacklogPane — the full-width "Task backlog" center surface (Phase 0 + Phase 1).
 *
 * Mirrors the Human-review pane: it is swapped into the center over CyboflowRoot
 * by App.tsx when the rail's "Task backlog" item is active. CROSS-PROJECT — it
 * drives {@link useBacklogStore} via the no-arg `init()` (once on mount), which
 * full-syncs tasks + boards + projects for ALL projects and subscribes to the
 * global task-change stream. A header dropdown narrows the view to one project
 * (or "All projects", the default) via the store's in-memory `filterProjectId`;
 * the `projectId` prop survives ONLY as the NewTaskDialog default project.
 *
 * Layout: header (eyebrow + title + counts line + in-flow / awaiting-review
 * chips + project filter + Archived toggle + Kanban/List segmented toggle) over
 * either KanbanView (one column per visible unified stage) or ListView (group
 * per non-empty visible stage). Kanban cards are draggable within their own
 * column (same-column reorder via fractional `sort_order` — see `reorderTask`
 * below); cross-column drops are a no-op in v1. A "+ New" affordance opens
 * NewTaskDialog; each card has a "Run" action that launches a run for the task
 * in ITS project (`task.project_id`, not the pane prop).
 *
 * Render pipeline: filterTasks (project narrow + archive-in-place visibility)
 * -> unifiedStages (per-project boards collapsed into one column set by stage
 * POSITION) -> bucketByStage (keyed on `stage_position`). The header counts
 * derive from the same filtered list — board and header read one source of
 * truth. Archiving stamps `archived_at` in place (no Archived stage exists);
 * the Archived toggle reveals archived cards (dimmed) plus hidden_by_default
 * stages (won't-do), and labels itself with the archived count.
 *
 * EmptyBacklogView shows only when NO projects exist after load.
 *
 * Design hex → EXISTING semantic tokens (styles/tokens/colors.css):
 *   terracotta → interactive, gold → status-warning, green → status-success.
 */
import { useEffect, useState } from 'react';
import { Kanban, List, Plus, Archive, ChevronDown, FolderOpen } from 'lucide-react';
import { useBacklogStore } from '../stores/backlogStore';
import type { BacklogProjectRef } from '../stores/backlogStore';
import {
  filterTasks,
  unifiedStages,
  countArchived,
  bucketByStage,
  deriveCounts,
  isExecutionStage,
  readyForDevChildTaskIds,
  planReorder,
  friendlyStageError,
} from './Backlog/backlogSelectors';
import { trpc } from '../trpc/client';
import { Dropdown, type DropdownItem } from './ui/Dropdown';
import { KanbanView } from './Backlog/KanbanView';
import { ListView } from './Backlog/ListView';
import { NewTaskDialog } from './Backlog/NewTaskDialog';
import { useTaskRunLauncher } from './Backlog/useTaskRunLauncher';
import { TaskBatchPickerModal } from './cyboflow/TaskBatchPickerModal';
import type { BacklogTaskItem, BoardStage } from '../../../shared/types/tasks';
import { DEFAULT_SUBSTRATE } from '../../../shared/types/substrate';
import type { LayoutMode } from '../stores/backlogStore';

const NOW_REFRESH_MS = 60_000;

interface BacklogPaneProps {
  /**
   * Active project id, or null. ONLY used as the NewTaskDialog default project —
   * the board itself is cross-project and narrows via the store's filter.
   */
  projectId: number | null;
}

/** Shown when no projects exist at all (nothing to put on a board). */
export function EmptyBacklogView(): React.JSX.Element {
  return (
    <div
      className="flex h-full w-full items-center justify-center bg-bg-primary p-8 text-center"
      data-testid="empty-backlog"
    >
      <div>
        <div className="eyebrow text-text-tertiary">Planning pipeline · pre-sprint</div>
        <h2 className="mt-1 text-[22px] font-bold tracking-[-0.01em] text-text-primary">Task backlog</h2>
        <p className="mt-2 text-sm text-text-muted">Create a project to start a backlog.</p>
      </div>
    </div>
  );
}

/**
 * Project filter dropdown — "All projects" (default) or a single project. The
 * trigger is labelled with the current selection; choosing an item writes the
 * store's in-memory `filterProjectId`.
 */
function ProjectFilter({
  projects,
  filterProjectId,
  onFilterChange,
}: {
  projects: BacklogProjectRef[];
  filterProjectId: number | null;
  onFilterChange: (id: number | null) => void;
}): React.JSX.Element {
  const selected = filterProjectId === null
    ? null
    : projects.find((p) => p.id === filterProjectId) ?? null;
  const items: DropdownItem[] = [
    {
      id: 'all',
      label: 'All projects',
      onClick: () => onFilterChange(null),
    },
    ...projects.map((p): DropdownItem => ({
      id: `project-${p.id}`,
      label: p.name,
      onClick: () => onFilterChange(p.id),
    })),
  ];
  return (
    <Dropdown
      position="auto"
      width="sm"
      items={items}
      selectedId={selected === null ? 'all' : `project-${selected.id}`}
      trigger={
        <button
          type="button"
          data-testid="project-filter-trigger"
          aria-haspopup="menu"
          aria-label="Filter by project"
          className="inline-flex max-w-[200px] items-center gap-1 rounded-button border border-border-primary bg-bg-primary px-2.5 py-1 text-[11px] font-semibold text-text-secondary transition-colors hover:bg-bg-hover"
        >
          <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate">{selected === null ? 'All projects' : selected.name}</span>
          <ChevronDown className="h-3 w-3 flex-shrink-0" />
        </button>
      }
    />
  );
}

/** Kanban/List segmented toggle (right-aligned in the header). */
function LayoutToggle({
  mode,
  onChange,
}: {
  mode: LayoutMode;
  onChange: (mode: LayoutMode) => void;
}): React.JSX.Element {
  return (
    <div className="inline-flex overflow-hidden rounded-button border border-border-primary" role="group" aria-label="Backlog layout">
      <button
        type="button"
        onClick={() => onChange('kanban')}
        aria-pressed={mode === 'kanban'}
        data-testid="layout-toggle-kanban"
        className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold transition-colors ${
          mode === 'kanban'
            ? 'bg-interactive text-text-on-interactive'
            : 'bg-bg-primary text-text-secondary hover:bg-bg-hover'
        }`}
      >
        <Kanban className="h-3.5 w-3.5" />
        Kanban
      </button>
      <button
        type="button"
        onClick={() => onChange('list')}
        aria-pressed={mode === 'list'}
        data-testid="layout-toggle-list"
        className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold transition-colors ${
          mode === 'list'
            ? 'bg-interactive text-text-on-interactive'
            : 'bg-bg-primary text-text-secondary hover:bg-bg-hover'
        }`}
      >
        <List className="h-3.5 w-3.5" />
        List
      </button>
    </div>
  );
}

interface BacklogHeaderProps {
  /** The FILTERED list — counts must track the project filter + archive visibility. */
  tasks: BacklogTaskItem[];
  /** Archived count from the UNFILTERED list (the toggle label's "(n)"). */
  archivedCount: number;
  projects: BacklogProjectRef[];
  filterProjectId: number | null;
  layoutMode: LayoutMode;
  showArchived: boolean;
  onFilterChange: (id: number | null) => void;
  onLayoutChange: (mode: LayoutMode) => void;
  onToggleArchived: () => void;
  onNew: () => void;
}

function BacklogHeader({
  tasks,
  archivedCount,
  projects,
  filterProjectId,
  layoutMode,
  showArchived,
  onFilterChange,
  onLayoutChange,
  onToggleArchived,
  onNew,
}: BacklogHeaderProps): React.JSX.Element {
  const counts = deriveCounts(tasks);
  return (
    <div className="flex-shrink-0 border-b border-border-primary bg-bg-secondary px-7 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="eyebrow text-text-tertiary">Planning pipeline · pre-sprint</div>
          <h2 className="mt-1 text-[22px] font-bold tracking-[-0.01em] text-text-primary">Task backlog</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary" data-testid="backlog-counts">
            <span><b className="font-bold text-text-primary">{counts.items}</b> items</span>
            <span aria-hidden>·</span>
            <span><b className="font-bold text-text-primary">{counts.epics}</b> epics</span>
            <span aria-hidden>·</span>
            <span><b className="font-bold text-text-primary">{counts.solo}</b> solo</span>
            <span aria-hidden>·</span>
            <span><b className="font-bold text-text-primary">{counts.ideas}</b> ideas</span>
            <span aria-hidden>·</span>
            <span><b className="font-bold text-text-primary">{counts.done}</b> done</span>
            {counts.inFlow > 0 && (
              <span
                className="ml-1 rounded-full border border-interactive/40 bg-interactive-surface px-2 py-px font-semibold text-interactive"
                data-testid="in-flow-chip"
              >
                {counts.inFlow} in flow
              </span>
            )}
            {counts.awaitingReview > 0 && (
              <span
                className="rounded-full border border-status-warning/40 bg-status-warning/10 px-2 py-px font-semibold text-status-warning"
                data-testid="awaiting-review-chip"
              >
                {counts.awaitingReview} awaiting review
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          <ProjectFilter
            projects={projects}
            filterProjectId={filterProjectId}
            onFilterChange={onFilterChange}
          />
          <button
            type="button"
            onClick={onToggleArchived}
            aria-pressed={showArchived}
            data-testid="show-archived-toggle"
            className={`inline-flex items-center gap-1 rounded-button border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
              showArchived
                ? 'border-interactive bg-interactive-surface text-interactive'
                : 'border-border-primary bg-bg-primary text-text-secondary hover:bg-bg-hover'
            }`}
          >
            <Archive className="h-3.5 w-3.5" />
            {archivedCount > 0 ? `Archived (${archivedCount})` : 'Archived'}
          </button>
          <LayoutToggle mode={layoutMode} onChange={onLayoutChange} />
          <button
            type="button"
            onClick={onNew}
            data-testid="backlog-new-button"
            className="inline-flex items-center gap-1 rounded-button bg-interactive px-2.5 py-1 text-[11px] font-semibold text-text-on-interactive hover:bg-interactive-hover"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
            New
          </button>
        </div>
      </div>
    </div>
  );
}

/** The board body — Kanban or List depending on layoutMode. */
function BacklogBoard({
  stages,
  tasks,
  layoutMode,
  onRun,
  onReorder,
  launchingTaskId,
  now,
}: {
  /** Unified visible stages (unifiedStages output). */
  stages: BoardStage[];
  /** The FILTERED task list (filterTasks output). */
  tasks: BacklogTaskItem[];
  layoutMode: LayoutMode;
  onRun: (task: BacklogTaskItem) => void;
  /** Same-column re-rank (Kanban only, DnD + card-menu Move items — the List stays read-only). */
  onReorder: (task: BacklogTaskItem, targetIndex: number) => void;
  launchingTaskId: string | null;
  now: number;
}): React.JSX.Element {
  const buckets = bucketByStage(tasks, stages);
  if (layoutMode === 'kanban') {
    return (
      <KanbanView
        buckets={buckets}
        onRun={onRun}
        onReorder={onReorder}
        launchingTaskId={launchingTaskId}
        now={now}
      />
    );
  }
  return <ListView buckets={buckets} onRun={onRun} launchingTaskId={launchingTaskId} now={now} />;
}

export function BacklogPane({ projectId }: BacklogPaneProps): React.JSX.Element {
  const loaded = useBacklogStore((s) => s.loaded);
  const tasks = useBacklogStore((s) => s.tasks);
  const boards = useBacklogStore((s) => s.boards);
  const projects = useBacklogStore((s) => s.projects);
  const filterProjectId = useBacklogStore((s) => s.filterProjectId);
  const layoutMode = useBacklogStore((s) => s.layoutMode);
  const showArchived = useBacklogStore((s) => s.showArchived);
  const connectionStatus = useBacklogStore((s) => s.connectionStatus);
  const setFilterProject = useBacklogStore((s) => s.setFilterProject);
  const setLayoutMode = useBacklogStore((s) => s.setLayoutMode);
  const toggleShowArchived = useBacklogStore((s) => s.toggleShowArchived);

  const { launchingTaskId, error: launchError, launch, launchSprintBatch } = useTaskRunLauncher();
  const [isNewOpen, setIsNewOpen] = useState(false);
  // Same-column reorder failure (concurrency conflict etc.) — shares the launch
  // error banner styling below.
  const [reorderError, setReorderError] = useState<string | null>(null);

  // Sprint batch picker, opened when Run is clicked on an epic that is past
  // planning ("Ready for development" or later). `taskIds` pre-selects the
  // epic's ready-for-dev child tasks; `epicId` drives the card spinner on launch.
  const [batchPicker, setBatchPicker] = useState<{
    epicId: string;
    projectId: number;
    taskIds: string[];
  } | null>(null);

  // Shared clock tick so every "Nm ago" agrees and refreshes minutely.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), NOW_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  // GLOBAL init — once on mount. The store full-syncs all projects' tasks +
  // boards + the project list and subscribes to the global task-change stream;
  // it is idempotent while wired, so a remount reuses the live subscription.
  useEffect(() => {
    const unsubscribe = useBacklogStore.getState().init();
    return unsubscribe;
  }, []);

  // Only "no projects exist at all" is empty — an empty BOARD still renders
  // its columns (and the + New affordance).
  if (loaded && projects.length === 0) {
    return <EmptyBacklogView />;
  }

  // filterTasks -> unifiedStages -> bucketByStage (inside BacklogBoard); the
  // header counts read the same filtered list, the archived count the raw one.
  const filteredTasks = filterTasks(tasks, filterProjectId, showArchived);
  const stages = unifiedStages(boards, filterProjectId, showArchived);
  const archivedCount = countArchived(tasks, filterProjectId);

  // Launch in the task's OWN project — in All-projects mode the pane prop may
  // point at a different (or no) project.
  const handleRun = (task: BacklogTaskItem): void => {
    // An epic at "Ready for development" or later is past planning — Run should
    // EXECUTE its ready tasks via Sprint, not re-plan it via Planner. Open the
    // sprint batch picker pre-seeded with the epic's ready-for-dev child tasks so
    // the user confirms/adjusts the batch. Planning-stage epics/ideas (and tasks)
    // keep their direct one-click launch.
    if (task.type === 'epic' && isExecutionStage(task.stage_position)) {
      setBatchPicker({
        epicId: task.id,
        projectId: task.project_id,
        taskIds: readyForDevChildTaskIds(task),
      });
      return;
    }
    void launch(task.id, task.project_id, task.type);
  };

  /**
   * Shared same-column reorder core — deliberately DnD-independent (takes the
   * task + its desired POST-MOVE index, no drag event objects). Both Kanban
   * drag-and-drop AND the card ⋯ menu's Move up / down / to top (WCAG 2.5.7)
   * funnel into it via KanbanView's onReorder — one write path.
   *
   * Re-derives the task's rendered column (same bucketByStage pipeline the
   * board uses), plans the rank writes via planReorder (fractional midpoint;
   * whole-column seed/renumber fallback), and persists each assignment
   * SEQUENTIALLY through `tasks.update` (chokepoint-routed: version bump + one
   * entity_events delta per row). The updated rows stream back via the store's
   * onTaskChanged subscription; bucketByStage's compareBacklogOrder sort makes
   * the new order render immediately. On failure (e.g. a CONFLICT from a stale
   * expectedVersion) the error surfaces via friendlyStageError and a full task
   * refetch re-syncs the board — a mid-plan conflict can leave a seed plan
   * partially applied.
   */
  const reorderTask = async (task: BacklogTaskItem, targetIndex: number): Promise<void> => {
    const bucket = bucketByStage(filteredTasks, stages).find(
      (b) => b.stage.position === task.stage_position,
    );
    const columnTasks = bucket?.tasks ?? [];
    const fromIndex = columnTasks.findIndex((t) => t.id === task.id);
    if (fromIndex === -1 || columnTasks.length < 2) return;
    const toIndex = Math.max(0, Math.min(targetIndex, columnTasks.length - 1));
    if (fromIndex === toIndex) return;
    setReorderError(null);
    try {
      for (const step of planReorder(columnTasks, fromIndex, toIndex)) {
        await trpc.cyboflow.tasks.update.mutate({
          projectId: step.task.project_id,
          taskId: step.task.id,
          sortOrder: step.sortOrder,
          expectedVersion: step.task.version,
        });
      }
    } catch (err: unknown) {
      setReorderError(friendlyStageError(err));
      try {
        const fresh = await trpc.cyboflow.tasks.list.query({ projectId: null });
        useBacklogStore.getState().replaceTasks(fresh);
      } catch {
        // Refetch is best-effort — the live subscription remains the fallback.
      }
    }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-primary" data-testid="backlog-pane">
      <BacklogHeader
        tasks={filteredTasks}
        archivedCount={archivedCount}
        projects={projects}
        filterProjectId={filterProjectId}
        layoutMode={layoutMode}
        showArchived={showArchived}
        onFilterChange={setFilterProject}
        onLayoutChange={setLayoutMode}
        onToggleArchived={toggleShowArchived}
        onNew={() => setIsNewOpen(true)}
      />

      {(launchError ?? reorderError) && (
        <div className="flex-shrink-0 border-b border-border-primary bg-status-error/10 px-7 py-1.5 text-xs text-status-error" role="alert">
          {launchError ?? reorderError}
        </div>
      )}

      <div className="flex-1 overflow-auto px-7 py-4">
        {!loaded ? (
          <div className="py-16 text-center text-sm text-text-muted" data-testid="backlog-loading">
            {connectionStatus === 'disconnected'
              ? 'Could not load the backlog. Reopen the pane to retry.'
              : 'Loading backlog…'}
          </div>
        ) : (
          <BacklogBoard
            stages={stages}
            tasks={filteredTasks}
            layoutMode={layoutMode}
            onRun={handleRun}
            onReorder={(task, targetIndex) => void reorderTask(task, targetIndex)}
            launchingTaskId={launchingTaskId}
            now={now}
          />
        )}
      </div>

      {/* The pane's projectId prop survives ONLY as this default — the dialog
          itself resolves filterProjectId ?? this ?? first project. */}
      <NewTaskDialog
        isOpen={isNewOpen}
        projectId={projectId}
        onClose={() => setIsNewOpen(false)}
      />

      {/* Sprint batch picker for a ready epic — pre-seeded with the epic's
          ready-for-dev child tasks; on launch, Sprint runs over the confirmed
          batch (the epic id drives the card spinner). */}
      {batchPicker !== null && (
        <TaskBatchPickerModal
          isOpen
          projectId={batchPicker.projectId}
          substrate={DEFAULT_SUBSTRATE}
          preselectedTaskIds={batchPicker.taskIds}
          onClose={() => setBatchPicker(null)}
          onPicked={(taskIds) => {
            const { epicId, projectId: pid } = batchPicker;
            setBatchPicker(null);
            void launchSprintBatch(epicId, taskIds, pid);
          }}
        />
      )}
    </div>
  );
}

export default BacklogPane;
