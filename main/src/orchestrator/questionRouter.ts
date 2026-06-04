/**
 * QuestionRouter — singleton that owns the AskUserQuestion request/respond lifecycle.
 *
 * Design invariants (non-negotiable per ROADMAP-001 §5.7 and IDEA-025):
 *
 * 1. requestQuestion co-writes the questions INSERT and workflow_runs UPDATE
 *    inside a single db.transaction() guarded by `AND status='running'` on
 *    the UPDATE.  If the run is not in 'running' state, the transaction rolls
 *    back and requestQuestion throws RunNotRunningError. P4: that SAME
 *    transaction also co-writes a blocking decision review_items row (the
 *    AskUserQuestion gate is a decision the human must make), so the question
 *    row and the inbox row commit or roll back together; respond() resolves the
 *    folded item idempotently. No-op on a pre-migration-016 DB.
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
 * 5. The user's answer flows back to the SDK through the PreToolUse hook's
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
import {
  coWriteDecisionReviewItem,
  resolveReviewItemById,
  hasReviewItemsTable,
} from './reviewItemListing';
import { TaskChangeRouter } from './taskChangeRouter';

export type { QuestionRequest, QuestionAnswer, QuestionPayload };

/**
 * FIX-STAGE-MODEL (D): the planner step id whose Approve answer flips the run's
 * tasks to Ready-for-development, and the board position they land on. Verified
 * against database.ts seedDefaultBoard (position 6 = 'Ready for development').
 */
const APPROVE_PLAN_STEP_ID = 'approve-plan';
const READY_FOR_DEVELOPMENT_POSITION = 6;

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
// Attachment embedding
// ---------------------------------------------------------------------------

/**
 * Embed attachment file paths into the answer the agent receives, using the
 * SAME `<attachments>` convention as the quick-session composer
 * (frontend/src/hooks/useClaudePanel.ts). The block is appended to the FIRST
 * answer value so the paths arrive inline with the user's answer text. When
 * there are no answer keys (defensive), the block is stored under a synthetic
 * `__attachments__` key so the paths are not silently dropped.
 *
 * Returns a NEW QuestionAnswer; the input is not mutated. A no-op (returns the
 * original reference) when there are no attachments.
 */
export function embedAttachmentsIntoAnswer(answer: QuestionAnswer): QuestionAnswer {
  const paths = answer.attachments;
  if (!paths || paths.length === 0) return answer;

  const block =
    `\n\n<attachments>\nPlease look at these files which may provide additional instructions or context:\n` +
    `${paths.join('\n')}\n</attachments>`;

  const answers = { ...answer.answers };
  const keys = Object.keys(answers);
  if (keys.length > 0) {
    const firstKey = keys[0];
    answers[firstKey] = `${answers[firstKey]}${block}`;
  } else {
    answers['__attachments__'] = block.trimStart();
  }

  // Drop `attachments` from the resolved payload — it has been folded into the
  // answer text and is not part of the SDK `updatedInput.answers` contract.
  return { answers, ...(answer.annotations ? { annotations: answer.annotations } : {}) };
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
  /** The folded decision review_item id (P4); null when the inbox table is absent. */
  reviewItemId: string | null;
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
   * Per-router PQueues (this.questionQueues, see field doc above) are
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
   * ready. Question answers arrive via the SDK PreToolUse hook in
   * claudeCodeManager.makePreToolUseHook (TASK-758).
   */
  static initialize(db: DatabaseLike): QuestionRouter {
    QuestionRouter.instance = new QuestionRouter(db);
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

  /**
   * Build a concise decision-item title from the gate's questions. Uses the
   * first question's text (preferred) or header; falls back to a generic label
   * when the gate carries no questions. Kept short for the inbox row.
   */
  private deriveDecisionTitle(questions: QuestionPayload[]): string {
    const first = questions[0];
    const text = first?.question?.trim() || first?.header?.trim() || '';
    if (text.length === 0) return 'Decision required';
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
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

    let reviewItemId: string | null = null;

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

        // P4 fold: co-write a blocking decision review_item in the SAME
        // transaction (the AskUserQuestion gate is a decision the human must
        // make). Commits or rolls back with the questions row. No-op pre-016.
        reviewItemId = coWriteDecisionReviewItem(this.db, {
          runId,
          title: this.deriveDecisionTitle(questions),
          source: 'question',
          payload: null,
          now,
        });
      });

      // Execute the transaction — throws RunNotRunningError on guard failure.
      (txn as () => void)();

      this.pending.set(questionId, {
        request,
        socketReply,
        resolve: resolveAnswer,
        reject: rejectAnswer,
        reviewItemId,
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

      const { request, socketReply, resolve, reviewItemId } = entry;
      const now = new Date().toISOString();

      // Fold any attachment file paths into the answer text the agent receives.
      const effectiveAnswer = embedAttachmentsIntoAnswer(answer);

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
        // Mark the DB row as timed_out (guarded so a prior clearPendingForRun
        // can't be clobbered with a later answered_at timestamp).
        this.db.prepare(
          `UPDATE questions SET status = 'timed_out', answered_at = ?
           WHERE id = ? AND status = 'pending'`,
        ).run(now, questionId);
        // Resolve the folded decision review_item too (idempotent) — the gate is
        // gone (run canceled), so the inbox item must not linger as blocking.
        if (reviewItemId !== null) {
          resolveReviewItemById(this.db, reviewItemId, 'system', 'superseded', now, request.runId);
        }
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
      ).run(now, JSON.stringify(effectiveAnswer), questionId);
      // Resolve the folded decision review_item (idempotent) — the human answered.
      if (reviewItemId !== null) {
        resolveReviewItemById(this.db, reviewItemId, 'user', 'answered', now, request.runId);
      }

      resolve(effectiveAnswer);
      socketReply(effectiveAnswer);
      this.emit('questionAnswered', { questionId, status: 'answered' });

      // FIX-STAGE-MODEL (D): if this answered gate is the planner's final
      // approve-plan gate AND the user chose the Approve option, deterministically
      // flip the run's tasks to Ready for development — backend-driven (does NOT
      // rely on the agent calling cyboflow_set_task_stage). Fail-soft + idempotent;
      // runs AFTER the resume so a stage hiccup never delays the agent.
      await this.promoteTasksOnPlanApproval(request.runId, effectiveAnswer);
    });
  }

  /**
   * FIX-STAGE-MODEL (D): move ALL tasks originating from the run's seed idea to
   * Ready for development (position 6) when the just-answered gate is the
   * planner's `approve-plan` step and the chosen answer is the Approve option.
   *
   * "Approve vs Revise/Reject" rule: case-insensitively, the chosen answer value
   * must START WITH 'approve' (matches the planner.md `Approve` option label and
   * tolerates trailing chips/attachment text), and must NOT contain 'revise' or
   * 'reject'. Any other answer (Revise / Reject / unrecognized) is a no-op.
   *
   * Backend-deterministic + fail-soft: reads current_step_id + seed_idea_id
   * defensively (older test DBs lack these columns → the SELECT throws → caught →
   * no-op). The task moves route through TaskChangeRouter.applyChange with
   * actor='orchestrator'; the chokepoint is idempotent (a task already at
   * position 6 is a no-op delta). NEVER throws — respond() is unaffected.
   */
  private async promoteTasksOnPlanApproval(runId: string, answer: QuestionAnswer): Promise<void> {
    try {
      // Defensive read — current_step_id (mig 011) + seed_idea_id (mig 017) may be
      // absent on a minimal test DB. A throw here means "not applicable" → no-op.
      const run = this.db
        .prepare(
          'SELECT project_id AS projectId, current_step_id AS currentStepId, seed_idea_id AS seedIdeaId FROM workflow_runs WHERE id = ?',
        )
        .get(runId) as { projectId?: unknown; currentStepId?: unknown; seedIdeaId?: unknown } | undefined;
      if (!run) return;
      if (run.currentStepId !== APPROVE_PLAN_STEP_ID) return;

      const seedIdeaId = typeof run.seedIdeaId === 'string' ? run.seedIdeaId : null;
      if (!seedIdeaId) return;
      if (!this.isApproveAnswer(answer)) return;

      const projectId = typeof run.projectId === 'number' ? run.projectId : Number(run.projectId);

      // All tasks originating from the seed idea (read-only; writes go through the
      // chokepoint). Resolve the target stage id from each task's own board.
      const tasks = this.db
        .prepare('SELECT id, board_id AS boardId, stage_id AS stageId FROM tasks WHERE originating_idea_id = ?')
        .all(seedIdeaId) as Array<{ id: string; boardId: string; stageId: string }>;
      if (tasks.length === 0) return;

      const router = TaskChangeRouter.getInstance();
      for (const task of tasks) {
        const stageRow = this.db
          .prepare('SELECT id FROM board_stages WHERE board_id = ? AND position = ?')
          .get(task.boardId, READY_FOR_DEVELOPMENT_POSITION) as { id?: unknown } | undefined;
        const targetStageId = typeof stageRow?.id === 'string' ? stageRow.id : null;
        if (!targetStageId || targetStageId === task.stageId) continue; // unresolved or already there

        await router.applyChange(projectId, {
          actor: 'orchestrator',
          entityType: 'task',
          taskId: task.id,
          stageId: targetStageId,
          runId,
          kind: 'plan-approved',
        });
      }
    } catch (err) {
      console.warn(
        `[QuestionRouter] promoteTasksOnPlanApproval skipped for run ${runId} (fail-soft): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Decide whether a gate answer is the Approve option (vs Revise / Reject).
   * Case-insensitive: at least one answer value starts with 'approve', and NO
   * answer value contains 'revise' or 'reject'. Conservative — an ambiguous or
   * unrecognized answer returns false (no promotion).
   */
  private isApproveAnswer(answer: QuestionAnswer): boolean {
    const values = Object.values(answer.answers).map((v) => v.trim().toLowerCase());
    if (values.length === 0) return false;
    if (values.some((v) => v.includes('revise') || v.includes('reject'))) return false;
    return values.some((v) => v.startsWith('approve'));
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
        // Resolve the folded decision review_item too (idempotent).
        if (entry.reviewItemId !== null) {
          resolveReviewItemById(this.db, entry.reviewItemId, 'system', 'run_terminated', now, runId);
        }
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
      // Reconcile the folded inbox: orphaned pending question-sourced decision
      // review_items for these recovered runs can never resolve, so resolve them
      // too so they don't linger as stale blocking items. No-op pre-016.
      if (hasReviewItemsTable(this.db)) {
        const now = new Date().toISOString();
        this.db
          .prepare(
            `UPDATE review_items
                SET status = 'resolved', resolved_by = 'system', resolution = 'app_restart', updated_at = ?
              WHERE kind = 'decision' AND status = 'pending' AND source = 'question' AND run_id IN (${placeholders})`,
          )
          .run(now, ...ids);
      }
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
