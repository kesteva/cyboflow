/**
 * Pure read-side selectors + small formatters for the backlog UI.
 *
 * Kept framework-free (no React) so they unit-test trivially and can be reused
 * by both KanbanView and ListView.
 *
 * The board is a cross-project "overall" view: the store holds tasks/boards for
 * ALL projects and the selectors here narrow by project filter, apply
 * archive-in-place visibility (`archived_at` stamp — archiving no longer moves
 * an item to a terminal stage), unify per-project boards into one shared column
 * set by stage POSITION, and bucket items by `stage_position`.
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
 * Stages visible in the board, sorted by position. The board carries four
 * stages — 1 Idea, 6 Ready for development, 9 Done, 10 Won't do. The terminal
 * "Won't do" stage is hidden by default (archiving stamps `archived_at` in
 * place rather than moving an item) and excluded unless `showArchived` is on.
 */
export function visibleStages(board: Board, showArchived: boolean): BoardStage[] {
  return board.stages
    .filter((s) => showArchived || !s.hidden_by_default)
    .slice()
    .sort((a, b) => a.position - b.position);
}

// ---------------------------------------------------------------------------
// Archive-in-place visibility + project filter
// ---------------------------------------------------------------------------

/** Whether an item is archived in place (`archived_at` stamped; stage unchanged). */
export function isArchived(t: BacklogTaskItem): boolean {
  return t.archived_at !== null;
}

/**
 * Whether an idea has been decomposed OFF the board: it lives on only through
 * its epics/tasks and is never rendered as a board citizen. Independent of the
 * archived toggle — a decomposed idea is gone from the board regardless.
 */
export function isDecomposed(t: BacklogTaskItem): boolean {
  return t.type === 'idea' && t.decomposed_at !== null;
}

/**
 * Whether an epic/task plan is still PENDING approval (`approved_at === null`).
 * Pending entities are backend-invisible and sprint-ineligible until their plan
 * is approved, so the board hides them independent of the archived toggle.
 */
export function isPending(t: BacklogTaskItem): boolean {
  return (t.type === 'epic' || t.type === 'task') && t.approved_at === null;
}

/**
 * Whether an entity is currently sandboxed inside a side-by-side A/B experiment
 * (migration 047 — `experiment_id` stamped on CREATE, cleared only by
 * `experiments.decide`'s promote path). Server-side `selectProjectBacklog`
 * already excludes these rows by default, but a client selector is defense in
 * depth against any read path that fetches entities directly (e.g. a stale
 * cache, or a future surface that bypasses the server filter) — mirrors
 * `isPending` / `isDecomposed`, which are likewise both server- and
 * client-enforced.
 */
export function isExperimentSandboxed(t: BacklogTaskItem): boolean {
  return (t.experiment_id ?? null) !== null;
}

/**
 * Narrow the full cross-project task list to what the board should render:
 *  - drop items belonging to other projects when `filterProjectId` is set
 *    (children share their epic's project, so the top-level check covers them);
 *  - drop decomposed ideas + PENDING (unapproved) epics/tasks UNCONDITIONALLY —
 *    they are off the board independent of `showArchived`;
 *  - drop archived top-level items unless `showArchived` — an archived EPIC is
 *    dropped together with its whole subtree;
 *  - epics whose `children` include any hidden child (pending/decomposed always,
 *    archived only while `showArchived` is off) get a SHALLOW COPY with the
 *    children filtered and `childCount` / `pendingTasks` recomputed on the copy.
 * Store objects are never mutated; untouched items keep their original
 * reference (cheap referential stability for memoized renders).
 */
export function filterTasks(
  tasks: BacklogTaskItem[],
  filterProjectId: number | null,
  showArchived: boolean,
): BacklogTaskItem[] {
  // A child the board must hide: pending/decomposed/experiment-sandboxed
  // always, archived only while the archived toggle is off.
  const hideChild = (c: BacklogTaskItem): boolean =>
    isPending(c) || isDecomposed(c) || isExperimentSandboxed(c) || (!showArchived && isArchived(c));
  const result: BacklogTaskItem[] = [];
  for (const t of tasks) {
    if (filterProjectId !== null && t.project_id !== filterProjectId) continue;
    if (isDecomposed(t) || isPending(t) || isExperimentSandboxed(t)) continue;
    if (!showArchived && isArchived(t)) continue;
    if (t.children !== undefined && t.children.some(hideChild)) {
      const children = t.children.filter((c) => !hideChild(c));
      result.push({
        ...t,
        children,
        childCount: children.length,
        pendingTasks: children.filter((c) => !c.isDone).length,
      });
      continue;
    }
    result.push(t);
  }
  return result;
}

/**
 * Count archived items (any depth: top-level + epic children) for the header
 * toggle's "Archived (n)" label, narrowed by the project filter. Deliberately a
 * SEPARATE helper from deriveCounts: deriveCounts receives the already-FILTERED
 * list, which contains no archived items while the toggle is off — so the count
 * must be derived from the UNFILTERED store list.
 */
export function countArchived(tasks: BacklogTaskItem[], filterProjectId: number | null): number {
  let n = 0;
  for (const t of tasks) {
    if (filterProjectId !== null && t.project_id !== filterProjectId) continue;
    if (isArchived(t)) n += 1;
    if (t.children !== undefined) n += t.children.filter(isArchived).length;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Cross-project stage unification
// ---------------------------------------------------------------------------

/**
 * Collapse the stage columns of many boards (every project seeds identical
 * stages by position) into ONE shared column set:
 *  - boards narrowed to `filterProjectId` (null = all boards);
 *  - one representative stage per POSITION — the first board in array order
 *    wins (the store orders boards project_id ASC, is_default DESC), so its
 *    labels/colors front the unified columns;
 *  - hidden-by-default stages (won't-do) excluded unless `showArchived`;
 *  - sorted by position ascending.
 */
export function unifiedStages(
  boards: Board[],
  filterProjectId: number | null,
  showArchived: boolean,
): BoardStage[] {
  const byPosition = new Map<number, BoardStage>();
  for (const board of boards) {
    if (filterProjectId !== null && board.project_id !== filterProjectId) continue;
    for (const stage of board.stages) {
      if (!byPosition.has(stage.position)) byPosition.set(stage.position, stage);
    }
  }
  return [...byPosition.values()]
    .filter((s) => showArchived || !s.hidden_by_default)
    .sort((a, b) => a.position - b.position);
}

// ---------------------------------------------------------------------------
// Stage helpers for the per-card actions menu (manual stage move)
// ---------------------------------------------------------------------------

// Board stage positions (seedDefaultBoard). The board carries four stages —
// 1 Idea, 6 Ready for development, 9 Done, 10 Won't do. Position 6 ("Ready for
// development") is the single non-terminal execution stage and the
// planning→execution boundary; an entity at position 1 is still in planning,
// 9/10 are terminal.
export const READY_FOR_DEV_POSITION = 6;
export const LAST_EXECUTION_POSITION = 6;

/**
 * True when a stage position is a non-terminal EXECUTION stage — only position 6
 * ("Ready for development"). The backlog "Run" action routes an epic at an
 * execution stage to Sprint (execute its ready tasks) rather than Planner
 * (re-plan it).
 */
export function isExecutionStage(position: number): boolean {
  return position >= READY_FOR_DEV_POSITION && position <= LAST_EXECUTION_POSITION;
}

/**
 * The ids of an epic's child tasks that are AT "Ready for development" and
 * eligible to seed a sprint batch — a real task, not done, not archived, not
 * already in flight. Used to PRE-SELECT the sprint batch picker when Run is
 * clicked on a ready epic; returns [] for a non-epic or an epic with no loaded /
 * no ready children (the picker then opens with nothing pre-checked).
 */
export function readyForDevChildTaskIds(epic: BacklogTaskItem): string[] {
  return (epic.children ?? [])
    .filter(
      (c) =>
        c.type === 'task' &&
        c.stage_position === READY_FOR_DEV_POSITION &&
        !c.isDone &&
        c.archived_at === null &&
        c.inFlow.length === 0,
    )
    .map((c) => c.id);
}

/** The board stage a row currently sits in, or null when its stage_id is unknown to the board. */
export function findStageById(board: Board, stageId: string): BoardStage | null {
  return board.stages.find((s) => s.id === stageId) ?? null;
}

/**
 * The stages a USER may manually move an item to, sorted by position. Excludes:
 *  - DERIVED stages (write_policy === 'derived') — the chokepoint rejects user
 *    asserts on those (code 'forbidden_stage').
 *  - the item's CURRENT stage (a no-op move).
 * Across the four-stage board this offers positions 1 / 6 / 9 / 10 (minus the
 * current one): the terminal "Won't do" (10) stays a valid manual target so the
 * user can park an item by hand. Archiving is no longer a stage move — it stamps
 * `archived_at` in place via the dedicated Archive action.
 */
export function selectableStages(board: Board, currentStageId: string): BoardStage[] {
  return board.stages
    .filter((s) => s.write_policy === 'asserted' && s.id !== currentStageId)
    .slice()
    .sort((a, b) => a.position - b.position);
}

/**
 * Map a chokepoint rejection (stage move / archive / delete) to a human message
 * for the card-action dialogs. The chokepoint discriminated code is prefixed
 * onto the TRPCError message (`${code}: ${msg}`), so match on the code
 * substring; fall back to the raw message, then a generic line. The
 * 'active_runs' phrasing is operation-neutral since archive and delete hit the
 * same guard as stage moves.
 */
export function friendlyStageError(err: unknown): string {
  const msg = err instanceof Error ? err.message : '';
  if (msg.includes('active_runs'))
    return 'This item has an active run. Cancel or finish the run first.';
  if (msg.includes('concurrency'))
    return 'This item changed since you opened it. Close this dialog and try again.';
  if (msg.includes('forbidden_stage'))
    return 'That stage is set automatically by the orchestrator and can’t be changed by hand.';
  if (msg.includes('not_found')) return 'This item or stage no longer exists. Refresh the backlog.';
  return msg.length > 0 ? msg : 'Could not complete the action. Please try again.';
}

/**
 * Top-level items only — the UNION of all three entity types (ideas, epics, and
 * SOLO tasks) that have no parent epic. Child tasks of an epic are rendered
 * nested under their parent, never as their own column/row entry.
 *
 * The 3-table model has no `type` column on the row; `type` is computed on read
 * from the source table. We do NOT filter by `type` here — every idea / epic /
 * solo task with `parent_epic_id === null` is a top-level board citizen sharing
 * the single stage board — but we DO drop off-board items unconditionally:
 * decomposed ideas (reachable only via their children) and PENDING (unapproved)
 * epics/tasks (backend-invisible until plan approval).
 */
export function topLevelTasks(tasks: BacklogTaskItem[]): BacklogTaskItem[] {
  return tasks.filter(
    (t) => t.parent_epic_id === null && !isDecomposed(t) && !isPending(t),
  );
}

/**
 * Group the top-level UNION (ideas + epics + tasks) into one bucket per visible
 * stage, preserving stage order. Buckets are keyed by stage POSITION
 * (`item.stage_position === stage.position`), NOT stage_id — in the
 * cross-project view each project has its own stage rows, but every board
 * seeds identical positions, so position is the shared bucketing key.
 *
 * The board carries four stages:
 *   1 Idea · 6 Ready for development · 9 Done · 10 Won't do
 *   (terminal, hidden by default).
 *
 * All three entity types funnel into the same bucket map. An item whose position
 * is not in the visible set (e.g. a Won't-do item while showArchived is off,
 * since that stage carries `hidden_by_default`) is dropped — never an orphaned
 * entry.
 */
export function bucketByStage(
  tasks: BacklogTaskItem[],
  stages: BoardStage[],
): StageBucket[] {
  const byPosition = new Map<number, BacklogTaskItem[]>();
  for (const stage of stages) byPosition.set(stage.position, []);
  // Iterate the full union of top-level ideas/epics/tasks into the shared board.
  for (const item of topLevelTasks(tasks)) {
    const bucket = byPosition.get(item.stage_position);
    if (bucket) bucket.push(item);
  }
  return stages.map((stage) => ({ stage, tasks: byPosition.get(stage.position) ?? [] }));
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
 * Derive the header summary counts. Callers pass the FILTERED list
 * (filterTasks output) so the numbers track the project filter + archived
 * visibility; the archived count itself comes from countArchived on the
 * UNFILTERED list (see above).
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
