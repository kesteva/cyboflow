/**
 * SprintToolHandlers — the sprint tool family (per-lane progress writes via the
 * SprintLaneStore chokepoint and the ship flow's mid-run batch materialization),
 * split out of mcpQueryHandler.ts (issue #19).
 *
 * Standalone-typecheck invariant (orchestrator/**): no 'electron',
 * 'better-sqlite3', or concrete main/src/services import.
 */
import * as net from 'net';
import type { DatabaseLike, LoggerLike } from '../../types';
import { listRunCreatedTaskIds, listRunDecomposedIdeaIds } from '../../runEntityOwnership';
import { TaskChangeRouter } from '../../taskChangeRouter';
import type { TaskActor } from '../../taskChangeRouter';
import { resolveBacklogRef } from '../../taskListing';
import { SprintLaneError, SprintLaneStore } from '../../sprintLaneStore';
import {
  AWAITING_VERIFY_STEP,
  resolveSprintMaxTasks,
} from '../../../../../shared/types/sprintBatch';
import { resolveRunFanOutInner } from '../../laneChainResolution';
import type { CliSubstrate } from '../../../../../shared/types/substrate';
import { runStatusEvents } from '../../trpc/routers/events';
import type { RunStatusChangedEvent } from '../../../../../shared/types/cyboflow';
import type { McpQueryHandlerDeps, McpQueryMessage, McpQueryResponse } from '../mcpQueryMessages';

/**
 * The context McpQueryHandler composes this family with. `writeResponse` and
 * `resolveTaskRunContext` are private methods on the handler (the task and
 * workflow-config families share the latter), handed over as closures so the
 * moved bodies keep calling them as `this.<name>(...)` unchanged.
 */
export interface SprintToolContext {
  readonly db: DatabaseLike;
  readonly logger?: LoggerLike;
  readonly deps: McpQueryHandlerDeps;
  /** Serialize one reply onto the requesting socket. */
  writeResponse(client: net.Socket, response: McpQueryResponse): void;
  /** Non-terminal run → (projectId, agent actor); the guard every run-bound task-scoped tool shares. */
  resolveTaskRunContext(runId: string): { ok: true; projectId: number; actor: TaskActor } | { ok: false; error: string };
}

/**
 * The sprint MCP tool family: `cyboflow_update_sprint_task` and
 * `cyboflow_create_sprint_batch`. Split out of McpQueryHandler (issue #19) with
 * every method body verbatim; the handler routes the two message types here and
 * supplies the shared run guard.
 */
export class SprintToolHandlers {
  private readonly db: DatabaseLike;
  private readonly logger?: LoggerLike;
  private readonly deps: McpQueryHandlerDeps;
  private readonly writeResponse: SprintToolContext['writeResponse'];
  private readonly resolveTaskRunContext: SprintToolContext['resolveTaskRunContext'];

  constructor(ctx: SprintToolContext) {
    this.db = ctx.db;
    this.logger = ctx.logger;
    this.deps = ctx.deps;
    this.writeResponse = ctx.writeResponse;
    this.resolveTaskRunContext = ctx.resolveTaskRunContext;
  }

  // --------------------------------------------------------------------------
  // Sprint lane write (cyboflow_update_sprint_task)
  //
  // Per-task progress for the SINGLE session-hosted sprint run: the sprint
  // orchestrator agent reports each task's lane status / current step, which
  // routes through the SprintLaneStore chokepoint (NOT TaskChangeRouter —
  // sprint_batch_tasks is a non-entity table; see migration 022's header).
  // The write is keyed by the calling run's workflow_runs.batch_id, stamped at
  // launch by RunLauncher; a run without a batch (quick session, planner, a
  // sprint launched without seed tasks) is rejected.
  // --------------------------------------------------------------------------

  /**
   * Update one sprint lane's status and/or current step.
   *
   * Guards: resolveTaskRunContext (sentinel / missing / terminal run — reused
   * for parity with the other task-scoped writes), then the run row must carry
   * a non-null batch_id ('sprint_lane_requires_batch_run'). Lane-level
   * validation (step vocabulary, status domain, at-least-one-field, unknown
   * lane) is enforced INSIDE SprintLaneStore.updateLane and surfaces here as
   * SprintLaneError.code (bad_request | lane_not_found) — DESIGNED rejections,
   * mapped by writeSprintLaneError (mirrors writeTaskChangeError).
   */
  handleUpdateSprintTask(
    msg: Extract<McpQueryMessage, { type: 'mcp-update-sprint-task' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    // The lane substrate is keyed by the run's batch (workflow_runs.batch_id,
    // migration 022 — stamped by RunLauncher when the sprint launches with
    // seed tasks). Read defensively: a NULL/absent batch is a designed reject.
    const runRow = this.db
      .prepare('SELECT batch_id AS batchId FROM workflow_runs WHERE id = ?')
      .get(msg.runId) as { batchId?: unknown } | undefined;
    const batchId = typeof runRow?.batchId === 'string' && runRow.batchId.length > 0 ? runRow.batchId : null;
    if (!batchId) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'sprint_lane_requires_batch_run',
      });
      return;
    }

    // Orchestrated-plane mirror of the programmatic plane's driveLane threading
    // (programmatic/workflowController.ts runFanOut: allowedStepIds = inner ids,
    // widened with AWAITING_VERIFY_STEP for the merge-gate park step). Resolve the
    // CALLING run's chain-derived vocabulary instead of validating against the
    // fixed SPRINT_LANE_STEP_IDS default. Fail-soft: an unresolvable run/definition
    // or a definition with no fanOut step yields `undefined`, so
    // SprintLaneStore.updateLane degrades to today's canonical default — never
    // fail-closed.
    const inner = resolveRunFanOutInner(this.db, msg.runId);
    const allowedStepIds = inner ? [...inner.map((s) => s.id), AWAITING_VERIFY_STEP] : undefined;

    try {
      const lane = SprintLaneStore.getInstance().updateLane({
        runId: msg.runId,
        batchId,
        taskId: msg.taskId,
        ...(msg.status !== undefined ? { status: msg.status } : {}),
        ...(msg.currentStepId !== undefined ? { currentStepId: msg.currentStepId } : {}),
        ...(msg.attempt !== undefined ? { attempt: msg.attempt } : {}),
        ...(allowedStepIds !== undefined ? { allowedStepIds } : {}),
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          batch_id: lane.batchId,
          task_id: lane.taskId,
          status: lane.status,
          current_step_id: lane.currentStepId,
          attempts: lane.attempts,
          ref: lane.ref,
          title: lane.title,
          updated_at: lane.updatedAt,
        },
      });
    } catch (err) {
      this.writeSprintLaneError(client, msg.requestId, err);
    }
  }

  /**
   * Surface a lane-store failure as an ok:false response. A SprintLaneError
   * maps to its discriminated .code (mirrors writeTaskChangeError); anything
   * else is logged and collapsed to the opaque 'sprint_lane_failed'.
   */
  private writeSprintLaneError(client: net.Socket, requestId: string, err: unknown): void {
    if (err instanceof SprintLaneError) {
      // A createForRun 'no_eligible_tasks' (candidates exist but all failed the
      // eligibility guard) surfaces as the SAME ship-facing code the empty-set path
      // uses, so the ship agent gets one actionable signal. The WHY detail rides in
      // err.message (logged here — the wire response carries only the code string).
      if (err.code === 'no_eligible_tasks') {
        this.logger?.warn('[Cyboflow MCP Query] create-sprint-batch: no eligible tasks', {
          detail: err.message,
        });
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId,
          ok: false,
          error: 'ship_no_tasks_to_materialize',
        });
        return;
      }
      // createForRun's OWN batch-cap enforcement (Item 7) — the handler's step-5
      // pre-check above already returns this same 'ship_batch_too_large' code for
      // the common case, so this branch only fires when something changed the
      // eligible count BETWEEN that pre-check and the transaction (e.g. a
      // concurrent eligibility change) and the store's cap is what actually
      // caught it. Same wire code either way — callers see ONE signal.
      if (err.code === 'batch_too_large') {
        this.logger?.warn('[Cyboflow MCP Query] create-sprint-batch: batch too large', {
          detail: err.message,
        });
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId,
          ok: false,
          error: 'ship_batch_too_large',
        });
        return;
      }
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId,
        ok: false,
        error: err.code,
      });
      return;
    }
    this.logger?.error('[Cyboflow MCP Query] sprint lane update failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId,
      ok: false,
      error: 'sprint_lane_failed',
    });
  }

  // --------------------------------------------------------------------------
  // Mid-run sprint-batch materialization (cyboflow_create_sprint_batch)
  //
  // The HANDOFF SEAM for the 'ship' workflow: planner decomposition flows
  // directly into sprint execution in ONE continuous run. At the
  // 'materialize-batch' step the orchestrator calls this tool with the
  // human-approved task subset (from the approve-plan gate); the handler mints
  // the sprint batch + per-task lanes and stamps workflow_runs.batch_id MID-RUN
  // (RunLauncher only stamps it at launch for a seed-task sprint). Once batch_id
  // is non-null, the per-lane cyboflow_update_sprint_task writes succeed
  // (handleUpdateSprintTask reads batch_id live) and the swimlane canvas renders
  // (CyboflowRoot keys off activeRun.batch_id).
  //
  // IDEMPOTENT + transactional: a crash/resume re-call must not orphan a second
  // batch or reset lane status. Steps 2-7 (idempotency read → subset resolve →
  // empty/cap guards → createForRun → compare-and-set stamp) run in ONE
  // better-sqlite3 transaction; createForRun mints its own nested transaction
  // (savepoint), which composes safely.
  // --------------------------------------------------------------------------

  /**
   * Mint the sprint batch + lanes from the run's approved tasks and stamp
   * workflow_runs.batch_id, once.
   *
   * Guards (in order):
   *   1. resolveTaskRunContext — sentinel / missing / terminal run reject
   *      (parity with the other run-bound writes).
   *   2. IDEMPOTENCY — a run whose batch_id is already set returns
   *      { ok:true, batch_id, created:false } WITHOUT re-minting.
   *   3. SUBSET — the passed taskIds intersected with listRunCreatedTaskIds
   *      (ids the run did not create are dropped); the full created set when no
   *      subset is passed.
   *   4. EMPTY — no resolvable tasks → ok:false 'ship_no_tasks_to_materialize'.
   *   5. CAP backstop — more tasks than the effective per-substrate cap
   *      (resolveSprintMaxTasks over the user's Settings override) →
   *      ok:false 'ship_batch_too_large' (the human gate is the primary control).
   *   6. createForRun(projectId, substrate, taskIds) → { batchId }.
   *   7. COMPARE-AND-SET — UPDATE workflow_runs SET batch_id WHERE id AND
   *      batch_id IS NULL (a concurrent stamp loses, never double-mints).
   * On success emits a run-status-changed signal so activeRunsStore re-fetches
   * runs.list (now carrying batch_id) and the swimlane canvas mounts.
   */
  handleCreateSprintBatch(
    msg: Extract<McpQueryMessage, { type: 'mcp-create-sprint-batch' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveTaskRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    // Resolve the run's substrate (cap is substrate-keyed). Read defensively —
    // a pre-migration-013 DB lacking the column degrades to the 'sdk' default.
    let substrate: CliSubstrate = 'sdk';
    try {
      const subRow = this.db
        .prepare('SELECT substrate FROM workflow_runs WHERE id = ?')
        .get(msg.runId) as { substrate?: unknown } | undefined;
      if (subRow?.substrate === 'interactive') {
        substrate = 'interactive';
      }
    } catch {
      // Pre-migration-013 DB (no substrate column) — keep the 'sdk' default.
    }

    type Outcome =
      | { ok: true; batchId: string; created: boolean }
      | { ok: false; error: string };

    let outcome: Outcome;
    try {
      // Steps 2-7 in ONE transaction so a re-call cannot orphan a batch or
      // reset lane status. createForRun mints a nested savepoint internally.
      const txn = this.db.transaction((): Outcome => {
        // 2. IDEMPOTENCY — already materialized → no re-mint.
        const runRow = this.db
          .prepare('SELECT batch_id AS batchId FROM workflow_runs WHERE id = ?')
          .get(msg.runId) as { batchId?: unknown } | undefined;
        const existingBatchId =
          typeof runRow?.batchId === 'string' && runRow.batchId.length > 0 ? runRow.batchId : null;
        if (existingBatchId) {
          return { ok: true, batchId: existingBatchId, created: false };
        }

        // 3. SUBSET — intersect the passed ids with the run's created tasks (drop
        // any id the run did not create); fall back to the full created set. The
        // agent may pass DISPLAY REFS (e.g. 'TASK-034'), which never equal the opaque
        // 'tsk_' ids in the created set — so resolve each passed handle ref-or-id →
        // opaque id BEFORE the intersection (parity with add_task_dependency /
        // update_sprint_task ref resolution via resolveBacklogRef). An opaque id that
        // is already in the created set is kept as-is; anything else is resolved as a
        // display ref (project-scoped) and re-tested, so a real ref matches and a
        // bogus handle still drops out.
        const createdTaskIds = listRunCreatedTaskIds(this.db, msg.runId);
        let taskIds: string[];
        if (msg.taskIds && msg.taskIds.length > 0) {
          const createdSet = new Set(createdTaskIds);
          const resolved = [...new Set(msg.taskIds)].map((handle) =>
            createdSet.has(handle) ? handle : (resolveBacklogRef(this.db, ctx.projectId, handle) ?? handle),
          );
          taskIds = resolved.filter((id) => createdSet.has(id));
        } else {
          taskIds = createdTaskIds;
        }

        // 4. EMPTY guard.
        if (taskIds.length === 0) {
          return { ok: false, error: 'ship_no_tasks_to_materialize' };
        }

        // 5. CAP backstop (defense — the human gate is the primary control).
        if (taskIds.length > resolveSprintMaxTasks(this.deps.getSprintMaxTasks?.(), substrate)) {
          return { ok: false, error: 'ship_batch_too_large' };
        }

        // 6. Mint the batch + lanes via the SprintLaneStore chokepoint.
        const { batchId } = SprintLaneStore.getInstance().createForRun(ctx.projectId, substrate, taskIds);

        // 7. COMPARE-AND-SET the stamp (only when still NULL).
        this.db
          .prepare(
            'UPDATE workflow_runs SET batch_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND batch_id IS NULL',
          )
          .run(batchId, msg.runId);

        return { ok: true, batchId, created: true };
      });
      outcome = (txn as () => Outcome)();
    } catch (err) {
      this.writeSprintLaneError(client, msg.requestId, err);
      return;
    }

    if (!outcome.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: outcome.error,
      });
      return;
    }

    // Move the materialized batch's tasks to 'In development' (migration 066):
    // capture entry stage + derive execution stage per lane. Idempotent, so both
    // the created:true and idempotent created:false paths recompute. Fire-and-
    // forget + best-effort — a task-side failure (or an uninitialized router) must
    // never invalidate the committed batch or block the synchronous response.
    try {
      void TaskChangeRouter.getInstance()
        .recomputeTasksForBatch(outcome.batchId)
        .catch((err: unknown) => {
          this.logger?.warn('[Cyboflow MCP Query] create-sprint-batch task-stage derivation failed', {
            runId: msg.runId,
            batchId: outcome.batchId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    } catch (err: unknown) {
      this.logger?.warn('[Cyboflow MCP Query] create-sprint-batch task-stage derivation unavailable', {
        runId: msg.runId,
        batchId: outcome.batchId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 8. Emit a run-row-changed signal so activeRunsStore re-fetches runs.list
    // (now carrying batch_id) and the swimlane canvas mounts. The run stays
    // active; we re-assert its 'running' status. Best-effort — never let an
    // emit failure invalidate the committed batch.
    if (outcome.created) {
      try {
        runStatusEvents.emit('changed', {
          runId: msg.runId,
          status: 'running',
        } satisfies RunStatusChangedEvent);
      } catch (emitErr) {
        this.logger?.warn('[Cyboflow MCP Query] create-sprint-batch run-status emit failed', {
          runId: msg.runId,
          error: emitErr instanceof Error ? emitErr.message : String(emitErr),
        });
      }

      // Retire the run's owned idea(s) to the Decomposed terminal stage. Ship has
      // no planner-style human Archive gate (its terminal `decompose` step is
      // dropped), so without this a shipped idea lingers forever in its planning
      // stage even though its tasks now carry the flow. Fired here — AFTER the
      // human-approved plan is materialized into sprint lanes — and fire-and-forget
      // + best-effort: a failure must never invalidate the committed batch or block
      // the synchronous response below.
      void this.retireRunOwnedIdeas(ctx.projectId, msg.runId);
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { batch_id: outcome.batchId, created: outcome.created },
    });
  }

  /**
   * Retire every idea the run actually DECOMPOSED (via listRunDecomposedIdeaIds —
   * an owned idea with >=1 run-created child carrying its originating_idea_id
   * lineage; a seeded-but-childless idea in a multi-idea run is left on the board)
   * to the Decomposed terminal stage. The ship handoff seam's follow-on — see
   * handleCreateSprintBatch. Best-effort: each retire is idempotent (a no-op when
   * the idea is already at Decomposed) and individually guarded so one failure
   * can't starve the rest, and the whole pass is swallowed so it can never
   * invalidate the already-committed batch.
   */
  private async retireRunOwnedIdeas(projectId: number, runId: string): Promise<void> {
    try {
      const router = TaskChangeRouter.getInstance();
      for (const ideaId of listRunDecomposedIdeaIds(this.db, runId)) {
        await router.retireIdeaToDecomposed(projectId, ideaId).catch(() => {
          /* per-idea best-effort */
        });
      }
    } catch {
      /* best-effort housekeeping — never disturb the committed batch */
    }
  }
}
