/**
 * TaskChangeRouter — the SINGLE write chokepoint for native ENTITY state.
 *
 * INVARIANT: every entity-state write (GUI tRPC, orchestrator lifecycle, run
 * close-out, MCP agent tools) routes through applyChange (create / update /
 * archive toggle) or applyDelete (hard delete + cascade). Nothing UPDATEs or
 * DELETEs `ideas` / `epics` / `tasks` directly. Each applyChange atomically
 * (1) mutates the correct entity table and (2) appends a per-field delta row to
 * `entity_events(entity_type, entity_id)`, then emits a TaskChangedEvent after
 * commit — on BOTH the per-project channel and the cross-project
 * TASK_ALL_CHANNEL (the all-projects board subscribes once).
 *
 * ARCHIVE-IN-PLACE (migration 024): archiving is NOT a stage move. The
 * `archived` toggle on TaskChange stamps/clears `archived_at` on the row; the
 * entity keeps its current stage/column and visibility is a client concern.
 * Hard delete (applyDelete) cascades idea -> epics -> tasks (children first),
 * purges the entities' entity_events rows, and best-effort dismisses pending
 * review_items linked to the deleted entities via ReviewItemRouter.
 *
 * ENTITY-AWARE (migration 015): the unified `tasks` table is split into three
 * tables — ideas / epics / tasks. Table identity IS the discriminator, so the
 * `change` carries `entityType`. Callers at a boundary (tRPC / MCP) SHOULD pass
 * it; on the update path it is OPTIONAL — when omitted we resolve it by looking
 * the id up across all three tables. Lineage:
 *   - parent_epic_id     — only type='task', FK->epics, validated + cycle-checked.
 *   - originating_idea_id — type='epic' | 'task', FK->ideas, validated.
 * Decomposition: an IDEA is retired off the board by stamping `decomposed_at`
 * (the `decomposed` toggle); children are left UNCHANGED (no cascade) — they
 * carry the flow. Idea retirement is EXCLUSIVELY gate-driven (no auto-retire).
 *
 * Mirrors the per-run PQueue serialization pattern in approvalRouter.ts, but
 * keys the queue PER PROJECT (entity refs + version bumps are project-scoped).
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*. The DB is
 * injected as the narrow DatabaseLike interface.
 */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import PQueue from 'p-queue';
import { ReviewItemRouter } from './reviewItemRouter';
import type { DatabaseLike } from './types';
import type {
  BacklogTaskItem,
  FlowOverlay,
  IdeaAttachment,
  IdeaScope,
  Priority,
  TaskChangeAction,
  TaskChangedEvent,
  TaskType,
} from '../../../shared/types/tasks';
import { resolveStepAgentKey } from '../../../shared/types/agentIdentity';
import { listRunCreatedEpicIds, listRunCreatedIdeaIds, listRunCreatedTaskIds } from './runEntityOwnership';

// ---------------------------------------------------------------------------
// Public event emitter — exported HERE (NOT trpc/routers/events.ts) per the
// pinned contract, to avoid file contention with the events router. The tRPC
// subscription bridges this emitter via eventToAsyncIterable.
//
// Every event is emitted on TWO keys: the per-project channel
// ('task-project-' + projectId) AND the cross-project TASK_ALL_CHANNEL
// ('task-all') — the all-projects board subscribes to the latter once instead
// of one subscription per project.
// ---------------------------------------------------------------------------

export const taskChangeEvents = new EventEmitter();

/** Build the emit channel name for a project. Exported so the tRPC subscription stays in sync. */
export function taskProjectChannel(projectId: number): string {
  return `task-project-${projectId}`;
}

/** The cross-project channel every event is ALSO emitted on (all-projects board). */
export const TASK_ALL_CHANNEL = 'task-all';

// ---------------------------------------------------------------------------
// Entity-table descriptor map — the SINGLE place that knows table identity,
// id prefix, and which lineage columns each table carries.
// ---------------------------------------------------------------------------

interface EntityTableDescriptor {
  table: 'ideas' | 'epics' | 'tasks';
  idPrefix: string;
  /** This entity may carry a parent_epic_id (only tasks). */
  hasParentEpic: boolean;
  /** This entity may carry an originating_idea_id (epics + tasks). */
  hasOriginatingIdea: boolean;
  /** This entity may carry an entry_stage_id (only tasks). */
  hasEntryStage: boolean;
  /** This entity may carry a scope (only ideas). */
  hasScope: boolean;
  /** This entity may carry image attachments (only ideas, migration 028). */
  hasAttachments: boolean;
  /** This entity may carry a decomposed_at retire stamp (only ideas, migration 042). */
  hasDecomposed: boolean;
  /** This entity may carry an approved_at plan-gate stamp (epics + tasks, migration 042). */
  hasApproval: boolean;
}

const ENTITY_TABLES: Record<TaskType, EntityTableDescriptor> = {
  idea: { table: 'ideas', idPrefix: 'ide', hasParentEpic: false, hasOriginatingIdea: false, hasEntryStage: false, hasScope: true, hasAttachments: true, hasDecomposed: true, hasApproval: false },
  epic: { table: 'epics', idPrefix: 'epc', hasParentEpic: false, hasOriginatingIdea: true, hasEntryStage: false, hasScope: false, hasAttachments: false, hasDecomposed: false, hasApproval: true },
  task: { table: 'tasks', idPrefix: 'tsk', hasParentEpic: true, hasOriginatingIdea: true, hasEntryStage: true, hasScope: false, hasAttachments: false, hasDecomposed: false, hasApproval: true },
};

/** Resolve a descriptor for an entity type. */
function describe(type: TaskType): EntityTableDescriptor {
  return ENTITY_TABLES[type];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type TaskChangeErrorCode =
  | 'not_found'
  | 'invalid_parent'
  | 'invalid_lineage'
  | 'forbidden_stage'
  | 'active_runs'
  | 'concurrency'
  | 'invalid_dependency'
  | 'dependency_cycle'
  // A/B experiments (migration 049): a write crossed an experiment sandbox
  // boundary — an experiment-tagged run tried to mutate an entity outside its
  // experiment, OR an untagged actor (user / other run) tried to mutate a
  // hidden experiment-tagged entity. Surfaced to the agent as a tool-error so
  // the flow fails soft (it creates its own entity instead).
  | 'experiment_sandboxed';

/** Edge kind for a task->task dependency (mirrors the task_dependencies.kind CHECK). */
export type TaskDependencyKind = 'blocking' | 'related';

/** Discriminated error for all chokepoint rejections. */
export class TaskChangeError extends Error {
  constructor(
    public readonly code: TaskChangeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TaskChangeError';
  }
}

// ---------------------------------------------------------------------------
// Change request shape
// ---------------------------------------------------------------------------

/** Mutable entity fields a caller may set. `stageId`/`parentEpicId`/`originatingIdeaId` are handled separately. */
export interface TaskFieldChanges {
  title?: string;
  summary?: string | null;
  body?: string | null;
  priority?: Priority;
  repo?: string | null;
  /** Idea size hint — only valid on type='idea'. */
  scope?: IdeaScope | null;
  /**
   * Image attachments — only valid on type='idea' (migration 028). The whole
   * array is replaced wholesale (the editor sends the full desired set); null or
   * [] clears it. Persisted as JSON in the ideas.attachments column.
   */
  attachments?: IdeaAttachment[] | null;
  /**
   * Execution-entry capture (type='task' only). Set by the launch hook the
   * FIRST time a task leaves a planning stage into execution. Treated as an
   * asserted field that only the orchestrator path writes.
   */
  entryStageId?: string | null;
}

export type TaskActor = 'user' | 'orchestrator' | `agent:${string}` | 'linear';

export interface TaskChange {
  actor: TaskActor;
  /**
   * The entity-table discriminator. REQUIRED at the create path (defaults to
   * 'idea' when omitted for backward-compat). On the update path it is optional
   * — when omitted we resolve it by id across all three tables.
   */
  entityType?: TaskType;
  /** Omit to CREATE a new entity; provide to UPDATE an existing one. */
  taskId?: string;
  /** Field-level updates (title/summary/body/priority/repo/scope/entryStageId). */
  fields?: TaskFieldChanges;
  /** Move the entity to this stage (subject to write_policy authority + active-run guard). */
  stageId?: string;
  /** Re-parent (only valid for type='task'; null clears the parent). */
  parentEpicId?: string | null;
  /** Set/clear the originating idea (epics + tasks; null clears). */
  originatingIdeaId?: string | null;
  /**
   * Archive-in-place toggle (migration 024): true stamps `archived_at = now`,
   * false clears it. NOT a stage move — the entity keeps its stage/column.
   * Archiving a task with a non-terminal run is rejected ('active_runs') for
   * non-orchestrator actors; UNarchiving is never guarded.
   */
  archived?: boolean;
  /**
   * Decomposed toggle (idea-only, migration 042): true stamps `decomposed_at =
   * now`, false clears it. A stamped idea is OFF the board (retired; reachable
   * only via its children). NOT a stage move — the idea keeps its stage/column.
   * Rejected ('invalid_lineage') for epics/tasks. Idea retirement is now
   * EXCLUSIVELY gate-driven (no auto-retire on first child).
   */
  decomposed?: boolean;
  /**
   * Approved toggle (epics/tasks-only, migration 042 — the Q1 REVEAL): true
   * stamps `approved_at = now` (pending draft -> visible + sprint-eligible),
   * false clears it. ORCHESTRATOR-ONLY ('forbidden' for user/agent actors — an
   * agent must never self-approve its plan-gated drafts). Rejected
   * ('invalid_lineage') for ideas. Routing the reveal through the chokepoint
   * mints the entity_event + version bump + TaskChangedEvent broadcast that a
   * raw UPDATE would silently skip.
   */
  approved?: boolean;
  /** Optimistic-concurrency guard. If provided and != current version -> concurrency conflict. */
  expectedVersion?: number;
  /** The run that triggered this change, recorded on the entity_events row. */
  runId?: string;
  // ----- A/B experiment sandbox (migration 049) -----
  /**
   * CREATE path: stamp `experiment_id` on the new entity, sandboxing it (hidden
   * from the board + sandbox-scoped for updates). Supplied EXPLICITLY for the
   * orchestrator-created per-arm seed clones (which carry no runId); for a
   * run-created entity the stamp is derived from the creating run's own
   * experiment_id, so this field is only needed for the clone case.
   */
  experimentId?: string;
  /**
   * UPDATE path, ORCHESTRATOR-ONLY: clear the entity's `experiment_id` (SET NULL),
   * revealing it out of the sandbox. Minted as its own entity_event + broadcast so
   * a mounted board sees it appear. Used by experiments.decide on promote. Rejected
   * ('forbidden_stage') for non-orchestrator actors.
   */
  clearExperiment?: boolean;
  /**
   * UPDATE path: link this entity to the run that INTRODUCED it (post-merge bug
   * attribution, migration 049). A normal nullable scalar — human-settable (a user
   * declares "this bug was introduced by run X"), mints an entity_event + broadcast.
   * NOT orchestrator-restricted.
   */
  causedByRunId?: string | null;
  // ----- add-dependency path (task->task edge) -----
  /**
   * ADD-DEPENDENCY path: when set (alongside `taskId`), the change records a
   * task->task dependency edge — `taskId` is the BLOCKED task and
   * `dependsOnTaskId` is the PREREQUISITE. The write goes into
   * `task_dependencies` (NOT the entity table), is cycle-checked over the
   * existing blocking edges, INSERT-OR-IGNOREs on the UNIQUE constraint, and
   * appends a `dependency-added` entity_events row on the blocked task. This is
   * a dedicated branch in applyChange so it still serializes on the per-project
   * PQueue alongside every other entity write.
   */
  dependsOnTaskId?: string;
  /** Edge kind for the add-dependency path. Defaults to 'blocking'. */
  dependencyKind?: TaskDependencyKind;
  // ----- create-only fields (ignored on update) -----
  /** @deprecated use entityType. Kept so existing callers compile; entityType wins. */
  type?: TaskType;
  /** Initial title for the create path. */
  title?: string;
  /** Initial summary for the create path. */
  summary?: string | null;
  /** Initial body for the create path. */
  body?: string | null;
  /** Initial priority for the create path. Defaults to 'P2'. */
  priority?: Priority;
  /** Initial repo for the create path. */
  repo?: string | null;
  /** Initial scope for the create path (ideas only). */
  scope?: IdeaScope | null;
  /** Initial image attachments for the create path (ideas only, migration 028). */
  attachments?: IdeaAttachment[] | null;
  /** Board to create the entity on. Defaults to the project's default board. */
  boardId?: string;
  /** Stage to create the entity at. Defaults to the board's position-1 stage. */
  initialStageId?: string;
  /** Kind label for the emitted entity_events row. Defaults to a sensible value per path. */
  kind?: string;
}

// ---------------------------------------------------------------------------
// Internal row shapes for the SELECTs below.
// ---------------------------------------------------------------------------

/** The common columns every entity row exposes (super-set; lineage cols nullable per-table). */
interface EntityDbRow {
  id: string;
  project_id: number;
  ref: string;
  parent_epic_id: string | null;
  originating_idea_id: string | null;
  board_id: string;
  stage_id: string;
  entry_stage_id: string | null;
  title: string;
  summary: string | null;
  body: string | null;
  scope: IdeaScope | null;
  priority: Priority;
  repo: string | null;
  archived_at: string | null;
  /** Retire stamp (ideas-only, migration 042); NULL on epics/tasks + when on-board. */
  decomposed_at: string | null;
  /** Plan-approval stamp (epics/tasks-only, migration 042); NULL on ideas + when PENDING. */
  approved_at: string | null;
  /** JSON IdeaAttachment[] (ideas-only, migration 028); NULL on epics/tasks + when unset. */
  attachments: string | null;
  /** A/B experiment sandbox tag (migration 049); NULL on a normal board entity + pre-049 DBs. */
  experiment_id: string | null;
  /** Post-merge bug attribution (migration 049); the run that introduced this entity, else NULL. */
  caused_by_run_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

interface StageAuthorityRow {
  id: string;
  write_policy: 'asserted' | 'derived';
  is_terminal: number;
  position: number;
  board_id: string;
}

interface RunOverlayRow {
  id: string;
  status: string;
  outcome: string | null;
  current_step_id: string | null;
  steps_snapshot_json: string | null;
  workflow_id: string;
}

interface FieldDelta {
  field: string;
  from: unknown;
  to: unknown;
}

/** The board stage position considered "done" (merged & archived). */
const DONE_POSITION = 9;
/** The board stage entities enter development at — the LOW half of the derived pair. */
const READY_FOR_DEV_POSITION = 6;
/** Terminal hidden 'Won't do' stage — an explicit human parking, never derived. */
const WONT_DO_POSITION = 10;

/**
 * CREATE TYPE-DEFAULT (hybrid model, FIX-STAGE-MODEL A): when a create carries
 * NO explicit stage (initialStageId/stageId both undefined), the entity lands at
 * its type's natural starting stage. An explicit stage STILL wins (the agent can
 * override). Positions are verified against database.ts seedDefaultBoard:
 *   idea -> 1 (Idea), epic -> 6 (Ready for development), task -> 6 (Ready for development).
 */
const CREATE_DEFAULT_POSITION: Record<TaskType, number> = {
  idea: 1,
  epic: 6,
  task: 6,
};

/**
 * Q1 GUARD — the workflow step id of the planner/ship human "approve plan" gate.
 * A run whose frozen step set (steps_snapshot_json) includes this id is
 * PLAN-GATED: the epics+tasks it creates DURING planning stay PENDING
 * (approved_at NULL = backend-invisible + sprint-INELIGIBLE) until the gate is
 * approved (stamping workflow_runs.plan_approved_at). Mirrors
 * questionRouter.ts's APPROVE_PLAN_STEP_ID — kept LOCAL to preserve this file's
 * standalone-typecheck invariant (importing it from questionRouter would re-enter
 * the TaskChangeRouter ⇄ questionRouter module cycle).
 */
const APPROVE_PLAN_STEP_ID = 'approve-plan';

/**
 * Plan-gated built-in workflow names — the FALLBACK plan-gated signal used only
 * when a run's steps_snapshot_json is absent/unparseable (both built-ins carry an
 * approve-plan gate). The primary signal is the snapshot itself.
 */
const PLAN_GATED_WORKFLOW_NAMES = new Set(['planner', 'ship']);

// ---------------------------------------------------------------------------
// TaskChangeRouter
// ---------------------------------------------------------------------------

export class TaskChangeRouter {
  private static instance: TaskChangeRouter | null = null;

  /** Per-project serialization queues (ref minting + version bumps are project-scoped). */
  private projectQueues = new Map<number, PQueue>();

  /** Cached `${table}.${column}` existence (backward-compat shim for pre-042 / partial test DBs). */
  private columnExistsCache = new Map<string, boolean>();

  constructor(private readonly db: DatabaseLike) {}

  // --------------------------------------------------------------------------
  // Lifecycle (singleton, mirroring ApprovalRouter)
  // --------------------------------------------------------------------------

  static initialize(db: DatabaseLike): TaskChangeRouter {
    TaskChangeRouter.instance = new TaskChangeRouter(db);
    return TaskChangeRouter.instance;
  }

  static getInstance(): TaskChangeRouter {
    if (!TaskChangeRouter.instance) {
      throw new Error(
        'TaskChangeRouter has not been initialized. Call TaskChangeRouter.initialize() from main/src/index.ts.',
      );
    }
    return TaskChangeRouter.instance;
  }

  /** Reset singleton — intended for tests only. */
  static _resetForTesting(): void {
    TaskChangeRouter.instance = null;
  }

  private getProjectQueue(projectId: number): PQueue {
    let q = this.projectQueues.get(projectId);
    if (!q) {
      q = new PQueue({ concurrency: 1 });
      this.projectQueues.set(projectId, q);
    }
    return q;
  }

  /** Test/seam helper — exposes the per-project queue for `.onIdle()` waits. */
  _queueForProject(projectId: number): PQueue {
    return this.getProjectQueue(projectId);
  }

  // --------------------------------------------------------------------------
  // Core API
  // --------------------------------------------------------------------------

  /**
   * Apply a single entity change atomically and emit the resulting event.
   *
   * Create path (no taskId): mints a ref via task_ref_counters keyed on the
   * entity type, inserts a row into the matching table at the position-1 stage
   * (or a given stage), then logs a 'created' event.
   *
   * Update path: resolves the entity type (from change.entityType or a 3-table
   * id lookup), validates lineage + stage authority + active-run guard +
   * optimistic concurrency, UPDATEs the row (bumping version + updated_at), and
   * appends a per-field delta to entity_events — all in ONE transaction.
   *
   * @returns the affected entity id + the inserted entity_events row id/seq.
   */
  async applyChange(
    projectId: number,
    change: TaskChange,
  ): Promise<{ taskId: string; dependsOnTaskId?: string; event: { id: number; seq: number } }> {
    const result = (await this.getProjectQueue(projectId).add(() => {
      if (change.taskId === undefined) {
        return this.runCreate(projectId, change);
      }
      if (change.dependsOnTaskId !== undefined) {
        return this.runAddDependency(projectId, change);
      }
      return this.runUpdate(projectId, change);
    })) as {
      taskId: string;
      dependsOnTaskId?: string;
      event: { id: number; seq: number };
      previousParentEpicId?: string | null;
    };

    // POST-COMMIT FOLLOW-ON (re-entrant per-project-queue block): roll a parent
    // epic's DERIVED stage up after a child-task write settles. Each hook re-enters
    // applyChange via recomputeEpicStage — but that write is an EPIC UPDATE (never a
    // task create/stage-move), so it cannot recurse back through these hooks:
    // hook (a) skips non-creates, and hook (b)'s SELECT on the epic id finds no
    // task row. Both are best-effort (a rollup failure must not fail the change).
    //
    // (a) CHILD-CREATE: a NEW task created under a parent epic revives an all-done
    //     epic from Done (9) back to Ready for development (6) — the new pending
    //     child means the epic is no longer fully done.
    if (
      change.taskId === undefined &&
      (change.entityType ?? change.type ?? 'idea') === 'task' &&
      change.parentEpicId
    ) {
      await this.recomputeEpicStage(change.parentEpicId).catch(() => {});
    }

    // (b) STAGE-MOVE / ARCHIVE-TOGGLE / REVEAL / RE-PARENT: any update that
    //     changes which children COUNT toward the rollup re-derives the parent
    //     epic. Covers merge->Done(9), sprint close-out->Done(9), a user drag off
    //     Done, the archive/unarchive toggle (an archived child leaves the
    //     countable set — archiving the last not-Done child must roll the epic to
    //     Done), the Q1 approved reveal (a pending child entering the countable
    //     set), and a RE-PARENT (the task changes which epic it counts under).
    //     The SELECT on tasks finds no row for epic/idea ids, so non-task updates
    //     fall through untouched.
    if (
      change.taskId !== undefined &&
      (change.stageId !== undefined ||
        change.archived !== undefined ||
        change.approved !== undefined ||
        change.parentEpicId !== undefined)
    ) {
      const parent = this.db
        .prepare('SELECT parent_epic_id AS parentEpicId FROM tasks WHERE id = ?')
        .get(change.taskId) as { parentEpicId: string | null } | undefined;
      const newParentEpicId = parent?.parentEpicId ?? null;
      if (newParentEpicId) {
        await this.recomputeEpicStage(newParentEpicId).catch(() => {});
      }
      // F7: a re-parent must ALSO re-derive the PREVIOUS parent (the task LEFT
      // it — its countable-child set shrank, so an all-Done remainder rolls the
      // old epic to Done). runUpdate captured the old parent before the UPDATE.
      const previousParentEpicId = result.previousParentEpicId ?? null;
      if (previousParentEpicId && previousParentEpicId !== newParentEpicId) {
        await this.recomputeEpicStage(previousParentEpicId).catch(() => {});
      }
    }

    // NOTE: creating the first child of an idea NO LONGER auto-retires the idea.
    // Idea retirement is now EXCLUSIVELY gate-driven (the approve-plan gate calls
    // retireIdeaToDecomposed) — required so the Q1 guard's post-approval
    // child-create does not prematurely retire the idea before the plan settles.
    return result;
  }

  /**
   * Retire an idea off the board by stamping `decomposed_at` (migration 042).
   * Idempotent: reads the idea's current decomposed_at and no-ops when it is
   * already stamped (or the idea cannot be resolved). Routes through applyChange
   * with actor='orchestrator' + the `decomposed` toggle so the stamp mints an
   * entity_event and emits the 'decomposed' action. The idea keeps its stage
   * (the stamp, not a stage move, takes it off the board) and its children are
   * left UNCHANGED — they carry the flow.
   *
   * Public so the ship materialize-batch seam (which has no planner-style human
   * Archive gate) can retire a shipped run's seed idea once its plan is approved
   * and materialized into sprint lanes. See mcpQueryHandler.handleCreateSprintBatch.
   */
  async retireIdeaToDecomposed(projectId: number, ideaId: string): Promise<void> {
    const idea = this.db
      .prepare('SELECT decomposed_at FROM ideas WHERE id = ? AND project_id = ?')
      .get(ideaId, projectId) as { decomposed_at: string | null } | undefined;
    if (!idea) return; // idea vanished or wrong project — nothing to retire
    if (idea.decomposed_at !== null) return; // already retired — idempotent no-op

    await this.applyChange(projectId, {
      actor: 'orchestrator',
      entityType: 'idea',
      taskId: ideaId,
      decomposed: true,
      kind: 'decomposed',
    });
  }

  /**
   * PERMANENTLY delete an entity and its cascade, atomically.
   *
   * Cascade set (children first):
   *   idea -> epics(originating_idea_id) + tasks(originating_idea_id)
   *           + tasks(parent_epic_id IN those epics), deduped;
   *   epic -> tasks(parent_epic_id);
   *   task -> itself.
   *
   * Guard: for non-orchestrator actors, ANY cascade task with a non-terminal
   * run rejects the whole delete ('active_runs') — nothing is deleted.
   *
   * One transaction deletes each entity's entity_events rows then the entity
   * row, children first (no event row survives — the entity is gone). Post
   * commit: pending review_items linked to deleted entities are dismissed
   * best-effort via ReviewItemRouter (ALL failures swallowed), then a
   * TaskChangedEvent { action: 'deleted', task: <pre-delete snapshot> } is
   * emitted per deleted entity on BOTH channels.
   *
   * Deliberately NOT exposed to MCP agents — GUI/tRPC + orchestrator only.
   */
  async applyDelete(
    projectId: number,
    opts: { actor: TaskActor; taskId: string; entityType?: TaskType; runId?: string },
  ): Promise<{ taskId: string; deletedIds: string[] }> {
    const result = (await this.getProjectQueue(projectId).add(() =>
      this.runDelete(projectId, opts),
    )) as {
      taskId: string;
      deletedIds: string[];
      survivingParentEpicIds: string[];
    };

    // POST-COMMIT FOLLOW-ON (outside the queue task — see the applyChange seam):
    // deleting a child task changes its parent epic's rollup inputs; re-derive
    // each SURVIVING parent. Best-effort, mirrors the archive-toggle hook.
    for (const epicId of result.survivingParentEpicIds) {
      await this.recomputeEpicStage(epicId).catch(() => {});
    }

    return { taskId: result.taskId, deletedIds: result.deletedIds };
  }

  /**
   * Q1 GUARD (decline/interrupt = no tasks): hard-delete the PENDING draft
   * entities a run CREATED during planning — the EPICS it minted (each epic's
   * applyDelete cascade takes its child tasks) and the ORPHAN tasks it minted
   * straight off the idea (no parent epic) — when its plan is DECLINED or the run
   * is torn down (cancel / dismiss) BEFORE approval.
   *
   * KEYED ON run_id (the entity_events created-event projection —
   * listRunCreatedEpicIds / listRunCreatedTaskIds), NOT the seed idea: a
   * decline -> replan re-mints fresh drafts under the SAME run_id, so keying on
   * run_id deletes exactly THIS attempt's drafts (and re-reveals the next
   * attempt's). The seed/owned idea is NEVER in the created-epic/task projection,
   * so it is structurally left intact — reachable for the replan.
   *
   * TRIPLE-gated — all three must hold or the helper no-ops:
   *  1. The run is PLAN-GATED (runIsPlanGated over its frozen step snapshot /
   *     workflow name). Non-plan-gated runs (compound, sprint, quick, custom)
   *     DO create run-keyed entities (e.g. compound's cyboflow_create_task
   *     clean-up tasks) — but those land approved_at=now and human-visible at
   *     create, so teardown must never sweep them.
   *  2. workflow_runs.plan_approved_at IS NULL: an APPROVED run's entities were
   *     revealed and accepted by the human.
   *  3. Per-entity approved_at IS NULL (belt-and-braces at the delete loop):
   *     only still-PENDING drafts are swept, whatever the run-level state says.
   * Fail-soft: a pre-042 DB lacking the columns, or a vanished run, degrades to
   * no-op.
   *
   * actor='orchestrator' on each applyDelete — EXEMPT from the active-run guard
   * (the run being torn down IS the active run). Per-entity best-effort: a task
   * already removed by its parent epic's cascade throws not_found, swallowed so
   * the rest proceed. Routes through applyDelete so each delete mints the proper
   * 'deleted' broadcast + review-item cleanup.
   */
  async deleteRunCreatedEntities(projectId: number, runId: string): Promise<void> {
    // Gates 1+2: only a PLAN-GATED run whose plan was never approved sweeps its
    // drafts. Fail-soft — a pre-042 DB lacking plan_approved_at (or a vanished
    // run) means no-op.
    try {
      const row = this.db
        .prepare(
          `SELECT r.plan_approved_at AS planApprovedAt,
                  r.steps_snapshot_json AS stepsSnapshotJson,
                  w.name AS workflowName
             FROM workflow_runs r
             LEFT JOIN workflows w ON w.id = r.workflow_id
            WHERE r.id = ?`,
        )
        .get(runId) as
        | { planApprovedAt?: unknown; stepsSnapshotJson?: unknown; workflowName?: unknown }
        | undefined;
      if (!row) return;
      if (row.planApprovedAt !== null && row.planApprovedAt !== undefined) return;
      if (!this.runIsPlanGated(row.stepsSnapshotJson, row.workflowName)) return;
    } catch {
      return;
    }

    // Gate 3: only still-PENDING drafts. A revealed (approved_at-stamped) entity
    // survives teardown even if the run row is somehow inconsistent.
    const isPendingEntity = (table: 'epics' | 'tasks', id: string): boolean => {
      try {
        const r = this.db
          .prepare(`SELECT approved_at AS approvedAt FROM ${table} WHERE id = ?`)
          .get(id) as { approvedAt?: unknown } | undefined;
        if (!r) return false; // already gone — nothing to delete
        return r.approvedAt === null || r.approvedAt === undefined;
      } catch {
        return false; // pre-042 schema (no approved_at) — treat as visible, spare it
      }
    };

    // The set of tasks THIS run created (entity_events attribution) — the same
    // projection the orphan-task sweep below uses. Used to tell a run-owned
    // pending child from a foreign task another run parented under this epic.
    const runCreatedTaskIds = new Set(listRunCreatedTaskIds(this.db, runId));

    // The run's created EPICS first. An epic's applyDelete cascade hard-deletes
    // ALL its child tasks (collectDeleteCascade WHERE parent_epic_id) regardless
    // of each child's own approved_at / creating run — so before deleting a
    // pending run-created epic we inspect its children (F2). If ANY child is not
    // BOTH (a) pending (approved_at NULL) AND (b) created by THIS run, the cascade
    // would destroy a visible or foreign task — SPARE the epic entirely (it stays
    // an invisible pending draft) and delete only this run's own pending children
    // individually, each still per-entity gated.
    for (const epicId of listRunCreatedEpicIds(this.db, runId)) {
      if (!isPendingEntity('epics', epicId)) continue;

      const childIds = this.db
        .prepare('SELECT id FROM tasks WHERE parent_epic_id = ?')
        .all(epicId) as Array<{ id: string }>;
      const foreignOrVisibleChild = childIds.some(
        (c) => !(isPendingEntity('tasks', c.id) && runCreatedTaskIds.has(c.id)),
      );

      if (foreignOrVisibleChild) {
        // Spare the epic; delete only THIS run's pending children under it.
        console.info(
          `[TaskChangeRouter] deleteRunCreatedEntities: sparing pending epic ${epicId} (run ${runId}) — a child is visible or foreign; the epic stays an invisible pending draft`,
        );
        for (const child of childIds) {
          if (!runCreatedTaskIds.has(child.id) || !isPendingEntity('tasks', child.id)) continue;
          try {
            await this.applyDelete(projectId, {
              actor: 'orchestrator',
              entityType: 'task',
              taskId: child.id,
              runId,
            });
          } catch {
            // Best-effort: the child may already be gone (concurrent teardown).
          }
        }
        continue;
      }

      try {
        await this.applyDelete(projectId, {
          actor: 'orchestrator',
          entityType: 'epic',
          taskId: epicId,
          runId,
        });
      } catch {
        // Best-effort: the epic may already be gone (concurrent teardown).
      }
    }

    // Then the run's ORPHAN tasks (minted straight off the idea, no parent epic).
    // Read AFTER the epic deletions so cascade-claimed tasks are already gone; a
    // straggler that still throws not_found here is swallowed.
    for (const taskId of listRunCreatedTaskIds(this.db, runId)) {
      if (!isPendingEntity('tasks', taskId)) continue;
      try {
        await this.applyDelete(projectId, {
          actor: 'orchestrator',
          entityType: 'task',
          taskId,
          runId,
        });
      } catch {
        // Best-effort: cascade-deleted or vanished — nothing left to delete.
      }
    }
  }

  /**
   * A/B DISCARD SWEEP (migration 049) — hard-delete a losing/abandoned experiment
   * arm's entities. A generalization of {@link deleteRunCreatedEntities} with the
   * plan-gating triple-gate replaced by an EXPERIMENT gate: a target is swept iff
   * its `experiment_id === experimentId` (belt-and-braces per entity), reusing the
   * same epic-cascade child-sparing shape. Enumerates the run's created
   * epics/tasks/ideas (entity_events) PLUS the explicit orchestrator-created seed
   * clone (`seedCloneId`, which has no run-created event). Routes each delete
   * through applyDelete (actor 'orchestrator', exempt from the active-run guard).
   *
   * HARD-delete, not archive: experiment entities were NEVER on the board (hidden
   * by the tag the whole time), so archiving would surface throwaway drafts as
   * clutter; the winner's content is preserved via the fold+reparent BEFORE the
   * loser is swept (see experiments.decide). Best-effort per entity.
   */
  async deleteExperimentArmEntities(
    projectId: number,
    opts: { experimentId: string; runId: string; seedCloneId?: string | null },
  ): Promise<void> {
    const { experimentId, runId, seedCloneId } = opts;

    // A target is swept iff its experiment_id matches. Fail-soft: a vanished row
    // or a pre-049 DB (no experiment_id column) spares it (never a wrong delete).
    const matchesExperiment = (table: 'ideas' | 'epics' | 'tasks', id: string): boolean => {
      try {
        const r = this.db
          .prepare(`SELECT experiment_id AS eid FROM ${table} WHERE id = ?`)
          .get(id) as { eid?: unknown } | undefined;
        if (!r) return false; // already gone
        return r.eid === experimentId;
      } catch {
        return false; // pre-049 schema (no experiment_id) — spare it
      }
    };

    const runCreatedTaskIds = new Set(listRunCreatedTaskIds(this.db, runId));

    // Run-created EPICS first (their applyDelete cascade claims child tasks). If a
    // child is NOT both (a) this experiment's AND (b) this run's, SPARE the epic
    // and delete only this run's matching children individually (belt-and-braces
    // against cross-arm contamination — id-isolation makes this rare).
    for (const epicId of listRunCreatedEpicIds(this.db, runId)) {
      if (!matchesExperiment('epics', epicId)) continue;
      const childIds = this.db
        .prepare('SELECT id FROM tasks WHERE parent_epic_id = ?')
        .all(epicId) as Array<{ id: string }>;
      const foreignChild = childIds.some(
        (c) => !(matchesExperiment('tasks', c.id) && runCreatedTaskIds.has(c.id)),
      );
      if (foreignChild) {
        for (const child of childIds) {
          if (!runCreatedTaskIds.has(child.id) || !matchesExperiment('tasks', child.id)) continue;
          try {
            await this.applyDelete(projectId, { actor: 'orchestrator', entityType: 'task', taskId: child.id, runId });
          } catch {
            /* best-effort */
          }
        }
        continue;
      }
      try {
        await this.applyDelete(projectId, { actor: 'orchestrator', entityType: 'epic', taskId: epicId, runId });
      } catch {
        /* best-effort */
      }
    }

    // Run-created ORPHAN tasks (read after epic deletions so cascade-claimed ones are gone).
    for (const taskId of listRunCreatedTaskIds(this.db, runId)) {
      if (!matchesExperiment('tasks', taskId)) continue;
      try {
        await this.applyDelete(projectId, { actor: 'orchestrator', entityType: 'task', taskId, runId });
      } catch {
        /* best-effort */
      }
    }

    // Run-created IDEAS (a raw-prompt arm may mint its own idea).
    for (const ideaId of listRunCreatedIdeaIds(this.db, runId)) {
      if (!matchesExperiment('ideas', ideaId)) continue;
      try {
        await this.applyDelete(projectId, { actor: 'orchestrator', entityType: 'idea', taskId: ideaId, runId });
      } catch {
        /* best-effort */
      }
    }

    // The explicit orchestrator-created seed clone (no run-created event links it).
    // Its applyDelete cascade claims any epics/tasks still parented under it.
    if (seedCloneId && matchesExperiment('ideas', seedCloneId)) {
      try {
        await this.applyDelete(projectId, { actor: 'orchestrator', entityType: 'idea', taskId: seedCloneId, runId });
      } catch {
        /* best-effort */
      }
    }
  }

  // --------------------------------------------------------------------------
  // Create path
  // --------------------------------------------------------------------------

  private runCreate(
    projectId: number,
    change: TaskChange,
  ): { taskId: string; event: { id: number; seq: number } } {
    const type: TaskType = change.entityType ?? change.type ?? 'idea';
    const desc = describe(type);
    const now = new Date().toISOString();
    const taskId = `${desc.idPrefix}_${randomBytes(10).toString('hex')}`;

    let eventId = 0;
    let eventSeq = 0;

    const txn = this.db.transaction(() => {
      // Resolve board (default) + stage (type-default position, or provided).
      const boardId = change.boardId ?? `board-${projectId}-default`;
      const board = this.db
        .prepare('SELECT id FROM boards WHERE id = ? AND project_id = ?')
        .get(boardId, projectId) as { id: string } | undefined;
      if (!board) {
        throw new TaskChangeError('not_found', `board ${boardId} not found for project ${projectId}`);
      }

      // FIX-STAGE-MODEL (A): an explicit initialStageId/stageId wins (hybrid —
      // the agent may override); otherwise default BY ENTITY TYPE via
      // stageIdForPosition so a created entity lands at its natural starting
      // stage (idea->Idea, epic->Epics extracted, task->Tasks extracted) instead
      // of every entity piling up at position 1.
      const typeDefaultStageId =
        this.stageIdForPosition(boardId, CREATE_DEFAULT_POSITION[type]) ?? `stage-${boardId}-1`;
      const stageId = change.initialStageId ?? change.stageId ?? typeDefaultStageId;
      const stage = this.lookupStage(stageId);
      if (!stage || stage.board_id !== boardId) {
        throw new TaskChangeError('not_found', `stage ${stageId} not found on board ${boardId}`);
      }
      // Authority check also applies on create.
      this.assertStageAuthority(change.actor, stage);

      // Validate lineage (only the columns this entity type carries).
      const parentEpicId = change.parentEpicId ?? null;
      let originatingIdeaId = change.originatingIdeaId ?? null;
      // DECOMP-LINKAGE FIX: a planner that decomposes a SMALL idea creates tasks
      // directly under the idea with no epic — but the MCP create path passes no
      // originatingIdeaId, so the task lands NULL/NULL and the whole decomposition
      // is invisible (countDecomposition + selectIdeaDecomposition both find no
      // task matching either lineage column). Stamp the run's seed idea onto a
      // task created during the run when the caller gave no explicit idea. Only
      // type='task' (epics already carry the idea via the planner's epic-create
      // path); only when seed_idea_id is present. Fail-soft: a missing column on
      // an older DB / missing run row degrades to NULL (the prior behaviour).
      if (originatingIdeaId === null && type === 'task' && change.runId) {
        try {
          const run = this.db
            .prepare('SELECT seed_idea_id AS seedIdeaId FROM workflow_runs WHERE id = ?')
            .get(change.runId) as { seedIdeaId?: unknown } | undefined;
          if (run && typeof run.seedIdeaId === 'string' && run.seedIdeaId.length > 0) {
            originatingIdeaId = run.seedIdeaId;
          }
          // Raw-prompt planner: no seed_idea_id because the idea was CREATED
          // during the run. Fall back to the most-recent idea this run created
          // (entity_events). The planner-one-idea model means a run owns a single
          // idea, so the latest 'created' idea is the decomposition's parent.
          if (originatingIdeaId === null) {
            const created = this.db
              .prepare(
                `SELECT entity_id AS ideaId FROM entity_events
                  WHERE entity_type = 'idea' AND kind = 'created' AND run_id = ?
                  ORDER BY seq DESC LIMIT 1`,
              )
              .get(change.runId) as { ideaId?: unknown } | undefined;
            if (created && typeof created.ideaId === 'string' && created.ideaId.length > 0) {
              originatingIdeaId = created.ideaId;
            }
          }
        } catch {
          // pre-017 DB / missing entity_events — leave NULL (no regression).
        }
      }
      if (parentEpicId !== null) {
        this.validateParentEpic(projectId, type, taskId, parentEpicId);
      }
      if (originatingIdeaId !== null) {
        this.validateOriginatingIdea(projectId, type, originatingIdeaId);
      }

      // Mint the ref: UPDATE ... RETURNING. INSERT OR IGNORE seeds the counter row first.
      const ref = this.mintRef(projectId, type);

      const title = change.title ?? change.fields?.title ?? 'Untitled';
      const summary = change.summary ?? change.fields?.summary ?? null;
      const body = change.body ?? change.fields?.body ?? null;
      const priority: Priority = change.priority ?? change.fields?.priority ?? 'P2';
      const repo = change.repo ?? change.fields?.repo ?? null;
      const scope = desc.hasScope ? (change.scope ?? change.fields?.scope ?? null) : null;
      // Attachments (ideas-only): serialize the array to JSON for the column; a
      // null/empty set stays NULL so the no-attachments case has no JSON noise.
      const attachmentsArr = desc.hasAttachments
        ? (change.attachments ?? change.fields?.attachments ?? null)
        : null;
      const attachments =
        attachmentsArr && attachmentsArr.length > 0 ? JSON.stringify(attachmentsArr) : null;

      // A/B SANDBOX (migration 049): the experiment this entity belongs to — the
      // EXPLICIT change.experimentId (orchestrator-created seed clones, no runId)
      // OR the creating run's own experiment_id (run-created drafts). A non-null
      // value hides the entity from the board + sandbox-scopes its future updates.
      const createExperimentId = this.resolveCreateExperimentId(change);

      // Q1 GUARD: an epic/task created during an UNAPPROVED plan-gated run lands
      // PENDING (approved_at NULL = backend-invisible + sprint-ineligible) until
      // the approve-plan gate flips the run's plan_approved_at; every other create
      // is VISIBLE (approved_at = now). Ideas never carry approved_at (always
      // visible — hasApproval=false). An experiment-tagged epic/task ALSO lands
      // PENDING regardless of gate (it must never surface until decide reveals it).
      const approvedAt = desc.hasApproval
        ? this.computeCreateApprovedAt(change, now, createExperimentId)
        : null;

      this.insertEntity(desc, {
        id: taskId,
        projectId,
        ref,
        title,
        summary,
        body,
        priority,
        repo,
        boardId,
        stageId,
        scope,
        attachments,
        approvedAt,
        parentEpicId,
        originatingIdeaId,
        experimentId: createExperimentId,
        now,
      });

      const changes: FieldDelta[] = [
        { field: 'ref', from: null, to: ref },
        { field: 'stage_id', from: null, to: stageId },
        { field: 'title', from: null, to: title },
      ];
      if (parentEpicId !== null) changes.push({ field: 'parent_epic_id', from: null, to: parentEpicId });
      if (originatingIdeaId !== null) changes.push({ field: 'originating_idea_id', from: null, to: originatingIdeaId });
      if (scope !== null) changes.push({ field: 'scope', from: null, to: scope });
      if (attachments !== null) changes.push({ field: 'attachments', from: null, to: attachments });

      const ev = this.insertEvent(type, taskId, change.kind ?? 'created', change.actor, change.runId ?? null, changes, now);
      eventId = ev.id;
      eventSeq = ev.seq;
    });
    (txn as () => void)();

    this.emitChange(projectId, type, taskId, 'created');
    return { taskId, event: { id: eventId, seq: eventSeq } };
  }

  /** INSERT a row into the matching entity table, only setting columns the table carries. */
  private insertEntity(
    desc: EntityTableDescriptor,
    v: {
      id: string;
      projectId: number;
      ref: string;
      title: string;
      summary: string | null;
      body: string | null;
      priority: Priority;
      repo: string | null;
      boardId: string;
      stageId: string;
      scope: IdeaScope | null;
      /** Pre-serialized JSON IdeaAttachment[] (ideas-only) or null. */
      attachments: string | null;
      /** Q1 plan-gate stamp (epics/tasks only); null = PENDING, non-null = VISIBLE. */
      approvedAt: string | null;
      parentEpicId: string | null;
      originatingIdeaId: string | null;
      /** A/B experiment sandbox tag (migration 049); null = normal board entity. */
      experimentId: string | null;
      now: string;
    },
  ): void {
    const cols = ['id', 'project_id', 'ref', 'title', 'summary', 'body', 'priority', 'repo', 'board_id', 'stage_id'];
    const vals: unknown[] = [v.id, v.projectId, v.ref, v.title, v.summary, v.body, v.priority, v.repo, v.boardId, v.stageId];

    if (desc.hasScope) {
      cols.push('scope');
      vals.push(v.scope);
    }
    if (desc.hasAttachments) {
      cols.push('attachments');
      vals.push(v.attachments);
    }
    // Q1 plan-gate stamp (epics/tasks). Gated on the column actually existing so
    // pre-042 schemas / partial-migration test DBs (which omit approved_at) keep
    // inserting without 'no such column'; production (post-042) always has it.
    if (desc.hasApproval && this.columnExists(desc.table, 'approved_at')) {
      cols.push('approved_at');
      vals.push(v.approvedAt);
    }
    // A/B experiment sandbox tag (migration 049). Gated on the column existing so
    // pre-049 / partial-migration test DBs keep inserting; only stamps a non-null
    // value on an experiment-created entity (every other create passes null).
    if (this.columnExists(desc.table, 'experiment_id')) {
      cols.push('experiment_id');
      vals.push(v.experimentId);
    }
    if (desc.hasEntryStage) {
      cols.push('entry_stage_id');
      vals.push(null);
    }
    if (desc.hasParentEpic) {
      cols.push('parent_epic_id');
      vals.push(v.parentEpicId);
    }
    if (desc.hasOriginatingIdea) {
      cols.push('originating_idea_id');
      vals.push(v.originatingIdeaId);
    }
    cols.push('version', 'created_at', 'updated_at');
    vals.push(1, v.now, v.now);

    const placeholders = cols.map(() => '?').join(', ');
    this.db.prepare(`INSERT INTO ${desc.table} (${cols.join(', ')}) VALUES (${placeholders})`).run(...vals);
  }

  /** Mint the next ref for (project, type). Seeds the counter first; UPDATE ... RETURNING is atomic in txn. */
  private mintRef(projectId: number, type: TaskType): string {
    this.db
      .prepare('INSERT OR IGNORE INTO task_ref_counters (project_id, type, next_seq) VALUES (?, ?, 0)')
      .run(projectId, type);
    const counter = this.db
      .prepare(
        'UPDATE task_ref_counters SET next_seq = next_seq + 1 WHERE project_id = ? AND type = ? RETURNING next_seq',
      )
      .get(projectId, type) as { next_seq: number };
    return `${type.toUpperCase()}-${String(counter.next_seq).padStart(3, '0')}`;
  }

  /**
   * Q1 GUARD — compute the approved_at stamp for a CREATED epic/task.
   *
   * NULL = PENDING (backend-invisible + sprint-INELIGIBLE) until the creating
   * run's approve-plan gate is approved; a non-null stamp = VISIBLE. A planner/
   * ship run mints its epics+tasks DURING the plan, BEFORE the human approves it
   * at the approve-plan gate — those entities must stay pending until approval
   * stamps workflow_runs.plan_approved_at (and the promote step settles them).
   * Every other create lands VISIBLE: a user/manual create (no runId), a
   * non-plan-gated flow (e.g. sprint), or a run whose plan is already approved.
   *
   * Fail-soft: a missing/unreadable run row, or a pre-042 schema with no
   * plan_approved_at column, degrades to VISIBLE (the prior, no-guard behaviour).
   * Only consulted for epics/tasks (desc.hasApproval); ideas never call this.
   */
  /**
   * A/B SANDBOX (migration 049): resolve the experiment_id a CREATED entity
   * belongs to. Precedence: an EXPLICIT `change.experimentId` (the orchestrator
   * stamps it on the per-arm seed clones, which have no runId) wins; otherwise the
   * creating run's OWN experiment_id (so every entity a tagged run mints inherits
   * the sandbox). Fail-soft: a missing column / vanished run degrades to null (a
   * normal, board-visible entity — the prior behaviour).
   */
  private resolveCreateExperimentId(change: TaskChange): string | null {
    if (typeof change.experimentId === 'string' && change.experimentId.length > 0) {
      return change.experimentId;
    }
    return this.runExperimentIdFor(change.runId);
  }

  /**
   * The experiment_id stamped on a run (migration 048), or null. Fail-soft: no
   * runId, a vanished run, or a pre-048 DB (no experiment_id column) all yield
   * null. Used by both the create-tag derivation and the update sandbox guard.
   */
  private runExperimentIdFor(runId?: string): string | null {
    if (!runId) return null;
    try {
      const run = this.db
        .prepare('SELECT experiment_id AS experimentId FROM workflow_runs WHERE id = ?')
        .get(runId) as { experimentId?: unknown } | undefined;
      return typeof run?.experimentId === 'string' && run.experimentId.length > 0
        ? run.experimentId
        : null;
    } catch {
      return null; // pre-048 DB (no experiment_id column) -> untagged
    }
  }

  /**
   * The experiment_id tag on a TASK row (migration 049), or null. Fail-soft: a
   * vanished task or a pre-049 DB (no experiment_id column) yields null. Used by
   * the add-dependency sandbox guard, which cannot read `current.experiment_id`
   * (runAddDependency has no located-entity row like runUpdate does).
   */
  private taskExperimentIdFor(taskId: string): string | null {
    try {
      const row = this.db
        .prepare('SELECT experiment_id AS experimentId FROM tasks WHERE id = ?')
        .get(taskId) as { experimentId?: unknown } | undefined;
      return typeof row?.experimentId === 'string' && row.experimentId.length > 0
        ? row.experimentId
        : null;
    } catch {
      return null; // pre-049 DB (no experiment_id column) -> untagged
    }
  }

  private computeCreateApprovedAt(
    change: TaskChange,
    now: string,
    createExperimentId: string | null,
  ): string | null {
    // A/B SANDBOX: an experiment-tagged epic/task is PENDING until decide reveals
    // it — never visible mid-experiment regardless of the plan gate.
    if (createExperimentId !== null) return null;
    if (!change.runId) return now; // user/manual create or no creating run -> visible
    let run:
      | { planApprovedAt?: unknown; stepsSnapshotJson?: unknown; workflowName?: unknown }
      | undefined;
    try {
      run = this.db
        .prepare(
          `SELECT r.plan_approved_at AS planApprovedAt,
                  r.steps_snapshot_json AS stepsSnapshotJson,
                  w.name AS workflowName
             FROM workflow_runs r
             LEFT JOIN workflows w ON w.id = r.workflow_id
            WHERE r.id = ?`,
        )
        .get(change.runId) as
        | { planApprovedAt?: unknown; stepsSnapshotJson?: unknown; workflowName?: unknown }
        | undefined;
    } catch {
      return now; // pre-042 DB (no plan_approved_at column) / older schema -> visible
    }
    if (!run) return now; // run vanished -> visible (fail-soft)
    // Plan already approved -> children are visible immediately.
    if (typeof run.planApprovedAt === 'string' && run.planApprovedAt.length > 0) return now;
    // Plan-gated AND still-unapproved -> PENDING.
    if (this.runIsPlanGated(run.stepsSnapshotJson, run.workflowName)) return null;
    return now; // non-plan-gated run -> visible
  }

  /**
   * Whether the creating run is PLAN-GATED. PRIMARY signal: its frozen step set
   * (steps_snapshot_json = { [stepId]: agent }) includes the approve-plan gate —
   * trusted definitively when present + parseable. FALLBACK (snapshot absent or
   * unparseable): a planner/ship built-in is treated as plan-gated.
   */
  private runIsPlanGated(stepsSnapshotJson: unknown, workflowName: unknown): boolean {
    if (typeof stepsSnapshotJson === 'string' && stepsSnapshotJson.length > 0) {
      try {
        const snapshot = JSON.parse(stepsSnapshotJson) as Record<string, unknown>;
        return Object.prototype.hasOwnProperty.call(snapshot, APPROVE_PLAN_STEP_ID);
      } catch {
        // malformed snapshot — fall through to the workflow-name fallback
      }
    }
    return typeof workflowName === 'string' && PLAN_GATED_WORKFLOW_NAMES.has(workflowName);
  }

  /**
   * Whether `table` carries `column`, cached per `${table}.${column}`. Backward-
   * compat shim: pre-042 schemas (and the partial-migration in-memory DBs used by
   * sibling unit suites) lack approved_at, so the create-path INSERT must SKIP the
   * column there instead of throwing 'no such column'. Mirrors the PRAGMA
   * table_info probe used across database.ts. Fail-soft: a PRAGMA error -> absent.
   */
  private columnExists(table: string, column: string): boolean {
    const key = `${table}.${column}`;
    const cached = this.columnExistsCache.get(key);
    if (cached !== undefined) return cached;
    let present = false;
    try {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
      present = rows.some((r) => r.name === column);
    } catch {
      present = false;
    }
    this.columnExistsCache.set(key, present);
    return present;
  }

  // --------------------------------------------------------------------------
  // Update path
  // --------------------------------------------------------------------------

  private runUpdate(
    projectId: number,
    change: TaskChange,
  ): { taskId: string; event: { id: number; seq: number }; previousParentEpicId?: string | null } {
    const taskId = change.taskId as string;
    const now = new Date().toISOString();

    let eventId = 0;
    let eventSeq = 0;
    let action: TaskChangeAction = 'updated';
    let resolvedType: TaskType = 'task';
    // F7: the task's parent epic BEFORE a re-parent, captured inside the txn so
    // the post-commit rollup hook can re-derive the epic the task LEFT (not just
    // the one it joined). Stays null when the change is not an actual re-parent.
    let previousParentEpicId: string | null = null;

    const txn = this.db.transaction(() => {
      // Resolve the entity type: prefer the declared discriminator, else look up
      // the id across all three tables.
      const located = this.locateEntity(projectId, taskId, change.entityType);
      if (!located) {
        throw new TaskChangeError('not_found', `entity ${taskId} not found for project ${projectId}`);
      }
      const { type, row: current } = located;
      resolvedType = type;
      const desc = describe(type);

      // Optimistic concurrency.
      if (change.expectedVersion !== undefined && change.expectedVersion !== current.version) {
        throw new TaskChangeError(
          'concurrency',
          `entity ${taskId} version is ${current.version}, expected ${change.expectedVersion}`,
        );
      }

      // A/B SANDBOX GUARD (migration 049) — BIDIRECTIONAL, before every per-kind
      // branch so ALL update kinds (fields/stage/archive/reparent/originatingIdea)
      // are denied uniformly. The orchestrator is EXEMPT — only its promote/fold/
      // sweep/reveal (clearExperiment) paths legitimately cross the boundary.
      //   (a) an experiment-tagged run may write ONLY entities of its OWN
      //       experiment (blocks mutating the original seed idea, the main board,
      //       or a different experiment's entities);
      //   (b) an untagged actor (user edit / other run) may NOT write a hidden
      //       experiment-tagged entity (it is sandboxed until decide reveals it).
      if (change.actor !== 'orchestrator') {
        const runExperimentId = this.runExperimentIdFor(change.runId);
        const entityExperimentId = current.experiment_id ?? null;
        if (runExperimentId !== null) {
          if (entityExperimentId !== runExperimentId) {
            throw new TaskChangeError(
              'experiment_sandboxed',
              `entity ${taskId} is outside this experiment arm's sandbox — create a new entity instead of editing shared/main-board entities`,
            );
          }
        } else if (entityExperimentId !== null) {
          throw new TaskChangeError(
            'experiment_sandboxed',
            `entity ${taskId} belongs to an experiment sandbox and cannot be edited until the experiment is decided`,
          );
        }
      }

      const deltas: FieldDelta[] = [];
      const sets: string[] = [];
      const params: unknown[] = [];
      /** Default event kind for the archive toggle ('archived'|'unarchived'); change.kind still wins. */
      let archiveKind: string | null = null;

      // ----- stage move -----
      if (change.stageId !== undefined && change.stageId !== current.stage_id) {
        const targetStage = this.lookupStage(change.stageId);
        if (!targetStage) {
          throw new TaskChangeError('not_found', `stage ${change.stageId} not found`);
        }
        // AUTHORITY: derived stages are orchestrator-only.
        this.assertStageAuthority(change.actor, targetStage);
        // ACTIVE-RUN GUARD: a user/agent assert on a task with a non-terminal run is rejected
        // to avoid an asserted/derived tug-of-war. The orchestrator is exempt (it OWNS derived moves).
        if (change.actor !== 'orchestrator' && this.hasNonTerminalRun(taskId)) {
          throw new TaskChangeError('active_runs', 'cancel active runs first');
        }
        sets.push('stage_id = ?');
        params.push(change.stageId);
        deltas.push({ field: 'stage_id', from: current.stage_id, to: change.stageId });
        action = 'stageMoved';
      }

      // ----- decomposed toggle (idea retire stamp, migration 042) -----
      // Mirrors the archive toggle: idea-only, NOT a stage move. Stamping
      // decomposed_at takes the idea OFF the board (reachable only via children,
      // which are LEFT UNCHANGED). Surface the distinct 'decomposed' action so the
      // UI can react — the prior position-12 'Decomposed' stage's meaning.
      if (change.decomposed !== undefined) {
        if (!desc.hasDecomposed) {
          throw new TaskChangeError(
            'invalid_lineage',
            `only type='idea' may be decomposed (got '${type}')`,
          );
        }
        if (change.decomposed !== (current.decomposed_at !== null)) {
          const decomposedAt = change.decomposed ? now : null;
          sets.push('decomposed_at = ?');
          params.push(decomposedAt);
          deltas.push({ field: 'decomposed_at', from: current.decomposed_at, to: decomposedAt });
          action = 'decomposed';
        }
      }

      // ----- approved toggle (Q1 reveal stamp, migration 042) -----
      // Mirrors the decomposed toggle: epics/tasks-only, NOT a stage move.
      // Stamping approved_at reveals a PENDING draft (board-visible +
      // sprint-eligible). Orchestrator-only: the reveal belongs to the
      // approve-plan gate — an agent must never self-approve its drafts.
      if (change.approved !== undefined) {
        if (!desc.hasApproval) {
          throw new TaskChangeError(
            'invalid_lineage',
            `only epics/tasks carry approved_at (got '${type}')`,
          );
        }
        if (change.actor !== 'orchestrator') {
          throw new TaskChangeError('forbidden_stage', 'approved_at is orchestrator-derived');
        }
        if (change.approved !== (current.approved_at !== null)) {
          const approvedAt = change.approved ? now : null;
          sets.push('approved_at = ?');
          params.push(approvedAt);
          deltas.push({ field: 'approved_at', from: current.approved_at, to: approvedAt });
        }
      }

      // ----- clearExperiment toggle (A/B reveal, migration 049) -----
      // ORCHESTRATOR-ONLY: experiments.decide clears the winner's sandbox tag,
      // revealing it out of the experiment. Minting it through the chokepoint (vs a
      // raw UPDATE) gives the entity_event + version bump + broadcast a mounted
      // board needs to render the reveal. No-op if already clear.
      if (change.clearExperiment === true) {
        if (change.actor !== 'orchestrator') {
          throw new TaskChangeError('forbidden_stage', 'experiment_id is orchestrator-cleared');
        }
        if (this.columnExists(desc.table, 'experiment_id') && current.experiment_id !== null) {
          sets.push('experiment_id = ?');
          params.push(null);
          deltas.push({ field: 'experiment_id', from: current.experiment_id, to: null });
        }
      }

      // ----- causedByRunId scalar (post-merge bug attribution, migration 049) -----
      // A normal nullable scalar — human-settable ("this bug was introduced by run
      // X"). NOT orchestrator-restricted. Guarded on the column existing (pre-049).
      if (change.causedByRunId !== undefined && this.columnExists(desc.table, 'caused_by_run_id')) {
        const next = change.causedByRunId ?? null;
        if (next !== (current.caused_by_run_id ?? null)) {
          sets.push('caused_by_run_id = ?');
          params.push(next);
          deltas.push({ field: 'caused_by_run_id', from: current.caused_by_run_id ?? null, to: next });
        }
      }

      // ----- archive toggle (archive-in-place, migration 024) -----
      if (change.archived !== undefined && change.archived !== (current.archived_at !== null)) {
        // ACTIVE-RUN GUARD: archiving a task with a non-terminal run is rejected
        // for user/agent actors (mirrors the stage-move guard — archiving hides
        // the card while the orchestrator still drives it). UNarchiving is never
        // guarded, and the orchestrator is exempt.
        if (change.archived && change.actor !== 'orchestrator' && this.hasNonTerminalRun(taskId)) {
          throw new TaskChangeError('active_runs', 'cancel active runs first');
        }
        const archivedAt = change.archived ? now : null;
        sets.push('archived_at = ?');
        params.push(archivedAt);
        deltas.push({ field: 'archived_at', from: current.archived_at, to: archivedAt });
        // action stays 'updated' (not a stage move); only the event kind specializes.
        archiveKind = change.archived ? 'archived' : 'unarchived';
      }

      // ----- re-parent (tasks only) -----
      if (change.parentEpicId !== undefined && change.parentEpicId !== current.parent_epic_id) {
        if (!desc.hasParentEpic) {
          throw new TaskChangeError('invalid_parent', `only type='task' may have a parent epic (got '${type}')`);
        }
        if (change.parentEpicId !== null) {
          this.validateParentEpic(projectId, type, taskId, change.parentEpicId);
        }
        // Capture the OLD parent so the rollup hook re-derives it too (the task
        // is leaving it — its countable-child set shrank).
        previousParentEpicId = current.parent_epic_id;
        sets.push('parent_epic_id = ?');
        params.push(change.parentEpicId);
        deltas.push({ field: 'parent_epic_id', from: current.parent_epic_id, to: change.parentEpicId });
      }

      // ----- originating idea (epics + tasks) -----
      if (change.originatingIdeaId !== undefined && change.originatingIdeaId !== current.originating_idea_id) {
        if (!desc.hasOriginatingIdea) {
          throw new TaskChangeError(
            'invalid_lineage',
            `only epics/tasks may have an originating idea (got '${type}')`,
          );
        }
        if (change.originatingIdeaId !== null) {
          this.validateOriginatingIdea(projectId, type, change.originatingIdeaId);
        }
        sets.push('originating_idea_id = ?');
        params.push(change.originatingIdeaId);
        deltas.push({ field: 'originating_idea_id', from: current.originating_idea_id, to: change.originatingIdeaId });
      }

      // ----- scalar fields -----
      const f = change.fields;
      if (f) {
        if (f.title !== undefined && f.title !== current.title) {
          sets.push('title = ?');
          params.push(f.title);
          deltas.push({ field: 'title', from: current.title, to: f.title });
        }
        if (f.summary !== undefined && f.summary !== current.summary) {
          sets.push('summary = ?');
          params.push(f.summary);
          deltas.push({ field: 'summary', from: current.summary, to: f.summary });
        }
        if (f.body !== undefined && f.body !== current.body) {
          sets.push('body = ?');
          params.push(f.body);
          deltas.push({ field: 'body', from: current.body, to: f.body });
        }
        if (f.priority !== undefined && f.priority !== current.priority) {
          sets.push('priority = ?');
          params.push(f.priority);
          deltas.push({ field: 'priority', from: current.priority, to: f.priority });
        }
        if (f.repo !== undefined && f.repo !== current.repo) {
          sets.push('repo = ?');
          params.push(f.repo);
          deltas.push({ field: 'repo', from: current.repo, to: f.repo });
        }
        if (f.scope !== undefined && desc.hasScope && f.scope !== current.scope) {
          sets.push('scope = ?');
          params.push(f.scope);
          deltas.push({ field: 'scope', from: current.scope, to: f.scope });
        }
        if (f.attachments !== undefined && desc.hasAttachments) {
          // Whole-array replace; serialize to JSON (null/[] -> NULL) and compare
          // against the stored JSON so an unchanged set is a no-op.
          const nextAttachments =
            f.attachments && f.attachments.length > 0 ? JSON.stringify(f.attachments) : null;
          if (nextAttachments !== current.attachments) {
            sets.push('attachments = ?');
            params.push(nextAttachments);
            deltas.push({ field: 'attachments', from: current.attachments, to: nextAttachments });
          }
        }
        if (f.entryStageId !== undefined && desc.hasEntryStage && f.entryStageId !== current.entry_stage_id) {
          sets.push('entry_stage_id = ?');
          params.push(f.entryStageId);
          deltas.push({ field: 'entry_stage_id', from: current.entry_stage_id, to: f.entryStageId });
        }
      }

      // No-op guard: if nothing actually changed, do NOT bump version or write an event.
      // This preserves the no-orphan-UPDATE invariant (no updated_at change without an event row).
      if (deltas.length === 0) {
        const last = this.db
          .prepare(
            'SELECT id, seq FROM entity_events WHERE entity_type = ? AND entity_id = ? ORDER BY seq DESC LIMIT 1',
          )
          .get(type, taskId) as { id: number; seq: number } | undefined;
        eventId = last?.id ?? 0;
        eventSeq = last?.seq ?? 0;
        return;
      }

      // Atomic state + event write. Version bump + updated_at always accompany an event row.
      sets.push('version = version + 1');
      sets.push('updated_at = ?');
      params.push(now);
      params.push(taskId);
      this.db.prepare(`UPDATE ${desc.table} SET ${sets.join(', ')} WHERE id = ?`).run(...params);

      const ev = this.insertEvent(
        type,
        taskId,
        change.kind ?? archiveKind ?? action,
        change.actor,
        change.runId ?? null,
        deltas,
        now,
      );
      eventId = ev.id;
      eventSeq = ev.seq;
    });
    (txn as () => void)();

    this.emitChange(projectId, resolvedType, taskId, action);
    return { taskId, event: { id: eventId, seq: eventSeq }, previousParentEpicId };
  }

  // --------------------------------------------------------------------------
  // Delete path
  // --------------------------------------------------------------------------

  private async runDelete(
    projectId: number,
    opts: { actor: TaskActor; taskId: string; entityType?: TaskType; runId?: string },
  ): Promise<{ taskId: string; deletedIds: string[]; survivingParentEpicIds: string[] }> {
    const located = this.locateEntity(projectId, opts.taskId, opts.entityType);
    if (!located) {
      throw new TaskChangeError('not_found', `entity ${opts.taskId} not found for project ${projectId}`);
    }

    // Cascade set, children first (tasks -> epics -> root) so the txn below can
    // delete in array order without tripping the lineage FKs' ON DELETE SET NULL.
    const cascade = this.collectDeleteCascade(projectId, located.type, opts.taskId);

    // ACTIVE-RUN GUARD over the WHOLE cascade: a single task with a non-terminal
    // run rejects the delete (the orchestrator is exempt — it owns run teardown).
    if (opts.actor !== 'orchestrator') {
      for (const entity of cascade) {
        if (entity.type === 'task' && this.hasNonTerminalRun(entity.id)) {
          throw new TaskChangeError('active_runs', `task ${entity.id} has an active run — cancel it first`);
        }
      }
    }

    // Snapshot every entity BEFORE deletion — the 'deleted' emit carries the
    // last-known read-model item (the row is unreadable after commit).
    const snapshots = cascade.map((entity) => ({
      ...entity,
      snapshot: this.buildBacklogTaskItem(entity.type, entity.id),
    }));

    // Parent epics whose rollup inputs this delete changes: read BEFORE the
    // rows vanish, keep only parents that SURVIVE the cascade (a deleted parent
    // needs no re-derive). Deleting the last not-Done child must roll the
    // surviving epic to Done — mirrors the archive-toggle hook.
    const cascadeIds = new Set(cascade.map((e) => e.id));
    const survivingParentEpicIds = new Set<string>();
    for (const entity of cascade) {
      if (entity.type !== 'task') continue;
      const parent = this.db
        .prepare('SELECT parent_epic_id AS parentEpicId FROM tasks WHERE id = ?')
        .get(entity.id) as { parentEpicId: string | null } | undefined;
      if (parent?.parentEpicId && !cascadeIds.has(parent.parentEpicId)) {
        survivingParentEpicIds.add(parent.parentEpicId);
      }
    }

    const txn = this.db.transaction(() => {
      for (const entity of cascade) {
        this.db
          .prepare('DELETE FROM entity_events WHERE entity_type = ? AND entity_id = ?')
          .run(entity.type, entity.id);
        this.db.prepare(`DELETE FROM ${describe(entity.type).table} WHERE id = ?`).run(entity.id);
      }
    });
    (txn as () => void)();

    // Post-commit, best-effort: dismiss pending review_items linked to the
    // deleted entities (single-writer respected — through ReviewItemRouter).
    await this.dismissReviewItemsForDeleted(projectId, opts.actor, opts.runId ?? null, cascade);

    // Post-commit: one 'deleted' event per entity, pre-delete snapshot attached.
    for (const { id, snapshot } of snapshots) {
      if (!snapshot) continue; // vanished before the snapshot read — nothing to broadcast
      this.broadcast(projectId, { projectId, taskId: id, action: 'deleted', task: snapshot });
    }

    // NOTE: the rollup re-derive happens in applyDelete AFTER this queue task
    // settles — recomputeEpicStage re-enters applyChange, and enqueueing onto
    // the same per-project queue from INSIDE a queue task would deadlock.
    return {
      taskId: opts.taskId,
      deletedIds: cascade.map((e) => e.id),
      survivingParentEpicIds: [...survivingParentEpicIds],
    };
  }

  /**
   * Collect the delete cascade for a root entity, ordered children first
   * (tasks, then epics, then the root). Task ids reachable BOTH directly
   * (originating_idea_id) and via a cascade epic (parent_epic_id) are deduped.
   */
  private collectDeleteCascade(
    projectId: number,
    rootType: TaskType,
    rootId: string,
  ): Array<{ type: TaskType; id: string }> {
    const taskIds = new Set<string>();
    const epicIds: string[] = [];

    if (rootType === 'idea') {
      const epics = this.db
        .prepare('SELECT id FROM epics WHERE originating_idea_id = ? AND project_id = ?')
        .all(rootId, projectId) as Array<{ id: string }>;
      epicIds.push(...epics.map((r) => r.id));

      const directTasks = this.db
        .prepare('SELECT id FROM tasks WHERE originating_idea_id = ? AND project_id = ?')
        .all(rootId, projectId) as Array<{ id: string }>;
      for (const r of directTasks) taskIds.add(r.id);

      if (epicIds.length > 0) {
        const placeholders = epicIds.map(() => '?').join(',');
        const epicTasks = this.db
          .prepare(`SELECT id FROM tasks WHERE parent_epic_id IN (${placeholders})`)
          .all(...epicIds) as Array<{ id: string }>;
        for (const r of epicTasks) taskIds.add(r.id);
      }
    } else if (rootType === 'epic') {
      const childTasks = this.db
        .prepare('SELECT id FROM tasks WHERE parent_epic_id = ? AND project_id = ?')
        .all(rootId, projectId) as Array<{ id: string }>;
      for (const r of childTasks) taskIds.add(r.id);
    }
    // rootType === 'task': no children — the cascade is the task itself.

    return [
      ...[...taskIds].map((id) => ({ type: 'task' as TaskType, id })),
      ...epicIds.map((id) => ({ type: 'epic' as TaskType, id })),
      { type: rootType, id: rootId },
    ];
  }

  /**
   * Dismiss pending review_items soft-linked to the deleted entities through
   * the ReviewItemRouter chokepoint (status 'dismissed', resolution 'entity
   * deleted'). STRICTLY best-effort: every failure is swallowed — including an
   * uninitialized ReviewItemRouter singleton (unit tests) and per-item triage
   * errors — because the entity delete has already committed and must not be
   * reported as failed.
   */
  private async dismissReviewItemsForDeleted(
    projectId: number,
    actor: TaskActor,
    runId: string | null,
    deleted: Array<{ type: TaskType; id: string }>,
  ): Promise<void> {
    try {
      const reviewRouter = ReviewItemRouter.getInstance();
      for (const entity of deleted) {
        const pending = this.db
          .prepare(
            `SELECT id FROM review_items
              WHERE project_id = ? AND status = 'pending' AND entity_type = ? AND entity_id = ?`,
          )
          .all(projectId, entity.type, entity.id) as Array<{ id: string }>;
        for (const row of pending) {
          try {
            await reviewRouter.applyReviewItem(projectId, {
              op: 'dismiss',
              actor,
              reviewItemId: row.id,
              resolution: 'entity deleted',
              runId,
            });
          } catch {
            // Best-effort per item — a failed dismissal must not block the rest.
          }
        }
      }
    } catch {
      // Best-effort overall — swallow EVERYTHING (incl. uninitialized singleton).
    }
  }

  // --------------------------------------------------------------------------
  // Add-dependency path (task->task edge in task_dependencies)
  // --------------------------------------------------------------------------

  /**
   * Record a task->task dependency edge. `taskId` is the BLOCKED task,
   * `change.dependsOnTaskId` the PREREQUISITE. Each endpoint may be given as the
   * opaque `tasks.id` OR its display `ref` (e.g. `TASK-001`): agents reasoning
   * over the seeded sprint set only ever see refs (the `# Sprint tasks` block
   * renders refs, not opaque ids), so both endpoints are resolved id-or-ref to
   * the canonical id BEFORE any validation/storage — a ref-keyed call must not be
   * rejected `invalid_dependency` when the task is real (observed 2026-06-22, the
   * programmatic sprint dependency step). Both must be real TASKS in this project
   * (dependencies are task-only; ideas/epics never carry one). The edge:
   *   1. resolves both endpoints id-or-ref + validates existence and same project
   *      (`invalid_dependency` when either fails to resolve / is foreign),
   *   2. rejects self-edges on the RESOLVED ids (`invalid_dependency`) — so a
   *      mixed ref/id self-edge (`TASK-001` vs its `tsk_…`) is still caught,
   *   3. is cycle-checked over the existing blocking-edge closure
   *      (`dependency_cycle`) — only `blocking` edges form the DAG, so `related`
   *      edges skip the cycle guard,
   *   4. INSERT-OR-IGNOREs the RESOLVED ids (the UNIQUE(task_id, depends_on_task_id)
   *      makes a re-add a no-op),
   *   5. appends a `dependency-added` entity_events row on the blocked task so
   *      the change is in the faithful changelog.
   *
   * Returns the BLOCKED task's canonical id + the (new or last) entity_events
   * row. A dup re-add returns the most recent event without writing a new one.
   */
  private runAddDependency(
    projectId: number,
    change: TaskChange,
  ): { taskId: string; dependsOnTaskId: string; event: { id: number; seq: number } } {
    const rawTaskId = change.taskId as string;
    const rawDependsOn = change.dependsOnTaskId as string;
    const kind: TaskDependencyKind = change.dependencyKind ?? 'blocking';
    const now = new Date().toISOString();

    // Resolved canonical ids — assigned inside the txn, read by the post-txn
    // dup-lookup / emitChange / return so a ref-keyed call still keys everything
    // downstream on the opaque id.
    let blockedId = '';
    let prereqId = '';
    let eventId = 0;
    let eventSeq = 0;
    let wroteEdge = false;

    const txn = this.db.transaction(() => {
      // Resolve BOTH endpoints id-or-ref. Both must be real tasks in this
      // project (dependencies are task-only — ideas/epics never participate in
      // the execution DAG). Error messages carry the RAW input the caller sent
      // so a bad ref is legible (`task TASK-999 not found`).
      const blocked = this.resolveTaskByRefOrId(projectId, rawTaskId);
      if (!blocked) {
        throw new TaskChangeError('invalid_dependency', `task ${rawTaskId} not found`);
      }
      if (blocked.project_id !== projectId) {
        throw new TaskChangeError('invalid_dependency', `task ${rawTaskId} belongs to a different project`);
      }
      const prereq = this.resolveTaskByRefOrId(projectId, rawDependsOn);
      if (!prereq) {
        throw new TaskChangeError('invalid_dependency', `prerequisite task ${rawDependsOn} not found`);
      }
      if (prereq.project_id !== projectId) {
        throw new TaskChangeError(
          'invalid_dependency',
          `prerequisite task ${rawDependsOn} belongs to a different project`,
        );
      }
      blockedId = blocked.id;
      prereqId = prereq.id;

      // Self-edge guard — compare the RESOLVED ids so a mixed ref/id self-edge
      // (a ref on one endpoint, the same task's opaque id on the other) is caught.
      if (blockedId === prereqId) {
        throw new TaskChangeError('invalid_dependency', 'a task cannot depend on itself');
      }

      // A/B SANDBOX GUARD (migration 049) — BIDIRECTIONAL, mirroring runUpdate.
      // The DAG edge mutates the blocked task's dependency state + mints a
      // 'dependency-added' event/broadcast on it, so the same sandbox boundary
      // applies here as to any other update. The orchestrator is EXEMPT (its
      // promote/reveal paths legitimately span cleared entities):
      //   (a) an experiment-tagged run may only add an edge when BOTH endpoints
      //       belong to its OWN experiment (never touch main-board / other arms);
      //   (b) an untagged actor may NOT add an edge touching a hidden
      //       experiment-tagged task (sandboxed until decide reveals it).
      if (change.actor !== 'orchestrator') {
        const runExperimentId = this.runExperimentIdFor(change.runId);
        const blockedExperimentId = this.taskExperimentIdFor(blockedId);
        const prereqExperimentId = this.taskExperimentIdFor(prereqId);
        if (runExperimentId !== null) {
          if (blockedExperimentId !== runExperimentId || prereqExperimentId !== runExperimentId) {
            throw new TaskChangeError(
              'experiment_sandboxed',
              'dependency endpoints are outside this experiment arm\'s sandbox — both tasks must belong to this experiment',
            );
          }
        } else if (blockedExperimentId !== null || prereqExperimentId !== null) {
          throw new TaskChangeError(
            'experiment_sandboxed',
            'cannot add a dependency touching an experiment-sandboxed task until the experiment is decided',
          );
        }
      }

      // Idempotent no-op: the edge already exists (any kind on this pair).
      const existing = this.db
        .prepare('SELECT kind FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?')
        .get(blockedId, prereqId) as { kind: string } | undefined;
      if (existing) {
        return; // wroteEdge stays false — surface the last event below
      }

      // Cycle guard: only blocking edges form the ordering DAG. Reject an edge
      // that would create a cycle in the transitive closure of blocking edges.
      if (kind === 'blocking') {
        this.validateDependencyEdge(blockedId, prereqId);
      }

      // INSERT OR IGNORE — the UNIQUE(task_id, depends_on_task_id) makes a
      // racing re-add a no-op even if the SELECT above missed it.
      this.db
        .prepare(
          'INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, kind) VALUES (?, ?, ?)',
        )
        .run(blockedId, prereqId, kind);

      const deltas: FieldDelta[] = [
        { field: 'depends_on_task_id', from: null, to: prereqId },
        { field: 'dependency_kind', from: null, to: kind },
      ];
      const ev = this.insertEvent(
        'task',
        blockedId,
        change.kind ?? 'dependency-added',
        change.actor,
        change.runId ?? null,
        deltas,
        now,
      );
      eventId = ev.id;
      eventSeq = ev.seq;
      wroteEdge = true;
    });
    (txn as () => void)();

    // Dup re-add: surface the most recent entity_events row so callers still get
    // a stable { id, seq } (no new event was written).
    if (!wroteEdge) {
      const last = this.db
        .prepare(
          'SELECT id, seq FROM entity_events WHERE entity_type = ? AND entity_id = ? ORDER BY seq DESC LIMIT 1',
        )
        .get('task', blockedId) as { id: number; seq: number } | undefined;
      eventId = last?.id ?? 0;
      eventSeq = last?.seq ?? 0;
    } else {
      this.emitChange(projectId, 'task', blockedId, 'updated');
    }

    return { taskId: blockedId, dependsOnTaskId: prereqId, event: { id: eventId, seq: eventSeq } };
  }

  /**
   * Resolve a task identifier that may be EITHER the opaque `tasks.id` (`tsk_…`)
   * OR its display `ref` (`TASK-001`) to the canonical row. Opaque id wins (an
   * exact `id` match is tried first); on a miss the lookup falls back to the
   * project-scoped `ref` (UNIQUE(project_id, ref) ⇒ unambiguous). Returns
   * undefined when neither resolves. Used by `runAddDependency` so agents — which
   * only see display refs in the seeded `# Sprint tasks` block — can record edges
   * by ref while the stored edge + the fan-out DAG key on the opaque id.
   */
  private resolveTaskByRefOrId(
    projectId: number,
    identifier: string,
  ): { id: string; project_id: number } | undefined {
    const byId = this.db
      .prepare('SELECT id, project_id FROM tasks WHERE id = ?')
      .get(identifier) as { id: string; project_id: number } | undefined;
    if (byId) return byId;
    return this.db
      .prepare('SELECT id, project_id FROM tasks WHERE project_id = ? AND ref = ?')
      .get(projectId, identifier) as { id: string; project_id: number } | undefined;
  }

  // --------------------------------------------------------------------------
  // Entity location / per-table reads
  // --------------------------------------------------------------------------

  /**
   * Resolve an id to its entity type + row. If `declared` is given, only that
   * table is read (the boundary asserted the discriminator); otherwise all three
   * tables are tried in turn (idea -> epic -> task). Returns undefined when no
   * matching row exists in the relevant table(s).
   */
  private locateEntity(
    projectId: number,
    id: string,
    declared?: TaskType,
  ): { type: TaskType; row: EntityDbRow } | undefined {
    const order: TaskType[] = declared ? [declared] : ['idea', 'epic', 'task'];
    for (const type of order) {
      const row = this.readEntity(type, projectId, id);
      if (row) return { type, row };
    }
    return undefined;
  }

  /**
   * Read one entity row from its table, normalizing the per-table column set to
   * the common EntityDbRow super-set (lineage columns absent on a table read
   * back as null).
   */
  private readEntity(type: TaskType, projectId: number, id: string): EntityDbRow | undefined {
    const desc = describe(type);
    const parentEpic = desc.hasParentEpic ? 'parent_epic_id' : 'NULL AS parent_epic_id';
    const originatingIdea = desc.hasOriginatingIdea ? 'originating_idea_id' : 'NULL AS originating_idea_id';
    const entryStage = desc.hasEntryStage ? 'entry_stage_id' : 'NULL AS entry_stage_id';
    const scope = desc.hasScope ? 'scope' : 'NULL AS scope';
    const attachments = desc.hasAttachments ? 'attachments' : 'NULL AS attachments';
    const decomposedAt = desc.hasDecomposed ? 'decomposed_at' : 'NULL AS decomposed_at';
    const approvedAt =
      desc.hasApproval && this.columnExists(desc.table, 'approved_at')
        ? 'approved_at'
        : 'NULL AS approved_at';
    // A/B experiment tag + attribution (migration 049), fail-soft on pre-049 / partial test DBs.
    const experimentId = this.columnExists(desc.table, 'experiment_id')
      ? 'experiment_id'
      : 'NULL AS experiment_id';
    const causedByRunId = this.columnExists(desc.table, 'caused_by_run_id')
      ? 'caused_by_run_id'
      : 'NULL AS caused_by_run_id';
    const row = this.db
      .prepare(
        `SELECT id, project_id, ref, title, summary, body, priority, repo, board_id, stage_id, archived_at,
                ${decomposedAt}, ${approvedAt}, ${experimentId}, ${causedByRunId}, version, created_at, updated_at, ${parentEpic}, ${originatingIdea}, ${entryStage}, ${scope}, ${attachments}
           FROM ${desc.table} WHERE id = ? AND project_id = ?`,
      )
      .get(id, projectId) as EntityDbRow | undefined;
    return row;
  }

  // --------------------------------------------------------------------------
  // recomputeTaskExecutionStage — the AGGREGATE over a task's runs.
  // --------------------------------------------------------------------------

  /**
   * Recompute and write the DERIVED execution stage for a TASK by aggregating
   * over ALL its runs (supports parallel runs). Tasks are the only execution
   * entity, so this reads the `tasks` table directly. Writes via applyChange
   * with actor='orchestrator' + entityType='task'.
   *
   * Aggregation (first match wins):
   *   any outcome='merged'             -> done (position 9)
   *   else (runs nonempty, no merge)   -> entry_stage_id (fallback Ready-for-dev, position 6)
   *   else (no runs)                   -> no-op
   *
   * The board collapsed to four kept stages (Idea / Ready for development / Done /
   * Won't do), so there is no longer an in-development or ready-to-merge stage to
   * derive: EVERY non-merged run-state (running, awaiting_review, pr_open,
   * integrated, pending approval, or all-terminal-without-merge) holds the task at
   * its entry stage until a run actually merges into main.
   */
  async recomputeTaskExecutionStage(taskId: string): Promise<void> {
    const task = this.db
      .prepare('SELECT id, project_id, board_id, stage_id, entry_stage_id FROM tasks WHERE id = ?')
      .get(taskId) as
      | { id: string; project_id: number; board_id: string; stage_id: string; entry_stage_id: string | null }
      | undefined;
    if (!task) {
      throw new TaskChangeError('not_found', `task ${taskId} not found`);
    }

    const runs = this.db
      .prepare('SELECT id, status, outcome FROM workflow_runs WHERE task_id = ?')
      .all(taskId) as Array<{ id: string; status: string; outcome: string | null }>;

    if (runs.length === 0) {
      // No runs: leave the asserted planning stage untouched.
      return;
    }

    let targetStageId: string | null = null;

    const anyMerged = runs.some((r) => r.outcome === 'merged');

    if (anyMerged) {
      targetStageId = this.stageIdForPosition(task.board_id, DONE_POSITION); // done
    } else {
      // Every non-merged aggregate (running, awaiting_review, pr_open, integrated,
      // pending approval, or all-terminal-without-merge) holds the task at its
      // entry stage (fallback Ready for development, position 6).
      targetStageId = task.entry_stage_id ?? this.stageIdForPosition(task.board_id, READY_FOR_DEV_POSITION);
    }

    if (!targetStageId || targetStageId === task.stage_id) {
      return; // already there, or no resolvable target
    }

    await this.applyChange(task.project_id, {
      actor: 'orchestrator',
      entityType: 'task',
      taskId,
      stageId: targetStageId,
      kind: 'execution-stage',
    });
  }

  // --------------------------------------------------------------------------
  // recomputeEpicStage — the ROLLUP over an epic's child tasks.
  // --------------------------------------------------------------------------

  /**
   * Recompute and write the DERIVED stage for an EPIC by aggregating over its
   * COUNTABLE child tasks. Epics never carry runs, so — unlike a task — the
   * epic stage is a pure rollup of where its children sit on the board.
   *
   * A child COUNTS toward the rollup only when it is on the visible board and
   * still in play:
   *   - not archived (archived_at IS NULL — off the board),
   *   - not parked at 'Won't do' (position 10 — an explicit human retirement
   *     must neither block the epic's Done nor demote an all-Done epic),
   *   - not a PENDING draft (approved_at IS NULL — backend-invisible; an
   *     invisible draft must not move a visible epic).
   *
   * Aggregation over the countable set:
   *   all countable children at Done (9) -> Done (9)
   *   any countable child not yet Done   -> Ready for development (6)
   *   no countable children              -> no-op (epic keeps its stage)
   *
   * OWNERSHIP POLICY (F9): the rollup owns ONLY the DERIVED pair Ready for
   * development (6) <-> Done (9). An epic whose CURRENT stage is anything else —
   * Idea (1), Won't do (10), or any future position — is a human-asserted parking
   * and is NEVER re-derived by a child event. This subsumes the old Won't-do-only
   * guard: a child stage-move must not resurrect a parked epic, whatever position
   * the human chose.
   *
   * Writes via applyChange with actor='orchestrator' + entityType='epic', so the
   * orchestrator clears assertStageAuthority and the (epic-irrelevant) active-run
   * guard. The write is an epic UPDATE — never a task create/stage-move — so it
   * cannot recurse back into this rollup. Idempotent: a target equal to the epic's
   * current stage (or an unresolvable target) is a no-op.
   */
  async recomputeEpicStage(epicId: string): Promise<void> {
    const epic = this.db
      .prepare('SELECT id, project_id, board_id, stage_id FROM epics WHERE id = ?')
      .get(epicId) as
      | { id: string; project_id: number; board_id: string; stage_id: string }
      | undefined;
    if (!epic) {
      throw new TaskChangeError('not_found', `epic ${epicId} not found`);
    }

    // OWNERSHIP POLICY (F9): the rollup owns ONLY the derived pair {6, 9}. An
    // epic parked anywhere else (Idea=1, Won't do=10, any future position) is
    // human-asserted and never re-derived; bail before touching it. An
    // unresolvable stage row is likewise left untouched.
    const epicStage = this.lookupStage(epic.stage_id);
    if (
      !epicStage ||
      (epicStage.position !== READY_FOR_DEV_POSITION && epicStage.position !== DONE_POSITION)
    ) {
      return;
    }

    // Countable children (mirrors the epic-children query shape in
    // taskListing.selectTaskById): non-archived, not Won't-do, not pending.
    // approved_at gated behind the columnExists shim for pre-042 test DBs.
    const approvedFilter = this.columnExists('tasks', 'approved_at')
      ? 'AND t.approved_at IS NOT NULL'
      : '';
    const children = this.db
      .prepare(
        `SELECT bs.position AS position
           FROM tasks t
           JOIN board_stages bs ON bs.id = t.stage_id
          WHERE t.parent_epic_id = ? AND t.archived_at IS NULL
            AND bs.position != ${WONT_DO_POSITION} ${approvedFilter}`,
      )
      .all(epicId) as Array<{ position: number }>;

    if (children.length === 0) {
      // No countable children: leave the epic where it is.
      return;
    }

    const allDone = children.every((c) => c.position === DONE_POSITION);
    // allDone -> Done (9); otherwise hold at Ready for development (position 6).
    const targetStageId = this.stageIdForPosition(
      epic.board_id,
      allDone ? DONE_POSITION : READY_FOR_DEV_POSITION,
    );

    if (!targetStageId || targetStageId === epic.stage_id) {
      return; // already there, or no resolvable target
    }

    await this.applyChange(epic.project_id, {
      actor: 'orchestrator',
      entityType: 'epic',
      taskId: epicId,
      stageId: targetStageId,
      kind: 'execution-stage',
    });
  }

  // --------------------------------------------------------------------------
  // Validation / authority helpers
  // --------------------------------------------------------------------------

  private lookupStage(stageId: string): StageAuthorityRow | undefined {
    return this.db
      .prepare('SELECT id, write_policy, is_terminal, position, board_id FROM board_stages WHERE id = ?')
      .get(stageId) as StageAuthorityRow | undefined;
  }

  private stageIdForPosition(boardId: string, position: number): string | null {
    const row = this.db
      .prepare('SELECT id FROM board_stages WHERE board_id = ? AND position = ?')
      .get(boardId, position) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** AUTHORITY: derived stages are orchestrator-only. Reject user/agent actors. */
  private assertStageAuthority(actor: TaskActor, stage: StageAuthorityRow): void {
    if (stage.write_policy === 'derived' && actor !== 'orchestrator') {
      throw new TaskChangeError('forbidden_stage', 'execution stage is orchestrator-derived');
    }
  }

  /** A non-terminal run exists for the task (used by the active-run guard). */
  private hasNonTerminalRun(taskId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM workflow_runs
          WHERE task_id = ?
            AND status NOT IN ('completed', 'failed', 'canceled')
          LIMIT 1`,
      )
      .get(taskId) as { 1: number } | undefined;
    return row !== undefined;
  }

  private hasPendingApprovals(runIds: string[]): boolean {
    if (runIds.length === 0) return false;
    const placeholders = runIds.map(() => '?').join(',');
    const row = this.db
      .prepare(`SELECT 1 FROM approvals WHERE status = 'pending' AND run_id IN (${placeholders}) LIMIT 1`)
      .get(...runIds) as { 1: number } | undefined;
    return row !== undefined;
  }

  /**
   * Validate a parent epic reference: only type='task' may carry one; the parent
   * must exist in `epics`, be in the same project, and not create a cycle (the
   * parent epic must not itself originate from this task — and a task can never
   * be its own parent).
   */
  private validateParentEpic(projectId: number, childType: TaskType, childId: string, parentId: string): void {
    if (!describe(childType).hasParentEpic) {
      throw new TaskChangeError('invalid_parent', `only type='task' may have a parent epic (got '${childType}')`);
    }
    if (parentId === childId) {
      throw new TaskChangeError('invalid_parent', 'a task cannot be its own parent');
    }
    const parent = this.db
      .prepare('SELECT id, project_id, originating_idea_id FROM epics WHERE id = ?')
      .get(parentId) as { id: string; project_id: number; originating_idea_id: string | null } | undefined;
    if (!parent) {
      throw new TaskChangeError('invalid_parent', `parent epic ${parentId} not found`);
    }
    if (parent.project_id !== projectId) {
      throw new TaskChangeError('invalid_parent', `parent epic ${parentId} belongs to a different project`);
    }
    // An epic cannot originate from the very task that points at it (cycle guard).
    if (parent.originating_idea_id === childId) {
      throw new TaskChangeError('invalid_parent', 'parent/child cycle detected');
    }
  }

  /**
   * Cycle guard for a proposed BLOCKING dependency edge `(blockedId ->
   * dependsOnId)` — "blockedId is blocked by dependsOnId". The blocking edges
   * form a DAG: a row `(task_id=A, depends_on_task_id=B)` means A waits for B,
   * so the directed edge A -> B points from dependent to prerequisite. Adding
   * the new edge `blocked -> prereq` creates a cycle iff `prereq` can already
   * reach `blocked` by following existing `task_id -> depends_on_task_id`
   * blocking edges (i.e. prereq already transitively depends on blocked).
   *
   * DFS the transitive closure of blocking edges starting at `dependsOnId`; if
   * it ever reaches `blockedId` the proposed edge would close a cycle. Mirrors
   * the lineage cycle guard in validateParentEpic, generalized to the full
   * task_dependencies graph. Rejects with `dependency_cycle`.
   */
  private validateDependencyEdge(blockedId: string, dependsOnId: string): void {
    // A direct A->A self-loop is rejected earlier; this walks the existing graph.
    const stmt = this.db.prepare(
      "SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? AND kind = 'blocking'",
    );
    const visited = new Set<string>();
    const stack: string[] = [dependsOnId];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === blockedId) {
        throw new TaskChangeError(
          'dependency_cycle',
          `adding dependency ${blockedId} -> ${dependsOnId} would create a cycle`,
        );
      }
      if (visited.has(current)) continue;
      visited.add(current);
      const next = stmt.all(current) as Array<{ depends_on_task_id: string }>;
      for (const edge of next) {
        stack.push(edge.depends_on_task_id);
      }
    }
  }

  /**
   * Validate an originating-idea reference: only epics/tasks may carry one; the
   * idea must exist in `ideas` and be in the same project.
   */
  private validateOriginatingIdea(projectId: number, childType: TaskType, ideaId: string): void {
    if (!describe(childType).hasOriginatingIdea) {
      throw new TaskChangeError(
        'invalid_lineage',
        `only epics/tasks may have an originating idea (got '${childType}')`,
      );
    }
    const idea = this.db
      .prepare('SELECT id, project_id FROM ideas WHERE id = ?')
      .get(ideaId) as { id: string; project_id: number } | undefined;
    if (!idea) {
      throw new TaskChangeError('invalid_lineage', `originating idea ${ideaId} not found`);
    }
    if (idea.project_id !== projectId) {
      throw new TaskChangeError('invalid_lineage', `originating idea ${ideaId} belongs to a different project`);
    }
  }

  // --------------------------------------------------------------------------
  // Event write + emit
  // --------------------------------------------------------------------------

  private insertEvent(
    entityType: TaskType,
    entityId: string,
    kind: string,
    actor: TaskActor,
    runId: string | null,
    changes: FieldDelta[],
    now: string,
  ): { id: number; seq: number } {
    const maxRow = this.db
      .prepare('SELECT MAX(seq) AS maxSeq FROM entity_events WHERE entity_type = ? AND entity_id = ?')
      .get(entityType, entityId) as { maxSeq: number | null };
    const seq = (maxRow.maxSeq ?? 0) + 1;
    const info = this.db
      .prepare(
        `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id, changes_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entityType, entityId, seq, kind, actor, runId, JSON.stringify(changes), now) as {
      lastInsertRowid: number | bigint;
    };
    return { id: Number(info.lastInsertRowid), seq };
  }

  private emitChange(projectId: number, type: TaskType, taskId: string, action: TaskChangeAction): void {
    const task = this.buildBacklogTaskItem(type, taskId);
    if (!task) return; // deleted between commit and emit — nothing to broadcast
    this.broadcast(projectId, { projectId, taskId, action, task });
  }

  /** Emit one event on BOTH the per-project channel and the cross-project TASK_ALL_CHANNEL. */
  private broadcast(projectId: number, event: TaskChangedEvent): void {
    taskChangeEvents.emit(taskProjectChannel(projectId), event);
    taskChangeEvents.emit(TASK_ALL_CHANNEL, event);
  }

  /**
   * Build the single-entity read-model item carried by the emitted event,
   * including derived overlays. This is a SELF-CONTAINED projection (it does
   * NOT nest children) so the router has no dependency on the consumer's
   * taskListing.ts. The richer list/nesting projection lives there.
   *
   * Reads from the table matching `type` (incl body); execution overlays only
   * ever attach to tasks (ideas/epics have no workflow_runs link), but the
   * derivation is type-agnostic — a non-task simply has zero matching runs.
   */
  private buildBacklogTaskItem(type: TaskType, taskId: string): BacklogTaskItem | null {
    const row = this.readEntity(type, this.projectIdOf(type, taskId) ?? -1, taskId);
    if (!row) return null;

    const stage = this.lookupStage(row.stage_id);
    const isTerminal = stage ? stage.is_terminal === 1 : false;
    const isDonePosition = stage ? stage.position === DONE_POSITION : false;

    const runs = this.db
      .prepare(
        `SELECT id, status, outcome, current_step_id, steps_snapshot_json, workflow_id
           FROM workflow_runs WHERE task_id = ?`,
      )
      .all(taskId) as RunOverlayRow[];

    const inFlow: FlowOverlay[] = runs
      .filter((r) => r.status === 'running')
      .map((r) => ({
        agent: this.resolveAgentLabel(r),
        runId: r.id,
        stepId: r.current_step_id ?? null,
      }));

    const runIds = runs.map((r) => r.id);
    const awaitingReview =
      runs.some(
        (r) => r.status === 'awaiting_review' || r.outcome === 'pr_open' || r.outcome === 'integrated',
      ) ||
      this.hasPendingApprovals(runIds);

    const isDone = isTerminal && isDonePosition;

    return {
      id: row.id,
      project_id: row.project_id,
      type,
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
      // Visibility stamps (migration 042). MUST be projected on the emit path:
      // the frontend selectors compare `!== null`, so an omitted (undefined)
      // stamp silently flips board visibility on every live event.
      decomposed_at: row.decomposed_at,
      approved_at: row.approved_at,
      // A/B sandbox tag (migration 049). Same silent-drop rationale as the
      // visibility stamps: the client `isExperimentSandboxed` selector compares
      // `!== null`, so it MUST be projected on the emit path.
      experiment_id: row.experiment_id ?? null,
      version: row.version,
      stage_position: stage?.position ?? 0,
      inFlow,
      awaitingReview,
      isDone,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /** Cheap project_id lookup for the post-commit emit read (the row exists). */
  private projectIdOf(type: TaskType, id: string): number | undefined {
    const row = this.db
      .prepare(`SELECT project_id FROM ${describe(type).table} WHERE id = ?`)
      .get(id) as { project_id: number } | undefined;
    return row?.project_id;
  }

  /**
   * Resolve the agent label for a running run's current step from the launch
   * snapshot (steps_snapshot_json = { [stepId]: agent }). Falls back to the
   * step id, then a generic 'agent' label.
   */
  private resolveAgentLabel(run: RunOverlayRow): string {
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
}
