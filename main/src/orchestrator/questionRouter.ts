/**
 * QuestionRouter — singleton that owns the AskUserQuestion request/respond lifecycle.
 *
 * Design invariants (non-negotiable per ROADMAP-001 §5.7 and IDEA-025):
 *
 * 1. requestQuestion co-writes the questions INSERT and workflow_runs UPDATE
 *    inside a single db.transaction() guarded by `AND status='running'` on
 *    the UPDATE.  If the run is not in 'running' state, the transaction rolls
 *    back and requestQuestion throws RunNotRunningError.
 *
 * 2. respond uses a guarded UPDATE `WHERE id=? AND status='awaiting_input'`
 *    and checks info.changes > 0 before writing the allow reply on the socket.
 *    If changes === 0, the run was concurrently canceled — no socket write,
 *    resolve the awaiting caller with a synthetic empty-answers payload.
 *
 * 3. Both requestQuestion and respond submit their mutations via a
 *    QuestionRouter-owned per-run p-queue (this.questionQueues), ensuring
 *    serialization of all question-mutations for the same run.  This queue
 *    is intentionally separate from RunQueueRegistry's per-run queue: that
 *    queue hosts the long-running runExecutor.execute() task, and re-entering
 *    it from inside a PreToolUse hook would self-deadlock (see
 *    runQueueRegistry.ts §no-recursive-enqueue rule).
 *
 * 4. Questions do NOT auto-expire. A pending question remains in the queue
 *    until the user answers (or the run is canceled). This matches the product
 *    invariant "workflow pauses until the human responds."
 *
 * 5. Questions are NOT auto-expired. A pending question remains in the queue
 *    until the user answers (or the run is canceled). This matches the product
 *    invariant "workflow pauses until the human triages."
 *
 * 6. The user's answer flows back to the SDK through the PreToolUse hook's
 *    `updatedInput: { questions, answers }` payload (NOT through an injected
 *    tool_result). See .soloflow/archive/ideas/IDEA-025-research.md "Answered
 *    Questions" for the SDK contract details: the SDK synthesizes the
 *    tool_result from updatedInput.answers; injecting our own tool_result would
 *    either duplicate or conflict with the SDK's own emission.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*.
 * All collaborators are injected via the constructor.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import PQueue from 'p-queue';
import type { DatabaseLike } from './types';
import type { QuestionRequest, QuestionAnswer, QuestionPayload } from '../../../shared/types/questions';

export type { QuestionRequest, QuestionAnswer, QuestionPayload };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RunNotRunningError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} is not in 'running' state; question request rejected`);
    this.name = 'RunNotRunningError';
  }
}

export class QuestionNotFoundError extends Error {
  constructor(questionId: string) {
    super(`No pending question found with id ${questionId}`);
    this.name = 'QuestionNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingEntry {
  request: QuestionRequest;
  /** Writes the answer to the bridge socket (closes the Claude tool-call wait). */
  socketReply: (answer: QuestionAnswer) => void;
  /** Resolves or rejects the Promise returned from requestQuestion. */
  resolve: (answer: QuestionAnswer) => void;
  reject: (err: unknown) => void;
}

// ---------------------------------------------------------------------------
// QuestionRouter
// ---------------------------------------------------------------------------

export class QuestionRouter extends EventEmitter {
  private static instance: QuestionRouter | null = null;

  /**
   * In-flight questions: keyed by questionId.
   * The entry is present from the moment requestQuestion's transaction commits
   * until respond() (or a future clearPendingForRun) removes it.
   */
  private pending = new Map<string, PendingEntry>();

  /**
   * Per-run serialization queues for question-router mutations.
   *
   * MUST be separate from RunQueueRegistry's per-run queues — RunLauncher
   * already enqueues `runExecutor.execute(runId)` on that queue, and the SDK
   * PreToolUse hook fires from WITHIN that task. Re-entering the same queue
   * from inside it would self-deadlock (see runQueueRegistry.ts §no-recursive-
   * enqueue rule, §no-recursive-enqueue).  Question mutations therefore live on
   * their own queue here.
   */
  private questionQueues = new Map<string, PQueue>();

  private getQuestionQueue(runId: string): PQueue {
    let q = this.questionQueues.get(runId);
    if (!q) {
      q = new PQueue({ concurrency: 1 });
      this.questionQueues.set(runId, q);
    }
    return q;
  }

  /**
   * @param db               - Narrow DatabaseLike surface (no better-sqlite3 import).
   * @param _getQueueForRun  - Retained for parity with ApprovalRouter constructor.
   *                           NOT used internally — QuestionRouter serializes its
   *                           own mutations via questionQueues (see field doc above).
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
   * ready. Question answers arrive via the SDK PreToolUse hook in
   * claudeCodeManager.makePreToolUseHook (TASK-758).
   */
  static initialize(
    db: DatabaseLike,
    getQueueForRun: (runId: string) => PQueue,
  ): QuestionRouter {
    QuestionRouter.instance = new QuestionRouter(db, getQueueForRun);
    return QuestionRouter.instance;
  }

  static getInstance(): QuestionRouter {
    if (!QuestionRouter.instance) {
      throw new Error(
        'QuestionRouter has not been initialized. ' +
        'Call QuestionRouter.initialize() from main/src/index.ts ' +
        'after the RunQueueRegistry is ready.',
      );
    }
    return QuestionRouter.instance;
  }

  /** Reset singleton — intended for tests only. */
  static _resetForTesting(): void {
    QuestionRouter.instance = null;
  }

  // --------------------------------------------------------------------------
  // Core API
  // --------------------------------------------------------------------------

  /**
   * Register a question request for `runId`.
   *
   * Atomically:
   *  1. UPDATEs workflow_runs.status → 'awaiting_input' (guarded: only if
   *     current status = 'running').  Throws RunNotRunningError if changes = 0.
   *  2. INSERTs a row into questions (status = 'pending').
   *
   * Both writes share a single db.transaction() so they are
   * either both committed or both rolled back.
   *
   * The mutation is submitted via the per-run p-queue so it is serialized
   * with any concurrent status changes for the same run.
   *
   * Returns a Promise<QuestionAnswer> that resolves when respond() is called.
   *
   * @param runId        - workflow_runs.id
   * @param toolUseId    - The SDK tool_use_id for this AskUserQuestion call.
   * @param questions    - The 1–4 questions in this gate.
   * @param socketReply  - Closure invoked exactly once by respond() to convey
   *                       the answer back to the caller. Under the SDK
   *                       PreToolUse path this is a no-op (the caller awaits
   *                       the returned promise directly), kept for backward
   *                       compatibility with any future transport adapter.
   */
  async requestQuestion(
    runId: string,
    toolUseId: string,
    questions: QuestionPayload[],
    socketReply: (answer: QuestionAnswer) => void,
  ): Promise<QuestionAnswer> {
    if (!this.db) throw new Error('QuestionRouter db handle undefined');

    const questionId = randomUUID();
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    const request: QuestionRequest = {
      id: questionId,
      runId,
      toolUseId,
      questions,
      timestamp: nowMs,
    };

    // Wire up the answer Promise before enqueueing — the resolve/reject refs
    // are captured in the pending map once the transaction commits.
    let resolveAnswer!: (answer: QuestionAnswer) => void;
    let rejectAnswer!: (err: unknown) => void;
    const answerPromise = new Promise<QuestionAnswer>((res, rej) => {
      resolveAnswer = res;
      rejectAnswer = rej;
    });

    await this.getQuestionQueue(runId).add(async () => {
      // Atomic: UPDATE workflow_runs + INSERT questions in one transaction.
      const txn = this.db.transaction(() => {
        const updateStmt = this.db.prepare(
          `UPDATE workflow_runs SET status = 'awaiting_input', updated_at = ?
           WHERE id = ? AND status = 'running'`,
        );
        const updateResult = updateStmt.run(now, runId) as { changes: number };

        if (updateResult.changes === 0) {
          throw new RunNotRunningError(runId);
        }

        const insertStmt = this.db.prepare(
          `INSERT INTO questions
             (id, run_id, tool_use_id, questions_json, status, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?)`,
        );
        insertStmt.run(questionId, runId, toolUseId, JSON.stringify(questions), now);
      });

      // Execute the transaction — throws RunNotRunningError on guard failure.
      (txn as () => void)();

      this.pending.set(questionId, {
        request,
        socketReply,
        resolve: resolveAnswer,
        reject: rejectAnswer,
      });

      // Notify renderer subscribers (e.g. the question queue UI).
      this.emit('questionCreated', request);
    });

    return answerPromise;
  }

  /**
   * Submit an answer for an in-flight question.
   *
   * Runs a guarded UPDATE: `WHERE id=? AND status='awaiting_input'`.
   * If changes = 0 (run was concurrently canceled), marks question as
   * 'timed_out' and resolves the promise with a synthetic empty-answers
   * payload — the run is NOT revived.
   * If changes > 0, marks question as 'answered' and invokes socketReply.
   *
   * @param questionId - The UUID of the in-flight question row.
   * @param answer     - The user's answer.
   */
  async respond(questionId: string, answer: QuestionAnswer): Promise<void> {
    // Fast-path guard: surface unknown IDs synchronously before touching the queue.
    const peek = this.pending.get(questionId);
    if (!peek) {
      throw new QuestionNotFoundError(questionId);
    }

    // The authoritative reservation happens INSIDE the queue so that two
    // concurrent respond() calls for the same questionId (same runId queue)
    // are serialized — the second one finds the entry already gone and
    // returns as a silent no-op, satisfying the exactly-once socketReply
    // contract.
    await this.getQuestionQueue(peek.request.runId).add(async () => {
      // Re-fetch inside the queue — a prior concurrent respond() may have
      // already removed the entry.
      const entry = this.pending.get(questionId);
      if (!entry) {
        // A prior respond() already settled this question; no-op.
        return;
      }

      // Atomically reserve this entry before any async work.
      this.pending.delete(questionId);

      const { request, socketReply, resolve } = entry;
      const now = new Date().toISOString();

      const updateStmt = this.db.prepare(
        `UPDATE workflow_runs SET status = 'running', updated_at = ?
         WHERE id = ? AND status = 'awaiting_input'`,
      );
      const info = updateStmt.run(now, request.runId) as { changes: number };

      if (info.changes === 0) {
        // The run was concurrently canceled (or already completed/failed) between
        // requestQuestion and now.  Do NOT revive it.
        console.warn(
          `[QuestionRouter] respond: run ${request.runId} is no longer in ` +
          `'awaiting_input'; question ${questionId} superseded — marking timed_out`,
        );
        // Mark the DB row as timed_out.
        this.db.prepare(
          `UPDATE questions SET status = 'timed_out', answered_at = ?
           WHERE id = ?`,
        ).run(now, questionId);
        // Resolve the requestQuestion promise with a synthetic empty-answers payload
        // so the awaiting caller is not left hanging.
        const emptyAnswer: QuestionAnswer = { answers: {} };
        resolve(emptyAnswer);
        this.emit('questionAnswered', { questionId, status: 'timed_out' });
        return;
      }

      // Commit the question answer row.
      this.db.prepare(
        `UPDATE questions SET status = 'answered', answered_at = ?, answer_json = ?
         WHERE id = ?`,
      ).run(now, JSON.stringify(answer), questionId);

      resolve(answer);
      socketReply(answer);
      this.emit('questionAnswered', { questionId, status: 'answered' });
    });
  }

  /**
   * Clear all pending questions for `runId`.
   *
   * Called during run termination (e.g., from claudeCodeManager's runSdkQuery
   * finally block) to settle any in-flight question Promises so that callers
   * are not left hanging.
   *
   * Invariants:
   * - Synchronous; returns void.  Does NOT submit work through the per-run PQueue.
   * - Resolves each pending Promise with a synthetic empty-answers QuestionAnswer
   *   so the awaiting PreToolUse hook callback can return cleanly to the SDK.
   * - Does NOT invoke socketReply — the run is being torn down; the socket is
   *   no longer meaningful.
   * - Performs a guarded DB UPDATE (`WHERE id = ? AND status = 'pending'`) for
   *   idempotency with a concurrent respond() that may have already settled the row.
   * - DB errors during shutdown are swallowed with console.warn so they never
   *   surface as unhandled rejections during process teardown.
   */
  clearPendingForRun(runId: string): void {
    const emptyAnswer: QuestionAnswer = { answers: {} };

    // Collect entries first, then mutate the map to avoid iterating-while-deleting.
    const toClose: Array<{ questionId: string; entry: PendingEntry }> = [];
    for (const [questionId, entry] of this.pending.entries()) {
      if (entry.request.runId === runId) {
        toClose.push({ questionId, entry });
      }
    }

    for (const { questionId, entry } of toClose) {
      this.pending.delete(questionId);

      try {
        const now = new Date().toISOString();
        // Guarded UPDATE for idempotency: if respond() already settled the row,
        // status will no longer be 'pending' and changes will be 0 — that is fine.
        this.db.prepare(
          `UPDATE questions SET status = 'timed_out', answered_at = ?
           WHERE id = ? AND status = 'pending'`,
        ).run(now, questionId);
      } catch (err) {
        // Swallow DB errors during shutdown — do not throw.
        console.warn(
          `[QuestionRouter] clearPendingForRun: DB update failed for question ${questionId} (run ${runId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Resolve the awaiting Promise — do NOT invoke socketReply.
      entry.resolve(emptyAnswer);
      this.emit('questionAnswered', { questionId, status: 'timed_out' });
    }
  }

  /**
   * Boot-time recovery. Any workflow_runs row in 'awaiting_input' from a
   * previous session cannot be resumed (the SDK session is gone). Transition
   * them to 'failed' with error_message='app_restart' and flip any orphaned
   * pending questions to 'timed_out' for audit consistency.
   *
   * Returns the number of workflow_runs rows transitioned.
   */
  recoverStaleAwaitingInput(): number {
    const transition = this.db.transaction(() => {
      const staleRunIds = this.db
        .prepare(`SELECT id FROM workflow_runs WHERE status = 'awaiting_input'`)
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
        .prepare(`UPDATE questions SET status = 'timed_out', answered_at = CURRENT_TIMESTAMP WHERE run_id IN (${placeholders}) AND status = 'pending'`)
        .run(...ids);
      return staleRunIds.length;
    });
    const count = transition();
    if (count > 0) {
      console.log(`[QuestionRouter] Boot recovery transitioned ${count} stale awaiting_input run(s) to failed`);
    }
    return count;
  }

  /**
   * Returns a snapshot of all currently in-flight question requests.
   * Used by the renderer's question-queue subscription.
   */
  getPending(): QuestionRequest[] {
    return Array.from(this.pending.values()).map((p) => p.request);
  }
}
