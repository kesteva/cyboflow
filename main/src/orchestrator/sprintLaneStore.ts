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
  SprintLaneStepId,
} from '../../../shared/types/sprintBatch';
import { SPRINT_BATCH_CAP, SPRINT_LANE_STEP_IDS } from '../../../shared/types/sprintBatch';

// ---------------------------------------------------------------------------
// Auto-derive: parent-orchestrator subagent dispatch -> lane step
//
// The sprint orchestrator is SUPPOSED to advance lanes via cyboflow_update_sprint_task
// (handleUpdateSprintTask), but in practice it skips that prose-only call while
// busy delegating — leaving lanes stuck at queued/current_step_id=NULL. As a
// BACKSTOP, deriveLaneFromTaskDispatch (below) observes the parent's PreToolUse
// Task-tool dispatches and advances the matching lane WITHOUT relying on the
// agent. It is called from BOTH PreToolUse seams (the interactive orchestrator-
// socket handler AND the SDK in-process hook) so it fires on either substrate.
// ---------------------------------------------------------------------------

/**
 * Map a sprint per-task subagent_type to its lane step. ONLY the five per-task
 * agents are mapped; the sprint-wide phase-1/phase-3 agents
 * (cyboflow-dependency-analyzer / cyboflow-sprint-verify / cyboflow-sprint-review)
 * have no per-task lane and are deliberately absent -> an unmapped subagent_type
 * is a no-op.
 */
const SPRINT_SUBAGENT_TO_LANE_STEP: Readonly<Record<string, SprintLaneStepId>> = {
  'cyboflow-implement': 'implement',
  'cyboflow-write-tests': 'write-tests',
  'cyboflow-code-review': 'code-review',
  'cyboflow-task-verify': 'task-verify',
  'cyboflow-visual-verify': 'visual-verify',
};

/**
 * True when `token` appears in `prompt` as a whole token — present and NOT
 * immediately followed by an alphanumeric char. Prevents a lane ref like
 * "TASK-1" from matching inside "TASK-12" (and a short id from matching a longer
 * one) during multi-lane sprint-wave attribution.
 */
function tokenAppearsInPrompt(prompt: string, token: string): boolean {
  if (token.length === 0) return false;
  let from = 0;
  for (;;) {
    const idx = prompt.indexOf(token, from);
    if (idx === -1) return false;
    const next = prompt[idx + token.length];
    if (next === undefined || !/[0-9A-Za-z]/.test(next)) return true;
    from = idx + 1;
  }
}

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

    // Q1 eligibility guard. This is the SINGLE materialization chokepoint that
    // runs.start AND handleCreateSprintBatch both converge on, so gating here
    // means neither path can seed a sprint over a pending/unready selection. A
    // task is kept ONLY when it is approved (approved_at IS NOT NULL — a NULL
    // approval is PENDING/sprint-ineligible), not archived, and sitting at a
    // ready-or-later, non-terminal board stage (position >= 6, is_terminal = 0
    // — which drops both 'Done' and 'Won't do'). Ineligible ids are DROPPED; an
    // empty result is rejected with a clear SprintLaneError.
    const eligibleTaskIds = this.filterEligibleTaskIds(projectId, uniqueTaskIds);
    if (eligibleTaskIds.length === 0) {
      throw new SprintLaneError(
        'bad_request',
        'createForRun: no sprint-eligible tasks in selection (each must be approved + at "Ready for development" or later, not archived/done/won\'t-do)',
      );
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
      for (const taskId of eligibleTaskIds) {
        insertLane.run(batchId, taskId);
      }
    });
    (txn as () => void)();

    this.logger?.info('[SprintLaneStore] lane substrate created', {
      batchId,
      projectId,
      substrate,
      tasks: eligibleTaskIds.length,
      dropped: uniqueTaskIds.length - eligibleTaskIds.length,
    });
    return { batchId };
  }

  /**
   * Q1 sprint-eligibility filter — the single source of truth for which of a
   * candidate task-id selection may seed a sprint. A task is ELIGIBLE only when
   * it is APPROVED (tasks.approved_at IS NOT NULL — a NULL approval is PENDING,
   * backend-invisible + sprint-ineligible until plan approval), NOT archived
   * (archived_at IS NULL), and sitting at a ready-or-later, NON-terminal board
   * stage (board_stages.position >= 6 — '>= 6' tolerates in-dev movement per the
   * ship promote-before-batch ordering — AND is_terminal = 0, which drops both
   * 'Done' (pos 9) and 'Won't do' (pos 10)). Candidate ids with no tasks row are
   * dropped (inner JOIN). Input order is preserved; duplicates are collapsed.
   *
   * Called by createForRun (the materialization chokepoint) and the runs.start
   * pre-check. On a pre-036 schema lacking approved_at/archived_at the filter
   * degrades to PERMISSIVE (returns the unique candidates unchanged), mirroring
   * the codebase's pre-migration defensive-read precedent — production DBs
   * always carry the columns, so the guard is fully active there.
   */
  filterEligibleTaskIds(projectId: number, taskIds: string[]): string[] {
    const unique = [...new Set(taskIds)];
    if (unique.length === 0) return [];
    try {
      const placeholders = unique.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT t.id AS id
             FROM tasks t
             JOIN board_stages bs ON bs.id = t.stage_id
            WHERE t.project_id = ?
              AND t.id IN (${placeholders})
              AND t.approved_at IS NOT NULL
              AND t.archived_at IS NULL
              AND bs.position >= 6
              AND bs.is_terminal = 0`,
        )
        .all(projectId, ...unique) as Array<{ id: string }>;
      const eligible = new Set(rows.map((r) => r.id));
      return unique.filter((id) => eligible.has(id));
    } catch (err) {
      if (err instanceof Error && /no such column/i.test(err.message)) {
        this.logger?.debug('[SprintLaneStore] eligibility filter skipped (pre-036 schema)', {
          error: err.message,
        });
        return unique;
      }
      throw err;
    }
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
   *                        currentStepId outside the allowed step-id set, or an
   *                        attempt that is not an integer >= 1.
   *   - 'lane_not_found' — no (batch_id, task_id) row.
   *
   * `currentStepId` semantics: undefined = leave unchanged; null = clear.
   * `allowedStepIds` semantics: the lane-step vocabulary a non-null
   * `currentStepId` is validated against. undefined ⇒ defaults to
   * SPRINT_LANE_STEP_IDS (the orchestrated / sprint contract — byte-identical
   * to the pre-generalization behavior). The host fan-out driver passes a
   * per-fanOut-step inner-id set so non-sprint flows declare their own lane
   * vocabulary.
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
    allowedStepIds?: readonly string[];
  }): SprintLaneRow {
    const { runId, batchId, taskId, status, currentStepId, attempt } = args;

    if (status === undefined && currentStepId === undefined && attempt === undefined) {
      throw new SprintLaneError('bad_request', 'updateLane requires at least one of status / currentStepId / attempt');
    }
    if (status !== undefined && !LANE_STATUSES.includes(status)) {
      throw new SprintLaneError('bad_request', `unknown lane status '${String(status)}'`);
    }
    const allowed = args.allowedStepIds ?? (SPRINT_LANE_STEP_IDS as readonly string[]);
    if (currentStepId !== undefined && currentStepId !== null && !allowed.includes(currentStepId)) {
      throw new SprintLaneError(
        'bad_request',
        `unknown lane step '${currentStepId}' (expected one of ${allowed.join(', ')})`,
      );
    }
    if (attempt !== undefined && (!Number.isInteger(attempt) || attempt < 1)) {
      throw new SprintLaneError('bad_request', `attempt must be an integer >= 1 (got ${String(attempt)})`);
    }

    const now = new Date().toISOString();

    // The lane is keyed by the opaque tasks.id, but agents only see the display
    // ref (e.g. TASK-008) in the seeded sprint-task block — so accept EITHER and
    // normalize to the canonical opaque id (parity with cyboflow_add_task_dependency's
    // resolveTaskByRefOrId). Opaque id wins: the exact task_id match is tried first
    // (join-free, so a lane whose tasks row is absent still resolves); only on a
    // miss do we resolve the display ref via the tasks.ref join, scoped to THIS batch.
    let resolvedTaskId = taskId;

    const txn = this.db.transaction(() => {
      let existing = this.db
        .prepare('SELECT id FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
        .get(batchId, taskId) as { id: number } | undefined;
      if (!existing) {
        const byRef = this.db
          .prepare(
            `SELECT sbt.id AS id, sbt.task_id AS taskId
               FROM sprint_batch_tasks sbt
               JOIN tasks t ON t.id = sbt.task_id
              WHERE sbt.batch_id = ? AND t.ref = ?`,
          )
          .get(batchId, taskId) as { id: number; taskId: string } | undefined;
        if (byRef) {
          existing = { id: byRef.id };
          resolvedTaskId = byRef.taskId;
        }
      }
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

    const lane = this.readLane(batchId, resolvedTaskId);
    if (!lane) {
      // Row vanished between commit and read-back — surface as not_found.
      throw new SprintLaneError('lane_not_found', `lane for task ${resolvedTaskId} vanished after update`);
    }

    const event: SprintLaneChangedEvent = {
      runId,
      batchId,
      taskId: resolvedTaskId,
      status: lane.status,
      currentStepId: lane.currentStepId,
      attempts: lane.attempts,
      timestamp: now,
    };
    sprintLaneEvents.emit(sprintLaneChannel(runId), event);

    return lane;
  }

  // --------------------------------------------------------------------------
  // deriveLaneFromTaskDispatch — observe-only auto-advance (substrate-agnostic)
  // --------------------------------------------------------------------------

  /**
   * BACKSTOP for the lane substrate: given a parent-orchestrator PreToolUse
   * Task-tool dispatch, advance the matching lane to status='running' with the
   * derived current step — without relying on the orchestrator calling
   * cyboflow_update_sprint_task. Called from BOTH PreToolUse seams (the
   * interactive orchestrator-socket handler and the SDK in-process hook) so it
   * fires regardless of substrate. The SINGLE write goes through updateLane, so
   * the existing sprintLaneEvents -> tRPC -> SprintLanesPanel pipeline lights up.
   *
   * Fully defensive (never throws — the caller's gating/verdict path must always
   * proceed). Strict NO-OP for: the 'orchestrator' sentinel, non-Task tools,
   * unmapped/phase-wide subagent_types, non-sprint runs (NULL batch_id), empty
   * lane lists, ambiguous multi-lane attribution, and any lane already
   * at-or-past the derived step (monotonic-forward — loopbacks that re-dispatch
   * `implement` keep the further-along step; terminal lanes are never resurrected).
   */
  deriveLaneFromTaskDispatch(args: {
    runId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  }): void {
    const { runId, toolName, toolInput } = args;
    try {
      if (runId === 'orchestrator') return;
      if (toolName !== 'Task') return;

      const subagentType = toolInput['subagent_type'];
      if (typeof subagentType !== 'string') return;
      const step = SPRINT_SUBAGENT_TO_LANE_STEP[subagentType];
      if (step === undefined) return;

      // Resolve the run's batch (migration 022). NULL/absent batch = non-sprint
      // run -> strict no-op (mirrors handleUpdateSprintTask's read).
      const runRow = this.db
        .prepare('SELECT batch_id AS batchId FROM workflow_runs WHERE id = ?')
        .get(runId) as { batchId?: unknown } | undefined;
      const batchId =
        typeof runRow?.batchId === 'string' && runRow.batchId.length > 0 ? runRow.batchId : null;
      if (!batchId) return;

      // Attribution -> the lane's taskId. Single-lane batch is trivial; a
      // multi-lane wave needs an UNAMBIGUOUS ref/taskId match in the dispatch
      // prompt (0 or >1 matches -> skip safely; never guess).
      const lanes = this.listLanes(batchId);
      if (lanes.length === 0) return;

      let lane: SprintLaneRow | undefined;
      if (lanes.length === 1) {
        lane = lanes[0];
      } else {
        const prompt = typeof toolInput['prompt'] === 'string' ? toolInput['prompt'] : '';
        if (prompt === '') return;
        const matches = lanes.filter((l) => {
          const byRef = typeof l.ref === 'string' && tokenAppearsInPrompt(prompt, l.ref);
          const byId = tokenAppearsInPrompt(prompt, l.taskId);
          return byRef || byId;
        });
        if (matches.length !== 1) return;
        lane = matches[0];
      }
      if (lane === undefined) return;

      // Monotonic-forward guard: never resurrect a terminal lane; never regress a
      // lane already at-or-past this step (applies to running AND blocked; a
      // queued lane has currentStepId=null -> index -1 -> always advances).
      if (lane.status === 'integrated' || lane.status === 'failed') return;
      const existingIdx =
        lane.currentStepId === null
          ? -1
          : (SPRINT_LANE_STEP_IDS as readonly string[]).indexOf(lane.currentStepId);
      const derivedIdx = (SPRINT_LANE_STEP_IDS as readonly string[]).indexOf(step);
      if (existingIdx >= derivedIdx) return;

      this.updateLane({ runId, batchId, taskId: lane.taskId, status: 'running', currentStepId: step });
    } catch (err) {
      // Best-effort UI backstop — a lane read/write failure must never disturb
      // the caller's PreToolUse gating/verdict path.
      this.logger?.debug('[SprintLaneStore] auto-derive skipped', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
