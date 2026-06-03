/**
 * ApprovalRouter — singleton that owns the approval request/respond lifecycle.
 *
 * Design invariants (non-negotiable per ROADMAP-001 §5.7 and slice 6):
 *
 * 1. requestApproval co-writes the approvals INSERT and workflow_runs UPDATE
 *    inside a single db.transaction() guarded by `AND status='running'` on
 *    the UPDATE.  If the run is not in 'running' state, the transaction rolls
 *    back and requestApproval throws RunNotRunningError. P4: that SAME
 *    transaction also co-writes a blocking permission review_items row (the
 *    unified-inbox fold), so the approval row and the inbox row commit or roll
 *    back together; respond() resolves the folded item idempotently. The fold is
 *    a no-op on a pre-migration-016 DB (table-existence guarded).
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
import {
  coWritePermissionReviewItem,
  resolvePermissionReviewItem,
  hasReviewItemsTable,
} from './reviewItemListing';

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
   * Per-router PQueues (this.approvalQueues, see field doc above) are
   * intentional and MUST stay separate from RunQueueRegistry's per-run
   * queues — that registry hosts the long-running runExecutor.execute()
   * task and the SDK PreToolUse hook fires from WITHIN that task.
   * Re-entering RunQueueRegistry's queue from inside its own task would
   * self-deadlock (runQueueRegistry.ts §no-recursive-enqueue).
   */
  constructor(private readonly db: DatabaseLike) {
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
  static initialize(db: DatabaseLike): ApprovalRouter {
    ApprovalRouter.instance = new ApprovalRouter(db);
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

        // P4 fold: co-write a blocking permission review_item in the SAME
        // transaction so the unified inbox row and the approvals row commit (or
        // roll back) together. No-op on a pre-migration-016 DB. The folded item
        // links back to this approval via payload.approvalId so respond() can
        // resolve it idempotently.
        coWritePermissionReviewItem(this.db, {
          approvalId,
          runId,
          toolName,
          input,
          source: 'approval',
          now,
        });
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
      // No in-flight decision. The approval may still be a stale `pending` DB row
      // whose decisionPromise is gone (app restart) or whose run was closed out.
      // Settle it directly so the user can clear it from the review queue; only
      // report not-found when there is genuinely nothing pending to act on.
      if (this.settleStalePendingApproval(approvalId, decision)) {
        return;
      }
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
          // Resolve the folded permission review_item too (idempotent).
          resolvePermissionReviewItem(this.db, approvalId, 'auto-policy', 'superseded', now, request.runId);
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
        // Resolve the folded permission review_item (idempotent).
        resolvePermissionReviewItem(this.db, approvalId, 'user', 'approved', now, request.runId);

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
        // Resolve the folded permission review_item (idempotent). A deny resolves
        // the inbox item: the gate has been triaged; Claude is free to retry with
        // a different tool, which opens a fresh approval + review_item.
        resolvePermissionReviewItem(this.db, approvalId, 'user', 'rejected', now, request.runId);

        resolve(decision);
        socketReply(decision);
        this.emit('approvalDecided', { approvalId, decision: 'rejected' });
      }
    });
  }

  /**
   * Settle an approval that has a `pending` DB row but no in-memory entry — a
   * row that outlived its decisionPromise (app restart) or its run (close-out).
   * There is no awaiting caller or socket to satisfy; we move the row to a
   * terminal status and emit `approvalDecided` so the review queue drops it.
   *
   * @returns true if a `pending` row was settled (changes > 0); false when no
   *   such row exists or it was already terminal (caller treats that as
   *   not-found and throws ApprovalNotFoundError).
   */
  private settleStalePendingApproval(approvalId: string, decision: ApprovalDecision): boolean {
    const status = decision.behavior === 'allow' ? 'approved' : 'rejected';
    const now = new Date().toISOString();
    try {
      const info = this.db.prepare(
        `UPDATE approvals SET status = ?, decided_at = ?, decided_by = 'user'
         WHERE id = ? AND status = 'pending'`,
      ).run(status, now, approvalId) as { changes: number };
      if (info.changes > 0) {
        // Resolve any folded permission review_item for this approval (idempotent).
        resolvePermissionReviewItem(this.db, approvalId, 'user', status, now, null);
        this.emit('approvalDecided', { approvalId, decision: status });
        return true;
      }
    } catch (err) {
      console.warn(
        `[ApprovalRouter] settleStalePendingApproval: DB update failed for ${approvalId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return false;
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
        // Resolve the folded permission review_item too (idempotent).
        resolvePermissionReviewItem(this.db, approvalId, 'system', 'run_terminated', now, runId);
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

    // Sweep any remaining DB-only `pending` rows for this run — rows whose
    // in-memory entry was already gone (app restart, or an approval recorded
    // before this process started). Without this, closing out a run leaves
    // orphaned `pending` approvals stuck in the review queue forever.
    try {
      const now = new Date().toISOString();
      const staleRows = this.db
        .prepare(`SELECT id FROM approvals WHERE run_id = ? AND status = 'pending'`)
        .all(runId) as Array<{ id: string }>;
      for (const { id } of staleRows) {
        this.db.prepare(
          `UPDATE approvals SET status = 'rejected', decided_at = ?, decided_by = 'system'
           WHERE id = ? AND status = 'pending'`,
        ).run(now, id);
        resolvePermissionReviewItem(this.db, id, 'system', 'run_terminated', now, runId);
        this.emit('approvalDecided', { approvalId: id, decision: 'rejected' });
      }
    } catch (err) {
      console.warn(
        `[ApprovalRouter] clearPendingForRun: DB sweep failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Boot-time recovery for runs stuck mid-tool-approval. A run in
   * 'awaiting_review' WITH a pending approval row was blocked on the Unix
   * permission socket from the previous app session, which is gone (path is
   * keyed on the previous process.pid) — the agent can never receive its
   * socket reply, so the run cannot be resumed. Transition only those to
   * 'failed' with error_message='app_restart' and flip their orphaned pending
   * approvals to 'timed_out' for audit consistency.
   *
   * A clean-drain REST run (awaiting_review with NO pending approval) is NOT
   * recovered here: its agent already finished and it needs no socket — it
   * simply awaits the user's Merge / Create-PR / Dismiss decision, which the
   * runs router serves from the DB + worktree. Failing it on boot would
   * silently destroy a finished run waiting to be closed out (the bug this
   * scoping fixes).
   *
   * Returns the number of workflow_runs rows transitioned.
   */
  recoverStaleAwaitingReview(): number {
    const transition = this.db.transaction(() => {
      const staleRunIds = this.db
        .prepare(
          `SELECT DISTINCT r.id
             FROM workflow_runs r
             JOIN approvals a ON a.run_id = r.id
            WHERE r.status = 'awaiting_review' AND a.status = 'pending'`,
        )
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
      // Reconcile the folded inbox: orphaned pending permission review_items for
      // these recovered runs can never resolve (the socket is gone), so resolve
      // them too so they don't linger as stale blocking items. No-op pre-016.
      if (hasReviewItemsTable(this.db)) {
        const now = new Date().toISOString();
        this.db
          .prepare(
            `UPDATE review_items
                SET status = 'resolved', resolved_by = 'system', resolution = 'app_restart', updated_at = ?
              WHERE kind = 'permission' AND status = 'pending' AND run_id IN (${placeholders})`,
          )
          .run(now, ...ids);
      }
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
