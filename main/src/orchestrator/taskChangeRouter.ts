/**
 * TaskChangeRouter — the SINGLE write chokepoint for native task state.
 *
 * INVARIANT: every task-state write (GUI tRPC, orchestrator lifecycle, run
 * close-out) routes through applyChange. Nothing UPDATEs `tasks` directly.
 * Each applyChange atomically (1) mutates `tasks` and (2) appends a per-field
 * delta row to `task_events`, then emits a TaskChangedEvent after commit.
 *
 * Mirrors the per-run PQueue serialization pattern in approvalRouter.ts, but
 * keys the queue PER PROJECT (task refs + version bumps are project-scoped).
 *
 * Phase-0/1 scope: in-process callers only (GUI + orchestrator). The `change`
 * shape and the `actor` union are deliberately MCP-ready so the cyboflow_*
 * task tools can be added later as just another actor with NO refactor — but
 * NO MCP wiring is added here.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*. The DB is
 * injected as the narrow DatabaseLike interface.
 */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import PQueue from 'p-queue';
import type { DatabaseLike } from './types';
import type {
  BacklogTaskItem,
  FlowOverlay,
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
// Emit key format: 'task-project-' + projectId.
// ---------------------------------------------------------------------------

export const taskChangeEvents = new EventEmitter();

/** Build the emit channel name for a project. Exported so the tRPC subscription stays in sync. */
export function taskProjectChannel(projectId: number): string {
  return `task-project-${projectId}`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type TaskChangeErrorCode =
  | 'not_found'
  | 'invalid_parent'
  | 'forbidden_stage'
  | 'active_runs'
  | 'concurrency';

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

/** Mutable task fields a caller may set. `stageId` and `parentEpicId` are handled separately. */
export interface TaskFieldChanges {
  title?: string;
  summary?: string | null;
  priority?: Priority;
  repo?: string | null;
  /**
   * Execution-entry capture. Set by the launch hook the FIRST time a task
   * leaves a planning stage into execution. Treated as an asserted field that
   * only the orchestrator path writes.
   */
  entryStageId?: string | null;
}

export type TaskActor = 'user' | 'orchestrator' | `agent:${string}` | 'linear';

export interface TaskChange {
  actor: TaskActor;
  /** Omit to CREATE a new task; provide to UPDATE an existing one. */
  taskId?: string;
  /** Field-level updates (title/summary/priority/repo/entryStageId). */
  fields?: TaskFieldChanges;
  /** Move the task to this stage (subject to write_policy authority + active-run guard). */
  stageId?: string;
  /** Re-parent (only valid for type='task'; null clears the parent). */
  parentEpicId?: string | null;
  /** Optimistic-concurrency guard. If provided and != current version -> concurrency conflict. */
  expectedVersion?: number;
  /** The run that triggered this change, recorded on the task_events row. */
  runId?: string;
  // ----- create-only fields (ignored on update) -----
  /** Task type for the create path. Defaults to 'idea'. */
  type?: TaskType;
  /** Initial title for the create path. */
  title?: string;
  /** Initial summary for the create path. */
  summary?: string | null;
  /** Initial priority for the create path. Defaults to 'P2'. */
  priority?: Priority;
  /** Initial repo for the create path. */
  repo?: string | null;
  /** Board to create the task on. Defaults to the project's default board. */
  boardId?: string;
  /** Stage to create the task at. Defaults to the board's 'idea' (position 1) stage. */
  initialStageId?: string;
  /** Kind label for the emitted task_events row. Defaults to a sensible value per path. */
  kind?: string;
}

// ---------------------------------------------------------------------------
// Internal row shapes for the SELECTs below.
// ---------------------------------------------------------------------------

interface TaskDbRow {
  id: string;
  project_id: number;
  type: TaskType;
  ref: string;
  parent_epic_id: string | null;
  board_id: string;
  stage_id: string;
  entry_stage_id: string | null;
  title: string;
  summary: string | null;
  priority: Priority;
  repo: string | null;
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
   * Apply a single task change atomically and emit the resulting event.
   *
   * Create path (no taskId): mints a ref via task_ref_counters, inserts a task
   * at the idea stage (or a given stage), then logs a 'created' event.
   *
   * Update path: validates parent + stage authority + active-run guard +
   * optimistic concurrency, UPDATEs the task (bumping version + updated_at),
   * and appends a per-field delta to task_events — all in ONE transaction.
   *
   * @returns the affected taskId + the inserted task_events row id/seq.
   */
  async applyChange(
    projectId: number,
    change: TaskChange,
  ): Promise<{ taskId: string; event: { id: number; seq: number } }> {
    return this.getProjectQueue(projectId).add(() => {
      return change.taskId === undefined
        ? this.runCreate(projectId, change)
        : this.runUpdate(projectId, change);
    }) as Promise<{ taskId: string; event: { id: number; seq: number } }>;
  }

  // --------------------------------------------------------------------------
  // Create path
  // --------------------------------------------------------------------------

  private runCreate(
    projectId: number,
    change: TaskChange,
  ): { taskId: string; event: { id: number; seq: number } } {
    const type: TaskType = change.type ?? 'idea';
    const now = new Date().toISOString();
    const taskId = `tsk_${randomBytes(10).toString('hex')}`;

    let eventId = 0;
    let eventSeq = 0;

    const txn = this.db.transaction(() => {
      // Resolve board (default) + stage (idea / position 1, or provided).
      const boardId = change.boardId ?? `board-${projectId}-default`;
      const board = this.db
        .prepare('SELECT id FROM boards WHERE id = ? AND project_id = ?')
        .get(boardId, projectId) as { id: string } | undefined;
      if (!board) {
        throw new TaskChangeError('not_found', `board ${boardId} not found for project ${projectId}`);
      }

      const stageId =
        change.initialStageId ?? change.stageId ?? `stage-${boardId}-1`;
      const stage = this.lookupStage(stageId);
      if (!stage || stage.board_id !== boardId) {
        throw new TaskChangeError('not_found', `stage ${stageId} not found on board ${boardId}`);
      }
      // Authority check also applies on create.
      this.assertStageAuthority(change.actor, stage);

      // Validate parent (only type='task' may have one).
      const parentEpicId = change.parentEpicId ?? null;
      if (parentEpicId !== null) {
        this.validateParent(projectId, type, taskId, parentEpicId);
      }

      // Mint the ref: UPDATE ... RETURNING. INSERT OR IGNORE seeds the counter row first.
      this.db
        .prepare(
          'INSERT OR IGNORE INTO task_ref_counters (project_id, type, next_seq) VALUES (?, ?, 0)',
        )
        .run(projectId, type);
      const counter = this.db
        .prepare(
          'UPDATE task_ref_counters SET next_seq = next_seq + 1 WHERE project_id = ? AND type = ? RETURNING next_seq',
        )
        .get(projectId, type) as { next_seq: number };
      const ref = `${type.toUpperCase()}-${String(counter.next_seq).padStart(3, '0')}`;

      const title = change.title ?? change.fields?.title ?? 'Untitled';
      const summary = change.summary ?? change.fields?.summary ?? null;
      const priority: Priority = change.priority ?? change.fields?.priority ?? 'P2';
      const repo = change.repo ?? change.fields?.repo ?? null;

      this.db
        .prepare(
          `INSERT INTO tasks
             (id, project_id, type, ref, parent_epic_id, board_id, stage_id, entry_stage_id,
              title, summary, priority, repo, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(taskId, projectId, type, ref, parentEpicId, boardId, stageId, title, summary, priority, repo, now, now);

      const changes: FieldDelta[] = [
        { field: 'type', from: null, to: type },
        { field: 'ref', from: null, to: ref },
        { field: 'stage_id', from: null, to: stageId },
        { field: 'title', from: null, to: title },
      ];
      if (parentEpicId !== null) changes.push({ field: 'parent_epic_id', from: null, to: parentEpicId });

      const ev = this.insertEvent(taskId, change.kind ?? 'created', change.actor, change.runId ?? null, changes, now);
      eventId = ev.id;
      eventSeq = ev.seq;
    });
    (txn as () => void)();

    this.emitChange(projectId, taskId, 'created');
    return { taskId, event: { id: eventId, seq: eventSeq } };
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

    const txn = this.db.transaction(() => {
      const current = this.db
        .prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?')
        .get(taskId, projectId) as TaskDbRow | undefined;
      if (!current) {
        throw new TaskChangeError('not_found', `task ${taskId} not found for project ${projectId}`);
      }

      // Optimistic concurrency.
      if (change.expectedVersion !== undefined && change.expectedVersion !== current.version) {
        throw new TaskChangeError(
          'concurrency',
          `task ${taskId} version is ${current.version}, expected ${change.expectedVersion}`,
        );
      }

      const deltas: FieldDelta[] = [];
      const sets: string[] = [];
      const params: unknown[] = [];

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

      // ----- re-parent -----
      if (change.parentEpicId !== undefined && change.parentEpicId !== current.parent_epic_id) {
        if (change.parentEpicId !== null) {
          this.validateParent(projectId, current.type, taskId, change.parentEpicId);
        } else if (current.type !== 'task') {
          // Clearing is a no-op authority-wise, but only tasks ever had a parent.
        }
        sets.push('parent_epic_id = ?');
        params.push(change.parentEpicId);
        deltas.push({ field: 'parent_epic_id', from: current.parent_epic_id, to: change.parentEpicId });
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
        if (f.entryStageId !== undefined && f.entryStageId !== current.entry_stage_id) {
          sets.push('entry_stage_id = ?');
          params.push(f.entryStageId);
          deltas.push({ field: 'entry_stage_id', from: current.entry_stage_id, to: f.entryStageId });
        }
      }

      // No-op guard: if nothing actually changed, do NOT bump version or write an event.
      // This preserves the no-orphan-UPDATE invariant (no updated_at change without an event row).
      if (deltas.length === 0) {
        // Surface the event row that the caller's contract expects: re-read the
        // latest event seq so callers still get a consistent shape. We do NOT
        // write anything.
        const last = this.db
          .prepare('SELECT id, seq FROM task_events WHERE task_id = ? ORDER BY seq DESC LIMIT 1')
          .get(taskId) as { id: number; seq: number } | undefined;
        eventId = last?.id ?? 0;
        eventSeq = last?.seq ?? 0;
        return;
      }

      // Atomic state + event write. Version bump + updated_at always accompany an event row.
      sets.push('version = version + 1');
      sets.push('updated_at = ?');
      params.push(now);
      params.push(taskId);
      this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);

      const ev = this.insertEvent(taskId, change.kind ?? action, change.actor, change.runId ?? null, deltas, now);
      eventId = ev.id;
      eventSeq = ev.seq;
    });
    (txn as () => void)();

    this.emitChange(projectId, taskId, action);
    return { taskId, event: { id: eventId, seq: eventSeq } };
  }

  // --------------------------------------------------------------------------
  // recomputeTaskExecutionStage — the AGGREGATE over a task's runs.
  // --------------------------------------------------------------------------

  /**
   * Recompute and write the DERIVED execution stage for a task by aggregating
   * over ALL its runs (supports parallel runs). Writes via applyChange with
   * actor='orchestrator', so the derived-stage authority is satisfied and the
   * change is logged + emitted like any other.
   *
   * Aggregation (first match wins):
   *   any outcome='merged'                                          -> done
   *   else any status='running'                                     -> indev
   *   else any (awaiting_review | outcome='pr_open' | pending appr.) -> merge
   *   else (runs nonempty && all terminal-without-merge)            -> entry_stage_id (fallback 'ready')
   *   else (no runs)                                                -> no-op
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
      targetStageId = this.stageIdForPosition(task.board_id, 9); // done
    } else if (anyRunning) {
      targetStageId = this.stageIdForPosition(task.board_id, 7); // indev
    } else {
      const runIds = runs.map((r) => r.id);
      const anyAwaitingReview = runs.some((r) => r.status === 'awaiting_review' || r.outcome === 'pr_open');
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
   * Validate a parent epic reference: exists, type='epic', same project, not
   * self, and no 1-level cycle (the parent must not itself point back at this
   * task). Only type='task' may carry a parent.
   */
  private validateParent(projectId: number, childType: TaskType, childId: string, parentId: string): void {
    if (childType !== 'task') {
      throw new TaskChangeError('invalid_parent', `only type='task' may have a parent (got '${childType}')`);
    }
    if (parentId === childId) {
      throw new TaskChangeError('invalid_parent', 'a task cannot be its own parent');
    }
    const parent = this.db
      .prepare('SELECT id, project_id, type, parent_epic_id FROM tasks WHERE id = ?')
      .get(parentId) as
      | { id: string; project_id: number; type: TaskType; parent_epic_id: string | null }
      | undefined;
    if (!parent) {
      throw new TaskChangeError('invalid_parent', `parent ${parentId} not found`);
    }
    if (parent.type !== 'epic') {
      throw new TaskChangeError('invalid_parent', `parent ${parentId} is not an epic (type='${parent.type}')`);
    }
    if (parent.project_id !== projectId) {
      throw new TaskChangeError('invalid_parent', `parent ${parentId} belongs to a different project`);
    }
    if (parent.parent_epic_id === childId) {
      throw new TaskChangeError('invalid_parent', 'parent/child cycle detected');
    }
  }

  // --------------------------------------------------------------------------
  // Event write + emit
  // --------------------------------------------------------------------------

  private insertEvent(
    taskId: string,
    kind: string,
    actor: TaskActor,
    runId: string | null,
    changes: FieldDelta[],
    now: string,
  ): { id: number; seq: number } {
    const maxRow = this.db
      .prepare('SELECT MAX(seq) AS maxSeq FROM task_events WHERE task_id = ?')
      .get(taskId) as { maxSeq: number | null };
    const seq = (maxRow.maxSeq ?? 0) + 1;
    const info = this.db
      .prepare(
        `INSERT INTO task_events (task_id, seq, kind, actor, run_id, changes_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(taskId, seq, kind, actor, runId, JSON.stringify(changes), now) as {
      lastInsertRowid: number | bigint;
    };
    return { id: Number(info.lastInsertRowid), seq };
  }

  private emitChange(projectId: number, taskId: string, action: TaskChangeAction): void {
    const task = this.buildBacklogTaskItem(taskId);
    if (!task) return; // deleted between commit and emit — nothing to broadcast
    const event: TaskChangedEvent = { projectId, taskId, action, task };
    taskChangeEvents.emit(taskProjectChannel(projectId), event);
  }

  /**
   * Build the single-task read-model item carried by the emitted event,
   * including derived overlays. This is a SELF-CONTAINED projection (it does
   * NOT nest children) so the router has no dependency on the consumer's
   * taskListing.ts. The richer list/nesting projection lives there.
   */
  private buildBacklogTaskItem(taskId: string): BacklogTaskItem | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, type, ref, title, summary, priority, repo,
                parent_epic_id, board_id, stage_id, version, created_at, updated_at
           FROM tasks WHERE id = ?`,
      )
      .get(taskId) as TaskDbRow | undefined;
    if (!row) return null;

    const stage = this.lookupStage(row.stage_id);
    const isTerminal = stage ? stage.is_terminal === 1 : false;
    const isDonePosition = stage ? stage.position === 9 : false;

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
      runs.some((r) => r.status === 'awaiting_review' || r.outcome === 'pr_open') ||
      this.hasPendingApprovals(runIds);

    const isDone = isTerminal && isDonePosition;

    return {
      id: row.id,
      project_id: row.project_id,
      type: row.type,
      ref: row.ref,
      title: row.title,
      summary: row.summary,
      priority: row.priority,
      repo: row.repo,
      parent_epic_id: row.parent_epic_id,
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
