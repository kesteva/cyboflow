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
 * Decomposition: moving an IDEA to the Decomposed terminal stage is an allowed
 * asserted move; children are left UNCHANGED (no cascade) — they carry the flow.
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
}

const ENTITY_TABLES: Record<TaskType, EntityTableDescriptor> = {
  idea: { table: 'ideas', idPrefix: 'ide', hasParentEpic: false, hasOriginatingIdea: false, hasEntryStage: false, hasScope: true, hasAttachments: true },
  epic: { table: 'epics', idPrefix: 'epc', hasParentEpic: false, hasOriginatingIdea: true, hasEntryStage: false, hasScope: false, hasAttachments: false },
  task: { table: 'tasks', idPrefix: 'tsk', hasParentEpic: true, hasOriginatingIdea: true, hasEntryStage: true, hasScope: false, hasAttachments: false },
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
  | 'dependency_cycle';

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
  /** Optimistic-concurrency guard. If provided and != current version -> concurrency conflict. */
  expectedVersion?: number;
  /** The run that triggered this change, recorded on the entity_events row. */
  runId?: string;
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
  /** JSON IdeaAttachment[] (ideas-only, migration 028); NULL on epics/tasks + when unset. */
  attachments: string | null;
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

/** The board stage position at which an idea is considered "decomposed" (idea-only terminal). */
const DECOMPOSED_POSITION = 12;
/** The board stage position considered "done" (merged & archived). */
const DONE_POSITION = 9;

/**
 * CREATE TYPE-DEFAULT (hybrid model, FIX-STAGE-MODEL A): when a create carries
 * NO explicit stage (initialStageId/stageId both undefined), the entity lands at
 * its type's natural starting stage. An explicit stage STILL wins (the agent can
 * override). Positions are verified against database.ts seedDefaultBoard:
 *   idea -> 1 (Idea), epic -> 4 (Epics extracted), task -> 5 (Tasks extracted).
 */
const CREATE_DEFAULT_POSITION: Record<TaskType, number> = {
  idea: 1,
  epic: 4,
  task: 5,
};

// ---------------------------------------------------------------------------
// TaskChangeRouter
// ---------------------------------------------------------------------------

export class TaskChangeRouter {
  private static instance: TaskChangeRouter | null = null;

  /** Per-project serialization queues (ref minting + version bumps are project-scoped). */
  private projectQueues = new Map<number, PQueue>();

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
  ): Promise<{ taskId: string; event: { id: number; seq: number } }> {
    const result = (await this.getProjectQueue(projectId).add(() => {
      if (change.taskId === undefined) {
        return this.runCreate(projectId, change);
      }
      if (change.dependsOnTaskId !== undefined) {
        return this.runAddDependency(projectId, change);
      }
      return this.runUpdate(projectId, change);
    })) as { taskId: string; event: { id: number; seq: number } };

    // FIX-STAGE-MODEL (B): when a CREATE introduces the FIRST child of an idea
    // (an epic OR task carrying originatingIdeaId), the originating idea retires
    // to the Decomposed terminal stage — the children carry the flow forward.
    // Done as a FOLLOW-ON orchestrator applyChange AFTER the child create commits
    // (NOT a re-entrant nested applyChange inside the create txn, which would
    // self-deadlock the per-project PQueue). Idempotent: a no-op when the idea is
    // already terminal/Decomposed. Failures are swallowed (the child create has
    // already committed; retiring the idea is best-effort housekeeping).
    if (change.taskId === undefined && change.originatingIdeaId) {
      const isChildType = (change.entityType ?? change.type ?? 'idea') !== 'idea';
      if (isChildType) {
        await this.decomposeOriginatingIdea(projectId, change.originatingIdeaId).catch(() => {
          // Best-effort: the child already exists; a failure here must not bubble
          // up and fail the create the caller already observed as successful.
        });
      }
    }

    return result;
  }

  /**
   * Retire an originating idea to the Decomposed terminal stage (FIX-STAGE-MODEL
   * B). Idempotent: reads the idea's current stage position and no-ops when it is
   * already at the Decomposed position (or the idea / Decomposed stage cannot be
   * resolved). Routes through applyChange with actor='orchestrator' so the move
   * mints an entity_event and emits the 'decomposed' action like any other
   * idea->Decomposed transition. Called as a FOLLOW-ON (post-commit), never
   * nested inside another applyChange transaction.
   */
  private async decomposeOriginatingIdea(projectId: number, ideaId: string): Promise<void> {
    const idea = this.db
      .prepare('SELECT board_id, stage_id FROM ideas WHERE id = ? AND project_id = ?')
      .get(ideaId, projectId) as { board_id: string; stage_id: string } | undefined;
    if (!idea) return; // idea vanished or wrong project — nothing to retire

    const decomposedStageId = this.stageIdForPosition(idea.board_id, DECOMPOSED_POSITION);
    if (!decomposedStageId || decomposedStageId === idea.stage_id) {
      return; // Decomposed stage missing, or idea already retired — idempotent no-op
    }

    await this.applyChange(projectId, {
      actor: 'orchestrator',
      entityType: 'idea',
      taskId: ideaId,
      stageId: decomposedStageId,
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
    return (await this.getProjectQueue(projectId).add(() => this.runDelete(projectId, opts))) as {
      taskId: string;
      deletedIds: string[];
    };
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
      const originatingIdeaId = change.originatingIdeaId ?? null;
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
        parentEpicId,
        originatingIdeaId,
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
      parentEpicId: string | null;
      originatingIdeaId: string | null;
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

  // --------------------------------------------------------------------------
  // Update path
  // --------------------------------------------------------------------------

  private runUpdate(
    projectId: number,
    change: TaskChange,
  ): { taskId: string; event: { id: number; seq: number } } {
    const taskId = change.taskId as string;
    const now = new Date().toISOString();

    let eventId = 0;
    let eventSeq = 0;
    let action: TaskChangeAction = 'updated';
    let resolvedType: TaskType = 'task';

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
        // Decomposition: an IDEA moving to the Decomposed terminal stage retires.
        // Children are intentionally LEFT UNCHANGED here (no cascade) — they carry
        // the flow. Surface the distinct 'decomposed' action so the UI can react.
        action =
          type === 'idea' && targetStage.position === DECOMPOSED_POSITION ? 'decomposed' : 'stageMoved';
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
    return { taskId, event: { id: eventId, seq: eventSeq } };
  }

  // --------------------------------------------------------------------------
  // Delete path
  // --------------------------------------------------------------------------

  private async runDelete(
    projectId: number,
    opts: { actor: TaskActor; taskId: string; entityType?: TaskType; runId?: string },
  ): Promise<{ taskId: string; deletedIds: string[] }> {
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

    return { taskId: opts.taskId, deletedIds: cascade.map((e) => e.id) };
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
   * `change.dependsOnTaskId` the PREREQUISITE. Both must be real TASKS in this
   * project (dependencies are task-only; ideas/epics never carry one). The edge:
   *   1. rejects self-edges (`invalid_dependency`),
   *   2. validates both endpoints exist + same project (`invalid_dependency`),
   *   3. is cycle-checked over the existing blocking-edge closure
   *      (`dependency_cycle`) — only `blocking` edges form the DAG, so `related`
   *      edges skip the cycle guard,
   *   4. INSERT-OR-IGNOREs (the UNIQUE(task_id, depends_on_task_id) makes a
   *      re-add a no-op),
   *   5. appends a `dependency-added` entity_events row on the blocked task so
   *      the change is in the faithful changelog.
   *
   * Returns the BLOCKED task id + the (new or last) entity_events row. A dup
   * re-add returns the most recent event without writing a new one.
   */
  private runAddDependency(
    projectId: number,
    change: TaskChange,
  ): { taskId: string; event: { id: number; seq: number } } {
    const taskId = change.taskId as string;
    const dependsOnTaskId = change.dependsOnTaskId as string;
    const kind: TaskDependencyKind = change.dependencyKind ?? 'blocking';
    const now = new Date().toISOString();

    let eventId = 0;
    let eventSeq = 0;
    let wroteEdge = false;

    const txn = this.db.transaction(() => {
      // Self-edge guard.
      if (taskId === dependsOnTaskId) {
        throw new TaskChangeError('invalid_dependency', 'a task cannot depend on itself');
      }

      // Both endpoints must be real tasks in this project. Dependencies are
      // task-only (ideas/epics never participate in the execution DAG).
      const blocked = this.db
        .prepare('SELECT id, project_id FROM tasks WHERE id = ?')
        .get(taskId) as { id: string; project_id: number } | undefined;
      if (!blocked) {
        throw new TaskChangeError('invalid_dependency', `task ${taskId} not found`);
      }
      if (blocked.project_id !== projectId) {
        throw new TaskChangeError('invalid_dependency', `task ${taskId} belongs to a different project`);
      }
      const prereq = this.db
        .prepare('SELECT id, project_id FROM tasks WHERE id = ?')
        .get(dependsOnTaskId) as { id: string; project_id: number } | undefined;
      if (!prereq) {
        throw new TaskChangeError('invalid_dependency', `prerequisite task ${dependsOnTaskId} not found`);
      }
      if (prereq.project_id !== projectId) {
        throw new TaskChangeError(
          'invalid_dependency',
          `prerequisite task ${dependsOnTaskId} belongs to a different project`,
        );
      }

      // Idempotent no-op: the edge already exists (any kind on this pair).
      const existing = this.db
        .prepare('SELECT kind FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?')
        .get(taskId, dependsOnTaskId) as { kind: string } | undefined;
      if (existing) {
        return; // wroteEdge stays false — surface the last event below
      }

      // Cycle guard: only blocking edges form the ordering DAG. Reject an edge
      // that would create a cycle in the transitive closure of blocking edges.
      if (kind === 'blocking') {
        this.validateDependencyEdge(taskId, dependsOnTaskId);
      }

      // INSERT OR IGNORE — the UNIQUE(task_id, depends_on_task_id) makes a
      // racing re-add a no-op even if the SELECT above missed it.
      this.db
        .prepare(
          'INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, kind) VALUES (?, ?, ?)',
        )
        .run(taskId, dependsOnTaskId, kind);

      const deltas: FieldDelta[] = [
        { field: 'depends_on_task_id', from: null, to: dependsOnTaskId },
        { field: 'dependency_kind', from: null, to: kind },
      ];
      const ev = this.insertEvent(
        'task',
        taskId,
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
        .get('task', taskId) as { id: number; seq: number } | undefined;
      eventId = last?.id ?? 0;
      eventSeq = last?.seq ?? 0;
    } else {
      this.emitChange(projectId, 'task', taskId, 'updated');
    }

    return { taskId, event: { id: eventId, seq: eventSeq } };
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
    const row = this.db
      .prepare(
        `SELECT id, project_id, ref, title, summary, body, priority, repo, board_id, stage_id, archived_at,
                version, created_at, updated_at, ${parentEpic}, ${originatingIdea}, ${entryStage}, ${scope}, ${attachments}
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
   *   any outcome='merged'                                                       -> done
   *   else any status='running'                                                  -> indev
   *   else any (awaiting_review | outcome='pr_open' | outcome='integrated' | pending appr.) -> merge
   *   else (runs nonempty && all terminal-without-merge)                         -> entry_stage_id (fallback 'ready')
   *   else (no runs)                                                             -> no-op
   *
   * `outcome='integrated'` (feat/parallel-sprint) is the per-task close-out for a
   * batch run whose branch merged into the integration branch but NOT yet into
   * main — it must hold the task at stage 8 (Ready to merge), exactly like
   * `pr_open`, until the finalize merge-to-main stamps `outcome='merged'`.
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
    const anyRunning = runs.some((r) => r.status === 'running');

    if (anyMerged) {
      targetStageId = this.stageIdForPosition(task.board_id, DONE_POSITION); // done
    } else if (anyRunning) {
      targetStageId = this.stageIdForPosition(task.board_id, 7); // indev
    } else {
      const runIds = runs.map((r) => r.id);
      const anyAwaitingReview = runs.some(
        (r) => r.status === 'awaiting_review' || r.outcome === 'pr_open' || r.outcome === 'integrated',
      );
      const pendingApprovals = this.hasPendingApprovals(runIds);
      if (anyAwaitingReview || pendingApprovals) {
        targetStageId = this.stageIdForPosition(task.board_id, 8); // merge
      } else {
        // All runs terminal-without-merge -> revert to entry_stage_id (fallback 'ready').
        targetStageId = task.entry_stage_id ?? this.stageIdForPosition(task.board_id, 6); // ready
      }
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
        if (typeof agent === 'string' && agent.length > 0) return agent;
      } catch {
        // ignore malformed snapshot — fall through to defaults
      }
    }
    return run.current_step_id ?? 'agent';
  }
}
