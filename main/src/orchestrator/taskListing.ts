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
 *   inFlow         = one entry per NON-TERMINAL run (status NOT IN completed/
 *                    failed/canceled) associated with the task either DIRECTLY
 *                    (workflow_runs.task_id) or via a sprint-BATCH lane
 *                    (workflow_runs.batch_id joined through sprint_batch_tasks —
 *                    migration 066's derived 'In development' stage tracks the
 *                    same association); agent resolved from
 *                    steps_snapshot_json[current_step_id], else current_step_id,
 *                    else 'agent'; sessionId/sessionName LEFT JOINed from the
 *                    run's `sessions` row. Both the batch arm and the session
 *                    join degrade gracefully on an old schema (columnExists).
 *   awaitingReview = any run status='awaiting_review' OR outcome='pr_open' OR a
 *                    pending approval exists for any of the task's runs.
 *   isDone         = the task's stage is_terminal && position === 9 ('done').
 *
 * Standalone-typecheck invariant: NO imports from 'electron', 'better-sqlite3',
 * or main/src/services/*. Only narrow interfaces and shared types.
 */
import type {
  BacklogMembership,
  BacklogTaskItem,
  Board,
  BoardStage,
  EntityCategory,
  FlowOverlay,
  IdeaAttachment,
  TaskDependencyRef,
  TaskExecutor,
} from '../../../shared/types/tasks';
import type { IdeaComponentState } from '../../../shared/types/ideaComponents';
import type { SprintBatchStatus } from '../../../shared/types/sprintBatch';
import type { ExperimentStatus } from '../../../shared/types/experiments';
import { isBaselineArm, isQuickArm } from '../../../shared/types/experiments';
import { resolveStepAgentKey } from '../../../shared/types/agentIdentity';
import { listRunOwnedOrBatchIdeaIds } from './runEntityOwnership';
import { TERMINAL_RUN_STATUSES } from '../../../shared/types/cyboflow';
import { resolveIdeaComponents, resolveIdeaComponentsBatch } from './ideaComponents/resolveIdeaComponents';
import type { DatabaseLike } from './types';

/** The board stage position considered "done" — a blocking prereq is satisfied here. */
const DONE_POSITION = 9;

/** Run statuses with no live association — mirrors TaskChangeRouter's TERMINAL_RUN_STATUS_SET. */
const TERMINAL_RUN_STATUS_SET = new Set<string>(TERMINAL_RUN_STATUSES);

/**
 * WeakMap-cached `PRAGMA table_info` probe, keyed per db instance (this file
 * has no class to hold instance state, unlike TaskChangeRouter.columnExists,
 * which this mirrors). Lets computeTaskOverlay run once-per-row without
 * re-querying the schema every time. Fail-soft: a PRAGMA error reads back
 * absent, degrading to the pre-migration behaviour.
 */
const columnExistsCache = new WeakMap<DatabaseLike, Map<string, boolean>>();

function columnExists(db: DatabaseLike, table: string, column: string): boolean {
  let cache = columnExistsCache.get(db);
  if (!cache) {
    cache = new Map();
    columnExistsCache.set(db, cache);
  }
  const key = `${table}.${column}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let present = false;
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
    present = rows.some((r) => r.name === column);
  } catch {
    present = false;
  }
  cache.set(key, present);
  return present;
}

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
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6'; // migration 117 widen
  /** Entity classification (migration 059); NOT NULL DEFAULT 'feature' on every table. */
  category: EntityCategory;
  repo: string | null;
  parent_epic_id: string | null;
  originating_idea_id: string | null;
  scope: 'small' | 'large' | null;
  /** WHO performs the work (137, tasks-only); the ideas/epics branches project 'agent'. */
  executor: TaskExecutor;
  board_id: string;
  stage_id: string;
  archived_at: string | null;
  /** IDEA-only decompose stamp (042); projected as NULL on the epics/tasks branches. */
  decomposed_at: string | null;
  /** EPIC/TASK approval stamp (042); projected as NULL on the ideas branch. */
  approved_at: string | null;
  /** A/B experiment sandbox tag (049); non-null rows are hidden by default in selectProjectBacklog. */
  experiment_id: string | null;
  /** User-controlled manual rank (057); NULL = unranked (legacy created_at/ref order). */
  sort_order: number | null;
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
  'id, project_id, type, ref, title, summary, body, priority, category, repo, parent_epic_id, originating_idea_id, scope, executor, board_id, stage_id, archived_at, decomposed_at, approved_at, experiment_id, sort_order, version, created_at, updated_at';

/**
 * UNION_COLUMNS prefixed with a subquery alias for joined outer SELECTs — the
 * LEFT JOIN onto board_stages would otherwise make id/board_id ambiguous.
 */
function aliasedUnionColumns(alias: string): string {
  return UNION_COLUMNS.split(', ')
    .map((column) => `${alias}.${column}`)
    .join(', ');
}

/**
 * The `executor` projection for a TASK branch (migration 137), fail-soft on a
 * pre-137 schema: the literal keeps every task 'agent', which is exactly the
 * pre-137 reading. Ideas/epics have no such column at all and always project
 * the literal — the union is positional, so every branch must emit the slot.
 */
function taskExecutorColumn(db: DatabaseLike, alias: string): string {
  return columnExists(db, 'tasks', 'executor') ? `${alias}executor` : "'agent' AS executor";
}

/** The per-branch filters entityUnionSql can emit ('' = unscoped, all projects). */
type EntityUnionFilter = '' | 'WHERE project_id = ?' | 'WHERE id = ?';

/**
 * Build the full ideas+epics+tasks UNION subquery. The same `filter` is applied
 * to every branch, so callers bind the SAME value three times for the
 * parameterized filters and nothing for '' (positional bind discipline — the
 * bind count must match the emitted SQL).
 */
function entityUnionSql(filter: EntityUnionFilter, hasExecutor: boolean): string {
  const where = filter === '' ? '' : ` ${filter}`;
  const taskExecutor = hasExecutor ? 'executor' : "'agent' AS executor";
  return `
    SELECT id, project_id, 'idea' AS type, ref, title, summary, body, priority, category, repo,
           NULL AS parent_epic_id, NULL AS originating_idea_id, scope, 'agent' AS executor,
           board_id, stage_id, archived_at, decomposed_at, NULL AS approved_at, experiment_id, sort_order, version, created_at, updated_at
      FROM ideas${where}
    UNION ALL
    SELECT id, project_id, 'epic' AS type, ref, title, summary, body, priority, category, repo,
           NULL AS parent_epic_id, originating_idea_id, NULL AS scope, 'agent' AS executor,
           board_id, stage_id, archived_at, NULL AS decomposed_at, approved_at, experiment_id, sort_order, version, created_at, updated_at
      FROM epics${where}
    UNION ALL
    SELECT id, project_id, 'task' AS type, ref, title, summary, body, priority, category, repo,
           parent_epic_id, originating_idea_id, NULL AS scope, ${taskExecutor},
           board_id, stage_id, archived_at, NULL AS decomposed_at, approved_at, experiment_id, sort_order, version, created_at, updated_at
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
  /** `workflow_runs.session_id`; null when the column is absent (old schema) or unset. */
  session_id: string | null;
  /** `sessions.name` via LEFT JOIN; null when the sessions table/join is unavailable or the row is gone. */
  session_name: string | null;
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
 * Idea sibling of {@link gatherTaskRunOverlayRows}'s task/epic arm (TASK-224):
 * an idea is never linked via `workflow_runs.task_id`/`batch_id` — a live
 * Planner/Ship run instead records the idea it was SEEDED with via
 * `seed_idea_id` (migration 017, single-idea) or `seed_idea_ids` (migration
 * 061, JSON array — multi-idea planner batches). Both are soft links (no FK,
 * no cascading delete), so a run seeded from a since-deleted idea simply
 * matches nothing here.
 *
 * Guarded per-column via columnExists so a pre-017 schema (neither column)
 * returns [] and a pre-061 schema (seed_idea_id only) falls back to the
 * single-idea arm alone. `json_valid()` guards the `json_each` arm against a
 * malformed/non-array stored value throwing 'malformed JSON' and taking the
 * whole board query down with it.
 */
function gatherIdeaRunOverlayRows(
  db: DatabaseLike,
  ideaId: string,
  sessionSelect: string,
  sessionJoin: string,
): RunOverlayRow[] {
  const hasSeedIdeaId = columnExists(db, 'workflow_runs', 'seed_idea_id');
  const hasSeedIdeaIds = columnExists(db, 'workflow_runs', 'seed_idea_ids');
  if (!hasSeedIdeaId && !hasSeedIdeaIds) return [];

  const clauses: string[] = [];
  const params: string[] = [];
  if (hasSeedIdeaId) {
    clauses.push('wr.seed_idea_id = ?');
    params.push(ideaId);
  }
  if (hasSeedIdeaIds) {
    clauses.push(
      'wr.seed_idea_ids IS NOT NULL AND json_valid(wr.seed_idea_ids) AND EXISTS (SELECT 1 FROM json_each(wr.seed_idea_ids) je WHERE je.value = ?)',
    );
    params.push(ideaId);
  }
  const whereClause = clauses.map((c) => `(${c})`).join(' OR ');

  return db
    .prepare(
      `SELECT DISTINCT wr.id, wr.status, wr.outcome, wr.current_step_id, wr.steps_snapshot_json, ${sessionSelect}
         FROM workflow_runs wr
         ${sessionJoin}
        WHERE ${whereClause}`,
    )
    .all(...params) as RunOverlayRow[];
}

/**
 * Gather the overlay rows for a task's OWN direct runs AND any sprint-batch
 * runs whose lane names it (migration 066's derived 'In development' stage
 * tracks the SAME association — see TaskChangeRouter.gatherTaskRuns). LEFT
 * JOINs `sessions` to project the hosting session's name. DISTINCT on the row
 * dedupes a run that happens to match both arms (every non-id column is
 * functionally dependent on wr.id, so DISTINCT-the-row == DISTINCT-by-id).
 *
 * Both the batch arm and the session join are gated behind columnExists so a
 * pre-022 (no sprint_batch_tasks/batch_id) or pre-019 (no session_id) schema
 * degrades gracefully — batch runs are simply excluded / session fields read
 * back null — instead of throwing 'no such column/table'.
 *
 * `entityType === 'idea'` delegates to {@link gatherIdeaRunOverlayRows} instead
 * (TASK-224) — an idea has no task_id/batch_id association at all.
 */
function gatherTaskRunOverlayRows(
  db: DatabaseLike,
  taskId: string,
  entityType?: TaskDbRow['type'],
): RunOverlayRow[] {
  // The `sessions` table is legacy (schema.sql, not a numbered migration) —
  // some partial-migration test DBs add workflow_runs.session_id (migration
  // 019) WITHOUT ever creating it, so the column check alone is not enough;
  // PRAGMA table_info on a MISSING table returns zero rows (no error), so this
  // doubles as a table-existence probe.
  const hasSession =
    columnExists(db, 'workflow_runs', 'session_id') && columnExists(db, 'sessions', 'name');
  const sessionSelect = hasSession
    ? 'wr.session_id AS session_id, s.name AS session_name'
    : 'NULL AS session_id, NULL AS session_name';
  const sessionJoin = hasSession ? 'LEFT JOIN sessions s ON s.id = wr.session_id' : '';

  if (entityType === 'idea') {
    return gatherIdeaRunOverlayRows(db, taskId, sessionSelect, sessionJoin);
  }

  const hasBatch = columnExists(db, 'workflow_runs', 'batch_id');
  const whereClause = hasBatch
    ? 'wr.task_id = ? OR wr.batch_id IN (SELECT batch_id FROM sprint_batch_tasks WHERE task_id = ?)'
    : 'wr.task_id = ?';
  const params = hasBatch ? [taskId, taskId] : [taskId];

  return db
    .prepare(
      `SELECT DISTINCT wr.id, wr.status, wr.outcome, wr.current_step_id, wr.steps_snapshot_json, ${sessionSelect}
         FROM workflow_runs wr
         ${sessionJoin}
        WHERE ${whereClause}`,
    )
    .all(...params) as RunOverlayRow[];
}

/**
 * The derived overlay fields for a single task, computed on read.
 *
 *   inFlow         — one FlowOverlay per NON-TERMINAL run associated with the
 *                    task (direct task-link OR sprint-batch lane; parallel runs
 *                    supported). Agent resolved via resolveAgentLabel; session
 *                    identity via gatherTaskRunOverlayRows' LEFT JOIN.
 *   awaitingReview — any run is awaiting_review OR has outcome='pr_open', OR a
 *                    pending approval exists for any of the task's runs.
 *   isDone         — the task's current stage is terminal AND at position 9
 *                    ('done'). The other terminal stages (wont_do/decomposed)
 *                    are NOT "done".
 *
 * @param db   - Narrow DatabaseLike interface.
 * @param task - The base task row (needs id + stage_id; `type` is optional and
 *               defaults to the task/epic association arm — pass `'idea'` so a
 *               live Planner/Ship run seeded with this idea (`seed_idea_id` /
 *               `seed_idea_ids`, TASK-224) is picked up instead).
 */
export function computeTaskOverlay(
  db: DatabaseLike,
  task: Pick<TaskDbRow, 'id' | 'stage_id'> & Partial<Pick<TaskDbRow, 'type'>>,
): { inFlow: FlowOverlay[]; awaitingReview: boolean; isDone: boolean; experimentSeed: boolean } {
  const stage = db
    .prepare('SELECT is_terminal, position FROM board_stages WHERE id = ?')
    .get(task.stage_id) as StageOverlayRow | undefined;
  const isDone = stage ? stage.is_terminal === 1 && stage.position === 9 : false;

  const runs = gatherTaskRunOverlayRows(db, task.id, task.type);

  const inFlow: FlowOverlay[] = runs
    .filter((r) => !TERMINAL_RUN_STATUS_SET.has(r.status))
    .map((r) => ({
      agent: resolveAgentLabel(r),
      runId: r.id,
      stepId: r.current_step_id ?? null,
      runStatus: r.status,
      sessionId: r.session_id,
      sessionName: r.session_name,
    }));

  const runIds = runs.map((r) => r.id);
  const awaitingReview =
    runs.some((r) => r.status === 'awaiting_review' || r.outcome === 'pr_open') ||
    hasPendingApprovals(db, runIds);

  return { inFlow, awaitingReview, isDone, experimentSeed: isLiveExperimentSeed(db, task.id) };
}

/**
 * True when `taskId` is the ORIGINAL seed of a LIVE (non-settled) A/B experiment —
 * its per-arm clones carry the runs (and are hidden by their experiment tag), so
 * the original itself has none, yet the deriver holds it at "In development"
 * (position 7) while the experiment runs (C2). Drives the "In experiment" card
 * badge. Mirrors the deriver's predicate in TaskChangeRouter.isLiveExperimentSeed;
 * degrades PERMISSIVELY (false) on a pre-051/pre-049 schema lacking the tables.
 */
function isLiveExperimentSeed(db: DatabaseLike, taskId: string): boolean {
  try {
    const row = db
      .prepare(
        `SELECT 1 FROM experiment_seed_tasks est
           JOIN experiments e ON e.id = est.experiment_id
          WHERE est.original_task_id = ?
            AND e.status NOT IN ('decided', 'abandoned', 'superseded')
          LIMIT 1`,
      )
      .get(taskId);
    return row !== undefined;
  } catch (err) {
    if (err instanceof Error && /no such (column|table)/i.test(err.message)) return false;
    throw err;
  }
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
// Membership overlay (sprint-batch + experiment, IDEA-053 / TASK-202)
// ---------------------------------------------------------------------------

/** Generic `id -> value` bulk lookup — used for the small denormalization joins below. */
/**
 * Generic `id -> value` bulk lookup.
 *
 * TRUST BOUNDARY: `table` / `idColumn` / `valueColumn` are INTERPOLATED into the
 * SQL (SQLite cannot bind identifiers), so every call site MUST pass a hardcoded
 * schema literal — they all do today. `ids` is the only caller-derived input and
 * it is bound through `?` placeholders. Never route a user/agent-supplied string
 * into the first three parameters.
 */
function fetchColumnMap(
  db: DatabaseLike,
  table: string,
  idColumn: string,
  valueColumn: string,
  ids: readonly string[],
): Map<string, string> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT ${idColumn} AS id, ${valueColumn} AS value FROM ${table} WHERE ${idColumn} IN (${placeholders})`,
    )
    .all(...ids) as Array<{ id: string; value: string | null }>;
  for (const r of rows) {
    if (typeof r.value === 'string') map.set(r.id, r.value);
  }
  return map;
}

interface SprintMembershipRow {
  task_id: string;
  batch_id: string;
  status: SprintBatchStatus;
}

/**
 * Sprint label: trimmed hosting `sessions.name` for the batch-owning run, else
 * trimmed `workflows.name`, else 'Sprint', suffixed with the batch id's first 8
 * hex chars (the fixed suffix that disambiguates duplicate session/workflow
 * names — see IDEA-053). The "batch-owning run" is the MOST RECENT
 * `workflow_runs` row stamped with this batch's id (the single-run lane
 * model stamps exactly one at batch creation; a rewind/restart could in
 * principle stamp another, so MAX(created_at, id) picks a deterministic one).
 */
function resolveSprintBatchLabels(db: DatabaseLike, batchIds: readonly string[]): Map<string, string> {
  const labels = new Map<string, string>();
  if (batchIds.length === 0) return labels;
  const hasSession = columnExists(db, 'workflow_runs', 'session_id') && columnExists(db, 'sessions', 'name');
  const sessionSelect = hasSession ? 's.name AS session_name' : 'NULL AS session_name';
  const sessionJoin = hasSession ? 'LEFT JOIN sessions s ON s.id = wr.session_id' : '';
  const placeholders = batchIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT sb.id AS batch_id, ${sessionSelect}, w.name AS workflow_name
         FROM sprint_batches sb
         LEFT JOIN workflow_runs wr ON wr.id = (
           SELECT wr2.id FROM workflow_runs wr2
            WHERE wr2.batch_id = sb.id
            ORDER BY wr2.created_at DESC, wr2.id DESC
            LIMIT 1
         )
         ${sessionJoin}
         LEFT JOIN workflows w ON w.id = wr.workflow_id
        WHERE sb.id IN (${placeholders})`,
    )
    .all(...batchIds) as Array<{ batch_id: string; session_name: string | null; workflow_name: string | null }>;
  for (const r of rows) {
    const base = r.session_name?.trim() || r.workflow_name?.trim() || 'Sprint';
    labels.set(r.batch_id, `${base} · ${r.batch_id.slice(0, 8)}`);
  }
  return labels;
}

/**
 * Bulk-gather sprint memberships for a SET of task ids in TWO queries total
 * (task->batch mapping, then batch->label resolution) — never one query per
 * task. Restricted to batches whose lifecycle is planning/running/finalizing
 * (an active batch); a batch already completed/failed/canceled contributes no
 * membership. Fail-soft on a pre-022 schema (no sprint_batches table): a
 * membership overlay must never break a backlog read.
 */
function gatherSprintMemberships(
  db: DatabaseLike,
  taskIds: readonly string[],
): Array<{ taskId: string; membership: BacklogMembership }> {
  if (taskIds.length === 0) return [];
  try {
    const placeholders = taskIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT sbt.task_id AS task_id, sb.id AS batch_id, sb.status AS status
           FROM sprint_batch_tasks sbt
           JOIN sprint_batches sb ON sb.id = sbt.batch_id
          WHERE sbt.task_id IN (${placeholders})
            AND sb.status IN ('planning', 'running', 'finalizing')`,
      )
      .all(...taskIds) as SprintMembershipRow[];
    if (rows.length === 0) return [];

    const labelByBatch = resolveSprintBatchLabels(db, [...new Set(rows.map((r) => r.batch_id))]);

    return rows.map((r) => ({
      taskId: r.task_id,
      membership: {
        kind: 'sprint' as const,
        id: r.batch_id,
        label: labelByBatch.get(r.batch_id) ?? `Sprint · ${r.batch_id.slice(0, 8)}`,
        status: r.status,
      },
    }));
  } catch (err) {
    if (err instanceof Error && /no such (column|table)/i.test(err.message)) return [];
    throw err;
  }
}

interface ExperimentMembershipRow {
  task_id: string;
  experiment_id: string;
  status: ExperimentStatus;
  workflow_id: string;
  variant_a_id: string;
  variant_b_id: string;
  run_a_id: string | null;
  run_b_id: string | null;
  session_a_id: string | null;
  session_b_id: string | null;
}

/** One arm's human label — see the doc block above gatherExperimentMemberships for the fallback chain. */
function resolveExperimentArmLabel(
  variantId: string,
  runId: string | null,
  sessionId: string | null,
  variantLabelById: Map<string, string>,
  runVariantLabelById: Map<string, string>,
  sessionNameById: Map<string, string>,
): string {
  if (isBaselineArm(variantId)) return 'Current workflow';
  if (isQuickArm(variantId)) {
    const sessionName = sessionId ? sessionNameById.get(sessionId)?.trim() : undefined;
    return sessionName || 'Quick session';
  }
  const variantLabel = variantLabelById.get(variantId)?.trim();
  if (variantLabel) return variantLabel;
  const runVariantLabel = runId ? runVariantLabelById.get(runId)?.trim() : undefined;
  if (runVariantLabel) return runVariantLabel;
  return `Variant ${variantId.slice(0, 8)}`;
}

/**
 * Experiment label: `${workflowBase}: ${armALabel} vs ${armBLabel} ·
 * ${experimentId.slice(0,8)}` (IDEA-053). `workflowBase` is trimmed
 * `workflows.name`, else 'Experiment'. Each real variant arm resolves trimmed
 * `workflow_variants.label`, else the arm run's trimmed denormalized
 * `workflow_runs.variant_label`, else `Variant <id8>`. The baseline sentinel
 * ({@link isBaselineArm}) always renders 'Current workflow'; the quick
 * sentinel ({@link isQuickArm}) renders the arm session's trimmed name, else
 * 'Quick session'. Resolves every lookup in bulk (one query per denormalized
 * table), never per-experiment.
 */
function resolveExperimentLabels(db: DatabaseLike, rows: readonly ExperimentMembershipRow[]): Map<string, string> {
  const workflowIds = [...new Set(rows.map((r) => r.workflow_id))];
  const workflowNameById = fetchColumnMap(db, 'workflows', 'id', 'name', workflowIds);

  const variantIds = [
    ...new Set(
      rows
        .flatMap((r) => [r.variant_a_id, r.variant_b_id])
        .filter((id) => !isBaselineArm(id) && !isQuickArm(id)),
    ),
  ];
  const variantLabelById = fetchColumnMap(db, 'workflow_variants', 'id', 'label', variantIds);

  const runIds = [
    ...new Set(rows.flatMap((r) => [r.run_a_id, r.run_b_id]).filter((id): id is string => id !== null)),
  ];
  const runVariantLabelById = fetchColumnMap(db, 'workflow_runs', 'id', 'variant_label', runIds);

  const sessionIds = [
    ...new Set(rows.flatMap((r) => [r.session_a_id, r.session_b_id]).filter((id): id is string => id !== null)),
  ];
  const sessionNameById = columnExists(db, 'sessions', 'name')
    ? fetchColumnMap(db, 'sessions', 'id', 'name', sessionIds)
    : new Map<string, string>();

  const labels = new Map<string, string>();
  for (const r of rows) {
    const workflowBase = workflowNameById.get(r.workflow_id)?.trim() || 'Experiment';
    const armALabel = resolveExperimentArmLabel(
      r.variant_a_id,
      r.run_a_id,
      r.session_a_id,
      variantLabelById,
      runVariantLabelById,
      sessionNameById,
    );
    const armBLabel = resolveExperimentArmLabel(
      r.variant_b_id,
      r.run_b_id,
      r.session_b_id,
      variantLabelById,
      runVariantLabelById,
      sessionNameById,
    );
    labels.set(r.experiment_id, `${workflowBase}: ${armALabel} vs ${armBLabel} · ${r.experiment_id.slice(0, 8)}`);
  }
  return labels;
}

/**
 * Bulk-gather experiment memberships for a SET of task ids. Restricted to a
 * LIVE experiment (status running/grading — matches {@link isLiveExperimentSeed})
 * naming the task as its `experiment_seed_tasks.original_task_id` — the
 * VISIBLE original, never the hidden per-arm clones (which carry their own
 * `experiment_id` sandbox tag instead). `SELECT DISTINCT` collapses the two
 * per-arm mapping rows (arm A + arm B share the same original_task_id) into
 * one membership entry. Fail-soft on a pre-049/pre-051 schema.
 */
function gatherExperimentMemberships(
  db: DatabaseLike,
  taskIds: readonly string[],
): Array<{ taskId: string; membership: BacklogMembership }> {
  if (taskIds.length === 0) return [];
  try {
    const placeholders = taskIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT DISTINCT est.original_task_id AS task_id, e.id AS experiment_id, e.status AS status,
                e.workflow_id AS workflow_id, e.variant_a_id AS variant_a_id, e.variant_b_id AS variant_b_id,
                e.run_a_id AS run_a_id, e.run_b_id AS run_b_id,
                e.session_a_id AS session_a_id, e.session_b_id AS session_b_id
           FROM experiment_seed_tasks est
           JOIN experiments e ON e.id = est.experiment_id
          WHERE est.original_task_id IN (${placeholders})
            AND e.status IN ('running', 'grading')`,
      )
      .all(...taskIds) as ExperimentMembershipRow[];
    if (rows.length === 0) return [];

    const labelByExperiment = resolveExperimentLabels(db, rows);

    return rows.map((r) => ({
      taskId: r.task_id,
      membership: {
        kind: 'experiment' as const,
        id: r.experiment_id,
        label: labelByExperiment.get(r.experiment_id) ?? `Experiment · ${r.experiment_id.slice(0, 8)}`,
        status: r.status,
      },
    }));
  } catch (err) {
    if (err instanceof Error && /no such (column|table)/i.test(err.message)) return [];
    throw err;
  }
}

/**
 * Bulk-gather BOTH sprint + experiment memberships for a SET of task ids in
 * ONE map — the read-side counterpart of {@link loadProjectDependencyOverlays}
 * / {@link resolveIdeaComponentsBatchSafe}: scoped bulk queries + grouping,
 * never a per-item query. A task with no rows is simply absent from the map;
 * callers default it to `[]`. `main/src/orchestrator/taskChangeRouter.ts`'s
 * emit-path constructor mirrors this exact query shape (single-id array) for
 * shape parity — see its `gatherMemberships`.
 */
export function loadMembershipsForTaskIds(
  db: DatabaseLike,
  taskIds: readonly string[],
): Map<string, BacklogMembership[]> {
  const byTask = new Map<string, BacklogMembership[]>();
  if (taskIds.length === 0) return byTask;
  for (const { taskId, membership } of [
    ...gatherSprintMemberships(db, taskIds),
    ...gatherExperimentMemberships(db, taskIds),
  ]) {
    const list = byTask.get(taskId);
    if (list) {
      list.push(membership);
    } else {
      byTask.set(taskId, [membership]);
    }
  }
  return byTask;
}

/** Attach the membership overlay to a projected TASK item (no-op fields kept stable). */
function applyMembershipsOverlay(item: BacklogTaskItem, memberships: readonly BacklogMembership[]): void {
  item.memberships = memberships;
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
  /**
   * The prerequisite's OWN executor (migration 137). 'human' makes this edge
   * non-gating — see foldDependencyRows. Reads back 'agent' on a pre-137 DB
   * (the SELECT substitutes the literal), so the old behaviour is preserved
   * exactly where the column does not exist.
   */
  dep_executor: TaskExecutor;
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
  /**
   * Refs of the blocking prerequisites whose executor is 'human' (migration
   * 137) — recorded, but NOT counted against `readyToWork`. See
   * {@link foldDependencyRows}.
   */
  waitingOnHuman: string[];
}

/**
 * Build a `taskId -> DependencyOverlay` map for an ENTIRE project in ONE query.
 *
 * Each `task_dependencies` row is LEFT JOINed to the prerequisite task (for
 * ref/title) and its board stage (for the position used by the readyToWork
 * predicate). A task with no rows is absent from the map; callers default it to
 * `{ blockedBy: [], relatedTo: [], readyToWork: true, waitingOnHuman: [] }` (no blockers ⇒ ready).
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
  // Fail-soft on a pre-137 schema: the literal keeps every prerequisite 'agent',
  // which is exactly the pre-137 behaviour (no edge is ever non-gating).
  const depExecutor = columnExists(db, 'tasks', 'executor')
    ? 'dep.executor AS dep_executor'
    : "'agent' AS dep_executor";
  const stmt = db.prepare(
    `SELECT d.task_id, d.depends_on_task_id, d.kind,
            dep.ref   AS dep_ref,
            dep.title AS dep_title,
            ${depExecutor},
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
  // Same pre-137 fail-soft as loadProjectDependencyOverlays.
  const depExecutor = columnExists(db, 'tasks', 'executor')
    ? 'dep.executor AS dep_executor'
    : "'agent' AS dep_executor";
  const rows = db
    .prepare(
      `SELECT d.task_id, d.depends_on_task_id, d.kind,
              dep.ref   AS dep_ref,
              dep.title AS dep_title,
              ${depExecutor},
              s.position AS dep_position
         FROM task_dependencies d
         JOIN tasks dep ON dep.id = d.depends_on_task_id
         LEFT JOIN board_stages s ON s.id = dep.stage_id
        WHERE d.task_id = ?`,
    )
    .all(taskId) as DependencyEdgeRow[];

  return foldDependencyRows(rows).get(taskId) ?? { blockedBy: [], relatedTo: [], readyToWork: true, waitingOnHuman: [] };
}

/**
 * Fold dependency-edge rows into a per-blocked-task overlay map. readyToWork is
 * true when a task has NO blocking edges, or EVERY blocking prerequisite sits at
 * the Done position (9). `related` edges are advisory and never gate readiness.
 *
 * A blocking prerequisite whose OWN executor is 'human' (migration 137) is the
 * third case: the edge is real board truth and stays in `blockedBy`, but it does
 * NOT clear `readyToWork`. Nothing in a sprint ever moves a human task to Done —
 * no lane is created for it — so counting it would pin every dependent to
 * "blocked" permanently, on the board, in the batch picker, and in the
 * `ready_to_work` field every agent reads from `cyboflow_list_tasks`. Its ref is
 * surfaced separately in `waitingOnHuman` so a consumer can say "waits on
 * TASK-009 (human)" instead of showing the blocked chip.
 */
function foldDependencyRows(rows: DependencyEdgeRow[]): Map<string, DependencyOverlay> {
  const byTask = new Map<string, DependencyOverlay>();
  for (const r of rows) {
    let overlay = byTask.get(r.task_id);
    if (!overlay) {
      overlay = { blockedBy: [], relatedTo: [], readyToWork: true, waitingOnHuman: [] };
      byTask.set(r.task_id, overlay);
    }
    const ref: TaskDependencyRef = {
      taskId: r.depends_on_task_id,
      ref: r.dep_ref,
      title: r.dep_title,
    };
    if (r.kind === 'blocking') {
      overlay.blockedBy.push(ref);
      if (r.dep_executor === 'human') {
        // Non-gating by construction — see the docblock. Recorded, never counted.
        overlay.waitingOnHuman.push(ref.ref);
      } else if (r.dep_position !== DONE_POSITION) {
        // A blocking AGENT prereq not yet at the Done position keeps the task blocked.
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
  item.waitingOnHuman = overlay.waitingOnHuman;
}

/**
 * Attach the idea component ledger overlay (migration 101) to a projected IDEA
 * item. Same batch-overlay shape as {@link applyDependencyOverlay}: the caller
 * resolves the ledger for a whole batch of idea ids in ONE
 * `resolveIdeaComponentsBatch` call, then applies each idea's slice here —
 * never a per-item resolver call inside `projectTaskItem` (that would issue a
 * fistful of queries per card). Epics/tasks never call this, so `components`
 * stays `undefined` for them, per the shared type's "not computed" contract.
 */
function applyIdeaComponentsOverlay(item: BacklogTaskItem, components: IdeaComponentState[]): void {
  item.components = components;
}

/**
 * Fail-soft `resolveIdeaComponentsBatch` wrapper — mirrors `isLiveExperimentSeed`
 * above. `idea_components`/`approved_designs` (migrations 098/082) are recent
 * additions; a schema predating them (an older on-disk DB mid-migration, or one
 * of this repo's many hand-rolled test fixtures that hasn't been updated for
 * 098 yet) degrades PERMISSIVELY to an empty map — every idea then reads back
 * `components: undefined` ("not computed") instead of throwing 'no such table'
 * on every backlog read.
 */
function resolveIdeaComponentsBatchSafe(
  db: DatabaseLike,
  ideaIds: readonly string[],
): Map<string, IdeaComponentState[]> {
  if (ideaIds.length === 0) return new Map();
  try {
    return resolveIdeaComponentsBatch(db, ideaIds);
  } catch (err) {
    if (err instanceof Error && /no such (column|table)/i.test(err.message)) return new Map();
    throw err;
  }
}

/** Single-idea sibling of {@link resolveIdeaComponentsBatchSafe}, same degrade contract. */
function resolveIdeaComponentsSafe(db: DatabaseLike, ideaId: string): IdeaComponentState[] | undefined {
  try {
    return resolveIdeaComponents(db, ideaId);
  } catch (err) {
    if (err instanceof Error && /no such (column|table)/i.test(err.message)) return undefined;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Backlog projection
// ---------------------------------------------------------------------------

/**
 * Project a base task row + its overlays into a BacklogTaskItem (children are
 * filled in by selectProjectBacklog's nesting pass, not here).
 */
function projectTaskItem(db: DatabaseLike, row: TaskDbRow): BacklogTaskItem {
  const { inFlow, awaitingReview, isDone, experimentSeed } = computeTaskOverlay(db, row);
  return {
    id: row.id,
    project_id: row.project_id,
    type: row.type,
    ref: row.ref,
    title: row.title,
    summary: row.summary,
    body: row.body,
    priority: row.priority,
    category: row.category,
    // WHO performs the work (137). Same silent-drop rationale as the stamps
    // below: the picker excludes human tasks and the card badges them.
    executor: row.executor ?? 'agent',
    repo: row.repo,
    parent_epic_id: row.parent_epic_id,
    originating_idea_id: row.originating_idea_id,
    scope: row.scope,
    board_id: row.board_id,
    stage_id: row.stage_id,
    archived_at: row.archived_at,
    decomposed_at: row.decomposed_at,
    approved_at: row.approved_at,
    experiment_id: row.experiment_id ?? null,
    // Manual rank (057). Same silent-drop rationale as the stamps above: the
    // frontend orders by it, so every emit/read constructor must populate it.
    sort_order: row.sort_order ?? null,
    version: row.version,
    stage_position: row.stage_position,
    inFlow,
    awaitingReview,
    isDone,
    // Live A/B experiment seed (C2) — drives the "In experiment" card badge.
    experimentSeed,
    // Exact sprint/experiment memberships (IDEA-053, TASK-202). Defaults to []
    // here; task-type items get it overwritten by applyMembershipsOverlay via a
    // BULK loadMembershipsForTaskIds call — never computed per-row in here (that
    // would reintroduce the N+1 pattern the bulk overlay exists to avoid).
    memberships: [],
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
       FROM (${entityUnionSql('WHERE id = ?', columnExists(db, 'tasks', 'executor'))}) e
       LEFT JOIN board_stages bs ON bs.id = e.stage_id`)
      .get(taskId, taskId, taskId) as TaskDbRow | undefined);
  if (!row) return null;

  const item = projectTaskItem(db, row);

  if (row.type === 'task') {
    applyDependencyOverlay(item, loadTaskDependencyOverlay(db, row.id));
    applyMembershipsOverlay(item, loadMembershipsForTaskIds(db, [row.id]).get(row.id) ?? []);
  }

  if (row.type === 'idea') {
    const components = resolveIdeaComponentsSafe(db, row.id);
    if (components) applyIdeaComponentsOverlay(item, components);
  }

  if (row.type === 'epic') {
    // Children are always tasks (only `tasks` carries parent_epic_id).
    const childRows = db
      .prepare(
        `SELECT t.id, t.project_id, 'task' AS type, t.ref, t.title, t.summary, t.body, t.priority, t.category, t.repo,
                t.parent_epic_id, t.originating_idea_id, NULL AS scope, ${taskExecutorColumn(db, 't.')},
                t.board_id, t.stage_id, t.archived_at, NULL AS decomposed_at, t.approved_at, t.experiment_id, t.sort_order, t.version, t.created_at, t.updated_at,
                COALESCE(bs.position, 0) AS stage_position
           FROM tasks t
           LEFT JOIN board_stages bs ON bs.id = t.stage_id
          WHERE t.parent_epic_id = ?
          ORDER BY t.created_at ASC, t.ref ASC`,
      )
      .all(taskId) as TaskDbRow[];
    // Memberships for every child in ONE bulk call — never per-child.
    const childMemberships = loadMembershipsForTaskIds(db, childRows.map((c) => c.id));
    const children = childRows.map((c) => {
      const childItem = projectTaskItem(db, c);
      applyDependencyOverlay(childItem, loadTaskDependencyOverlay(db, c.id));
      applyMembershipsOverlay(childItem, childMemberships.get(c.id) ?? []);
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
           SELECT id, project_id, 'idea' AS type, ref, title, summary, body, priority, category, repo,
                  NULL AS parent_epic_id, NULL AS originating_idea_id, scope, 'agent' AS executor,
                  board_id, stage_id, archived_at, decomposed_at, NULL AS approved_at, experiment_id, sort_order, version, created_at, updated_at
             FROM ideas WHERE id = ?
         ) e
         LEFT JOIN board_stages bs ON bs.id = e.stage_id`,
    )
    .get(ideaId) as TaskDbRow | undefined;
  if (!ideaRow) return null;

  const idea = projectTaskItem(db, ideaRow);
  const ideaComponents = resolveIdeaComponentsSafe(db, ideaId);
  if (ideaComponents) applyIdeaComponentsOverlay(idea, ideaComponents);

  // Epics decomposed from this idea (ASC by created_at, ref tiebreak).
  const epicRows = db
    .prepare(
      `SELECT e.id, e.project_id, 'epic' AS type, e.ref, e.title, e.summary, e.body, e.priority, e.category, e.repo,
              NULL AS parent_epic_id, e.originating_idea_id, NULL AS scope, 'agent' AS executor,
              e.board_id, e.stage_id, e.archived_at, NULL AS decomposed_at, e.approved_at, e.experiment_id, e.sort_order, e.version, e.created_at, e.updated_at,
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
        `SELECT t.id, t.project_id, 'task' AS type, t.ref, t.title, t.summary, t.body, t.priority, t.category, t.repo,
                t.parent_epic_id, t.originating_idea_id, NULL AS scope, ${taskExecutorColumn(db, 't.')},
                t.board_id, t.stage_id, t.archived_at, NULL AS decomposed_at, t.approved_at, t.experiment_id, t.sort_order, t.version, t.created_at, t.updated_at,
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
      `SELECT t.id, t.project_id, 'task' AS type, t.ref, t.title, t.summary, t.body, t.priority, t.category, t.repo,
              t.parent_epic_id, t.originating_idea_id, NULL AS scope, ${taskExecutorColumn(db, 't.')},
              t.board_id, t.stage_id, t.archived_at, NULL AS decomposed_at, t.approved_at, t.experiment_id, t.sort_order, t.version, t.created_at, t.updated_at,
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

  // Memberships for every task in the tree (epics' children + direct tasks) in
  // ONE bulk call, applied after the fact — mirrors the epic-children pass in
  // selectTaskById without disturbing the per-epic taskRows queries above.
  const allTaskItems = [...epics.flatMap((e) => e.children ?? []), ...directTasks];
  const membershipsByTask = loadMembershipsForTaskIds(db, allTaskItems.map((t) => t.id));
  for (const t of allTaskItems) {
    applyMembershipsOverlay(t, membershipsByTask.get(t.id) ?? []);
  }

  return idea;
}

/**
 * Project a RUN's decomposition — one BacklogTaskItem (idea root + nested
 * epics/tasks, exactly as {@link selectIdeaDecomposition} returns) PER idea the
 * run owns. Covers the multi-idea planner batch (IDEA-009): a run seeded with
 * or that created several ideas surfaces one decomposition tree per idea,
 * instead of only the first.
 *
 * Idea-id resolution mirrors autoMintArtifacts' multi-idea idea-spec mint via
 * the SHARED {@link listRunOwnedOrBatchIdeaIds} helper (runEntityOwnership.ts):
 * the run's owned ideas (seed ideas UNION run-created ideas) when non-empty,
 * else the single sprint-batch idea a standalone sprint operates on. A run that
 * owns no resolvable idea returns [].
 *
 * Drafts are included: selectIdeaDecomposition applies no approved_at filter,
 * so a hidden-draft idea/epic/task (plan-gated run pending approval) still
 * projects here — this is a run-scoped decomposition read, not a board read.
 *
 * This is the dedicated read behind a run-scoped `decomposed-stories` artifact
 * view — selectIdeaDecomposition alone only covers a single known idea id.
 *
 * @param db    - Narrow DatabaseLike interface (real or test).
 * @param runId - The workflow_runs.id whose owned ideas' decomposition to project.
 */
export function selectRunDecomposition(db: DatabaseLike, runId: string): BacklogTaskItem[] {
  const ideaIds = listRunOwnedOrBatchIdeaIds(db, runId);
  if (ideaIds.length === 0) return [];

  const items: BacklogTaskItem[] = [];
  for (const ideaId of ideaIds) {
    const item = selectIdeaDecomposition(db, ideaId);
    if (item !== null) items.push(item);
  }
  return items;
}

/**
 * Resolve a display ref (e.g. 'TASK-014', 'IDEA-009', 'EPIC-002') to its opaque
 * backlog id, scoped to `projectId` so a ref belonging to another project can
 * never resolve here (the caller — cyboflow_get_task's handler — treats a miss
 * as not_found, never leaking cross-project existence). Table identity is the
 * discriminator (migration 015): tries ideas -> epics -> tasks in turn and
 * returns the first hit. Returns null when no table has a matching
 * (project_id, ref) row.
 *
 * @param db        - Narrow DatabaseLike interface.
 * @param projectId - The project the ref must belong to.
 * @param ref       - The display ref to resolve (e.g. 'TASK-014').
 */
export function resolveBacklogRef(db: DatabaseLike, projectId: number, ref: string): string | null {
  const tables = ['ideas', 'epics', 'tasks'] as const;
  for (const table of tables) {
    const row = db
      .prepare(`SELECT id FROM ${table} WHERE project_id = ? AND ref = ?`)
      .get(projectId, ref) as { id: string } | undefined;
    if (row) return row.id;
  }
  return null;
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
export function selectProjectBacklog(
  db: DatabaseLike,
  projectId: number | null,
  // A/B experiments (migration 049): by default the backlog EXCLUDES
  // experiment-tagged rows (hidden sandbox drafts) server-side — closing the leak
  // paths the client board filter alone misses (TaskBatchPickerModal, IdeaPickerModal).
  // Slice C's compare view passes `includeExperimentTagged` to see an arm's outputs.
  opts?: { includeExperimentTagged?: boolean },
): BacklogTaskItem[] {
  // Single UNION across the three entity tables → one BacklogTaskItem[]. The
  // outer SELECT joins the stage position and applies the shared ordering
  // across the merged set. The per-branch project filter is emitted only when
  // scoped, so the bind count always matches the SQL.
  const scoped = projectId !== null;
  const stmt = db.prepare(
    `SELECT ${aliasedUnionColumns('e')}, COALESCE(bs.position, 0) AS stage_position
       FROM (${entityUnionSql(scoped ? 'WHERE project_id = ?' : '', columnExists(db, 'tasks', 'executor'))}) e
       LEFT JOIN board_stages bs ON bs.id = e.stage_id
      ORDER BY (e.sort_order IS NULL) ASC, e.sort_order ASC, e.created_at ASC, e.ref ASC`,
  );
  const allRows = (scoped ? stmt.all(projectId, projectId, projectId) : stmt.all()) as TaskDbRow[];
  // Drop experiment-tagged rows unless explicitly included. Filtered post-query
  // (vs a WHERE clause) so the same UNION serves both modes and stays fail-soft
  // on any pre-049 row whose experiment_id reads back null.
  const includeTagged = opts?.includeExperimentTagged === true;
  const rows = includeTagged ? allRows : allRows.filter((r) => (r.experiment_id ?? null) === null);

  // Dependency edges are task-only — load the whole project's overlays in ONE
  // query and map them onto each task item as we project.
  const depOverlays = loadProjectDependencyOverlays(db, projectId);

  // Idea component ledger (migration 101) is ideas-only — resolve the WHOLE
  // batch's ledger in ONE resolveIdeaComponentsBatch call (mirroring the
  // dependency-overlay precedent above), never a per-item resolver call inside
  // projectTaskItem.
  const ideaIds = rows.filter((row) => row.type === 'idea').map((row) => row.id);
  const componentsByIdea = resolveIdeaComponentsBatchSafe(db, ideaIds);

  // Sprint/experiment memberships (IDEA-053, TASK-202) are task-only — resolve
  // the WHOLE scope's memberships in ONE bulk loadMembershipsForTaskIds call
  // (mirroring the dependency-overlay + idea-component precedents above),
  // never a per-item query inside projectTaskItem.
  const taskIds = rows.filter((row) => row.type === 'task').map((row) => row.id);
  const membershipsByTask = loadMembershipsForTaskIds(db, taskIds);

  // First pass: project every row to a BacklogTaskItem keyed by id.
  const itemsById = new Map<string, BacklogTaskItem>();
  for (const row of rows) {
    const item = projectTaskItem(db, row);
    if (row.type === 'task') {
      applyDependencyOverlay(
        item,
        depOverlays.get(row.id) ?? { blockedBy: [], relatedTo: [], readyToWork: true, waitingOnHuman: [] },
      );
      applyMembershipsOverlay(item, membershipsByTask.get(row.id) ?? []);
    }
    if (row.type === 'idea') {
      const components = componentsByIdea.get(row.id);
      if (components) applyIdeaComponentsOverlay(item, components);
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
