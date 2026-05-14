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

export interface ApprovalRequest {
  /** UUID for the approvals row */
  id: string;
  /** workflow_runs.id */
  runId: string;
  toolName: string;
  input: Record<string, unknown>;
  timestamp: number;
}

export interface ApprovalDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

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
   * Called once at boot from main/src/index.ts after the RunQueueRegistry and
   * CyboflowPermissionIpcServer are ready.
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
        'after the RunQueueRegistry and CyboflowPermissionIpcServer are ready.',
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
   * @param socketReply  - Closure that writes the decision back to the bridge
   *                       socket.  Passed directly by the caller (e.g.
   *                       CyboflowPermissionIpcServer) where the socket is in
   *                       scope.  Invoked exactly once by respond().
   */
  async requestApproval(
    runId: string,
    toolName: string,
    input: Record<string, unknown>,
    socketReply: (decision: ApprovalDecision) => void,
  ): Promise<ApprovalDecision> {
    const approvalId = randomUUID();
    const now = new Date().toISOString();

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
   *  - Marks approval as 'rejected'.  Does NOT touch workflow_runs.status
   *    (Claude will receive the deny on the socket and the run remains in
   *    awaiting_review until Claude yields — §5.7).
   *  - Invokes socketReply.
   *
   * @param approvalId - The UUID of the in-flight approval row.
   * @param decision   - The user's (or policy's) decision.
   */
  async respond(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const entry = this.pending.get(approvalId);
    if (!entry) {
      throw new ApprovalNotFoundError(approvalId);
    }

    const { request, socketReply, resolve } = entry;
    const now = new Date().toISOString();

    await this.getQueueForRun(request.runId).add(async () => {
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
          this.pending.delete(approvalId);
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

        this.pending.delete(approvalId);
        resolve(decision);
        socketReply(decision);
      } else {
        // deny: update approvals only, do NOT touch workflow_runs.
        this.db.prepare(
          `UPDATE approvals SET status = 'rejected', decided_at = ?, decided_by = 'user'
           WHERE id = ?`,
        ).run(now, approvalId);

        this.pending.delete(approvalId);
        resolve(decision);
        socketReply(decision);
      }
    });
  }

  /**
   * Clear all pending approvals for `runId`.
   *
   * Stub — the full body (deny in-flight approvals, write DB rows, close
   * socket connections) lands in TASK-304.  For now this is a documented
   * no-op that satisfies the import surface required by claudeCodeManager.ts.
   */
  clearPendingForRun(runId: string): void {
    // TODO(TASK-304): Implement full clearPendingForRun body:
    //   1. Find all pending entries for runId.
    //   2. Write a synthetic deny response to each socket.
    //   3. Update approvals.status = 'rejected' for each row.
    //   4. Remove entries from this.pending.
    console.warn(`[ApprovalRouter] clearPendingForRun(${runId}) called — stub, no-op until TASK-304`);
  }

  /**
   * Returns a snapshot of all currently in-flight approval requests.
   * Used by the renderer's review-queue subscription.
   */
  getPending(): ApprovalRequest[] {
    return Array.from(this.pending.values()).map((p) => p.request);
  }
}
