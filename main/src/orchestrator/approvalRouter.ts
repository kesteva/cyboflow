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
 * 3. Both requestApproval and respond submit their mutations via the per-run
 *    p-queue obtained from the RunQueueRegistry, ensuring serialization of
 *    all state mutations for the same run.
 *
 * 4. The deny path updates approvals.status='rejected' and does NOT touch
 *    workflow_runs.status — Claude will receive the deny on the socket, emit
 *    a tool-result error, and the run remains in awaiting_review until Claude
 *    yields (§5.7 of the design doc).
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
// Constants
// ---------------------------------------------------------------------------

/** v1 default per ROADMAP-001 §5.7. Adjustable post-MVP via config. */
export const APPROVAL_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

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
  /** Handle for the 60-minute auto-expiry timer. Cleared by respond() to avoid leaks. */
  timeoutHandle: NodeJS.Timeout;
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
   * @param db              - Narrow DatabaseLike surface (no better-sqlite3 import).
   * @param getQueueForRun  - Returns (or lazily creates) the per-run PQueue from
   *                          RunQueueRegistry.  Pass `registry.getOrCreate.bind(registry)`.
   */
  constructor(
    private readonly db: DatabaseLike,
    private readonly getQueueForRun: (runId: string) => PQueue,
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

    await this.getQueueForRun(runId).add(async () => {
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

      // Schedule the 60-minute auto-expiry timer per ROADMAP-001 §5.7.
      const timeoutHandle = setTimeout(() => {
        void this.expireApproval(approvalId);
      }, APPROVAL_TIMEOUT_MS);

      this.pending.set(approvalId, {
        request,
        socketReply,
        resolve: resolveDecision,
        reject: rejectDecision,
        timeoutHandle,
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
   *  - Marks approval as 'rejected'.  Does NOT touch workflow_runs.status
   *    (Claude will receive the deny on the socket and the run remains in
   *    awaiting_review until Claude yields — §5.7).
   *  - Invokes socketReply.
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

    // Cancel the auto-expiry timer before entering the queue so the timer
    // cannot fire concurrently while respond() is processing.
    clearTimeout(peek.timeoutHandle);

    // The authoritative reservation happens INSIDE the queue so that two
    // concurrent respond() calls for the same approvalId (same runId queue)
    // are serialized — the second one finds the entry already gone and
    // returns as a silent no-op, satisfying the exactly-once socketReply
    // contract.
    await this.getQueueForRun(peek.request.runId).add(async () => {
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
          return;
        }

        // Commit the approval row.
        this.db.prepare(
          `UPDATE approvals SET status = 'approved', decided_at = ?, decided_by = 'user'
           WHERE id = ?`,
        ).run(now, approvalId);

        resolve(decision);
        socketReply(decision);
      } else {
        // deny: update approvals only, do NOT touch workflow_runs.
        this.db.prepare(
          `UPDATE approvals SET status = 'rejected', decided_at = ?, decided_by = 'user'
           WHERE id = ?`,
        ).run(now, approvalId);

        resolve(decision);
        socketReply(decision);
      }
    });
  }

  /**
   * Called by the 60-minute auto-expiry timer when a pending approval has not
   * been resolved by a human or policy decision within the timeout window.
   *
   * Submits work through the per-run queue so expiry is serialized with any
   * concurrent respond() call for the same run.  If respond() beat the timer
   * to the entry (entry is already gone from this.pending), this is a no-op.
   *
   * Sets approvals.status = 'timed_out' and sends a deny decision on the
   * bridge socket.  Does NOT touch workflow_runs.status — Claude receives the
   * deny on the socket and the run remains in awaiting_review until Claude
   * yields (§5.7).
   */
  private async expireApproval(approvalId: string): Promise<void> {
    const entry = this.pending.get(approvalId);
    if (!entry) return;

    await this.getQueueForRun(entry.request.runId).add(async () => {
      const entryNow = this.pending.get(approvalId);
      if (!entryNow) return; // respond() beat the timer inside the queue.

      this.pending.delete(approvalId);

      const now = new Date().toISOString();
      this.db.prepare(
        `UPDATE approvals SET status = 'timed_out', decided_at = ?, decided_by = 'timeout'
         WHERE id = ?`,
      ).run(now, approvalId);

      const denyDecision: ApprovalDecision = {
        behavior: 'deny',
        message: 'Approval timed out after 60 minutes',
      };
      entryNow.socketReply(denyDecision);
      entryNow.resolve(denyDecision);
      this.emit('approvalExpired', approvalId);
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
      // Cancel the auto-expiry timer before removing the entry.
      clearTimeout(entry.timeoutHandle);
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
