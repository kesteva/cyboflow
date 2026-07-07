/**
 * HumanStepManager — owns the run-pause lifecycle for a workflow step marked
 * `human: true` (a human gate, e.g. the Plan-review / approve-plan stage).
 *
 * Design (P4):
 *  - When the agent reports a step whose resolved definition has `human === true`,
 *    openHumanGate co-writes a BLOCKING decision review_items row AND transitions
 *    the run running -> awaiting_review in ONE db.transaction(). The run is then
 *    PAUSED: it does NOT transparently pass the gate. Subsequent MCP step writes /
 *    tool approvals fail their `status='running'` guard, so the agent cannot
 *    advance until a human resolves the gate.
 *  - On resolve of the gate's decision item (from the reviewItems tRPC router),
 *    resolveHumanGate applies AGGREGATE-UNBLOCK: it resolves the item and resumes
 *    the run to 'running' ONLY when there is no OTHER pending blocking review_item
 *    for the run (a permission gate or a second decision may still be open). The
 *    run stays awaiting_review until ALL blocking items resolve, then AUTO-resumes.
 *
 * Idempotency: openHumanGate is keyed on the (runId, stepId) source so reporting
 * the same human step twice (status running then done) opens the gate at most
 * once. resolveHumanGate's UPDATEs are guarded so a double-resolve is a no-op.
 *
 * Standalone-typecheck invariant: NO imports from 'electron', 'better-sqlite3',
 * or any concrete service in main/src/services/*. The DB is the narrow
 * DatabaseLike interface; lifecycle UPDATEs are issued directly (the
 * stateMachine transition table is reused conceptually — running<->awaiting_review
 * are both legal — but this module does not import the services/cyboflow helper to
 * preserve the standalone invariant).
 */
import PQueue from 'p-queue';
import type { DatabaseLike } from './types';
import type { RunStatusChangedEvent } from '../../../shared/types/cyboflow';
import {
  coWriteDecisionReviewItem,
  resolveReviewItemById,
  dismissReviewItemById,
  countPendingBlockingReviewItems,
  hasReviewItemsTable,
} from './reviewItemListing';
import { emitReviewItemChangedById } from './reviewItemRouter';
import { runStatusEvents } from './trpc/routers/events';

/** Provenance source stamped on a human-gate decision review_item. */
const HUMAN_GATE_SOURCE = 'gate:human-step';

/**
 * Provenance prefix stamped on a systemic-pause decision review_item (the
 * canonical constant is `SYSTEMIC_PAUSE_SOURCE` in
 * programmatic/systemicPauseGate.ts — duplicated here as a bare literal to keep
 * this module free of a `programmatic/` import). Cancel-path cleanup
 * (clearPendingForRun) must dismiss these pause items too, so a canceled run does
 * not strand an orphan "Run paused" decision row in the review queue.
 */
const SYSTEMIC_PAUSE_SOURCE = 'gate:systemic-pause';

export class HumanStepManager {
  private static instance: HumanStepManager | null = null;

  /** Per-run serialization queue (separate from RunQueueRegistry — see routers). */
  private queues = new Map<string, PQueue>();

  constructor(private readonly db: DatabaseLike) {}

  static initialize(db: DatabaseLike): HumanStepManager {
    HumanStepManager.instance = new HumanStepManager(db);
    return HumanStepManager.instance;
  }

  static getInstance(): HumanStepManager {
    if (!HumanStepManager.instance) {
      throw new Error(
        'HumanStepManager has not been initialized. Call HumanStepManager.initialize() from main/src/index.ts.',
      );
    }
    return HumanStepManager.instance;
  }

  /** Reset singleton — intended for tests only. */
  static _resetForTesting(): void {
    HumanStepManager.instance = null;
  }

  private getQueue(runId: string): PQueue {
    let q = this.queues.get(runId);
    if (!q) {
      q = new PQueue({ concurrency: 1 });
      this.queues.set(runId, q);
    }
    return q;
  }

  /** Test/seam helper — exposes the per-run queue for `.onIdle()` waits. */
  _queueForRun(runId: string): PQueue {
    return this.getQueue(runId);
  }

  /**
   * Open a human gate for `runId` at `stepId` (idempotent per run+step).
   *
   * Atomically (in ONE transaction):
   *   1. Guarded UPDATE workflow_runs running -> awaiting_review.
   *   2. Co-write a blocking decision review_items row (source identifies the gate
   *      + step).
   * If the run is not in 'running' state, the transaction rolls back and NO gate
   * is opened (returns null) — the run is already paused / terminal.
   *
   * @returns the minted review-item id, or null when the gate was not opened
   *   (run not running, table absent, or the gate is already open for this step).
   */
  async openHumanGate(
    runId: string,
    stepId: string,
    stepName: string,
  ): Promise<string | null> {
    if (!hasReviewItemsTable(this.db)) return null;

    return (await this.getQueue(runId).add(() => {
      // Idempotency guard: if a pending human-gate decision item for THIS step
      // already exists, do not open a second one.
      const existing = this.db
        .prepare(
          `SELECT id FROM review_items
            WHERE run_id = ? AND kind = 'decision' AND status = 'pending'
              AND source = ? LIMIT 1`,
        )
        .get(runId, this.sourceForStep(stepId)) as { id?: string } | undefined;
      if (existing?.id) return null;

      const now = new Date().toISOString();
      let reviewItemId: string | null = null;
      let gateOpened = false;

      const txn = this.db.transaction(() => {
        // Accept BOTH 'running' and 'awaiting_review' for the gate-open transition.
        // 'awaiting_review' covers the resume-lag window for BACK-TO-BACK gates:
        // the UI resolve path (reviewItems.resolve) emits 'resolved' and only THEN
        // calls maybeResumeRun, so the programmatic controller can open the NEXT
        // gate while the run is momentarily still awaiting_review. Opening from
        // awaiting_review re-parks it there (no-op on status) and the new blocking
        // decision item keeps the prior gate's maybeResumeRun from resuming — which
        // is correct (the run IS still gated). Terminal states (completed/failed/
        // canceled) are still refused (→ null). The per-step idempotency guard
        // above prevents a duplicate gate for the SAME step.
        const info = this.db
          .prepare(
            `UPDATE workflow_runs SET status = 'awaiting_review', updated_at = ?
              WHERE id = ? AND status IN ('running', 'awaiting_review')`,
          )
          .run(now, runId) as { changes: number };
        if (info.changes === 0) {
          // Run terminal (or row gone) — do NOT open a gate.
          return;
        }
        gateOpened = true;

        reviewItemId = coWriteDecisionReviewItem(this.db, {
          runId,
          title: `Human gate: ${stepName}`,
          body: `Workflow step '${stepId}' requires a human decision before the run can advance.`,
          source: this.sourceForStep(stepId),
          payload: null,
          now,
        });
      });
      (txn as () => void)();

      // Renderer signals AFTER the commit — the co-write deliberately bypasses
      // the ReviewItemRouter chokepoint (it must share this transaction), so the
      // emits the chokepoint would have owned happen here: the project-scoped
      // review-item delta (queue chip / landing inbox) and the run-status
      // change (rail badge / landing re-sync).
      if (gateOpened) {
        runStatusEvents.emit('changed', {
          runId,
          status: 'awaiting_review',
        } satisfies RunStatusChangedEvent);
      }
      if (reviewItemId) emitReviewItemChangedById(this.db, reviewItemId, 'created');

      return reviewItemId;
    })) as string | null;
  }

  /**
   * Resolve a human-gate (or any) blocking decision item and AUTO-RESUME the run
   * subject to aggregate-unblock.
   *
   * Atomically (in ONE transaction):
   *   1. Resolve the review_items row by id (idempotent guarded UPDATE).
   *   2. If NO other pending blocking review_item remains for the run, transition
   *      the run awaiting_review -> running (auto-resume). Otherwise the run STAYS
   *      awaiting_review until the remaining blocking items resolve.
   *
   * @returns { resolved, resumed } — whether the item transitioned and whether
   *   the run auto-resumed in this call.
   */
  async resolveHumanGate(
    runId: string,
    reviewItemId: string,
    resolvedBy: string,
    resolution: string | null,
  ): Promise<{ resolved: boolean; resumed: boolean }> {
    return (await this.getQueue(runId).add(() => {
      const now = new Date().toISOString();
      let resolved = false;
      let resumed = false;

      const txn = this.db.transaction(() => {
        const id = resolveReviewItemById(this.db, reviewItemId, resolvedBy, resolution, now, runId);
        resolved = id !== null;

        // Aggregate-unblock: resume ONLY when no other blocking item is pending.
        if (countPendingBlockingReviewItems(this.db, runId) === 0) {
          const info = this.db
            .prepare(
              `UPDATE workflow_runs SET status = 'running', updated_at = ?
                WHERE id = ? AND status = 'awaiting_review'`,
            )
            .run(now, runId) as { changes: number };
          resumed = info.changes > 0;
        }
      });
      (txn as () => void)();

      if (resolved) emitReviewItemChangedById(this.db, reviewItemId, 'resolved');
      if (resumed) {
        runStatusEvents.emit('changed', { runId, status: 'running' } satisfies RunStatusChangedEvent);
      }

      return { resolved, resumed };
    })) as { resolved: boolean; resumed: boolean };
  }

  /**
   * True when the run has at least one PENDING blocking review_item (any kind —
   * decision gate, permission, human_task, OR a blocking finding). The programmatic
   * blocking-items checkpoint (BlockingReviewItemsGate) reads this to decide whether
   * a step boundary must park the run. Fail-soft: 0 (no gate) when the inbox table
   * is absent.
   */
  hasPendingBlockingItems(runId: string): boolean {
    if (!hasReviewItemsTable(this.db)) return false;
    return countPendingBlockingReviewItems(this.db, runId) > 0;
  }

  /**
   * Park a RUNNING programmatic run in awaiting_review because a PENDING blocking
   * review_item exists for it (e.g. a blocking finding recorded mid-step). Unlike
   * openHumanGate this does NOT co-write a decision item — the blocking item that
   * triggered the park already exists. Guarded `WHERE status='running'` so it never
   * disturbs a run that is already parked/terminal, and a no-op when the run has no
   * pending blocking items (a benign race where they cleared first). Serialized on
   * the SAME per-run queue as the gate transitions. Emits the awaiting_review
   * run-status delta on a real transition.
   *
   * @returns true when the run actually transitioned running -> awaiting_review.
   */
  async parkForBlockingReview(runId: string): Promise<boolean> {
    if (!hasReviewItemsTable(this.db)) return false;
    return (await this.getQueue(runId).add(() => {
      // Only park when there is genuinely something blocking (avoid parking a run
      // whose blocking items cleared between the caller's check and this task).
      if (countPendingBlockingReviewItems(this.db, runId) === 0) return false;
      const now = new Date().toISOString();
      const info = this.db
        .prepare(
          `UPDATE workflow_runs SET status = 'awaiting_review', updated_at = ?
            WHERE id = ? AND status = 'running'`,
        )
        .run(now, runId) as { changes: number };
      const parked = info.changes > 0;
      if (parked) {
        runStatusEvents.emit('changed', { runId, status: 'awaiting_review' } satisfies RunStatusChangedEvent);
      }
      return parked;
    })) as boolean;
  }

  /**
   * Aggregate-unblock auto-resume — the resume HALF of resolveHumanGate, used by
   * the reviewItems tRPC router AFTER the item has already been resolved through
   * the ReviewItemRouter chokepoint (so the chokepoint owns the audit + emit, and
   * this only handles the run transition).
   *
   * Transitions the run awaiting_review -> running ONLY when there is NO pending
   * blocking review_item left for it. A run with remaining blocking items (a
   * permission gate or a sibling decision still open) STAYS awaiting_review.
   * Idempotent: a guarded UPDATE means a no-blocking-remaining run that is not in
   * awaiting_review is a safe no-op.
   *
   * @returns true if the run auto-resumed in this call.
   */
  async maybeResumeRun(runId: string): Promise<boolean> {
    if (!hasReviewItemsTable(this.db)) return false;
    return (await this.getQueue(runId).add(() => {
      if (countPendingBlockingReviewItems(this.db, runId) > 0) return false;
      const now = new Date().toISOString();
      const info = this.db
        .prepare(
          `UPDATE workflow_runs SET status = 'running', updated_at = ?
            WHERE id = ? AND status = 'awaiting_review'`,
        )
        .run(now, runId) as { changes: number };
      const resumed = info.changes > 0;
      if (resumed) {
        runStatusEvents.emit('changed', { runId, status: 'running' } satisfies RunStatusChangedEvent);
      }
      return resumed;
    })) as boolean;
  }

  /**
   * Dismiss any PENDING human-gate decision items for a run — the symmetric
   * twin of ApprovalRouter.clearPendingForRun / QuestionRouter.clearPendingForRun,
   * called from the cancel path so a canceled run does not strand an orphan
   * "Human gate" decision row in the review queue.
   *
   * Marks each pending `decision` row with EITHER gate provenance — the human-gate
   * source (`gate:human-step:*`) OR the systemic-pause source
   * (`gate:systemic-pause:*`) — as 'dismissed' (resolved_by 'system', resolution
   * 'canceled') and emits a 'dismissed' delta so the queue/landing subscriptions
   * update. It does NOT resume the run (cancel owns the terminal transition) and is
   * fail-soft on a missing table. NOTE: the
   * IN-MEMORY gate Promise (ReviewQueueHumanGate) is settled separately and
   * synchronously by the run's AbortSignal (RunExecutor.requestProgrammaticCancel)
   * BEFORE this runs, so the 'dismissed' event here is purely DB/queue cleanup and
   * cannot drive the gate decision (the resolver already settled to 'abort').
   *
   * Serialized on the SAME per-run queue as openHumanGate/resolveHumanGate, so it
   * runs AFTER any in-flight openHumanGate transaction has committed — closing the
   * cross-queue race where a cancel that lands mid-open could SELECT zero pending
   * rows (the gate row not yet committed) and leave it orphaned.
   *
   * @returns the number of decision rows dismissed.
   */
  async clearPendingForRun(runId: string): Promise<number> {
    if (!hasReviewItemsTable(this.db)) return 0;
    return (await this.getQueue(runId).add(() => {
      const now = new Date().toISOString();
      const pending = this.db
        .prepare(
          `SELECT id FROM review_items
            WHERE run_id = ? AND kind = 'decision' AND status = 'pending'
              AND (source LIKE ? OR source LIKE ?)`,
        )
        .all(runId, `${HUMAN_GATE_SOURCE}:%`, `${SYSTEMIC_PAUSE_SOURCE}:%`) as Array<{ id: string }>;
      if (pending.length === 0) return 0;

      let dismissed = 0;
      for (const { id } of pending) {
        const dismissedId = dismissReviewItemById(this.db, id, 'system', 'canceled', now, runId);
        if (dismissedId !== null) {
          dismissed += 1;
          emitReviewItemChangedById(this.db, dismissedId, 'dismissed');
        }
      }
      return dismissed;
    })) as number;
  }

  /**
   * Find the id of an ALREADY-pending human-gate decision item for (runId, stepId),
   * or null (crash-safe resume). Used by ReviewQueueHumanGate to re-attach to a
   * gate that openHumanGate reports as already open after a restart re-drives a run
   * parked at it. Read-only; no transition. Delegates to the source-generic
   * findPendingItemBySource with this run's human-gate source.
   */
  async findPendingGate(runId: string, stepId: string): Promise<string | null> {
    return this.findPendingItemBySource(runId, this.sourceForStep(stepId));
  }

  /**
   * Find the id of an ALREADY-pending blocking `decision` review item for
   * (runId, source), or null. The source-generic form of findPendingGate: any
   * gate that mints a per-source blocking decision item (human gate, systemic
   * pause) re-attaches through this on a crash-safe resume. Read-only; no
   * transition. Fail-soft when the inbox table is absent.
   */
  async findPendingItemBySource(runId: string, source: string): Promise<string | null> {
    if (!hasReviewItemsTable(this.db)) return null;
    const row = this.db
      .prepare(
        `SELECT id FROM review_items
          WHERE run_id = ? AND kind = 'decision' AND status = 'pending' AND source = ? LIMIT 1`,
      )
      .get(runId, source) as { id?: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * Find the run's pending systemic-pause decision item — ANY step (prefix match
   * on `gate:systemic-pause:%`) — returning its id + project scope, or null.
   * Backs the monitor's retry_step fallback: a run PARKED on a live systemic
   * pause is neither failed nor resting, so retryRunHandler refuses it as
   * not_retryable — the host instead RESOLVES this item, which the
   * ReviewQueueSystemicPauseGate settles as a 'retry' verdict and the walk
   * re-runs the interrupted step. Read-only; no transition. Fail-soft when the
   * inbox table is absent.
   */
  async findPendingSystemicPauseItem(
    runId: string,
  ): Promise<{ reviewItemId: string; projectId: number } | null> {
    if (!hasReviewItemsTable(this.db)) return null;
    const row = this.db
      .prepare(
        `SELECT id, project_id FROM review_items
          WHERE run_id = ? AND kind = 'decision' AND status = 'pending' AND source LIKE ? LIMIT 1`,
      )
      .get(runId, `${SYSTEMIC_PAUSE_SOURCE}:%`) as
      | { id?: string; project_id?: number | null }
      | undefined;
    if (!row?.id || row.project_id === null || row.project_id === undefined) return null;
    return { reviewItemId: row.id, projectId: row.project_id };
  }

  /**
   * Stable per-step source string so the idempotency probe and the gate row use
   * the SAME provenance. e.g. 'gate:human-step:plan-review'.
   */
  private sourceForStep(stepId: string): string {
    return `${HUMAN_GATE_SOURCE}:${stepId}`;
  }
}
