/**
 * taskListing — shared READ-side projection for the native entity backlog.
 *
 * Exports the queries the cyboflow.tasks tRPC router reads from, kept in this
 * separate module (mirroring approvalListing.ts) so the router stays a thin
 * tRPC wrapper and the projection can be unit-tested against a DatabaseLike
 * without the tRPC plumbing.
 *
 * 3-TABLE MODEL (migration 015): ideas/epics/tasks are read via a single UNION
 * that synthesizes the `type` literal per source table and projects each table's
 * per-table column set onto the common BacklogTaskItem shape (absent lineage /
 * scope / entry columns read back as NULL). The single onTaskChanged channel +
 * single list query are preserved — the renderer still sees one BacklogTaskItem[].
 *
 *  - boardsForProject(db, projectId)  -> Board[]            (board + ordered stages)
 *  - selectProjectBacklog(db, projectId) -> BacklogTaskItem[] (UNION + on-read overlays + epic nesting)
 *  - computeTaskOverlay(db, taskRow)  -> { inFlow, awaitingReview, isDone } (per-entity derivation)
 *
 * On-read overlay derivation (kept CONSISTENT with the chokepoint's private
 * buildBacklogTaskItem in taskChangeRouter.ts — foundation note #4):
 *   inFlow         = workflow_runs WHERE task_id=? AND status='running'; agent
 *                    resolved from steps_snapshot_json[current_step_id], else
 *                    current_step_id, else 'agent'.
 *   awaitingReview = any run status='awaiting_review' OR outcome='pr_open' OR a
 *                    pending approval exists for any of the task's runs.
 *   isDone         = the task's stage is_terminal && position === 9 ('done').
 *
 * Standalone-typecheck invariant: NO imports from 'electron', 'better-sqlite3',
 * or main/src/services/*. Only narrow interfaces and shared types.
 */
import type {
  BacklogTaskItem,
  Board,
  BoardStage,
  FlowOverlay,
} from '../../../shared/types/tasks';
import type { DatabaseLike } from './types';

// ---------------------------------------------------------------------------
// Internal DB row shapes for the SELECTs below. SQLite BOOLEAN columns surface
// as number 0|1 on read; we normalize to boolean when projecting to the shared
// types (foundation note #9).
// ---------------------------------------------------------------------------

interface BoardDbRow {
  id: string;
  project_id: number;
  name: string;
  kind: 'default' | 'custom';
  is_default: number; // 0 | 1
}

interface BoardStageDbRow {
  id: string;
  board_id: string;
  label: string;
  color_oklch: string;
  hint: string | null;
  position: number;
  write_policy: 'asserted' | 'derived';
  is_terminal: number; // 0 | 1
  hidden_by_default: number; // 0 | 1
}

/**
 * The unified read row produced by the 3-table UNION. `type` is synthesized as a
 * literal in each SELECT branch; lineage / scope columns absent on a given table
 * are projected as NULL so every branch is shape-identical.
 */
interface TaskDbRow {
  id: string;
  project_id: number;
  type: 'idea' | 'epic' | 'task';
  ref: string;
  title: string;
  summary: string | null;
  body: string | null;
  priority: 'P0' | 'P1' | 'P2';
  repo: string | null;
  parent_epic_id: string | null;
  originating_idea_id: string | null;
  scope: 'small' | 'large' | null;
  board_id: string;
  stage_id: string;
  version: number;
  created_at: string;
  updated_at: string;
}

/**
 * The 3-table UNION column list. Each branch synthesizes `type` + projects the
 * absent lineage/scope columns as typed NULLs so the union shape is uniform. The
 * column ORDER is fixed and shared by every branch (SQLite unions positionally).
 */
const UNION_COLUMNS =
  'id, project_id, type, ref, title, summary, body, priority, repo, parent_epic_id, originating_idea_id, scope, board_id, stage_id, version, created_at, updated_at';

/** Build the full ideas+epics+tasks UNION subquery for a project, aliased `e`. */
function entityUnionSql(): string {
  return `
    SELECT id, project_id, 'idea' AS type, ref, title, summary, body, priority, repo,
           NULL AS parent_epic_id, NULL AS originating_idea_id, scope,
           board_id, stage_id, version, created_at, updated_at
      FROM ideas WHERE project_id = ?
    UNION ALL
    SELECT id, project_id, 'epic' AS type, ref, title, summary, body, priority, repo,
           NULL AS parent_epic_id, originating_idea_id, NULL AS scope,
           board_id, stage_id, version, created_at, updated_at
      FROM epics WHERE project_id = ?
    UNION ALL
    SELECT id, project_id, 'task' AS type, ref, title, summary, body, priority, repo,
           parent_epic_id, originating_idea_id, NULL AS scope,
           board_id, stage_id, version, created_at, updated_at
      FROM tasks WHERE project_id = ?`;
}

interface StageOverlayRow {
  is_terminal: number; // 0 | 1
  position: number;
}

interface RunOverlayRow {
  id: string;
  status: string;
  outcome: string | null;
  current_step_id: string | null;
  steps_snapshot_json: string | null;
}

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

/**
 * Return the boards for a project with their stages nested + ordered by
 * position. SQLite booleans (is_default / is_terminal / hidden_by_default) are
 * normalized to real booleans here so the inferred AppRouter shape matches the
 * shared Board/BoardStage types (number→boolean).
 *
 * @param db        - Narrow DatabaseLike interface (real or test).
 * @param projectId - The project whose boards to list.
 * @returns Board[] (one default board per project in Phase 0/1), stages ASC.
 */
export function boardsForProject(db: DatabaseLike, projectId: number): Board[] {
  const boardRows = db
    .prepare(
      `SELECT id, project_id, name, kind, is_default
         FROM boards
        WHERE project_id = ?
        ORDER BY is_default DESC, name ASC`,
    )
    .all(projectId) as BoardDbRow[];

  return boardRows.map((board): Board => {
    const stageRows = db
      .prepare(
        `SELECT id, board_id, label, color_oklch, hint, position,
                write_policy, is_terminal, hidden_by_default
           FROM board_stages
          WHERE board_id = ?
          ORDER BY position ASC`,
      )
      .all(board.id) as BoardStageDbRow[];

    const stages: BoardStage[] = stageRows.map((s): BoardStage => ({
      id: s.id,
      label: s.label,
      color_oklch: s.color_oklch,
      hint: s.hint,
      position: s.position,
      write_policy: s.write_policy,
      is_terminal: s.is_terminal === 1,
      hidden_by_default: s.hidden_by_default === 1,
    }));

    return {
      id: board.id,
      project_id: board.project_id,
      name: board.name,
      kind: board.kind,
      is_default: board.is_default === 1,
      stages,
    };
  });
}

// ---------------------------------------------------------------------------
// Per-task overlay derivation
// ---------------------------------------------------------------------------

/**
 * Resolve the agent label for a running run's current step from the launch
 * snapshot (steps_snapshot_json = { [stepId]: agent }). Falls back to the step
 * id, then a generic 'agent' label.
 *
 * Kept identical to TaskChangeRouter.resolveAgentLabel so the emitted-event
 * overlay and the list-side overlay never drift (foundation note #4).
 */
function resolveAgentLabel(run: RunOverlayRow): string {
  if (run.current_step_id && run.steps_snapshot_json) {
    try {
      const snapshot = JSON.parse(run.steps_snapshot_json) as Record<string, unknown>;
      const agent = snapshot[run.current_step_id];
      if (typeof agent === 'string' && agent.length > 0) return agent;
    } catch {
      // ignore malformed snapshot — fall through to defaults
    }
  }
  return run.current_step_id ?? 'agent';
}

/**
 * The derived overlay fields for a single task, computed on read.
 *
 *   inFlow         — one FlowOverlay per RUNNING run on the task (parallel runs
 *                    supported). Agent resolved via resolveAgentLabel.
 *   awaitingReview — any run is awaiting_review OR has outcome='pr_open', OR a
 *                    pending approval exists for any of the task's runs.
 *   isDone         — the task's current stage is terminal AND at position 9
 *                    ('done'). The other terminal stages (wont_do/archived) are
 *                    NOT "done".
 *
 * @param db   - Narrow DatabaseLike interface.
 * @param task - The base task row (needs id + stage_id).
 */
export function computeTaskOverlay(
  db: DatabaseLike,
  task: Pick<TaskDbRow, 'id' | 'stage_id'>,
): { inFlow: FlowOverlay[]; awaitingReview: boolean; isDone: boolean } {
  const stage = db
    .prepare('SELECT is_terminal, position FROM board_stages WHERE id = ?')
    .get(task.stage_id) as StageOverlayRow | undefined;
  const isDone = stage ? stage.is_terminal === 1 && stage.position === 9 : false;

  const runs = db
    .prepare(
      `SELECT id, status, outcome, current_step_id, steps_snapshot_json
         FROM workflow_runs WHERE task_id = ?`,
    )
    .all(task.id) as RunOverlayRow[];

  const inFlow: FlowOverlay[] = runs
    .filter((r) => r.status === 'running')
    .map((r) => ({
      agent: resolveAgentLabel(r),
      runId: r.id,
      stepId: r.current_step_id ?? null,
    }));

  const runIds = runs.map((r) => r.id);
  const awaitingReview =
    runs.some((r) => r.status === 'awaiting_review' || r.outcome === 'pr_open') ||
    hasPendingApprovals(db, runIds);

  return { inFlow, awaitingReview, isDone };
}

/** True if any of the given runs has a pending approval row. */
function hasPendingApprovals(db: DatabaseLike, runIds: string[]): boolean {
  if (runIds.length === 0) return false;
  const placeholders = runIds.map(() => '?').join(',');
  const row = db
    .prepare(`SELECT 1 FROM approvals WHERE status = 'pending' AND run_id IN (${placeholders}) LIMIT 1`)
    .get(...runIds) as { 1: number } | undefined;
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Backlog projection
// ---------------------------------------------------------------------------

/**
 * Project a base task row + its overlays into a BacklogTaskItem (children are
 * filled in by selectProjectBacklog's nesting pass, not here).
 */
function projectTaskItem(db: DatabaseLike, row: TaskDbRow): BacklogTaskItem {
  const { inFlow, awaitingReview, isDone } = computeTaskOverlay(db, row);
  return {
    id: row.id,
    project_id: row.project_id,
    type: row.type,
    ref: row.ref,
    title: row.title,
    summary: row.summary,
    body: row.body,
    priority: row.priority,
    repo: row.repo,
    parent_epic_id: row.parent_epic_id,
    originating_idea_id: row.originating_idea_id,
    scope: row.scope,
    board_id: row.board_id,
    stage_id: row.stage_id,
    version: row.version,
    inFlow,
    awaitingReview,
    isDone,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Project a SINGLE task by id into a BacklogTaskItem, including its overlays
 * and (when the task is an epic) its nested children + rollups. Returns null
 * when the task does not exist. Used by the cyboflow.tasks.get procedure.
 *
 * @param db     - Narrow DatabaseLike interface.
 * @param taskId - The task id to project.
 */
export function selectTaskById(db: DatabaseLike, taskId: string): BacklogTaskItem | null {
  // Try each table by id (table identity is the discriminator). Cheaper than a
  // full UNION when we only want one row.
  const row =
    (db.prepare(`SELECT ${UNION_COLUMNS} FROM (
       SELECT id, project_id, 'idea' AS type, ref, title, summary, body, priority, repo,
              NULL AS parent_epic_id, NULL AS originating_idea_id, scope,
              board_id, stage_id, version, created_at, updated_at FROM ideas WHERE id = ?
       UNION ALL
       SELECT id, project_id, 'epic' AS type, ref, title, summary, body, priority, repo,
              NULL AS parent_epic_id, originating_idea_id, NULL AS scope,
              board_id, stage_id, version, created_at, updated_at FROM epics WHERE id = ?
       UNION ALL
       SELECT id, project_id, 'task' AS type, ref, title, summary, body, priority, repo,
              parent_epic_id, originating_idea_id, NULL AS scope,
              board_id, stage_id, version, created_at, updated_at FROM tasks WHERE id = ?
     )`).get(taskId, taskId, taskId) as TaskDbRow | undefined);
  if (!row) return null;

  const item = projectTaskItem(db, row);

  if (row.type === 'epic') {
    // Children are always tasks (only `tasks` carries parent_epic_id).
    const childRows = db
      .prepare(
        `SELECT id, project_id, 'task' AS type, ref, title, summary, body, priority, repo,
                parent_epic_id, originating_idea_id, NULL AS scope,
                board_id, stage_id, version, created_at, updated_at
           FROM tasks
          WHERE parent_epic_id = ?
          ORDER BY created_at ASC, ref ASC`,
      )
      .all(taskId) as TaskDbRow[];
    const children = childRows.map((c) => projectTaskItem(db, c));
    item.children = children;
    item.childCount = children.length;
    item.pendingTasks = children.filter((c) => !c.isDone).length;
  }

  return item;
}

/**
 * Return the full backlog for a project as a nested tree:
 *   - Epics carry their child tasks under `children` (ASC by created_at), plus
 *     `childCount` and `pendingTasks` (children not yet done).
 *   - Tasks whose parent epic is in the same project are nested under that epic
 *     and NOT repeated at the top level.
 *   - Orphan tasks (no parent, or parent missing) + ideas + epics surface at the
 *     top level.
 *
 * Each item carries the on-read overlays (inFlow / awaitingReview / isDone).
 *
 * @param db        - Narrow DatabaseLike interface (real or test).
 * @param projectId - The project whose backlog to project.
 * @returns BacklogTaskItem[] — top-level items, epics nesting their tasks.
 */
export function selectProjectBacklog(db: DatabaseLike, projectId: number): BacklogTaskItem[] {
  // Single UNION across the three entity tables → one BacklogTaskItem[]. The
  // outer SELECT applies the shared ordering across the merged set.
  const rows = db
    .prepare(
      `SELECT ${UNION_COLUMNS} FROM (${entityUnionSql()})
        ORDER BY created_at ASC, ref ASC`,
    )
    .all(projectId, projectId, projectId) as TaskDbRow[];

  // First pass: project every row to a BacklogTaskItem keyed by id.
  const itemsById = new Map<string, BacklogTaskItem>();
  for (const row of rows) {
    itemsById.set(row.id, projectTaskItem(db, row));
  }

  // Second pass: nest child tasks under their parent epic; collect top level.
  const topLevel: BacklogTaskItem[] = [];
  for (const row of rows) {
    const item = itemsById.get(row.id);
    if (!item) continue; // unreachable — every row was inserted above
    const parentId = row.parent_epic_id;
    const parent = parentId ? itemsById.get(parentId) : undefined;
    if (parentId && parent && parent.type === 'epic') {
      (parent.children ??= []).push(item);
    } else {
      // No parent, parent missing, or parent isn't an epic in this project ->
      // surface at the top level so nothing is silently dropped.
      topLevel.push(item);
    }
  }

  // Third pass: compute epic rollups (childCount / pendingTasks). pendingTasks
  // counts children that are not yet done.
  for (const item of itemsById.values()) {
    if (item.type !== 'epic') continue;
    const children = item.children ?? [];
    item.childCount = children.length;
    item.pendingTasks = children.filter((c) => !c.isDone).length;
  }

  return topLevel;
}
