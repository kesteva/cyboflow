/**
 * ApprovalRouter — singleton that owns the approval request/respond lifecycle.
 *
 * Design invariants (non-negotiable per ROADMAP-001 §5.7 and slice 6):
 *
 * 1. requestApproval co-writes the approvals INSERT and workflow_runs UPDATE
 *    inside a single db.transaction() guarded by `AND status='running'` on
 *    the UPDATE.  If the run is not in 'running' state, the transaction rolls
 *    back and requestApproval throws RunNotRunningError.
 *
 * 2. respond uses a guarded UPDATE `WHERE id=? AND status='awaiting_review'`
 *    and checks info.changes > 0 before writing the allow reply on the socket.
 *    If changes === 0, the run was concurrently canceled — no socket write.
 *
 * 3. Both requestApproval and respond submit their mutations via an
 *    ApprovalRouter-owned per-run p-queue (this.approvalQueues), ensuring
 *    serialization of all approval-mutations for the same run.  This queue
 *    is intentionally separate from RunQueueRegistry's per-run queue: that
 *    queue hosts the long-running runExecutor.execute() task, and re-entering
 *    it from inside a PreToolUse hook would self-deadlock (see
 *    runQueueRegistry.ts §no-recursive-enqueue rule).
 *
 * 4. The deny path mirrors the allow path's workflow_runs transition: a
 *    guarded UPDATE awaiting_review → running. The user denied this specific
 *    tool call, not the entire run, so Claude is free to retry with a
 *    different tool. Each subsequent PreToolUse opens a fresh approval gate.
 *
 * 5. Approvals do NOT auto-expire. A pending approval remains in the queue
 *    until the user decides (approve / reject) or the run is canceled. This
 *    matches the product invariant "workflow pauses until the human triages."
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*.
 * All collaborators are injected via the constructor.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import PQueue from 'p-queue';
import type { DatabaseLike } from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// Public approval contract — canonical home is shared/types/approval.ts.
// Re-exported here so every existing consumer keeps `from '../orchestrator/approvalRouter'`
// as its import path; that path remains backward-compatible by design.
import type { ApprovalRequest, ApprovalDecision } from '../../../shared/types/approval';
export type { ApprovalRequest, ApprovalDecision };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RunNotRunningError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} is not in 'running' state; approval request rejected`);
    this.name = 'RunNotRunningError';
  }
}

export class ApprovalNotFoundError extends Error {
  constructor(approvalId: string) {
    super(`No pending approval found with id ${approvalId}`);
    this.name = 'ApprovalNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingEntry {
  request: ApprovalRequest;
  /** Writes the decision to the bridge socket (closes the Claude tool-call wait). */
  socketReply: (decision: ApprovalDecision) => void;
  /** Resolves or rejects the Promise returned from requestApproval. */
  resolve: (decision: ApprovalDecision) => void;
  reject: (err: unknown) => void;
}

// ---------------------------------------------------------------------------
// ApprovalRouter
// ---------------------------------------------------------------------------

export class ApprovalRouter extends EventEmitter {
  private static instance: ApprovalRouter | null = null;

  /**
   * In-flight approvals: keyed by approvalId.
   * The entry is present from the moment requestApproval's transaction commits
   * until respond() (or a future clearPendingForRun) removes it.
   */
  private pending = new Map<string, PendingEntry>();

  /**
   * Per-run serialization queues for approval-router mutations.
   *
   * MUST be separate from RunQueueRegistry's per-run queues — RunLauncher
   * already enqueues `runExecutor.execute(runId)` on that queue, and the SDK
   * PreToolUse hook fires from WITHIN that task. Re-entering the same queue
   * from inside it would self-deadlock (see runQueueRegistry.ts §no-recursive-
   * enqueue rule).  Approval mutations therefore live on their own queue here.
   */
  private approvalQueues = new Map<string, PQueue>();

  private getApprovalQueue(runId: string): PQueue {
    let q = this.approvalQueues.get(runId);
    if (!q) {
      q = new PQueue({ concurrency: 1 });
      this.approvalQueues.set(runId, q);
    }
    return q;
  }

  /**
   * @param db               - Narrow DatabaseLike surface (no better-sqlite3 import).
   * @param _getQueueForRun  - Retained for backward compatibility with existing
   *                           callers/tests; NOT used internally.  ApprovalRouter
   *                           serializes its own mutations via approvalQueues
   *                           (see field doc above for the rationale).
   */
  constructor(
    private readonly db: DatabaseLike,
    _getQueueForRun: (runId: string) => PQueue,
  ) {
    super();
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Initialize (or replace) the singleton instance.
   * Called once at boot from main/src/index.ts after the RunQueueRegistry is
   * ready. Permission decisions arrive via the SDK PreToolUse hook in
   * claudeCodeManager.makePreToolUseHook (TASK-590).
   */
  static initialize(
    db: DatabaseLike,
    getQueueForRun: (runId: string) => PQueue,
  ): ApprovalRouter {
    ApprovalRouter.instance = new ApprovalRouter(db, getQueueForRun);
    return ApprovalRouter.instance;
  }

  static getInstance(): ApprovalRouter {
    if (!ApprovalRouter.instance) {
      throw new Error(
        'ApprovalRouter has not been initialized. ' +
        'Call ApprovalRouter.initialize() from main/src/index.ts ' +
        'after the RunQueueRegistry is ready.',
      );
    }
    return ApprovalRouter.instance;
  }

  /** Reset singleton — intended for tests only. */
  static _resetForTesting(): void {
    ApprovalRouter.instance = null;
  }

  // --------------------------------------------------------------------------
  // Core API
  // --------------------------------------------------------------------------

  /**
   * Register an approval request for `runId`.
   *
   * Atomically:
   *  1. UPDATEs workflow_runs.status → 'awaiting_review' (guarded: only if
   *     current status = 'running').  Throws RunNotRunningError if changes = 0.
   *  2. INSERTs a row into approvals (status = 'pending').
   *
   * Both writes share a single db.transaction() so they are
   * either both committed or both rolled back.
   *
   * The mutation is submitted via the per-run p-queue so it is serialized
   * with any concurrent status changes for the same run.
   *
   * Returns a Promise<ApprovalDecision> that resolves when respond() is called.
   *
   * @param runId        - workflow_runs.id
   * @param toolName     - The tool name Claude is requesting permission for.
   * @param input        - The tool call's input arguments.
   * @param socketReply  - Closure invoked exactly once by respond() to convey
   *                       the decision back to the caller. Under the SDK
   *                       PreToolUse path this is a no-op (the caller awaits
   *                       the returned promise directly), kept for backward
   *                       compatibility with any future transport adapter.
   */
  async requestApproval(
    runId: string,
    toolName: string,
    input: Record<string, unknown>,
    socketReply: (decision: ApprovalDecision) => void,
  ): Promise<ApprovalDecision> {
    if (!this.db) throw new Error('ApprovalRouter db handle undefined');

    const approvalId = randomUUID();
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    const request: ApprovalRequest = {
      id: approvalId,
      runId,
      toolName,
      input,
      timestamp: nowMs,
    };

    // Wire up the decision Promise before enqueueing — the resolve/reject refs
    // are captured in the pending map once the transaction commits.
    let resolveDecision!: (decision: ApprovalDecision) => void;
    let rejectDecision!: (err: unknown) => void;
    const decisionPromise = new Promise<ApprovalDecision>((res, rej) => {
      resolveDecision = res;
      rejectDecision = rej;
    });

    await this.getApprovalQueue(runId).add(async () => {
      // Atomic: UPDATE workflow_runs + INSERT approvals in one transaction.
      const txn = this.db.transaction(() => {
        const updateStmt = this.db.prepare(
          `UPDATE workflow_runs SET status = 'awaiting_review', updated_at = ?
           WHERE id = ? AND status = 'running'`,
        );
        const updateResult = updateStmt.run(now, runId) as { changes: number };

        if (updateResult.changes === 0) {
          throw new RunNotRunningError(runId);
        }

        const insertStmt = this.db.prepare(
          `INSERT INTO approvals
             (id, run_id, tool_name, tool_input_json, tool_use_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        );
        // tool_use_id is NOT NULL in the schema; we use the approvalId as the
        // canonical tool-use identifier until TASK-304 threads the real Claude
        // tool_use_id through the pipeline.
        insertStmt.run(approvalId, runId, toolName, JSON.stringify(input), approvalId, now);
      });

      // Execute the transaction — throws RunNotRunningError on guard failure.
      (txn as () => void)();

      this.pending.set(approvalId, {
        request,
        socketReply,
        resolve: resolveDecision,
        reject: rejectDecision,
      });

      // Notify renderer subscribers (e.g. the review queue UI).
      this.emit('approvalCreated', request);
    });

    return decisionPromise;
  }

  /**
   * Submit a decision for an in-flight approval.
   *
   * For `allow`:
   *  - Runs a guarded UPDATE: `WHERE id=? AND status='awaiting_review'`.
   *  - If changes = 0 (run was concurrently canceled), logs WARN, marks
   *    approval as 'rejected', and does NOT invoke socketReply.
   *  - If changes > 0, marks approval as 'approved' and invokes socketReply.
   *
   * For `deny`:
   *  - Runs a guarded UPDATE awaiting_review → running so the agent can retry
   *    with a different tool/approach. If the run was concurrently canceled,
   *    the guarded UPDATE is a no-op and the run stays canceled.
   *  - Marks approval as 'rejected' and invokes socketReply.
   *
   * @param approvalId - The UUID of the in-flight approval row.
   * @param decision   - The user's (or policy's) decision.
   */
  async respond(approvalId: string, decision: ApprovalDecision): Promise<void> {
    // Fast-path guard: surface unknown IDs synchronously before touching the queue.
    const peek = this.pending.get(approvalId);
    if (!peek) {
      throw new ApprovalNotFoundError(approvalId);
    }

    // The authoritative reservation happens INSIDE the queue so that two
    // concurrent respond() calls for the same approvalId (same runId queue)
    // are serialized — the second one finds the entry already gone and
    // returns as a silent no-op, satisfying the exactly-once socketReply
    // contract.
    await this.getApprovalQueue(peek.request.runId).add(async () => {
      // Re-fetch inside the queue — a prior concurrent respond() may have
      // already removed the entry.
      const entry = this.pending.get(approvalId);
      if (!entry) {
        // A prior respond() already settled this approval; no-op.
        return;
      }

      // Atomically reserve this entry before any async work.
      this.pending.delete(approvalId);

      const { request, socketReply, resolve } = entry;
      const now = new Date().toISOString();

      if (decision.behavior === 'allow') {
        const updateStmt = this.db.prepare(
          `UPDATE workflow_runs SET status = 'running', updated_at = ?
           WHERE id = ? AND status = 'awaiting_review'`,
        );
        const info = updateStmt.run(now, request.runId) as { changes: number };

        if (info.changes === 0) {
          // The run was concurrently canceled (or already completed/failed) between
          // requestApproval and now.  Do NOT revive it.
          console.warn(
            `[ApprovalRouter] respond allow: run ${request.runId} is no longer in ` +
            `'awaiting_review'; approval ${approvalId} superseded — socket reply suppressed`,
          );
          // Mark the DB row as rejected (superseded is not a valid status in the schema).
          this.db.prepare(
            `UPDATE approvals SET status = 'rejected', decided_at = ?, decided_by = 'auto-policy'
             WHERE id = ?`,
          ).run(now, approvalId);
          // Resolve the requestApproval promise with a synthetic deny so the
          // awaiting caller is not left hanging.
          resolve({ behavior: 'deny', message: 'Run was canceled before approval could be processed' });
          this.emit('approvalDecided', { approvalId, decision: 'rejected' });
          return;
        }

        // Commit the approval row.
        this.db.prepare(
          `UPDATE approvals SET status = 'approved', decided_at = ?, decided_by = 'user'
           WHERE id = ?`,
        ).run(now, approvalId);

        resolve(decision);
        socketReply(decision);
        this.emit('approvalDecided', { approvalId, decision: 'approved' });
      } else {
        // deny: transition workflow_runs back to 'running' so the agent can
        // retry with a different tool/approach. The user denied this specific
        // call, not the entire run. Guarded UPDATE so a concurrent cancel
        // wins — if the run is no longer awaiting_review, it stays where it is.
        this.db.prepare(
          `UPDATE workflow_runs SET status = 'running', updated_at = ?
           WHERE id = ? AND status = 'awaiting_review'`,
        ).run(now, request.runId);

        this.db.prepare(
          `UPDATE approvals SET status = 'rejected', decided_at = ?, decided_by = 'user'
           WHERE id = ?`,
        ).run(now, approvalId);

        resolve(decision);
        socketReply(decision);
        this.emit('approvalDecided', { approvalId, decision: 'rejected' });
      }
    });
  }

  /**
   * Clear all pending approvals for `runId`.
   *
   * Called during run termination (e.g., from claudeCodeManager's runSdkQuery
   * finally block) to settle any in-flight approval Promises so that callers
   * are not left hanging.
   *
   * Invariants:
   * - Synchronous; returns void.  Does NOT submit work through the per-run PQueue.
   * - Resolves each pending Promise with a deny-shaped ApprovalDecision so the
   *   awaiting PreToolUse hook callback can return a deny to the SDK cleanly.
   * - Does NOT invoke socketReply — the run is being torn down; the socket is
   *   no longer meaningful.
   * - Performs a guarded DB UPDATE (`WHERE id = ? AND status = 'pending'`) for
   *   idempotency with a concurrent respond() that may have already settled the row.
   * - DB errors during shutdown are swallowed with console.warn so they never
   *   surface as unhandled rejections during process teardown.
   */
  clearPendingForRun(runId: string): void {
    const denyDecision: ApprovalDecision = {
      behavior: 'deny',
      message: 'Run was terminated before approval could be processed',
    };

    // Collect entries first, then mutate the map to avoid iterating-while-deleting.
    const toClose: Array<{ approvalId: string; entry: PendingEntry }> = [];
    for (const [approvalId, entry] of this.pending.entries()) {
      if (entry.request.runId === runId) {
        toClose.push({ approvalId, entry });
      }
    }

    for (const { approvalId, entry } of toClose) {
      this.pending.delete(approvalId);

      try {
        const now = new Date().toISOString();
        // Guarded UPDATE for idempotency: if respond() already settled the row,
        // status will no longer be 'pending' and changes will be 0 — that is fine.
        this.db.prepare(
          `UPDATE approvals SET status = 'rejected', decided_at = ?, decided_by = 'system'
           WHERE id = ? AND status = 'pending'`,
        ).run(now, approvalId);
      } catch (err) {
        // Swallow DB errors during shutdown — do not throw.
        console.warn(
          `[ApprovalRouter] clearPendingForRun: DB update failed for approval ${approvalId} (run ${runId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Resolve the awaiting Promise — do NOT invoke socketReply.
      entry.resolve(denyDecision);
      this.emit('approvalDecided', { approvalId, decision: 'rejected' });
    }
  }

  /**
   * Boot-time recovery. The Unix permission socket from the previous app
   * session is gone (path is keyed on the previous process.pid), so any
   * workflow_runs row in 'awaiting_review' cannot be resumed. Transition
   * them to 'failed' with error_message='app_restart' and flip any orphaned
   * pending approvals to 'timed_out' for audit consistency.
   *
   * Returns the number of workflow_runs rows transitioned.
   */
  recoverStaleAwaitingReview(): number {
    const transition = this.db.transaction(() => {
      const staleRunIds = this.db
        .prepare(`SELECT id FROM workflow_runs WHERE status = 'awaiting_review'`)
        .all() as { id: string }[];
      if (staleRunIds.length === 0) return 0;
      const placeholders = staleRunIds.map(() => '?').join(',');
      const ids = staleRunIds.map(r => r.id);
      this.db
        .prepare(`UPDATE workflow_runs
                     SET status = 'failed',
                         error_message = 'app_restart',
                         ended_at = CURRENT_TIMESTAMP,
                         updated_at = CURRENT_TIMESTAMP
                   WHERE id IN (${placeholders})`)
        .run(...ids);
      this.db
        .prepare(`UPDATE approvals SET status = 'timed_out', decided_at = CURRENT_TIMESTAMP, decided_by = 'system' WHERE run_id IN (${placeholders}) AND status = 'pending'`)
        .run(...ids);
      return staleRunIds.length;
    });
    const count = transition();
    if (count > 0) {
      console.log(`[ApprovalRouter] Boot recovery transitioned ${count} stale awaiting_review run(s) to failed`);
    }
    return count;
  }

  /**
   * Returns a snapshot of all currently in-flight approval requests.
   * Used by the renderer's review-queue subscription.
   */
  getPending(): ApprovalRequest[] {
    return Array.from(this.pending.values()).map((p) => p.request);
  }
}
