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
import {
  coWriteDecisionReviewItem,
  resolveReviewItemById,
  countPendingBlockingReviewItems,
  hasReviewItemsTable,
} from './reviewItemListing';

/** Provenance source stamped on a human-gate decision review_item. */
const HUMAN_GATE_SOURCE = 'gate:human-step';

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

      const txn = this.db.transaction(() => {
        const info = this.db
          .prepare(
            `UPDATE workflow_runs SET status = 'awaiting_review', updated_at = ?
              WHERE id = ? AND status = 'running'`,
          )
          .run(now, runId) as { changes: number };
        if (info.changes === 0) {
          // Run not in 'running' — already paused / terminal. Do NOT open a gate.
          return;
        }

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

      return { resolved, resumed };
    })) as { resolved: boolean; resumed: boolean };
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
      return info.changes > 0;
    })) as boolean;
  }

  /**
   * Stable per-step source string so the idempotency probe and the gate row use
   * the SAME provenance. e.g. 'gate:human-step:plan-review'.
   */
  private sourceForStep(stepId: string): string {
    return `${HUMAN_GATE_SOURCE}:${stepId}`;
  }
}
