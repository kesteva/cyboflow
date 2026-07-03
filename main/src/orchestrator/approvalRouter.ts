/**
 * ApprovalRouter — singleton that owns the approval request/respond lifecycle.
 *
 * Design invariants (non-negotiable per ROADMAP-001 §5.7 and slice 6):
 *
 * 1. requestApproval co-writes the approvals INSERT and workflow_runs UPDATE
 *    inside a single db.transaction() guarded by `AND status='running'` on
 *    the UPDATE.  If the guarded UPDATE matches 0 rows, the transaction rolls
 *    back (no INSERT, no fold) and the caller re-reads workflow_runs.status to
 *    decide: a run still in 'awaiting_review' means a SIBLING approval is in
 *    flight, so requestApproval WAITS for the next 'approvalDecided' (raced
 *    with a short self-heal timer) and RETRIES — it does NOT throw, which is
 *    what previously caused a deny-storm when the SDK fired parallel tool calls
 *    in one turn. Only a terminal/invalid status (canceled / completed /
 *    failed / missing) throws RunNotRunningError. The single-pending model is
 *    preserved: a sibling never INSERTs until it grabs 'running'. P4: that SAME
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
import { emitUsage } from './telemetrySink';
import PQueue from 'p-queue';
import type { DatabaseLike } from './types';
import {
  coWritePermissionReviewItem,
  resolvePermissionReviewItem,
  resolveReviewItemById,
  hasReviewItemsTable,
} from './reviewItemListing';
import { emitReviewItemChangedById } from './reviewItemRouter';

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

/**
 * Self-heal poll interval (ms) for a sibling approval that is waiting for the
 * in-flight gate to clear. The waiter wakes on the next `approvalDecided`
 * event OR after this timer, whichever comes first, then re-reads
 * workflow_runs.status. The timer exists ONLY so a cancel/terminal transition
 * that emits no `approvalDecided` event still self-heals on the next re-check;
 * it does NOT cap the total wait time (the caller loops while the run stays in
 * 'awaiting_review' — the hook is meant to block until the user acts).
 */
const APPROVAL_WAIT_POLL_MS = 500;

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
   * Atomically (per attempt, inside the per-run p-queue):
   *  1. UPDATEs workflow_runs.status → 'awaiting_review' (guarded: only if
   *     current status = 'running').
   *  2. INSERTs a row into approvals (status = 'pending') + folds a blocking
   *     permission review_item — but ONLY if step 1 grabbed the gate.
   *
   * All writes share a single db.transaction() so they are either both
   * committed or both rolled back.
   *
   * Concurrency: if step 1 matches 0 rows the txn rolls back and we re-read
   * the run's status OUTSIDE the txn. If it is 'awaiting_review' a sibling
   * approval is in flight, so this call WAITS (off the queue, so respond() is
   * never blocked) for the next 'approvalDecided' event — raced with a short
   * self-heal timer — and RETRIES. Only a terminal/invalid status throws
   * RunNotRunningError. There is no wait cap: the hook blocks until the user
   * acts. This is the storm fix — a sibling no longer denies + re-requests.
   *
   * Returns a Promise<ApprovalDecision> that resolves when respond() is called.
   *
   * @param runId        - workflow_runs.id
   * @param toolName     - The tool name Claude is requesting permission for.
   * @param input        - The tool call's input arguments.
   * @param socketReply  - Closure invoked exactly once by respond() to convey
   *                       the decision back to the caller. Under the SDK
   *                       PreToolUse path this is a no-op (the caller awaits
   *                       the returned promise directly); the INTERACTIVE shell
   *                       transport (handleShellApprovalRequest) uses it to write
   *                       the verdict on the held-open socket — load-bearing,
   *                       must NOT regress.
   * @param source       - Provenance stamped on the folded permission
   *                       review_item (default 'approval'; the interactive shell
   *                       path passes 'approval:interactive'). Optional so every
   *                       existing SDK caller is unchanged.
   */
  async requestApproval(
    runId: string,
    toolName: string,
    input: Record<string, unknown>,
    socketReply: (decision: ApprovalDecision) => void,
    source: string = 'approval',
  ): Promise<ApprovalDecision> {
    if (!this.db) throw new Error('ApprovalRouter db handle undefined');

    const approvalId = randomUUID();

    const request: ApprovalRequest = {
      id: approvalId,
      runId,
      toolName,
      input,
      timestamp: Date.now(),
    };

    // Wire up the decision Promise before enqueueing — the resolve/reject refs
    // are captured in the pending map once the transaction commits.
    let resolveDecision!: (decision: ApprovalDecision) => void;
    let rejectDecision!: (err: unknown) => void;
    const decisionPromise = new Promise<ApprovalDecision>((res, rej) => {
      resolveDecision = res;
      rejectDecision = rej;
    });

    // CONCURRENCY / STORM FIX (FIX #1): a sibling tool call (or an SDK that
    // fires several tool calls in one turn) must NOT throw when an approval is
    // already in flight. The FIRST call grabs 'running'→'awaiting_review' and
    // blocks on its decisionPromise; a sibling that finds the run already in
    // 'awaiting_review' WAITS for that in-flight approval to resolve, then
    // retries — instead of throwing RunNotRunningError, which made the
    // PreToolUse hook deny and the agent re-request in a storm.
    //
    // The txn (running→awaiting_review + INSERT approvals + fold review_item)
    // is the ONLY thing held on the per-run PQueue. The WAIT happens OUTSIDE
    // the queue: keeping it inside would block respond() (it shares this queue)
    // and deadlock. Each retry re-enters the queue for a fresh txn attempt.
    //
    // Grab outcomes:
    //   'grabbed'  — we won the gate; pending entry set, event emitted, done.
    //   'wait'     — a sibling approval is in flight (run is awaiting_review);
    //                release the queue, wait for the next 'approvalDecided'
    //                (raced with a short timer so a no-event cancel self-heals),
    //                then retry.
    //   (throws)   — the run is in a terminal/invalid state (not 'running' and
    //                not 'awaiting_review'); a real RunNotRunningError.
    for (;;) {
      // PQueue.add resolves to `T | void` (the `void` arm is only reachable via
      // queue.clear(), which this router never calls). Type the task return and
      // narrow defensively below so the union is sound for TypeScript.
      const outcome = await this.getApprovalQueue(runId).add<'grabbed' | 'wait'>(async () => {
        const now = new Date().toISOString();

        // Atomic: UPDATE workflow_runs + INSERT approvals in one transaction.
        // The txn returns true if it grabbed the gate, false if changes=0 (in
        // which case it leaves the DB untouched — INSERT/fold never run).
        const txn = this.db.transaction(() => {
          const updateStmt = this.db.prepare(
            `UPDATE workflow_runs SET status = 'awaiting_review', updated_at = ?
             WHERE id = ? AND status = 'running'`,
          );
          const updateResult = updateStmt.run(now, runId) as { changes: number };

          if (updateResult.changes === 0) {
            // Did not grab the gate. Do NOT throw here — the txn rolls back
            // cleanly (no INSERT, no fold) and the caller decides wait vs throw
            // based on the run's current status, read outside the txn.
            return false;
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
            source,
            now,
          });
          return true;
        });

        const grabbed = (txn as () => boolean)();

        if (grabbed) {
          this.pending.set(approvalId, {
            request,
            socketReply,
            resolve: resolveDecision,
            reject: rejectDecision,
          });
          // Notify renderer subscribers (e.g. the review queue UI).
          this.emit('approvalCreated', request);
          return 'grabbed';
        }

        // changes=0: the run is not 'running'. Read its current status to
        // decide wait vs throw. A sibling approval in flight leaves it in
        // 'awaiting_review' → WAIT. Any other status is terminal/invalid →
        // throw a real RunNotRunningError (the hook should deny).
        const statusRow = this.db
          .prepare(`SELECT status FROM workflow_runs WHERE id = ?`)
          .get(runId) as { status: string } | undefined;

        if (statusRow?.status === 'awaiting_review') {
          return 'wait';
        }

        // Terminal/invalid (canceled, completed, failed, missing, …). Real error.
        throw new RunNotRunningError(runId);
      });

      if (outcome === 'grabbed') {
        return decisionPromise;
      }

      // Defensive: `void` is only reachable if the queue were cleared (it never
      // is). Treat anything other than 'wait' as nothing-to-retry and stop.
      if (outcome !== 'wait') {
        throw new RunNotRunningError(runId);
      }

      // outcome === 'wait': a sibling approval is in flight. Block (OUTSIDE the
      // queue) until the next approval is decided, then retry. No cap on wait
      // time — the hook SHOULD block until the user acts (that is the whole
      // point: "waiting" is the opposite of the storm). The short timer races
      // the event so a cancel that fires no 'approvalDecided' still self-heals
      // via the re-check on the next loop turn.
      await this.waitForApprovalSlot();
    }
  }

  /**
   * Block until either the next `approvalDecided` event fires (a sibling
   * approval was resolved → the gate may be free) OR a short timer elapses
   * (a cancel / terminal transition that emits no event still self-heals,
   * because the next loop turn re-reads workflow_runs.status). Resolves on
   * whichever happens first; the listener is always cleaned up.
   *
   * Intentionally has NO cap on the number of waits — the caller loops and
   * re-checks status each time, so a run that stays 'awaiting_review' keeps
   * waiting (the hook blocks until the user acts), and a run that goes
   * terminal is detected on the next retry and throws.
   */
  private waitForApprovalSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        this.off('approvalDecided', onDecided);
        clearTimeout(timer);
        resolve();
      };
      const onDecided = (): void => done();
      // Short self-heal timer (~500ms) raced with the event so a no-event
      // cancel does not hang forever before the status re-check.
      const timer = setTimeout(done, APPROVAL_WAIT_POLL_MS);
      this.once('approvalDecided', onDecided);
    });
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
        emitUsage('approval_decided', { decision: 'approve', scope: 'single' });
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
        emitUsage('approval_decided', { decision: 'reject', scope: 'single' });
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
    // Ids of the folded inbox items resolved by this recovery pass. Collected
    // INSIDE the transaction, emitted AFTER commit (see below) — an emit before
    // commit could broadcast a row the transaction then rolls back.
    const resolvedReviewItemIds: string[] = [];

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
      //
      // Route each resolution through the sanctioned sync helper
      // (resolveReviewItemById) rather than a bare UPDATE, so it writes the
      // 'resolved' entity_events delta exactly like the normal respond path
      // (resolved_by='system', resolution='app_restart'). The helper does NOT
      // open its own transaction (plain guarded UPDATE + entity_events INSERT),
      // so it is safe to call inside this enclosing boot transaction — nesting a
      // better-sqlite3 db.transaction() here would throw.
      if (hasReviewItemsTable(this.db)) {
        const now = new Date().toISOString();
        const orphaned = this.db
          .prepare(
            `SELECT id, run_id AS runId FROM review_items
              WHERE kind = 'permission' AND status = 'pending' AND run_id IN (${placeholders})`,
          )
          .all(...ids) as { id: string; runId: string | null }[];
        for (const { id, runId } of orphaned) {
          const resolved = resolveReviewItemById(this.db, id, 'system', 'app_restart', now, runId);
          if (resolved) resolvedReviewItemIds.push(resolved);
        }
      }
      return staleRunIds.length;
    });
    const count = transition();

    // Fail-soft renderer emits AFTER commit: broadcast a review-item delta for
    // each reconciled item so the queue chip updates incrementally instead of
    // waiting for a full re-sync. Guarded — a boot with no renderer listening yet
    // is a harmless no-op on the module-level emitter, and a DB error here must
    // never crash boot recovery.
    for (const id of resolvedReviewItemIds) {
      try {
        emitReviewItemChangedById(this.db, id, 'resolved');
      } catch (err) {
        console.warn(
          `[ApprovalRouter] recoverStaleAwaitingReview: review-item emit failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

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
