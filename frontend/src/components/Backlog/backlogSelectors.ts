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

// ---------------------------------------------------------------------------
// Stage helpers for the per-card actions menu (manual stage move + archive)
// ---------------------------------------------------------------------------

/** Board position of the terminal "Archived" stage (database.ts seedDefaultBoard). */
export const ARCHIVED_POSITION = 11;
/**
 * Board position of the idea-only terminal "Decomposed" stage. It is reached
 * automatically when an idea's first child is created — never a manual target —
 * so it is excluded from the change-stage picker.
 */
export const DECOMPOSED_POSITION = 12;

/** The board stage a row currently sits in, or null when its stage_id is unknown to the board. */
export function findStageById(board: Board, stageId: string): BoardStage | null {
  return board.stages.find((s) => s.id === stageId) ?? null;
}

/** The terminal "Archived" stage of a board (by canonical position, falling back to label), or null. */
export function findArchivedStage(board: Board): BoardStage | null {
  return (
    board.stages.find((s) => s.position === ARCHIVED_POSITION) ??
    board.stages.find((s) => s.label === 'Archived') ??
    null
  );
}

/**
 * The stages a USER may manually move an item to, sorted by position. Excludes:
 *  - DERIVED execution stages (write_policy === 'derived', positions 7/8) — the
 *    chokepoint rejects user asserts on those (code 'forbidden_stage').
 *  - the item's CURRENT stage (a no-op move).
 *  - the auto-only "Decomposed" terminal (idea retirement is never hand-set).
 * Terminal planning stages (Done / Won't do / Archived) ARE offered so the user
 * can mark an item done / parked / archived by hand.
 */
export function selectableStages(board: Board, currentStageId: string): BoardStage[] {
  return board.stages
    .filter(
      (s) =>
        s.write_policy === 'asserted' &&
        s.id !== currentStageId &&
        s.position !== DECOMPOSED_POSITION,
    )
    .slice()
    .sort((a, b) => a.position - b.position);
}

/**
 * Map a setStage rejection to a human message for the card-action dialogs. The
 * chokepoint discriminated code is prefixed onto the TRPCError message
 * (`${code}: ${msg}`), so match on the code substring; fall back to the raw
 * message, then a generic line.
 */
export function friendlyStageError(err: unknown): string {
  const msg = err instanceof Error ? err.message : '';
  if (msg.includes('active_runs'))
    return 'This item has an active run. Cancel or finish the run before changing its stage.';
  if (msg.includes('concurrency'))
    return 'This item changed since you opened it. Close this dialog and try again.';
  if (msg.includes('forbidden_stage'))
    return 'That stage is set automatically by the orchestrator and can’t be changed by hand.';
  if (msg.includes('not_found')) return 'This item or stage no longer exists. Refresh the backlog.';
  return msg.length > 0 ? msg : 'Could not update the stage. Please try again.';
}

/**
 * Top-level items only — the UNION of all three entity types (ideas, epics, and
 * SOLO tasks) that have no parent epic. Child tasks of an epic are rendered
 * nested under their parent, never as their own column/row entry.
 *
 * The 3-table model has no `type` column on the row; `type` is computed on read
 * from the source table. We deliberately do NOT filter by `type` here — every
 * idea / epic / solo task with `parent_epic_id === null` is a top-level board
 * citizen and shares the single 12-stage board (entity-model rebuild).
 */
export function topLevelTasks(tasks: BacklogTaskItem[]): BacklogTaskItem[] {
  return tasks.filter((t) => t.parent_epic_id === null);
}

/**
 * Group the top-level UNION (ideas + epics + tasks) into one bucket per visible
 * stage across the shared 12-stage board, preserving the board's stage order.
 *
 * The 12 stages span the full lineage:
 *   1 Captured · 2 Researching · 3 Idea spec · 4 Epics extracted ·
 *   5 Tasks extracted · 6 Plan review · 7 Ready for dev · 8 In development ·
 *   9 Ready to merge · 10 Done · (Won't do / Archived terminal, hidden by
 *   default) · 12 Decomposed (idea-only terminal — visible by default).
 *
 * All three entity types funnel into the same bucket map keyed by stage_id, so
 * an idea sitting in stage 12 (Decomposed) lands in that terminal column right
 * alongside epics/tasks in their own stages. A task whose stage is not in the
 * visible set (e.g. a Won't-do / Archived item while showArchived is off, since
 * those stages carry `hidden_by_default`) is dropped — never an orphaned entry.
 */
export function bucketByStage(
  tasks: BacklogTaskItem[],
  stages: BoardStage[],
): StageBucket[] {
  const byStage = new Map<string, BacklogTaskItem[]>();
  for (const stage of stages) byStage.set(stage.id, []);
  // Iterate the full union of top-level ideas/epics/tasks into the shared board.
  for (const item of topLevelTasks(tasks)) {
    const bucket = byStage.get(item.stage_id);
    if (bucket) bucket.push(item);
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
