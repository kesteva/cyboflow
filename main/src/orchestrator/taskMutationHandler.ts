/**
 * taskMutationHandler — the monitor's non-stopping "edit the sprint backlog"
 * actions: add / remove / edit a task on an IN-FLIGHT programmatic sprint (or
 * ship) run WITHOUT halting the walk.
 *
 * Why these are safe to run while the walk holds the run's PQueue: none of them
 * touch `workflow_runs` or the run queue. Task-record writes funnel through the
 * `TaskChangeRouter` chokepoint and lane writes through `SprintLaneStore` — each
 * owns its OWN per-project serialization, independent of the run's walk. So every
 * mutation here is a pure pre-flight read (validate the run) + a chokepoint write.
 *
 * Timing / "affect only not-yet-started work": a queued lane added or removed
 * here is picked up by the fan-out step's WAVE-BOUNDARY re-resolution
 * (WorkflowController.runFanOut) — an add appears in a later wave, a
 * not-yet-dispatched removal is dropped before it spawns. A lane already running
 * cannot be removed (SprintLaneStore.removeLane refuses a non-'queued' lane), and
 * an edit to an already-dispatched task's record won't reach the running agent.
 * The chat messages say so.
 *
 * add_task makes the created task sprint-ELIGIBLE by replaying the Q1 reveal's
 * promote sequence (create -> move to Ready-for-Dev -> stamp approved) so it
 * passes SprintLaneStore.filterEligibleTaskIds, then enrolls a queued lane. The
 * 'orchestrator' actor is used deliberately: the monitor relays a human's
 * explicit in-chat confirmation, and the approved/stage writes are
 * orchestrator-only authority.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/* — every collaborator is injected.
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { TaskChange } from './taskChangeRouter';
import type { Priority } from '../../../shared/types/tasks';
import type { SprintLaneRow } from '../../../shared/types/sprintBatch';

/** Board position of the Ready-for-Dev stage (the sprint-eligibility floor). */
const READY_FOR_DEV_POSITION = 6;

/**
 * Coerce a free-form priority string (from the monitor's structured output) to
 * the canonical `Priority` union, tolerating the common friendly synonyms.
 * Returns undefined for anything unrecognized so the chokepoint default (P2)
 * applies rather than a bogus write.
 */
function coercePriority(raw: string | undefined): Priority | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toUpperCase();
  if (s === 'P0' || s === 'P1' || s === 'P2') return s;
  if (s === 'HIGH' || s === 'URGENT' || s === 'CRITICAL') return 'P0';
  if (s === 'MEDIUM' || s === 'NORMAL') return 'P1';
  if (s === 'LOW' || s === 'MINOR') return 'P2';
  return undefined;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** SprintLaneStore.addLane / removeLane surface (injected at the composition root). */
export interface TaskMutationLaneStore {
  addLane(input: { projectId: number; batchId: string; taskId: string }): SprintLaneRow;
  removeLane(input: { projectId: number; batchId: string; taskId: string }): { removed: boolean };
}

export interface TaskMutationDeps {
  db: DatabaseLike;
  /** TaskChangeRouter.getInstance().applyChange (bound at the composition root). */
  applyTaskChange: (projectId: number, change: TaskChange) => Promise<{ taskId: string }>;
  laneStore: TaskMutationLaneStore;
  logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Reasons a task mutation is refused without mutating anything. */
export type TaskMutationNoOpReason =
  | 'not_found' // no workflow_runs row
  | 'not_programmatic' // orchestrated runs have no monitor-driven backlog edits
  | 'no_batch' // add/remove need a materialized sprint batch (workflow_runs.batch_id)
  | 'task_not_found' // remove/edit: the ref/id did not resolve to a task
  | 'not_eligible' // add: the task could not be made sprint-eligible
  | 'already_started' // remove: the lane is running/finished — too late
  | 'duplicate' // add: the task is already enrolled in this batch
  | 'nothing_to_change' // edit: no title/body/priority supplied
  | 'lane_error'; // an unexpected SprintLaneStore failure

export type TaskMutationResult =
  | { ok: true; taskId: string; taskRef?: string; message: string }
  | { ok: false; reason: TaskMutationNoOpReason; detail?: string };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface RunRow {
  projectId: number;
  batchId: string | null;
  executionModel: string | null;
}

function loadRun(db: DatabaseLike, runId: string): RunRow | undefined {
  return db
    .prepare(
      `SELECT project_id AS projectId, batch_id AS batchId, execution_model AS executionModel
         FROM workflow_runs WHERE id = ?`,
    )
    .get(runId) as RunRow | undefined;
}

/** Resolve a human ref (e.g. "TASK-123") OR an opaque id to a task id (project-scoped). */
function resolveTaskId(db: DatabaseLike, projectId: number, identifier: string): string | undefined {
  const byId = db.prepare('SELECT id FROM tasks WHERE id = ?').get(identifier) as
    | { id: string }
    | undefined;
  if (byId) return byId.id;
  const byRef = db
    .prepare('SELECT id FROM tasks WHERE project_id = ? AND ref = ?')
    .get(projectId, identifier) as { id: string } | undefined;
  return byRef?.id;
}

function readTaskRef(db: DatabaseLike, taskId: string): string | undefined {
  const row = db.prepare('SELECT ref FROM tasks WHERE id = ?').get(taskId) as
    | { ref?: string | null }
    | undefined;
  return typeof row?.ref === 'string' ? row.ref : undefined;
}

const TERMINAL_BATCH_STATUSES = new Set(['completed', 'failed', 'canceled']);

/** True when the batch exists and is still accepting lanes (not terminal). */
function batchIsLive(db: DatabaseLike, batchId: string): boolean {
  const row = db.prepare('SELECT status FROM sprint_batches WHERE id = ?').get(batchId) as
    | { status?: string }
    | undefined;
  return row !== undefined && !TERMINAL_BATCH_STATUSES.has(row.status ?? '');
}

/** The SprintLaneError code, read structurally so this handler stays decoupled. */
function laneErrorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// add_task
// ---------------------------------------------------------------------------

export async function addTaskToRun(
  runId: string,
  input: { title: string; body?: string; priority?: string },
  deps: TaskMutationDeps,
): Promise<TaskMutationResult> {
  const run = loadRun(deps.db, runId);
  if (!run) return { ok: false, reason: 'not_found' };
  if (run.executionModel !== 'programmatic') return { ok: false, reason: 'not_programmatic' };
  if (!run.batchId) return { ok: false, reason: 'no_batch' };
  const { projectId, batchId } = run;

  // Pre-check the batch is still live BEFORE creating anything — a terminal batch
  // can't accept lanes, and we must not leak an orphan approved task on refusal.
  if (!batchIsLive(deps.db, batchId)) {
    return { ok: false, reason: 'no_batch', detail: 'the sprint batch has already finished' };
  }

  // 1. Create the task (lands on the project's default board, approved_at NULL).
  const { taskId } = await deps.applyTaskChange(projectId, {
    actor: 'orchestrator',
    runId,
    entityType: 'task',
    title: input.title,
    body: input.body,
    priority: coercePriority(input.priority),
    kind: 'operator-added',
  });

  // 2. Promote to Ready-for-Dev so it clears the sprint-eligibility stage floor.
  const taskRow = deps.db
    .prepare('SELECT board_id AS boardId, stage_id AS stageId FROM tasks WHERE id = ?')
    .get(taskId) as { boardId?: string | null; stageId?: string | null } | undefined;
  const boardId = typeof taskRow?.boardId === 'string' ? taskRow.boardId : null;
  if (boardId) {
    const stageRow = deps.db
      .prepare('SELECT id FROM board_stages WHERE board_id = ? AND position = ?')
      .get(boardId, READY_FOR_DEV_POSITION) as { id?: string } | undefined;
    const readyStageId = typeof stageRow?.id === 'string' ? stageRow.id : null;
    if (readyStageId && readyStageId !== taskRow?.stageId) {
      await deps.applyTaskChange(projectId, {
        actor: 'orchestrator',
        runId,
        entityType: 'task',
        taskId,
        stageId: readyStageId,
        kind: 'operator-added',
      });
    }
  }

  // 3. Stamp approved (the Q1 reveal — makes it backend-visible + sprint-eligible).
  await deps.applyTaskChange(projectId, {
    actor: 'orchestrator',
    runId,
    entityType: 'task',
    taskId,
    approved: true,
    kind: 'operator-added',
  });

  // 4. Enroll a queued lane; the next fan-out wave re-resolution dispatches it.
  try {
    deps.laneStore.addLane({ projectId, batchId, taskId });
  } catch (err) {
    const code = laneErrorCode(err);
    deps.logger?.warn('[taskMutation] addLane failed', {
      runId,
      taskId,
      code,
      error: err instanceof Error ? err.message : String(err),
    });
    // The task was just created + approved + promoted, and the batch was
    // pre-checked live, so 'no_eligible_tasks' / 'bad_request' (duplicate /
    // terminal batch) are all defensive here — none should fire in practice.
    if (code === 'no_eligible_tasks') return { ok: false, reason: 'not_eligible', detail: input.title };
    if (code === 'bad_request') return { ok: false, reason: 'duplicate', detail: input.title };
    return { ok: false, reason: 'lane_error', detail: err instanceof Error ? err.message : undefined };
  }

  const taskRef = readTaskRef(deps.db, taskId);
  return {
    ok: true,
    taskId,
    taskRef,
    message: `Added task ${taskRef ? `${taskRef} ` : ''}'${input.title}' to the sprint — it'll be picked up on the next wave.`,
  };
}

// ---------------------------------------------------------------------------
// remove_task
// ---------------------------------------------------------------------------

export async function removeTaskFromRun(
  runId: string,
  input: { taskRef: string },
  deps: TaskMutationDeps,
): Promise<TaskMutationResult> {
  const run = loadRun(deps.db, runId);
  if (!run) return { ok: false, reason: 'not_found' };
  if (run.executionModel !== 'programmatic') return { ok: false, reason: 'not_programmatic' };
  if (!run.batchId) return { ok: false, reason: 'no_batch' };
  const { projectId, batchId } = run;

  // Resolve for a nice message; removeLane also resolves internally.
  const taskId = resolveTaskId(deps.db, projectId, input.taskRef);
  const taskRef = taskId ? readTaskRef(deps.db, taskId) : undefined;

  try {
    deps.laneStore.removeLane({ projectId, batchId, taskId: input.taskRef });
  } catch (err) {
    const code = laneErrorCode(err);
    deps.logger?.warn('[taskMutation] removeLane failed', {
      runId,
      taskRef: input.taskRef,
      code,
      error: err instanceof Error ? err.message : String(err),
    });
    if (code === 'lane_not_found') return { ok: false, reason: 'task_not_found', detail: input.taskRef };
    if (code === 'bad_request') return { ok: false, reason: 'already_started', detail: input.taskRef };
    return { ok: false, reason: 'lane_error', detail: err instanceof Error ? err.message : undefined };
  }

  return {
    ok: true,
    taskId: taskId ?? input.taskRef,
    taskRef,
    message: `Removed task ${taskRef ?? input.taskRef} from the sprint (it hadn't started).`,
  };
}

// ---------------------------------------------------------------------------
// edit_task
// ---------------------------------------------------------------------------

export async function editRunTask(
  runId: string,
  input: { taskRef: string; title?: string; body?: string; priority?: string },
  deps: TaskMutationDeps,
): Promise<TaskMutationResult> {
  const run = loadRun(deps.db, runId);
  if (!run) return { ok: false, reason: 'not_found' };
  if (run.executionModel !== 'programmatic') return { ok: false, reason: 'not_programmatic' };
  const { projectId } = run;

  const taskId = resolveTaskId(deps.db, projectId, input.taskRef);
  if (!taskId) return { ok: false, reason: 'task_not_found', detail: input.taskRef };

  const fields: { title?: string; body?: string; priority?: Priority } = {};
  if (input.title !== undefined) fields.title = input.title;
  if (input.body !== undefined) fields.body = input.body;
  const coercedPriority = coercePriority(input.priority);
  if (coercedPriority !== undefined) fields.priority = coercedPriority;
  if (Object.keys(fields).length === 0) return { ok: false, reason: 'nothing_to_change' };

  await deps.applyTaskChange(projectId, {
    actor: 'orchestrator',
    runId,
    entityType: 'task',
    taskId,
    fields,
    kind: 'operator-edited',
  });

  const taskRef = readTaskRef(deps.db, taskId);
  return {
    ok: true,
    taskId,
    taskRef,
    message: `Updated task ${taskRef ?? input.taskRef}${
      fields.title ? ` (now '${fields.title}')` : ''
    }. If its lane has already started, the change won't reach the running agent.`,
  };
}
