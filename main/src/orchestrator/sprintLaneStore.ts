/**
 * SprintLaneStore — the SINGLE write chokepoint for sprint LANES (the
 * sprint-orchestrator redesign's per-task progress substrate).
 *
 * A "lane" is one sprint_batch_tasks row repurposed from the retired
 * SprintBatchScheduler model (migration 022; migration 023 adds
 * current_step_id). The ONE session-hosted sprint run owns a sprint_batches
 * row (stamped onto workflow_runs.batch_id by RunLauncher); its orchestrator
 * agent fans out per-task subagents in the SHARED session worktree and reports
 * per-task progress through the cyboflow_update_sprint_task MCP tool, which
 * lands here. Lane status 'integrated' now MEANS "task complete + committed in
 * the session worktree" — there is no per-task integration branch/merge.
 *
 * Ownership doctrine (same as migration 022's header): sprint_batches /
 * sprint_batch_tasks are NOT entity-model tables — they do NOT route through
 * TaskChangeRouter. This store writes them directly with status-guarded
 * UPDATEs, the same way workflow_runs is written directly by RunLauncher.
 * Board-stage derivation of the underlying tasks still flows through the
 * entity chokepoint elsewhere.
 *
 * Singleton lifecycle mirrors TaskChangeRouter (initialize / getInstance /
 * _resetForTesting). Pass the optional `logger` at initialize time from
 * main/src/index.ts — omitting it silently disables the store's diagnostics
 * (CLAUDE.md optional-logger rule).
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*. The DB is
 * injected as the narrow DatabaseLike interface.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { DatabaseLike, LoggerLike } from './types';
import type { CliSubstrate } from '../../../shared/types/substrate';
import type {
  SprintBatchTaskStatus,
  SprintLaneChangedEvent,
  SprintLaneRow,
} from '../../../shared/types/sprintBatch';
import { SPRINT_BATCH_CAP, SPRINT_LANE_STEP_IDS } from '../../../shared/types/sprintBatch';

// ---------------------------------------------------------------------------
// Public event emitter — bridged by the tRPC lane subscription via
// eventToAsyncIterable (mirrors taskChangeEvents in taskChangeRouter.ts).
//
// Emit key format: 'sprint-lane-' + runId.
// ---------------------------------------------------------------------------

export const sprintLaneEvents = new EventEmitter();

/** Build the emit channel name for a run. Exported so the tRPC subscription stays in sync. */
export function sprintLaneChannel(runId: string): string {
  return `sprint-lane-${runId}`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SprintLaneErrorCode = 'lane_not_found' | 'bad_request';

/** Discriminated error for all lane-write rejections. */
export class SprintLaneError extends Error {
  constructor(
    public readonly code: SprintLaneErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SprintLaneError';
  }
}

// ---------------------------------------------------------------------------
// Internal constants / row shapes
// ---------------------------------------------------------------------------

/** Runtime mirror of the SprintBatchTaskStatus union (the 022 CHECK domain). */
const LANE_STATUSES: readonly SprintBatchTaskStatus[] = [
  'queued',
  'running',
  'integrated',
  'failed',
  'blocked',
];

/** sprint_batch_tasks LEFT JOIN tasks projection (ref/title fail-soft null). */
interface LaneDbRow {
  batch_id: string;
  task_id: string;
  status: SprintBatchTaskStatus;
  current_step_id: string | null;
  attempts: number;
  updated_at: string;
  ref: string | null;
  title: string | null;
}

// ---------------------------------------------------------------------------
// SprintLaneStore
// ---------------------------------------------------------------------------

export class SprintLaneStore {
  private static instance: SprintLaneStore | null = null;

  constructor(
    private readonly db: DatabaseLike,
    private readonly logger?: LoggerLike,
  ) {}

  // --------------------------------------------------------------------------
  // Lifecycle (singleton, mirroring TaskChangeRouter)
  // --------------------------------------------------------------------------

  static initialize(db: DatabaseLike, logger?: LoggerLike): SprintLaneStore {
    SprintLaneStore.instance = new SprintLaneStore(db, logger);
    return SprintLaneStore.instance;
  }

  static getInstance(): SprintLaneStore {
    if (!SprintLaneStore.instance) {
      throw new Error(
        'SprintLaneStore has not been initialized. Call SprintLaneStore.initialize() from main/src/index.ts.',
      );
    }
    return SprintLaneStore.instance;
  }

  /** Reset singleton — intended for tests only. */
  static _resetForTesting(): void {
    SprintLaneStore.instance = null;
  }

  // --------------------------------------------------------------------------
  // createForRun — seed the lane substrate for ONE sprint run
  // --------------------------------------------------------------------------

  /**
   * Create the batch row + one queued lane per task, in ONE transaction.
   * Called by RunLauncher when a sprint run launches with seedTaskIds; the
   * launcher stamps the returned batchId onto workflow_runs.batch_id.
   *
   * The batch is born 'running' (no scheduler planning phase in the redesign)
   * with concurrency = SPRINT_BATCH_CAP and integration_branch NULL (all work
   * happens in the SHARED session worktree — there is no integration branch).
   * Duplicate task ids are collapsed (UNIQUE(batch_id, task_id)); an empty
   * selection is rejected with 'bad_request'.
   */
  createForRun(projectId: number, substrate: CliSubstrate, taskIds: string[]): { batchId: string } {
    const uniqueTaskIds = [...new Set(taskIds)];
    if (uniqueTaskIds.length === 0) {
      throw new SprintLaneError('bad_request', 'createForRun requires at least one task id');
    }

    const batchId = randomUUID().replace(/-/g, '');

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sprint_batches (id, project_id, substrate, status, integration_branch, concurrency)
           VALUES (?, ?, ?, 'running', NULL, ?)`,
        )
        .run(batchId, projectId, substrate, SPRINT_BATCH_CAP);

      const insertLane = this.db.prepare(
        `INSERT INTO sprint_batch_tasks (batch_id, task_id, status) VALUES (?, ?, 'queued')`,
      );
      for (const taskId of uniqueTaskIds) {
        insertLane.run(batchId, taskId);
      }
    });
    (txn as () => void)();

    this.logger?.info('[SprintLaneStore] lane substrate created', {
      batchId,
      projectId,
      substrate,
      tasks: uniqueTaskIds.length,
    });
    return { batchId };
  }

  // --------------------------------------------------------------------------
  // updateLane — the per-task progress write
  // --------------------------------------------------------------------------

  /**
   * Update one lane's status and/or current step, then emit a
   * SprintLaneChangedEvent on sprintLaneChannel(runId).
   *
   * Rejections (SprintLaneError):
   *   - 'bad_request'    — neither status nor currentStepId given, status not
   *                        in the SprintBatchTaskStatus domain, a non-null
   *                        currentStepId outside SPRINT_LANE_STEP_IDS, or an
   *                        attempt that is not an integer >= 1.
   *   - 'lane_not_found' — no (batch_id, task_id) row.
   *
   * `currentStepId` semantics: undefined = leave unchanged; null = clear.
   * `attempt` semantics: sets the attempts column verbatim (1-based; the
   * orchestrator reports 2, 3, ... when re-delegating implement after a
   * verify failure — see SprintLaneRow.attempts). undefined = leave unchanged.
   * `status='integrated'` stamps integrated_at (task complete + committed in
   * the session worktree). updated_at is always bumped.
   */
  updateLane(args: {
    runId: string;
    batchId: string;
    taskId: string;
    status?: SprintBatchTaskStatus;
    currentStepId?: string | null;
    attempt?: number;
  }): SprintLaneRow {
    const { runId, batchId, taskId, status, currentStepId, attempt } = args;

    if (status === undefined && currentStepId === undefined && attempt === undefined) {
      throw new SprintLaneError('bad_request', 'updateLane requires at least one of status / currentStepId / attempt');
    }
    if (status !== undefined && !LANE_STATUSES.includes(status)) {
      throw new SprintLaneError('bad_request', `unknown lane status '${String(status)}'`);
    }
    if (
      currentStepId !== undefined &&
      currentStepId !== null &&
      !(SPRINT_LANE_STEP_IDS as readonly string[]).includes(currentStepId)
    ) {
      throw new SprintLaneError(
        'bad_request',
        `unknown lane step '${currentStepId}' (expected one of ${SPRINT_LANE_STEP_IDS.join(', ')})`,
      );
    }
    if (attempt !== undefined && (!Number.isInteger(attempt) || attempt < 1)) {
      throw new SprintLaneError('bad_request', `attempt must be an integer >= 1 (got ${String(attempt)})`);
    }

    const now = new Date().toISOString();

    const txn = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT id FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
        .get(batchId, taskId) as { id: number } | undefined;
      if (!existing) {
        throw new SprintLaneError('lane_not_found', `no lane for task ${taskId} in batch ${batchId}`);
      }

      const sets: string[] = ['updated_at = ?'];
      const params: unknown[] = [now];
      if (status !== undefined) {
        sets.push('status = ?');
        params.push(status);
        if (status === 'integrated') {
          sets.push('integrated_at = ?');
          params.push(now);
        }
      }
      if (currentStepId !== undefined) {
        sets.push('current_step_id = ?');
        params.push(currentStepId);
      }
      if (attempt !== undefined) {
        sets.push('attempts = ?');
        params.push(attempt);
      }
      params.push(existing.id);
      this.db.prepare(`UPDATE sprint_batch_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    });
    (txn as () => void)();

    const lane = this.readLane(batchId, taskId);
    if (!lane) {
      // Row vanished between commit and read-back — surface as not_found.
      throw new SprintLaneError('lane_not_found', `lane for task ${taskId} vanished after update`);
    }

    const event: SprintLaneChangedEvent = {
      runId,
      batchId,
      taskId,
      status: lane.status,
      currentStepId: lane.currentStepId,
      attempts: lane.attempts,
      timestamp: now,
    };
    sprintLaneEvents.emit(sprintLaneChannel(runId), event);

    return lane;
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  /**
   * All lanes of a batch in insertion order, with ref/title resolved fail-soft
   * from the tasks table (LEFT JOIN — null when the task row is missing) and
   * blockedByRefs computed on read (see blockedByRefsForBatch — NOT stored).
   */
  listLanes(batchId: string): SprintLaneRow[] {
    const rows = this.db
      .prepare(
        `SELECT bt.batch_id, bt.task_id, bt.status, bt.current_step_id, bt.attempts, bt.updated_at,
                t.ref AS ref, t.title AS title
           FROM sprint_batch_tasks bt
           LEFT JOIN tasks t ON t.id = bt.task_id
          WHERE bt.batch_id = ?
          ORDER BY bt.id ASC`,
      )
      .all(batchId) as LaneDbRow[];
    const blockedBy = this.blockedByRefsForBatch(batchId);
    return rows.map((row) => this.toLaneRow(row, blockedBy.get(row.task_id) ?? []));
  }

  /** One lane (same projection as listLanes), or undefined when absent. */
  private readLane(batchId: string, taskId: string): SprintLaneRow | undefined {
    const row = this.db
      .prepare(
        `SELECT bt.batch_id, bt.task_id, bt.status, bt.current_step_id, bt.attempts, bt.updated_at,
                t.ref AS ref, t.title AS title
           FROM sprint_batch_tasks bt
           LEFT JOIN tasks t ON t.id = bt.task_id
          WHERE bt.batch_id = ? AND bt.task_id = ?`,
      )
      .get(batchId, taskId) as LaneDbRow | undefined;
    if (!row) return undefined;
    const blockedBy = this.blockedByRefsForBatch(batchId);
    return this.toLaneRow(row, blockedBy.get(row.task_id) ?? []);
  }

  /**
   * Read-side computation of each lane's IN-BATCH blocking prerequisites:
   * task_dependencies (kind='blocking') edges whose PREREQUISITE has a lane in
   * the SAME batch that is not yet 'integrated'. Display refs resolve
   * fail-soft from the tasks table (fallback to the raw task id). Returns a
   * blocked-task-id → refs map; tasks without un-integrated in-batch prereqs
   * are simply absent. Out-of-batch dependencies are ignored — this is lane
   * gating, not global dependency truth.
   */
  private blockedByRefsForBatch(batchId: string): Map<string, string[]> {
    const rows = this.db
      .prepare(
        `SELECT dep.task_id AS blocked_task_id,
                COALESCE(t.ref, dep.depends_on_task_id) AS prereq_ref
           FROM task_dependencies dep
           JOIN sprint_batch_tasks pre
             ON pre.batch_id = ?
            AND pre.task_id = dep.depends_on_task_id
            AND pre.status != 'integrated'
           LEFT JOIN tasks t ON t.id = dep.depends_on_task_id
          WHERE dep.kind = 'blocking'
          ORDER BY dep.id ASC`,
      )
      .all(batchId) as Array<{ blocked_task_id: string; prereq_ref: string }>;
    const map = new Map<string, string[]>();
    for (const row of rows) {
      const refs = map.get(row.blocked_task_id);
      if (refs) {
        refs.push(row.prereq_ref);
      } else {
        map.set(row.blocked_task_id, [row.prereq_ref]);
      }
    }
    return map;
  }

  private toLaneRow(row: LaneDbRow, blockedByRefs: string[]): SprintLaneRow {
    return {
      batchId: row.batch_id,
      taskId: row.task_id,
      status: row.status,
      currentStepId: row.current_step_id,
      ref: row.ref,
      title: row.title,
      attempts: row.attempts,
      blockedByRefs,
      updatedAt: row.updated_at,
    };
  }

  // --------------------------------------------------------------------------
  // markBatchTerminal — batch close-out
  // --------------------------------------------------------------------------

  /**
   * Flip a batch to a terminal status. Status-guarded: only a NON-terminal
   * batch transitions (a completed/failed/canceled batch is immutable — a late
   * second call is a logged no-op, mirroring the old scheduler's guarded
   * UPDATEs). Stamps completed_at alongside.
   */
  markBatchTerminal(batchId: string, status: 'completed' | 'failed' | 'canceled'): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE sprint_batches
            SET status = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND status NOT IN ('completed', 'failed', 'canceled')`,
      )
      .run(status, now, now, batchId);
    if (result.changes === 0) {
      this.logger?.debug('[SprintLaneStore] markBatchTerminal no-op (batch missing or already terminal)', {
        batchId,
        status,
      });
      return;
    }
    this.logger?.info('[SprintLaneStore] batch terminal', { batchId, status });
  }
}
