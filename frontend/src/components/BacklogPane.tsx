/**
 * BacklogPane — the full-width "Task backlog" center surface (Phase 0 + Phase 1).
 *
 * Mirrors the Human-review pane: it is swapped into the center over CyboflowRoot
 * by App.tsx when the rail's "Task backlog" item is active. Project-scoped — it
 * drives {@link useBacklogStore} via `init(projectId)`, which full-syncs the
 * tasks + boards and subscribes to per-project task-change deltas, tearing down
 * and re-subscribing when the active project changes.
 *
 * Layout: header (eyebrow + title + counts line + in-flow / awaiting-review
 * chips + Kanban/List segmented toggle) over either KanbanView (one column per
 * visible stage) or ListView (group per non-empty visible stage). Read-only — no
 * drag-and-drop. A "+ New" affordance opens NewTaskDialog; each card has a "Run"
 * action that launches a run for the task (passing the contract's taskId param).
 *
 * The board is the UNION of all three entity types (ideas / epics / tasks) over
 * the shared 12-stage board (incl the idea-only terminal "Decomposed" column).
 * The header counts are derived from that same union result via deriveCounts,
 * filtered by type (epics / solo / ideas / done) — the board buckets and the
 * header read from one source of truth.
 *
 * Hidden-by-default stages (won't-do / archived) are excluded unless the
 * show-archived toggle is on. When no project is active, EmptyBacklogView shows.
 *
 * Design hex → EXISTING semantic tokens (styles/tokens/colors.css):
 *   terracotta → interactive, gold → status-warning, green → status-success.
 */
import { useEffect, useState } from 'react';
import { Kanban, List, Plus, Archive } from 'lucide-react';
import { useBacklogStore } from '../stores/backlogStore';
import {
  pickDefaultBoard,
  visibleStages,
  bucketByStage,
  deriveCounts,
} from './Backlog/backlogSelectors';
import { KanbanView } from './Backlog/KanbanView';
import { ListView } from './Backlog/ListView';
import { NewTaskDialog } from './Backlog/NewTaskDialog';
import { useTaskRunLauncher } from './Backlog/useTaskRunLauncher';
import type { BacklogTaskItem, Board } from '../../../shared/types/tasks';
import type { LayoutMode } from '../stores/backlogStore';

const NOW_REFRESH_MS = 60_000;

interface BacklogPaneProps {
  /** Active project id, or null when no project is selected. */
  projectId: number | null;
}

/** Shown when there is no active project to scope the backlog to. */
export function EmptyBacklogView(): React.JSX.Element {
  return (
    <div
      className="flex h-full w-full items-center justify-center bg-bg-primary p-8 text-center"
      data-testid="empty-backlog"
    >
      <div>
        <div className="eyebrow text-text-tertiary">Planning pipeline · pre-sprint</div>
        <h2 className="mt-1 text-[22px] font-bold tracking-[-0.01em] text-text-primary">Task backlog</h2>
        <p className="mt-2 text-sm text-text-muted">Select a project to view its backlog.</p>
      </div>
    </div>
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
  tasks: BacklogTaskItem[];
  layoutMode: LayoutMode;
  showArchived: boolean;
  onLayoutChange: (mode: LayoutMode) => void;
  onToggleArchived: () => void;
  onNew: () => void;
}

function BacklogHeader({
  tasks,
  layoutMode,
  showArchived,
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
            Archived
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
  board,
  tasks,
  layoutMode,
  showArchived,
  onRun,
  launchingTaskId,
  now,
}: {
  board: Board;
  tasks: BacklogTaskItem[];
  layoutMode: LayoutMode;
  showArchived: boolean;
  onRun: (task: BacklogTaskItem) => void;
  launchingTaskId: string | null;
  now: number;
}): React.JSX.Element {
  const stages = visibleStages(board, showArchived);
  const buckets = bucketByStage(tasks, stages);
  if (layoutMode === 'kanban') {
    return <KanbanView buckets={buckets} onRun={onRun} launchingTaskId={launchingTaskId} now={now} />;
  }
  return <ListView buckets={buckets} onRun={onRun} launchingTaskId={launchingTaskId} now={now} />;
}

export function BacklogPane({ projectId }: BacklogPaneProps): React.JSX.Element {
  const tasks = useBacklogStore((s) => s.tasks);
  const boards = useBacklogStore((s) => s.boards);
  const layoutMode = useBacklogStore((s) => s.layoutMode);
  const showArchived = useBacklogStore((s) => s.showArchived);
  const connectionStatus = useBacklogStore((s) => s.connectionStatus);
  const setLayoutMode = useBacklogStore((s) => s.setLayoutMode);
  const toggleShowArchived = useBacklogStore((s) => s.toggleShowArchived);

  const { launchingTaskId, error: launchError, launch } = useTaskRunLauncher();
  const [isNewOpen, setIsNewOpen] = useState(false);

  // Shared clock tick so every "Nm ago" agrees and refreshes minutely.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), NOW_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  // Project-scoped init: re-runs (and re-subscribes) whenever projectId changes.
  // The store itself no-ops on the same projectId and tears down on a change.
  useEffect(() => {
    if (projectId === null) return;
    const unsubscribe = useBacklogStore.getState().init(projectId);
    return unsubscribe;
  }, [projectId]);

  if (projectId === null) {
    return <EmptyBacklogView />;
  }

  const board = pickDefaultBoard(boards);

  const handleRun = (task: BacklogTaskItem): void => {
    void launch(task.id, projectId);
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-primary" data-testid="backlog-pane">
      <BacklogHeader
        tasks={tasks}
        layoutMode={layoutMode}
        showArchived={showArchived}
        onLayoutChange={setLayoutMode}
        onToggleArchived={toggleShowArchived}
        onNew={() => setIsNewOpen(true)}
      />

      {launchError && (
        <div className="flex-shrink-0 border-b border-border-primary bg-status-error/10 px-7 py-1.5 text-xs text-status-error" role="alert">
          {launchError}
        </div>
      )}

      <div className="flex-1 overflow-auto px-7 py-4">
        {board === null ? (
          <div className="py-16 text-center text-sm text-text-muted" data-testid="backlog-loading">
            {connectionStatus === 'disconnected'
              ? 'Could not load the backlog. Reopen the pane to retry.'
              : 'Loading backlog…'}
          </div>
        ) : (
          <BacklogBoard
            board={board}
            tasks={tasks}
            layoutMode={layoutMode}
            showArchived={showArchived}
            onRun={handleRun}
            launchingTaskId={launchingTaskId}
            now={now}
          />
        )}
      </div>

      <NewTaskDialog
        isOpen={isNewOpen}
        projectId={projectId}
        onClose={() => setIsNewOpen(false)}
      />
    </div>
  );
}

export default BacklogPane;
