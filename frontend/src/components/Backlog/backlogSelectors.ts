/**
 * Pure read-side selectors + small formatters for the backlog UI.
 *
 * Kept framework-free (no React) so they unit-test trivially and can be reused
 * by both KanbanView and ListView.
 */
import type { BacklogTaskItem, Board, BoardStage } from '../../../../shared/types/tasks';

/** A board stage paired with the (top-level) tasks currently sitting in it. */
export interface StageBucket {
  stage: BoardStage;
  tasks: BacklogTaskItem[];
}

/**
 * The default board for a project: prefer the one flagged `is_default`, else the
 * first. Returns null when the project has no boards yet (renders nothing).
 */
export function pickDefaultBoard(boards: Board[]): Board | null {
  if (boards.length === 0) return null;
  return boards.find((b) => b.is_default) ?? boards[0];
}

/**
 * Stages visible in the board, sorted by position. Hidden-by-default stages
 * (won't-do / archived) are excluded unless `showArchived` is on.
 */
export function visibleStages(board: Board, showArchived: boolean): BoardStage[] {
  return board.stages
    .filter((s) => showArchived || !s.hidden_by_default)
    .slice()
    .sort((a, b) => a.position - b.position);
}

/**
 * Top-level tasks only (ideas, epics, and SOLO tasks with no parent). Child
 * tasks of an epic are rendered nested under their parent, never as their own
 * column/row entry.
 */
export function topLevelTasks(tasks: BacklogTaskItem[]): BacklogTaskItem[] {
  return tasks.filter((t) => t.parent_epic_id === null);
}

/**
 * Group the top-level tasks into one bucket per visible stage, preserving the
 * board's stage order. A task whose stage is not in the visible set (e.g. an
 * archived task while showArchived is off) is dropped.
 */
export function bucketByStage(
  tasks: BacklogTaskItem[],
  stages: BoardStage[],
): StageBucket[] {
  const byStage = new Map<string, BacklogTaskItem[]>();
  for (const stage of stages) byStage.set(stage.id, []);
  for (const task of topLevelTasks(tasks)) {
    const bucket = byStage.get(task.stage_id);
    if (bucket) bucket.push(task);
  }
  return stages.map((stage) => ({ stage, tasks: byStage.get(stage.id) ?? [] }));
}

// ---------------------------------------------------------------------------
// Header counts
// ---------------------------------------------------------------------------

export interface BacklogCounts {
  items: number;
  epics: number;
  solo: number;
  ideas: number;
  done: number;
  inFlow: number;
  awaitingReview: number;
}

/**
 * Derive the header summary counts from the full task list.
 *  - items: every top-level task (epics + solo + ideas).
 *  - epics: type === 'epic'.
 *  - solo: type === 'task' with no parent epic.
 *  - ideas: type === 'idea'.
 *  - done: isDone overlay true (any type).
 *  - inFlow: tasks with at least one active run.
 *  - awaitingReview: tasks with the awaitingReview overlay.
 */
export function deriveCounts(tasks: BacklogTaskItem[]): BacklogCounts {
  const top = topLevelTasks(tasks);
  let epics = 0;
  let solo = 0;
  let ideas = 0;
  let done = 0;
  let inFlow = 0;
  let awaitingReview = 0;
  // Done / in-flow / awaiting-review count across ALL tasks (incl. epic
  // children) since those overlays attach to executable tasks of any depth.
  for (const t of tasks) {
    if (t.isDone) done += 1;
    if (t.inFlow.length > 0) inFlow += 1;
    if (t.awaitingReview) awaitingReview += 1;
  }
  for (const t of top) {
    if (t.type === 'epic') epics += 1;
    else if (t.type === 'idea') ideas += 1;
    else solo += 1;
  }
  return { items: top.length, epics, solo, ideas, done, inFlow, awaitingReview };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/**
 * Compact "Nm ago" relative time used on cards (e.g. "3m", "2h", "5d", "now").
 * Distinct from utils/timestampUtils.formatDistanceToNow which is verbose.
 */
export function compactAgo(timestamp: string, now: number = Date.now()): string {
  const then = new Date(timestamp).getTime();
  if (Number.isNaN(then)) return '';
  const diffSec = Math.max(0, Math.floor((now - then) / 1000));
  if (diffSec < 60) return 'now';
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
