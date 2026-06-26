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
 * PROJECT SCOPE: both list queries take `projectId: number | null` — null means
 * ALL projects in one flat list (the cross-project "overall" board view); a
 * number scopes to that project as before. The union's WHERE project_id = ?
 * clauses are emitted only when scoped, so the positional bind count always
 * matches the SQL.
 *
 * ARCHIVE-IN-PLACE (migration 024): every entity row carries `archived_at`
 * (NULL = active) and archived rows are ALWAYS returned — visibility is a
 * client concern (the Archived header toggle). The outer queries LEFT JOIN
 * board_stages to project `stage_position` (COALESCE(bs.position, 0)), the
 * cross-project bucketing key for the unified stage columns.
 *
 *  - boardsForProject(db, projectId)  -> Board[]            (board + ordered stages; null = all projects)
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
  IdeaAttachment,
  TaskDependencyRef,
} from '../../../shared/types/tasks';
import { resolveStepAgentKey } from '../../../shared/types/agentIdentity';
import type { DatabaseLike } from './types';

/** The board stage position considered "done" — a blocking prereq is satisfied here. */
const DONE_POSITION = 9;

/**
 * Read the image attachments (migration 028) for a single idea. Attachments are
 * an ideas-only concern kept OUT of the BacklogTaskItem UNION read model (they
 * are only needed when the idea editor opens), so the editor fetches them on
 * demand via tasks.getAttachments → here. Returns [] for a missing idea, a NULL
 * column, or unparseable JSON (defensive — never throws on bad stored data).
 */
export function selectIdeaAttachments(db: DatabaseLike, ideaId: string): IdeaAttachment[] {
  const row = db
    .prepare('SELECT attachments FROM ideas WHERE id = ?')
    .get(ideaId) as { attachments: string | null } | undefined;
  if (!row || !row.attachments) return [];
  try {
    const parsed: unknown = JSON.parse(row.attachments);
    return Array.isArray(parsed) ? (parsed as IdeaAttachment[]) : [];
  } catch {
    return [];
  }
}

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
 * are projected as NULL so every branch is shape-identical. `stage_position` is
 * NOT a union column — the outer query projects it via LEFT JOIN board_stages.
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
  archived_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  /** Projected by the outer LEFT JOIN onto board_stages; 0 when the stage row is missing. */
  stage_position: number;
}

/**
 * The 3-table UNION column list. Each branch synthesizes `type` + projects the
 * absent lineage/scope columns as typed NULLs so the union shape is uniform. The
 * column ORDER is fixed and shared by every branch (SQLite unions positionally).
 */
const UNION_COLUMNS =
  'id, project_id, type, ref, title, summary, body, priority, repo, parent_epic_id, originating_idea_id, scope, board_id, stage_id, archived_at, version, created_at, updated_at';

/**
 * UNION_COLUMNS prefixed with a subquery alias for joined outer SELECTs — the
 * LEFT JOIN onto board_stages would otherwise make id/board_id ambiguous.
 */
function aliasedUnionColumns(alias: string): string {
  return UNION_COLUMNS.split(', ')
    .map((column) => `${alias}.${column}`)
    .join(', ');
}

/** The per-branch filters entityUnionSql can emit ('' = unscoped, all projects). */
type EntityUnionFilter = '' | 'WHERE project_id = ?' | 'WHERE id = ?';

/**
 * Build the full ideas+epics+tasks UNION subquery. The same `filter` is applied
 * to every branch, so callers bind the SAME value three times for the
 * parameterized filters and nothing for '' (positional bind discipline — the
 * bind count must match the emitted SQL).
 */
function entityUnionSql(filter: EntityUnionFilter): string {
  const where = filter === '' ? '' : ` ${filter}`;
  return `
    SELECT id, project_id, 'idea' AS type, ref, title, summary, body, priority, repo,
           NULL AS parent_epic_id, NULL AS originating_idea_id, scope,
           board_id, stage_id, archived_at, version, created_at, updated_at
      FROM ideas${where}
    UNION ALL
    SELECT id, project_id, 'epic' AS type, ref, title, summary, body, priority, repo,
           NULL AS parent_epic_id, originating_idea_id, NULL AS scope,
           board_id, stage_id, archived_at, version, created_at, updated_at
      FROM epics${where}
    UNION ALL
    SELECT id, project_id, 'task' AS type, ref, title, summary, body, priority, repo,
           parent_epic_id, originating_idea_id, NULL AS scope,
           board_id, stage_id, archived_at, version, created_at, updated_at
      FROM tasks${where}`;
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
 * @param projectId - The project whose boards to list, or null for EVERY
 *                    project's boards (ordered project_id ASC, is_default DESC,
 *                    name ASC — the all-projects board view).
 * @returns Board[] (one default board per project in Phase 0/1), stages ASC.
 */
export function boardsForProject(db: DatabaseLike, projectId: number | null): Board[] {
  const boardRows = (
    projectId === null
      ? db
          .prepare(
            `SELECT id, project_id, name, kind, is_default
               FROM boards
              ORDER BY project_id ASC, is_default DESC, name ASC`,
          )
          .all()
      : db
          .prepare(
            `SELECT id, project_id, name, kind, is_default
               FROM boards
              WHERE project_id = ?
              ORDER BY is_default DESC, name ASC`,
          )
          .all(projectId)
  ) as BoardDbRow[];

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
      if (typeof agent === 'string' && agent.length > 0) return resolveStepAgentKey(run.current_step_id, agent) ?? agent;
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
 *                    ('done'). The other terminal stages (wont_do/decomposed)
 *                    are NOT "done".
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
// Dependency-edge overlay (task_dependencies, migration 015)
// ---------------------------------------------------------------------------

/** One row of the dependency JOIN: the OTHER endpoint's identity + done-state. */
interface DependencyEdgeRow {
  task_id: string;
  depends_on_task_id: string;
  kind: 'blocking' | 'related';
  /** The prerequisite's ref/title, denormalized for display. */
  dep_ref: string;
  dep_title: string;
  /** The prerequisite's stage position (null when the stage row is missing). */
  dep_position: number | null;
}

/**
 * The dependency overlay computed for ONE task: its blocking prerequisites, its
 * related peers, and whether it is ready to work (no blocking deps OR all
 * blocking deps at the Done position).
 */
export interface DependencyOverlay {
  blockedBy: TaskDependencyRef[];
  relatedTo: TaskDependencyRef[];
  readyToWork: boolean;
}

/**
 * Build a `taskId -> DependencyOverlay` map for an ENTIRE project in ONE query.
 *
 * Each `task_dependencies` row is LEFT JOINed to the prerequisite task (for
 * ref/title) and its board stage (for the position used by the readyToWork
 * predicate). A task with no rows is absent from the map; callers default it to
 * `{ blockedBy: [], relatedTo: [], readyToWork: true }` (no blockers ⇒ ready).
 *
 * @param db        - Narrow DatabaseLike interface.
 * @param projectId - Project whose tasks' dependency edges to load, or null to
 *                    load edges across ALL projects (the all-projects board).
 */
function loadProjectDependencyOverlays(
  db: DatabaseLike,
  projectId: number | null,
): Map<string, DependencyOverlay> {
  const scoped = projectId !== null;
  const stmt = db.prepare(
    `SELECT d.task_id, d.depends_on_task_id, d.kind,
            dep.ref   AS dep_ref,
            dep.title AS dep_title,
            s.position AS dep_position
       FROM task_dependencies d
       JOIN tasks t   ON t.id = d.task_id
       JOIN tasks dep ON dep.id = d.depends_on_task_id
       LEFT JOIN board_stages s ON s.id = dep.stage_id
      ${scoped ? 'WHERE t.project_id = ?' : ''}`,
  );
  const rows = (scoped ? stmt.all(projectId) : stmt.all()) as DependencyEdgeRow[];

  return foldDependencyRows(rows);
}

/**
 * Load the dependency overlay for a SINGLE task id (used by selectTaskById,
 * which projects one row without a full project scan).
 */
function loadTaskDependencyOverlay(db: DatabaseLike, taskId: string): DependencyOverlay {
  const rows = db
    .prepare(
      `SELECT d.task_id, d.depends_on_task_id, d.kind,
              dep.ref   AS dep_ref,
              dep.title AS dep_title,
              s.position AS dep_position
         FROM task_dependencies d
         JOIN tasks dep ON dep.id = d.depends_on_task_id
         LEFT JOIN board_stages s ON s.id = dep.stage_id
        WHERE d.task_id = ?`,
    )
    .all(taskId) as DependencyEdgeRow[];

  return foldDependencyRows(rows).get(taskId) ?? { blockedBy: [], relatedTo: [], readyToWork: true };
}

/**
 * Fold dependency-edge rows into a per-blocked-task overlay map. readyToWork is
 * true when a task has NO blocking edges, or EVERY blocking prerequisite sits at
 * the Done position (9). `related` edges are advisory and never gate readiness.
 */
function foldDependencyRows(rows: DependencyEdgeRow[]): Map<string, DependencyOverlay> {
  const byTask = new Map<string, DependencyOverlay>();
  for (const r of rows) {
    let overlay = byTask.get(r.task_id);
    if (!overlay) {
      overlay = { blockedBy: [], relatedTo: [], readyToWork: true };
      byTask.set(r.task_id, overlay);
    }
    const ref: TaskDependencyRef = {
      taskId: r.depends_on_task_id,
      ref: r.dep_ref,
      title: r.dep_title,
    };
    if (r.kind === 'blocking') {
      overlay.blockedBy.push(ref);
      // A blocking prereq not yet at the Done position keeps the task blocked.
      if (r.dep_position !== DONE_POSITION) {
        overlay.readyToWork = false;
      }
    } else {
      overlay.relatedTo.push(ref);
    }
  }
  return byTask;
}

/** Attach a dependency overlay to a projected item (no-op fields kept stable). */
function applyDependencyOverlay(item: BacklogTaskItem, overlay: DependencyOverlay): void {
  item.blockedBy = overlay.blockedBy;
  item.relatedTo = overlay.relatedTo;
  item.readyToWork = overlay.readyToWork;
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
    archived_at: row.archived_at,
    version: row.version,
    stage_position: row.stage_position,
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
  // full table scan when we only want one row.
  const row =
    (db.prepare(`SELECT ${aliasedUnionColumns('e')}, COALESCE(bs.position, 0) AS stage_position
       FROM (${entityUnionSql('WHERE id = ?')}) e
       LEFT JOIN board_stages bs ON bs.id = e.stage_id`)
      .get(taskId, taskId, taskId) as TaskDbRow | undefined);
  if (!row) return null;

  const item = projectTaskItem(db, row);

  if (row.type === 'task') {
    applyDependencyOverlay(item, loadTaskDependencyOverlay(db, row.id));
  }

  if (row.type === 'epic') {
    // Children are always tasks (only `tasks` carries parent_epic_id).
    const childRows = db
      .prepare(
        `SELECT t.id, t.project_id, 'task' AS type, t.ref, t.title, t.summary, t.body, t.priority, t.repo,
                t.parent_epic_id, t.originating_idea_id, NULL AS scope,
                t.board_id, t.stage_id, t.archived_at, t.version, t.created_at, t.updated_at,
                COALESCE(bs.position, 0) AS stage_position
           FROM tasks t
           LEFT JOIN board_stages bs ON bs.id = t.stage_id
          WHERE t.parent_epic_id = ?
          ORDER BY t.created_at ASC, t.ref ASC`,
      )
      .all(taskId) as TaskDbRow[];
    const children = childRows.map((c) => {
      const childItem = projectTaskItem(db, c);
      applyDependencyOverlay(childItem, loadTaskDependencyOverlay(db, c.id));
      return childItem;
    });
    item.children = children;
    item.childCount = children.length;
    item.pendingTasks = children.filter((c) => !c.isDone).length;
  }

  return item;
}

/**
 * Project an IDEA together with its decomposition tree — the idea as the root,
 * its epics nested under `children` (WHERE epics.originating_idea_id = ideaId),
 * and each epic's tasks nested under THAT epic's `children` (WHERE
 * tasks.parent_epic_id = epic.id). Returns null when the id is not an idea.
 *
 * This is the dedicated read behind the `decomposed-stories` artifact tab.
 * `selectTaskById` only nests children for an EPIC (via parent_epic_id) and has
 * NO idea→epics branch, so passing an idea id there yields children===undefined
 * and the renderer falls to its empty state even for a fully-decomposed idea.
 * This resolver fills that gap WITHOUT changing selectTaskById's semantics for
 * other tasks.get consumers.
 *
 * Shape contract: the returned item is a BacklogTaskItem whose `children` are
 * the idea's epics (each `epic.children = tasks[]`) FOLLOWED BY any tasks
 * decomposed directly under the idea with no epic (a small-idea decomposition).
 * DecomposedStoriesBody splits idea.children by type — epic-type get cards,
 * task-type render in a direct-task grid. Epics + tasks carry the same on-read
 * overlays + rollups as selectTaskById.
 *
 * @param db     - Narrow DatabaseLike interface.
 * @param ideaId - The originating idea id whose decomposition to project.
 */
export function selectIdeaDecomposition(db: DatabaseLike, ideaId: string): BacklogTaskItem | null {
  // The root MUST be an idea — ideas are the only entities epics link to via
  // originating_idea_id, and the artifact's sourceRef is always an idea id.
  const ideaRow = db
    .prepare(
      `SELECT ${aliasedUnionColumns('e')}, COALESCE(bs.position, 0) AS stage_position
         FROM (
           SELECT id, project_id, 'idea' AS type, ref, title, summary, body, priority, repo,
                  NULL AS parent_epic_id, NULL AS originating_idea_id, scope,
                  board_id, stage_id, archived_at, version, created_at, updated_at
             FROM ideas WHERE id = ?
         ) e
         LEFT JOIN board_stages bs ON bs.id = e.stage_id`,
    )
    .get(ideaId) as TaskDbRow | undefined;
  if (!ideaRow) return null;

  const idea = projectTaskItem(db, ideaRow);

  // Epics decomposed from this idea (ASC by created_at, ref tiebreak).
  const epicRows = db
    .prepare(
      `SELECT e.id, e.project_id, 'epic' AS type, e.ref, e.title, e.summary, e.body, e.priority, e.repo,
              NULL AS parent_epic_id, e.originating_idea_id, NULL AS scope,
              e.board_id, e.stage_id, e.archived_at, e.version, e.created_at, e.updated_at,
              COALESCE(bs.position, 0) AS stage_position
         FROM epics e
         LEFT JOIN board_stages bs ON bs.id = e.stage_id
        WHERE e.originating_idea_id = ?
        ORDER BY e.created_at ASC, e.ref ASC`,
    )
    .all(ideaId) as TaskDbRow[];

  const epics = epicRows.map((epicRow) => {
    const epic = projectTaskItem(db, epicRow);

    // Tasks under this epic (lineage via parent_epic_id), same ordering as
    // selectTaskById's epic-children pass.
    const taskRows = db
      .prepare(
        `SELECT t.id, t.project_id, 'task' AS type, t.ref, t.title, t.summary, t.body, t.priority, t.repo,
                t.parent_epic_id, t.originating_idea_id, NULL AS scope,
                t.board_id, t.stage_id, t.archived_at, t.version, t.created_at, t.updated_at,
                COALESCE(bs.position, 0) AS stage_position
           FROM tasks t
           LEFT JOIN board_stages bs ON bs.id = t.stage_id
          WHERE t.parent_epic_id = ?
          ORDER BY t.created_at ASC, t.ref ASC`,
      )
      .all(epicRow.id) as TaskDbRow[];

    const tasks = taskRows.map((taskRow) => {
      const taskItem = projectTaskItem(db, taskRow);
      applyDependencyOverlay(taskItem, loadTaskDependencyOverlay(db, taskRow.id));
      return taskItem;
    });

    epic.children = tasks;
    epic.childCount = tasks.length;
    epic.pendingTasks = tasks.filter((t) => !t.isDone).length;
    return epic;
  });

  // Tasks decomposed DIRECTLY under the idea (no epic) — a SMALL idea's planner
  // decomposition creates tasks with originating_idea_id set and parent_epic_id
  // NULL (the planner skips the epic layer). Without surfacing these, the
  // decomposed-stories artifact renders "not decomposed yet" for a small idea.
  // They are appended to idea.children as task-type items; the renderer splits
  // idea.children by type (epics get cards, direct tasks get a task grid).
  const directTaskRows = db
    .prepare(
      `SELECT t.id, t.project_id, 'task' AS type, t.ref, t.title, t.summary, t.body, t.priority, t.repo,
              t.parent_epic_id, t.originating_idea_id, NULL AS scope,
              t.board_id, t.stage_id, t.archived_at, t.version, t.created_at, t.updated_at,
              COALESCE(bs.position, 0) AS stage_position
         FROM tasks t
         LEFT JOIN board_stages bs ON bs.id = t.stage_id
        WHERE t.originating_idea_id = ? AND t.parent_epic_id IS NULL
        ORDER BY t.created_at ASC, t.ref ASC`,
    )
    .all(ideaId) as TaskDbRow[];

  const directTasks = directTaskRows.map((taskRow) => {
    const taskItem = projectTaskItem(db, taskRow);
    applyDependencyOverlay(taskItem, loadTaskDependencyOverlay(db, taskRow.id));
    return taskItem;
  });

  idea.children = [...epics, ...directTasks];
  idea.childCount = epics.length + directTasks.length;
  idea.pendingTasks =
    epics.filter((e) => !e.isDone).length + directTasks.filter((t) => !t.isDone).length;
  return idea;
}

/**
 * Return the full backlog as a nested tree:
 *   - Epics carry their child tasks under `children` (ASC by created_at), plus
 *     `childCount` and `pendingTasks` (children not yet done).
 *   - Tasks whose parent epic is in the result set are nested under that epic
 *     and NOT repeated at the top level.
 *   - Orphan tasks (no parent, or parent missing) + ideas + epics surface at the
 *     top level.
 *
 * Each item carries the on-read overlays (inFlow / awaitingReview / isDone) plus
 * `stage_position` (LEFT JOIN board_stages). Archived rows (`archived_at` set)
 * are ALWAYS included — visibility is a client concern.
 *
 * @param db        - Narrow DatabaseLike interface (real or test).
 * @param projectId - The project whose backlog to project, or null for ALL
 *                    projects merged into one list (the overall board view).
 * @returns BacklogTaskItem[] — top-level items, epics nesting their tasks.
 */
export function selectProjectBacklog(db: DatabaseLike, projectId: number | null): BacklogTaskItem[] {
  // Single UNION across the three entity tables → one BacklogTaskItem[]. The
  // outer SELECT joins the stage position and applies the shared ordering
  // across the merged set. The per-branch project filter is emitted only when
  // scoped, so the bind count always matches the SQL.
  const scoped = projectId !== null;
  const stmt = db.prepare(
    `SELECT ${aliasedUnionColumns('e')}, COALESCE(bs.position, 0) AS stage_position
       FROM (${entityUnionSql(scoped ? 'WHERE project_id = ?' : '')}) e
       LEFT JOIN board_stages bs ON bs.id = e.stage_id
      ORDER BY e.created_at ASC, e.ref ASC`,
  );
  const rows = (scoped ? stmt.all(projectId, projectId, projectId) : stmt.all()) as TaskDbRow[];

  // Dependency edges are task-only — load the whole project's overlays in ONE
  // query and map them onto each task item as we project.
  const depOverlays = loadProjectDependencyOverlays(db, projectId);

  // First pass: project every row to a BacklogTaskItem keyed by id.
  const itemsById = new Map<string, BacklogTaskItem>();
  for (const row of rows) {
    const item = projectTaskItem(db, row);
    if (row.type === 'task') {
      applyDependencyOverlay(
        item,
        depOverlays.get(row.id) ?? { blockedBy: [], relatedTo: [], readyToWork: true },
      );
    }
    itemsById.set(row.id, item);
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
      // No parent, parent missing, or parent isn't an epic in the result set ->
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
