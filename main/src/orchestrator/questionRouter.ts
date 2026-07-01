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
 *    tool_result). The SDK synthesizes the tool_result from updatedInput.answers;
 *    injecting our own tool_result would either duplicate or conflict with the
 *    SDK's own emission.
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
  countPendingBlockingReviewItems,
} from './reviewItemListing';
import { emitReviewItemChangedById } from './reviewItemRouter';
import { runStatusEvents } from './trpc/routers/events';
import type { RunStatusChangedEvent } from '../../../shared/types/cyboflow';
import { TaskChangeRouter } from './taskChangeRouter';
import { listRunOwnedIdeaIds, listRunCreatedTaskIds, listRunCreatedEpicIds } from './runEntityOwnership';

export type { QuestionRequest, QuestionAnswer, QuestionPayload };

/**
 * Boot recovery only rests a resumable awaiting_input run (one with a captured
 * claude_session_id) in 'awaiting_review' when it was last touched within this
 * many days. Beyond it the local SDK --resume session data is unlikely to still
 * exist, so the run is failed instead — this caps the review queue so it cannot
 * accumulate ancient reopen candidates across many restarts.
 */
const STALE_RESUMABLE_RECOVERY_DAYS = 7;

/**
 * FIX-STAGE-MODEL (D): the planner step id whose Approve answer flips the run's
 * tasks to Ready-for-development, and the board position they land on. Verified
 * against database.ts seedDefaultBoard (position 6 = 'Ready for development').
 */
const APPROVE_PLAN_STEP_ID = 'approve-plan';
const READY_FOR_DEVELOPMENT_POSITION = 6;

/**
 * Built-in workflows that carry the approve-plan gate. Mirrors the same-named set
 * in TaskChangeRouter — the FALLBACK signal for "plan-gated" when a run's frozen
 * step snapshot is absent/unparseable (the PRIMARY signal is the snapshot itself
 * containing APPROVE_PLAN_STEP_ID). Used by the F3 completion reveal to avoid
 * stamping plan_approved_at on a non-plan-gated run (e.g. a completed sprint).
 */
const PLAN_GATED_WORKFLOW_NAMES = new Set(['planner', 'ship']);

/**
 * FIX-STAGE-MODEL (decompose): the planner step id whose answer is the separate
 * final gate (Archive vs Keep the decomposed ideas + finish). Choosing Archive
 * retires the run's owned ideas OFF the board by stamping `decomposed_at` (the
 * gate-driven retire path — TaskChangeRouter.retireIdeaToDecomposed), NOT a
 * board-position move; a retired idea keeps its stage and is reachable only via
 * its children.
 */
const DECOMPOSE_STEP_ID = 'decompose';

/**
 * Ship (defense-in-depth): the `ship` workflow concatenates planner → sprint in
 * one orchestrated run and drops planner's terminal `decompose` step, so the
 * planner finalizer must never seal a ship run. Guarded by workflow name so a
 * future ship spec edit that reuses the `decompose` step id can't complete the
 * run before its sprint tasks execute.
 */
const SHIP_WORKFLOW_NAME = 'ship';

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

      // Renderer signals AFTER the commit — the review-item co-write bypasses
      // the ReviewItemRouter chokepoint (it must share this transaction), so
      // the project-scoped delta (queue chip / landing inbox) and the
      // run-status change are re-issued here.
      if (reviewItemId !== null) emitReviewItemChangedById(this.db, reviewItemId, 'created');
      runStatusEvents.emit('changed', { runId, status: 'awaiting_input' } satisfies RunStatusChangedEvent);
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
          emitReviewItemChangedById(this.db, reviewItemId, 'resolved');
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
        emitReviewItemChangedById(this.db, reviewItemId, 'resolved');
      }
      runStatusEvents.emit('changed', { runId: request.runId, status: 'running' } satisfies RunStatusChangedEvent);

      // FIX-STAGE-MODEL (D) / Q1 REVEAL (F10): the approve-plan reveal MUST complete
      // BEFORE the agent resumes. promoteTasksOnPlanApproval stamps approved_at on
      // every draft entity via the async TaskChangeRouter chokepoint (per-project
      // PQueue), and a ship agent's post-approval cyboflow_create_sprint_batch filters
      // on approved_at (SprintLaneStore.createForRun.filterEligibleTaskIds). Resolving
      // first raced the reveal: the batch arrived while tasks were still PENDING
      // (approved_at NULL) and materialize dropped every id, failing the run despite an
      // approved plan. So await the reveal here, before resolve/socketReply, so the
      // agent only resumes once approved_at is stamped on every revealed entity. The
      // method is internally fail-soft (its own try/catch, never throws), so awaiting
      // it can never block the reply/resume.
      await this.promoteTasksOnPlanApproval(request.runId, effectiveAnswer);

      resolve(effectiveAnswer);
      socketReply(effectiveAnswer);
      this.emit('questionAnswered', { questionId, status: 'answered' });

      // These follow-ons run AFTER the resume — none gates the agent's ability to
      // proceed on an approved plan (they retire the ship seed idea, tear down
      // rejected drafts, or finalize the planner run). All are fail-soft + idempotent.
      await this.retireShipIdeasOnPlanApproval(request.runId, effectiveAnswer);
      await this.deletePendingDraftsOnPlanDecline(request.runId, effectiveAnswer, request.questions);
      await this.finalizePlannerRun(request.runId, effectiveAnswer);
    });
  }

  /**
   * Q1 REVEAL + FIX-STAGE-MODEL (D): when the just-answered gate is the planner's
   * `approve-plan` step and the chosen answer is the Approve option, (a) stamp
   * workflow_runs.plan_approved_at = now, (b) reveal the run's PENDING entities by
   * stamping approved_at = now on every task it created (listRunCreatedTaskIds)
   * AND every epic it created (listRunCreatedEpicIds) — both idempotent (guarded
   * `IS NULL`), and (c) move ALL tasks the run CREATED to Ready for development
   * (position 6).
   *
   * Ownership is derived from the entity_events created-event projection
   * (listRunCreatedTaskIds), NOT from seed_idea_id / originating_idea_id — the
   * planner agent never stamps those run→entity link columns, so a seed-idea
   * lineage read would always come up empty in practice.
   *
   * "Approve vs Revise/Reject" rule: case-insensitively, the chosen answer value
   * must START WITH 'approve' (matches the planner.md `Approve` option label and
   * tolerates trailing chips/attachment text), and must NOT contain 'revise' or
   * 'reject'. Any other answer (Revise / Reject / unrecognized) is a no-op.
   *
   * Backend-deterministic + fail-soft: reads current_step_id defensively (older
   * test DBs lack the column → the SELECT throws → caught → no-op). The task
   * moves route through TaskChangeRouter.applyChange with actor='orchestrator';
   * the chokepoint is idempotent (a task already at position 6 is a no-op delta).
   * NEVER throws — respond() is unaffected.
   */
  private async promoteTasksOnPlanApproval(runId: string, answer: QuestionAnswer): Promise<void> {
    try {
      // Defensive read — current_step_id (mig 011) may be absent on a minimal
      // test DB. A throw here means "not applicable" → no-op.
      const run = this.db
        .prepare(
          'SELECT project_id AS projectId, current_step_id AS currentStepId FROM workflow_runs WHERE id = ?',
        )
        .get(runId) as { projectId?: unknown; currentStepId?: unknown } | undefined;
      if (!run) return;
      if (run.currentStepId !== APPROVE_PLAN_STEP_ID) return;
      if (!this.isApproveAnswer(answer)) return;

      const projectId = typeof run.projectId === 'number' ? run.projectId : Number(run.projectId);
      await this.revealRunDrafts(runId, projectId);
    } catch (err) {
      console.warn(
        `[QuestionRouter] promoteTasksOnPlanApproval skipped for run ${runId} (fail-soft): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * F3 — fail-soft completion reveal. Public entry point that reveals a run's
   * PENDING draft entities WITHOUT the answer/step gate of
   * promoteTasksOnPlanApproval. Called at the run-COMPLETED terminal transition
   * (runs.end) for a plan-gated run whose plan_approved_at is still NULL: e.g. a
   * user-edited workflow that kept the `approve-plan` step id but used gate labels
   * isApproveAnswer never matched, or a free-text approval. The run ran to
   * completion, so hiding its output would be silent data loss on a later dismiss;
   * visible-but-unwanted beats invisible-then-deleted.
   *
   * Reuses the SAME reveal core as the approve path (stamp plan_approved_at, flip
   * approved_at on every run-created epic+task, retire owned ideas, move tasks to
   * Ready for development). Naturally a no-op when the run's drafts were already
   * swept (cancel/dismiss/fail/reject deleted the rows → the per-entity reveals hit
   * vanished rows and are caught), or when the plan was already approved (every
   * stamp is IS NULL-guarded / idempotent). NEVER throws — the completion
   * transition is unaffected.
   */
  async promotePendingDraftsForRun(runId: string): Promise<void> {
    try {
      // Read plan_approved_at + the plan-gated signals in one shot. Defensive: a
      // pre-042 DB lacks plan_approved_at / steps_snapshot_json → the SELECT throws
      // → caught → no-op.
      const run = this.db
        .prepare(
          `SELECT r.project_id AS projectId,
                  r.plan_approved_at AS planApprovedAt,
                  r.steps_snapshot_json AS stepsSnapshotJson,
                  w.name AS workflowName
             FROM workflow_runs r
             LEFT JOIN workflows w ON w.id = r.workflow_id
            WHERE r.id = ?`,
        )
        .get(runId) as
        | { projectId?: unknown; planApprovedAt?: unknown; stepsSnapshotJson?: unknown; workflowName?: unknown }
        | undefined;
      if (!run) return;
      // Already approved → the approve gate already revealed; nothing to do.
      if (typeof run.planApprovedAt === 'string' && run.planApprovedAt.length > 0) return;
      // Non-plan-gated (e.g. a completed sprint) → it never minted PENDING drafts,
      // so a reveal would only wrongly stamp plan_approved_at. Skip.
      if (!this.runIsPlanGated(run.stepsSnapshotJson, run.workflowName)) return;
      const projectId = typeof run.projectId === 'number' ? run.projectId : Number(run.projectId);
      await this.revealRunDrafts(runId, projectId);
    } catch (err) {
      console.warn(
        `[QuestionRouter] promotePendingDraftsForRun skipped for run ${runId} (fail-soft): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Whether a run is PLAN-GATED. PRIMARY signal: its frozen step set
   * (steps_snapshot_json) includes the approve-plan gate. FALLBACK (snapshot
   * absent/unparseable): a planner/ship built-in. Mirrors the same-named guard in
   * TaskChangeRouter.
   */
  private runIsPlanGated(stepsSnapshotJson: unknown, workflowName: unknown): boolean {
    if (typeof stepsSnapshotJson === 'string' && stepsSnapshotJson.length > 0) {
      try {
        const snapshot = JSON.parse(stepsSnapshotJson) as Record<string, unknown>;
        return Object.prototype.hasOwnProperty.call(snapshot, APPROVE_PLAN_STEP_ID);
      } catch {
        // malformed snapshot — fall through to the workflow-name fallback
      }
    }
    return typeof workflowName === 'string' && PLAN_GATED_WORKFLOW_NAMES.has(workflowName);
  }

  /**
   * Reveal core shared by promoteTasksOnPlanApproval (approve gate) and
   * promotePendingDraftsForRun (F3 completion fallback): (a) stamp
   * workflow_runs.plan_approved_at = now, (b) reveal the run's PENDING entities by
   * stamping approved_at = now on every task it created (listRunCreatedTaskIds)
   * AND every epic it created (listRunCreatedEpicIds) — both idempotent (guarded
   * `IS NULL`), (c) retire the run's owned idea(s) OFF the board, and (d) move ALL
   * tasks the run CREATED to Ready for development (position 6).
   *
   * Ownership is derived from the entity_events created-event projection
   * (listRunCreatedTaskIds), NOT from seed_idea_id / originating_idea_id — the
   * planner agent never stamps those run→entity link columns, so a seed-idea
   * lineage read would always come up empty in practice.
   *
   * May throw on a pre-042 DB (plan_approved_at UPDATE hits "no such column") — the
   * two callers each wrap this in their own fail-soft try/catch. Per-entity work is
   * best-effort (a vanished row must not abort the remaining reveals).
   */
  private async revealRunDrafts(runId: string, projectId: number): Promise<void> {
    const now = new Date().toISOString();

      // Q1 REVEAL: the plan is approved — stamp the run's plan-approval gate and
      // reveal the entities it created during planning. A plan-gated run mints its
      // epics+tasks PENDING (approved_at NULL = backend-invisible + sprint-
      // ineligible per the create-side Q1 guard in TaskChangeRouter); approval
      // flips them to approved_at=now. plan_approved_at lives on workflow_runs
      // (not an entity table), so the run-level stamp is a direct guarded UPDATE;
      // the per-entity approved_at reveal routes through the TaskChangeRouter
      // chokepoint (`approved` toggle, orchestrator-only) so each reveal mints an
      // entity_event + version bump + TaskChangedEvent broadcast — a mounted
      // board sees the drafts appear the moment the plan is approved (the tasks
      // are typically ALREADY at position 6, so the stage-move loop below is a
      // no-op delta and the reveal event is the ONLY signal the frontend gets).
      // Fail-soft: a pre-042 DB lacking these columns throws "no such column" →
      // caught by the method's outer try/catch → no-op (never throws).
      this.db
        .prepare(
          `UPDATE workflow_runs SET plan_approved_at = ?, updated_at = ?
           WHERE id = ? AND plan_approved_at IS NULL`,
        )
        .run(now, now, runId);

      const taskIds = listRunCreatedTaskIds(this.db, runId);
      const epicIds = listRunCreatedEpicIds(this.db, runId);

      const router = TaskChangeRouter.getInstance();
      // Per-entity best-effort: a vanished row (concurrent teardown) must not
      // abort the remaining reveals.
      for (const epicId of epicIds) {
        try {
          await router.applyChange(projectId, {
            actor: 'orchestrator',
            entityType: 'epic',
            taskId: epicId,
            approved: true,
            runId,
            kind: 'plan-approved',
          });
        } catch {
          // gone or unrevealable — reveal the rest
        }
      }
      for (const taskId of taskIds) {
        try {
          await router.applyChange(projectId, {
            actor: 'orchestrator',
            entityType: 'task',
            taskId,
            approved: true,
            runId,
            kind: 'plan-approved',
          });
        } catch {
          // gone or unrevealable — reveal the rest
        }
      }

      // F8: the plan is approved — the run's owned idea(s) are now decomposed into
      // the revealed plan (its epics + tasks carry the flow), so retire them OFF the
      // board HERE (stamp decomposed_at) rather than only at a later gate. Previously
      // idea retirement was exclusively gate-driven (planner's final decompose gate /
      // ship's approve-plan), so a planner run interrupted after plan approval but
      // before its decompose gate stranded the seed idea on the board forever next to
      // its revealed children. Owned = seed_idea_id UNION run-created ideas
      // (listRunOwnedIdeaIds, the same resolver finalizePlannerRun uses). Idempotent
      // (retireIdeaToDecomposed no-ops once decomposed_at is stamped, so the later
      // decompose gate / ship materialize re-assert harmlessly) + failure-isolated
      // per-idea — the reveal already happened; retirement must never undo it or throw.
      for (const ideaId of listRunOwnedIdeaIds(this.db, runId)) {
        await router.retireIdeaToDecomposed(projectId, ideaId).catch(() => {
          /* per-idea best-effort */
        });
      }

      if (taskIds.length === 0) return;
      for (const taskId of taskIds) {
        const taskRow = this.db
          .prepare('SELECT board_id AS boardId, stage_id AS stageId FROM tasks WHERE id = ?')
          .get(taskId) as { boardId?: unknown; stageId?: unknown } | undefined;
        const boardId = typeof taskRow?.boardId === 'string' ? taskRow.boardId : null;
        const currentStageId = typeof taskRow?.stageId === 'string' ? taskRow.stageId : null;
        if (!boardId) continue;

        const stageRow = this.db
          .prepare('SELECT id FROM board_stages WHERE board_id = ? AND position = ?')
          .get(boardId, READY_FOR_DEVELOPMENT_POSITION) as { id?: unknown } | undefined;
        const targetStageId = typeof stageRow?.id === 'string' ? stageRow.id : null;
        if (!targetStageId || targetStageId === currentStageId) continue; // unresolved or already there

        await router.applyChange(projectId, {
          actor: 'orchestrator',
          entityType: 'task',
          taskId,
          stageId: targetStageId,
          runId,
          kind: 'plan-approved',
        });
      }
  }

  /**
   * Ship: retire the run's owned idea(s) to the terminal Decomposed stage when the
   * just-answered gate is `approve-plan` and the human chose Approve — i.e. the
   * moment the tasks are approved. The ship workflow concatenates planner → sprint
   * and DROPS planner's separate terminal decompose/Archive gate, so without this
   * the seed idea lingers in its planning stage forever: a ship run interrupted any
   * time after plan approval (before the create-sprint-batch materialize seam, or
   * mid-execution, or before the final human-review gate) never reaches the agent's
   * retirement. Approving the plan IS the decomposition — its tasks now carry the
   * flow — so the idea is archived here, deterministically and independent of the
   * agent surviving to a later step.
   *
   * Scoped to the `ship` workflow by name: planner runs ALSO answer an
   * `approve-plan` gate, but a planner idea must retire only at its own later
   * decompose/Archive gate (finalizePlannerRun), NEVER here.
   *
   * Backend-deterministic + idempotent (retireIdeaToDecomposed is a no-op once the
   * idea is at Decomposed, so the later materialize seam / human-review retirement
   * are harmless re-asserts) + fail-soft: reads current_step_id defensively (older
   * DBs lack the column → the SELECT throws → caught → no-op). NEVER throws —
   * respond() is unaffected.
   */
  private async retireShipIdeasOnPlanApproval(runId: string, answer: QuestionAnswer): Promise<void> {
    try {
      const run = this.db
        .prepare(
          'SELECT project_id AS projectId, current_step_id AS currentStepId FROM workflow_runs WHERE id = ?',
        )
        .get(runId) as { projectId?: unknown; currentStepId?: unknown } | undefined;
      if (!run) return;
      if (run.currentStepId !== APPROVE_PLAN_STEP_ID) return;
      if (!this.isApproveAnswer(answer)) return;

      // Ship-only — see finalizePlannerRun for the symmetric planner guard. The
      // workflow-name lookup is a LEFT JOIN read (a missing workflows row yields a
      // null name → no retire), matching the defensive pattern there.
      const wf = this.db
        .prepare(
          `SELECT w.name AS workflowName
             FROM workflow_runs r
             LEFT JOIN workflows w ON w.id = r.workflow_id
            WHERE r.id = ?`,
        )
        .get(runId) as { workflowName?: unknown } | undefined;
      if (!(typeof wf?.workflowName === 'string' && wf.workflowName === SHIP_WORKFLOW_NAME)) return;

      const projectId = typeof run.projectId === 'number' ? run.projectId : Number(run.projectId);
      const router = TaskChangeRouter.getInstance();
      for (const ideaId of listRunOwnedIdeaIds(this.db, runId)) {
        await router.retireIdeaToDecomposed(projectId, ideaId).catch(() => {
          /* per-idea best-effort */
        });
      }
    } catch (err) {
      console.warn(
        `[QuestionRouter] retireShipIdeasOnPlanApproval skipped for run ${runId} (fail-soft): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Q1 GUARD (REJECT = no tasks): when the just-answered gate is the planner's
   * `approve-plan` step and the human chose an explicit REJECT (terminal
   * decline), hard-delete the PENDING draft entities this run created during
   * planning — its epics (cascade takes their child tasks) and its orphan tasks
   * — so a rejected plan leaves no orphaned drafts behind.
   *
   * REJECT-ONLY, deliberately NOT any-non-approve: a Revise answer, a cap-trim
   * negotiation reply ("drop TASK-4 first"), or free-text feedback keeps the
   * drafts — the agent adjusts them in place (update/create) and re-presents at
   * the next approve-plan ask. Ship creates its tasks BEFORE this gate and
   * retains their ids across revise rounds; deleting on every non-approve answer
   * destroyed the ids mid-negotiation and bricked the run at materialize.
   * (Cancel/dismiss teardown still sweeps pending drafts unconditionally via
   * deleteRunCreatedEntities — the interrupt path is unchanged.)
   *
   * Routes through TaskChangeRouter.deleteRunCreatedEntities, which keys on
   * run_id (NEVER the seed idea — that survives for the replan) and self-gates on
   * plan-gated + plan_approved_at IS NULL + per-entity pending (an Approve
   * already stamped it in promoteTasksOnPlanApproval AND is filtered out here,
   * so it can never reach the delete).
   *
   * Backend-deterministic + fail-soft: reads current_step_id defensively (older
   * test DBs lack the column -> the SELECT throws -> caught -> no-op). NEVER
   * throws — respond() is unaffected.
   */
  private async deletePendingDraftsOnPlanDecline(
    runId: string,
    answer: QuestionAnswer,
    questions?: ReadonlyArray<QuestionPayload>,
  ): Promise<void> {
    try {
      const run = this.db
        .prepare(
          'SELECT project_id AS projectId, current_step_id AS currentStepId FROM workflow_runs WHERE id = ?',
        )
        .get(runId) as { projectId?: unknown; currentStepId?: unknown } | undefined;
      if (!run) return;
      if (run.currentStepId !== APPROVE_PLAN_STEP_ID) return;
      // ONLY an explicit Reject OPTION deletes (see isRejectAnswer). Approve ->
      // reveal; Revise / trim / free text (even free text that starts with 'reject',
      // e.g. "Reject TASK-4 but keep the rest") -> drafts persist for the agent to
      // adjust and re-present. The presented gate's option labels are threaded in so
      // the check keys on a selected option, never a prefix match on free text.
      if (!this.isRejectAnswer(answer, questions)) return;

      const projectId = typeof run.projectId === 'number' ? run.projectId : Number(run.projectId);
      await TaskChangeRouter.getInstance().deleteRunCreatedEntities(projectId, runId);
    } catch (err) {
      console.warn(
        `[QuestionRouter] deletePendingDraftsOnPlanDecline skipped for run ${runId} (fail-soft): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * FIX-STAGE-MODEL (decompose): the planner's separate FINAL gate, answered at
   * the `decompose` step. The gate offers two options:
   *  - "Archive & finish": the run's owned ideas (listRunOwnedIdeaIds — seed idea
   *    UNION run-created ideas) are retired OFF the board by stamping
   *    `decomposed_at` (TaskChangeRouter.retireIdeaToDecomposed — the idea keeps
   *    its stage), then the run completes.
   *  - "Keep ideas & finish": the ideas stay on the board; the run completes.
   *
   * In BOTH cases the run then COMPLETES — respond() has already flipped the run
   * back to 'running' (the standard answer transition), so a guarded UPDATE here
   * lands it in its terminal 'completed' state. The completion is gated by the
   * aggregate-unblock invariant: if any blocking review_item is still pending the
   * run must NOT complete yet (it waits for the human to clear the inbox).
   *
   * Backend-deterministic + idempotent + fail-soft: reads current_step_id
   * defensively (older DBs lack the column → the SELECT throws → caught → no-op);
   * idea retirement routes through TaskChangeRouter.retireIdeaToDecomposed (a
   * no-op when the idea is already stamped decomposed_at); the completion UPDATE
   * is guarded by `status='running'` so a re-answer is a no-op. NEVER throws —
   * respond() is unaffected.
   */
  private async finalizePlannerRun(runId: string, answer: QuestionAnswer): Promise<void> {
    try {
      const run = this.db
        .prepare(
          'SELECT project_id AS projectId, current_step_id AS currentStepId FROM workflow_runs WHERE id = ?',
        )
        .get(runId) as { projectId?: unknown; currentStepId?: unknown } | undefined;
      if (!run) return;
      if (run.currentStepId !== DECOMPOSE_STEP_ID) return;

      // Defense-in-depth (Ship): the `ship` workflow concatenates planner →
      // sprint in one run and DROPS planner's terminal `decompose` step, so this
      // finalizer never fires for ship today. Guard anyway so a future ship spec
      // edit that reuses the `decompose` step id can't seal a ship run before its
      // sprint tasks execute. Defensive + fail-soft: the workflow-name lookup is
      // a LEFT JOIN read (a missing workflows row yields a null name → no skip),
      // and any throw is caught below → no-op.
      const wf = this.db
        .prepare(
          `SELECT w.name AS workflowName
           FROM workflow_runs r
           LEFT JOIN workflows w ON w.id = r.workflow_id
           WHERE r.id = ?`,
        )
        .get(runId) as { workflowName?: unknown } | undefined;
      if (typeof wf?.workflowName === 'string' && wf.workflowName === SHIP_WORKFLOW_NAME) return;

      const projectId = typeof run.projectId === 'number' ? run.projectId : Number(run.projectId);

      if (this.isArchiveAnswer(answer)) {
        const router = TaskChangeRouter.getInstance();
        for (const ideaId of listRunOwnedIdeaIds(this.db, runId)) {
          await router.retireIdeaToDecomposed(projectId, ideaId).catch(() => {
            /* per-idea best-effort */
          });
        }
      }

      // Aggregate-unblock gate: a run may only complete once ALL its blocking
      // review items are resolved/dismissed. If any remain pending, leave the run
      // running (it stays open for the human to clear the inbox).
      if (countPendingBlockingReviewItems(this.db, runId) > 0) return;

      const now = new Date().toISOString();
      const info = this.db
        .prepare(
          `UPDATE workflow_runs SET status = 'completed', ended_at = CURRENT_TIMESTAMP, updated_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(now, runId) as { changes: number };
      if (info.changes > 0) {
        runStatusEvents.emit('changed', { runId, status: 'completed' } satisfies RunStatusChangedEvent);
      }
    } catch (err) {
      console.warn(
        `[QuestionRouter] finalizePlannerRun skipped for run ${runId} (fail-soft): ${err instanceof Error ? err.message : String(err)}`,
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
   * Decide whether a gate answer is an EXPLICIT Reject (terminal decline).
   *
   * A decline fires ONLY when the user SELECTED an explicit reject OPTION — the
   * answer value must EXACTLY equal (case-insensitive, trimmed) one of the
   * presented question's option LABELS that itself starts with 'reject'. A prefix
   * match on free text is deliberately NOT enough: at the ship approve-plan gate a
   * draft-preserving negotiation reply like "Reject TASK-4 but keep the rest"
   * (which ship.md frames as keep-the-rest) starts with 'reject' but is NOT a
   * terminal decline, and must never tear the whole draft plan down mid-negotiation.
   * Fail-safe: when in doubt, keep the drafts.
   *
   * When the presented options are unavailable at this seam (`questions` absent or
   * carrying no reject option), fall back to an EXACT match on a canonical reject
   * token ('reject' / 'reject plan') — still never a prefix match. Conservative on
   * purpose: Revise, cap-trim replies, and free-text feedback are NOT rejects
   * (drafts must survive negotiation rounds); only a deliberate Reject tears them down.
   */
  private isRejectAnswer(answer: QuestionAnswer, questions?: ReadonlyArray<QuestionPayload>): boolean {
    if (this.isApproveAnswer(answer)) return false;
    const values = Object.values(answer.answers).map((v) => v.trim().toLowerCase());
    if (values.length === 0) return false;

    // Collect the presented reject-option labels (case-insensitive, trimmed).
    const rejectLabels = new Set<string>();
    for (const q of questions ?? []) {
      for (const opt of q.options ?? []) {
        const label = opt.label.trim().toLowerCase();
        if (label.startsWith('reject')) rejectLabels.add(label);
      }
    }
    if (rejectLabels.size > 0) {
      // An explicit reject option was presented — a decline requires selecting it
      // (exact label match), never a prefix match on free text.
      return values.some((v) => rejectLabels.has(v));
    }

    // Fallback (options unavailable): exact-match a canonical reject token only.
    return values.some((v) => v === 'reject' || v === 'reject plan');
  }

  /**
   * Decide whether a decompose-gate answer is the Archive option (vs Keep).
   * Case-insensitive: at least one answer value (trimmed, lowercased) starts
   * with 'archive'. So 'Archive & finish' → true; 'Keep ideas & finish' → false.
   */
  private isArchiveAnswer(answer: QuestionAnswer): boolean {
    return Object.values(answer.answers).some((v) => v.trim().toLowerCase().startsWith('archive'));
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
          emitReviewItemChangedById(this.db, entry.reviewItemId, 'resolved');
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

    // Settle the OWNING run if it is still wedged at 'awaiting_input'.
    // clearPendingForRun fires on run teardown (the SDK query's finally block,
    // cancel, shutdown). The question rows + folded review items above are now
    // settled, but the run row itself is untouched — so a run torn down WHILE a
    // gate was open lingers at 'awaiting_input' with no pending question and no
    // live SDK session: the gate UI has nothing to act on and the composer's
    // only enable path (awaiting_review nudge / a live question) never fires, so
    // the run is unreachable until recoverStaleAwaitingInput at the NEXT app boot
    // flips it to 'failed'. Rest it in 'awaiting_review' instead, so it lands in
    // the review queue and is nudge-resumable (runs.nudge requires
    // awaiting_review + a captured claude_session_id, both of which a torn-down
    // run has). Guarded `WHERE status='awaiting_input'`: a cancel / fail path
    // that already stamped (or, like cancelRunHandler, later stamps under
    // `status NOT IN terminal`) a terminal status always wins, and an
    // already-terminal run never matches. Fail-soft — a DB error during teardown
    // must never throw.
    try {
      const settledAt = new Date().toISOString();
      const settle = this.db
        .prepare(
          `UPDATE workflow_runs SET status = 'awaiting_review', updated_at = ?
           WHERE id = ? AND status = 'awaiting_input'`,
        )
        .run(settledAt, runId) as { changes: number };
      if (settle.changes > 0) {
        runStatusEvents.emit(
          'changed',
          { runId, status: 'awaiting_review' } satisfies RunStatusChangedEvent,
        );
      }
    } catch (err) {
      console.warn(
        `[QuestionRouter] clearPendingForRun: run-status settle failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Boot-time recovery for workflow_runs left in 'awaiting_input' by a previous
   * session (the SDK iterator is one-shot and is gone after a restart).
   *
   * The SDK *process* being gone does NOT mean the *conversation* is gone: a run
   * that captured a `claude_session_id` (stamped at the first system/init event)
   * can be re-opened via `--resume` (runs.nudge re-drives the same conversation).
   * So we split the stale runs:
   *   - RESUMABLE (claude_session_id present AND last touched within
   *     STALE_RESUMABLE_RECOVERY_DAYS) → 'awaiting_review'. The run lands in the
   *     review queue and is nudge-resumable — NOT a dead end. (This is the
   *     "reopen after timeout" fix; mirrors the in-session teardown settle in
   *     clearPendingForRun.)
   *   - SESSIONLESS or STALE (no captured session, or older than the cap) →
   *     'failed' (error_message='app_restart') — genuinely unresumable, the
   *     original conservative behavior. The age cap keeps the review queue from
   *     accumulating ancient reopen candidates across many restarts.
   *
   * For BOTH buckets the orphaned in-flight gate is dead, so pending questions are
   * flipped to 'timed_out' and folded decision review_items resolved (audit
   * consistency + no lingering blocking items). A resumable run re-opens via a
   * fresh nudge turn, not by answering the stale gate.
   *
   * Returns the total number of workflow_runs rows transitioned.
   */
  recoverStaleAwaitingInput(): number {
    const transition = this.db.transaction(() => {
      const staleRuns = this.db
        .prepare(
          `SELECT id, claude_session_id,
                  CASE WHEN julianday('now') - julianday(updated_at) <= ? THEN 1 ELSE 0 END AS is_fresh
             FROM workflow_runs WHERE status = 'awaiting_input'`,
        )
        .all(STALE_RESUMABLE_RECOVERY_DAYS) as {
          id: string;
          claude_session_id: string | null;
          is_fresh: number;
        }[];
      if (staleRuns.length === 0) return { resumable: 0, failed: 0 };

      // Reopenable = captured an SDK conversation AND recovered recently enough
      // (is_fresh) that the local --resume session data plausibly still exists.
      // Anything else (sessionless OR stale) is failed instead.
      const isResumable = (r: { claude_session_id: string | null; is_fresh: number }): boolean =>
        r.claude_session_id !== null && r.claude_session_id !== '' && r.is_fresh === 1;
      const resumableIds = staleRuns.filter(isResumable).map((r) => r.id);
      const failedIds = staleRuns.filter((r) => !isResumable(r)).map((r) => r.id);
      const allIds = staleRuns.map((r) => r.id);

      if (resumableIds.length > 0) {
        const ph = resumableIds.map(() => '?').join(',');
        this.db
          .prepare(`UPDATE workflow_runs
                       SET status = 'awaiting_review', updated_at = CURRENT_TIMESTAMP
                     WHERE id IN (${ph})`)
          .run(...resumableIds);
      }
      if (failedIds.length > 0) {
        const ph = failedIds.map(() => '?').join(',');
        this.db
          .prepare(`UPDATE workflow_runs
                       SET status = 'failed',
                           error_message = 'app_restart',
                           ended_at = CURRENT_TIMESTAMP,
                           updated_at = CURRENT_TIMESTAMP
                     WHERE id IN (${ph})`)
          .run(...failedIds);
      }

      // Settle the dead gate for ALL recovered runs (both buckets).
      const allPh = allIds.map(() => '?').join(',');
      this.db
        .prepare(`UPDATE questions SET status = 'timed_out', answered_at = CURRENT_TIMESTAMP WHERE run_id IN (${allPh}) AND status = 'pending'`)
        .run(...allIds);
      // Reconcile the folded inbox: orphaned pending question-sourced decision
      // review_items can never resolve via the dead gate, so resolve them too so
      // they don't linger as stale blocking items. No-op pre-016.
      if (hasReviewItemsTable(this.db)) {
        const now = new Date().toISOString();
        this.db
          .prepare(
            `UPDATE review_items
                SET status = 'resolved', resolved_by = 'system', resolution = 'app_restart', updated_at = ?
              WHERE kind = 'decision' AND status = 'pending' AND source = 'question' AND run_id IN (${allPh})`,
          )
          .run(now, ...allIds);
      }
      return { resumable: resumableIds.length, failed: failedIds.length };
    });
    const { resumable, failed } = transition();
    const total = resumable + failed;
    if (total > 0) {
      console.log(
        `[QuestionRouter] Boot recovery: ${total} stale awaiting_input run(s) — ` +
        `${resumable} rested in awaiting_review (resumable), ${failed} failed (no session / stale > ${STALE_RESUMABLE_RECOVERY_DAYS}d)`,
      );
    }
    return total;
  }

  /**
   * Returns a snapshot of all currently in-flight question requests.
   * Used by the renderer's question-queue subscription.
   */
  getPending(): QuestionRequest[] {
    return Array.from(this.pending.values()).map((p) => p.request);
  }
}
