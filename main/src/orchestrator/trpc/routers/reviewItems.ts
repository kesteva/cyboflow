/**
 * cyboflow.reviewItems sub-router.
 *
 * Provides the typed tRPC contract for the renderer's review-queue inbox:
 *   - list             : query        -> ReviewItem[] (project inbox, filtered)
 *   - get              : query        -> ReviewItem | null (single item)
 *   - resolve          : mutation     -> { reviewItemId } (ReviewItemRouter triage)
 *   - dismiss          : mutation     -> { reviewItemId } (ReviewItemRouter triage)
 *   - promoteToTask    : mutation     -> { reviewItemId, taskId } (TWO chokepoints)
 *   - setTag           : mutation     -> { reviewItemId } (findings triage — re-tag)
 *   - setPriority      : mutation     -> { reviewItemId } (findings triage — re-prioritize)
 *   - approve          : mutation     -> { reviewItemId, staged } (untriaged -> ready)
 *   - setSelected      : mutation     -> { count } (batch compound-selection toggle)
 *   - onReviewItemChanged : subscription -> ReviewItemChangedEvent (project-scoped)
 *
 * Triage validation lives ENTIRELY in the chokepoint (ReviewItemRouter). This
 * router is a thin wrapper: the mutations forward {actor:'user', ...} and surface
 * ReviewItemError.code to the client.
 *
 * promoteToTask is the only TWO-chokepoint operation: it mints a real task via
 * TaskChangeRouter.applyChange AND resolves the review item via ReviewItemRouter,
 * recording the minted task id in the item's resolution. It validates that the
 * item is NOT already linked to an entity (entity_id must be null) before minting
 * — a permission/decision item already bound to an idea/epic/task is not a
 * promotion candidate.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import type { DatabaseLike } from '../../types';
import type { ReviewItem, ReviewItemChangedEvent } from '../../../../../shared/types/reviews';
import {
  ReviewItemRouter,
  ReviewItemError,
  reviewItemChangeEvents,
  reviewItemProjectChannel,
  type ReviewItemDbRow,
} from '../../reviewItemRouter';
import { TaskChangeRouter, TaskChangeError } from '../../taskChangeRouter';
import { HumanStepManager } from '../../humanStepManager';
import { eventToAsyncIterable } from './events';
import { TERMINAL_RUN_STATUSES_SQL_IN } from '../../../../../shared/types/cyboflow';

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Map a ReviewItemError / TaskChangeError discriminated code to a TRPCError so
 * the renderer can branch on `error.data.code`. Re-throws other errors unchanged.
 */
function rethrowAsTRPCError(err: unknown): never {
  if (err instanceof ReviewItemError) {
    const codeMap: Record<ReviewItemError['code'], TRPCError['code']> = {
      not_found: 'NOT_FOUND',
      invalid_entity: 'BAD_REQUEST',
      invalid_payload: 'BAD_REQUEST',
      invalid_status: 'CONFLICT',
    };
    throw new TRPCError({
      code: codeMap[err.code],
      message: `${err.code}: ${err.message}`,
      cause: err,
    });
  }
  if (err instanceof TaskChangeError) {
    const codeMap: Record<TaskChangeError['code'], TRPCError['code']> = {
      not_found: 'NOT_FOUND',
      invalid_parent: 'BAD_REQUEST',
      invalid_lineage: 'BAD_REQUEST',
      forbidden_stage: 'FORBIDDEN',
      active_runs: 'CONFLICT',
      concurrency: 'CONFLICT',
      invalid_dependency: 'BAD_REQUEST',
      dependency_cycle: 'CONFLICT',
    };
    throw new TRPCError({
      code: codeMap[err.code],
      message: `${err.code}: ${err.message}`,
      cause: err,
    });
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Read helpers — shaped via the chokepoint's single-source ReviewItemRouter.shapeRow.
// ---------------------------------------------------------------------------

function requireDb(db: DatabaseLike | undefined, where: string): DatabaseLike {
  if (!db) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `[reviewItems.${where}] db not wired into tRPC context`,
    });
  }
  return db;
}

// ---------------------------------------------------------------------------
// Zod input schemas
// ---------------------------------------------------------------------------

const kindSchema = z.enum(['finding', 'permission', 'decision', 'human_task']);
const statusSchema = z.enum(['pending', 'resolved', 'dismissed']);

/**
 * Guard: a PENDING question-sourced decision item must be settled by ANSWERING
 * its AskUserQuestion (questions.respond), never by direct resolve/dismiss —
 * the run is awaiting_input on a specific answer, so triaging the item alone
 * strands the waiting agent forever (the question socket never replies and
 * maybeResumeRun only resumes awaiting_review). QuestionRouter resolves the
 * folded item itself when the question is answered. Throws CONFLICT when a
 * pending question still exists for the item's run.
 */
function assertNotOpenQuestionGate(db: DatabaseLike, reviewItemId: string, projectId: number): void {
  const item = db
    .prepare(
      `SELECT kind, source, status, run_id AS runId FROM review_items
        WHERE id = ? AND project_id = ?`,
    )
    .get(reviewItemId, projectId) as
    | { kind?: string; source?: string | null; status?: string; runId?: string | null }
    | undefined;
  if (
    !item ||
    item.kind !== 'decision' ||
    item.source !== 'question' ||
    item.status !== 'pending' ||
    !item.runId
  ) {
    return;
  }
  const pendingQuestion = db
    .prepare(`SELECT 1 FROM questions WHERE run_id = ? AND status = 'pending' LIMIT 1`)
    .get(item.runId);
  if (pendingQuestion) {
    throw new TRPCError({
      code: 'CONFLICT',
      message:
        'invalid_status: this decision is an open question — answer it from the session chat; resolving it here would strand the waiting agent',
    });
  }
}

export const reviewItemsRouter = router({
  /**
   * List the review inbox for a project, newest-first, with optional filters on
   * status / kind / blocking / runId / staged / selected. Returns ReviewItem[]
   * so the inferred AppRouter type carries the full read-model (incl. parsed
   * payload + boolean `blocking` + finding-scoped priority/staged_at/selected)
   * to the renderer.
   *
   * SINGLE-FETCH CONTRACT (findings triage): the Insights store derives BOTH the
   * UNTRIAGED and READY sections from ONE call
   * `list({ projectId, kind: 'finding', status: 'pending' })` — untriaged =
   * `staged_at` null, ready = `staged_at` set. The optional `staged`/`selected`
   * filters exist for targeted reads but the triage view deliberately fetches
   * once and partitions client-side.
   */
  list: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        status: statusSchema.optional(),
        kind: kindSchema.optional(),
        blocking: z.boolean().optional(),
        runId: z.string().min(1).optional(),
        /** true => staged_at IS NOT NULL (ready); false => staged_at IS NULL (untriaged). */
        staged: z.boolean().optional(),
        /** true => selected = 1; false => selected = 0. */
        selected: z.boolean().optional(),
        /**
         * Findings-only merge gate (Insights compounding surface). When true, a
         * FINDING is surfaced only if its session was MERGED (a run in the same
         * session has outcome='merged') — unmerged work may never land, so its
         * findings might not apply. Replaces the run-status orphan-hide FOR
         * FINDINGS (gates still get the orphan-hide). Off by default so the
         * pre-merge Review Queue is unaffected.
         */
        requireMergedSession: z.boolean().optional(),
      }),
    )
    .query(async ({ input, ctx }): Promise<ReviewItem[]> => {
      const db = requireDb(ctx.db, 'list');
      const clauses: string[] = ['ri.project_id = ?'];
      const params: unknown[] = [input.projectId];
      if (input.status !== undefined) {
        clauses.push('ri.status = ?');
        params.push(input.status);
      }
      if (input.kind !== undefined) {
        clauses.push('ri.kind = ?');
        params.push(input.kind);
      }
      if (input.blocking !== undefined) {
        clauses.push('ri.blocking = ?');
        params.push(input.blocking ? 1 : 0);
      }
      if (input.runId !== undefined) {
        clauses.push('ri.run_id = ?');
        params.push(input.runId);
      }
      if (input.staged !== undefined) {
        clauses.push(input.staged ? 'ri.staged_at IS NOT NULL' : 'ri.staged_at IS NULL');
      }
      if (input.selected !== undefined) {
        clauses.push('ri.selected = ?');
        params.push(input.selected ? 1 : 0);
      }
      // Hide orphaned UNTRIAGED PENDING items whose bound run has gone terminal
      // (canceled/failed/completed): the gate can never be actioned — there is
      // no live run to resume — so it must not clutter the queue or inflate the
      // blocking count (ReviewQueueView derives both list + blockingCount from
      // this query). Items with no run binding (run_id NULL) and items already
      // resolved/dismissed are unaffected — the LEFT JOIN keeps them.
      //
      // STAGED findings survive (staged_at IS NOT NULL): the human explicitly
      // approved them into READY-to-compound, so they must remain even after the
      // producing run goes terminal — the human's keep signal overrides the
      // orphan-hide. This relaxation is finding-scoped only in effect: it KEEPS
      // a staged row, and a staged row is necessarily a finding (only findings
      // are stageable). The Review Queue's blocking/permission view filters
      // `kind != 'finding'`, so a kept staged finding can NEVER leak into the
      // blocking count or the gate/permission list (verified: ReviewQueueView).
      if (input.requireMergedSession) {
        // Insights compounding surface: a FINDING surfaces only if its session
        // was MERGED — i.e. a run in the SAME session has outcome='merged' (the
        // close-out signal; the producing run's own status may read 'canceled'
        // after worktree teardown, so we key on the session's merge OUTCOME, not
        // run status). Unmerged work may never land, so its findings might not
        // apply. This REPLACES the run-status orphan-hide for findings; GATES
        // (kind != 'finding') still get the orphan-hide below.
        clauses.push(
          `NOT (ri.kind != 'finding' AND ri.status = 'pending' AND ri.staged_at IS NULL AND ri.run_id IS NOT NULL AND r.status IN ${TERMINAL_RUN_STATUSES_SQL_IN})`,
        );
        clauses.push(
          `(ri.kind != 'finding' OR EXISTS (
             SELECT 1 FROM workflow_runs wrm
              WHERE wrm.session_id = r.session_id AND wrm.outcome = 'merged'))`,
        );
      } else {
        // Eval-authored findings (source 'agent:eval*') are POST-HOC by design: the
        // K-sample jury runs for minutes after the human-review trigger, so a fast
        // 'Complete workflow' can flip the run terminal BEFORE the finding is
        // written — the orphan-hide would then suppress it (incl. a blocking
        // catastrophic-cap item) the moment it lands, emptying the summary
        // drill-down and hiding it from the blocking count. Exempt them so they
        // surface (and gate) even on a terminal run; the human still dismisses them.
        clauses.push(
          `NOT (ri.status = 'pending' AND ri.staged_at IS NULL AND ri.run_id IS NOT NULL AND r.status IN ${TERMINAL_RUN_STATUSES_SQL_IN} AND ri.source NOT LIKE 'agent:eval%')`,
        );
      }
      const rows = db
        .prepare(
          `SELECT ri.* FROM review_items ri
             LEFT JOIN workflow_runs r ON r.id = ri.run_id
            WHERE ${clauses.join(' AND ')}
            ORDER BY ri.created_at DESC, ri.id DESC`,
        )
        .all(...params) as ReviewItemDbRow[];
      return rows.map((r) => ReviewItemRouter.shapeRow(r));
    }),

  /**
   * Fetch a single review item by id. Returns null when it does not exist.
   */
  get: protectedProcedure
    .input(z.object({ reviewItemId: z.string().min(1) }))
    .query(async ({ input, ctx }): Promise<ReviewItem | null> => {
      const db = requireDb(ctx.db, 'get');
      const row = db
        .prepare('SELECT * FROM review_items WHERE id = ?')
        .get(input.reviewItemId) as ReviewItemDbRow | undefined;
      return row ? ReviewItemRouter.shapeRow(row) : null;
    }),

  /**
   * Resolve a review item (triage). Forwards to ReviewItemRouter.applyReviewItem
   * with op='resolve' as actor='user'. Re-resolving a terminal item surfaces
   * code:'invalid_status' (TRPCError 'CONFLICT').
   *
   * P4 AUTO-RESUME: resolving a BLOCKING item bound to a run triggers
   * aggregate-unblock — after the chokepoint resolve commits, HumanStepManager
   * transitions the run awaiting_review -> running ONLY when no other pending
   * blocking review_item remains for that run (a permission gate or a sibling
   * decision still open keeps the run paused). The chokepoint owns the audit +
   * renderer emit; the resume is a follow-on transition.
   */
  resolve: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        reviewItemId: z.string().min(1),
        resolution: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }): Promise<{ reviewItemId: string; resumed: boolean }> => {
      const db = requireDb(ctx.db, 'resolve');
      // Read the item's run binding + blocking flag BEFORE resolving (the resolve
      // does not change either) so we know whether to apply aggregate-unblock.
      const before = db
        .prepare('SELECT run_id AS runId, blocking FROM review_items WHERE id = ? AND project_id = ?')
        .get(input.reviewItemId, input.projectId) as { runId?: string | null; blocking?: number } | undefined;

      assertNotOpenQuestionGate(db, input.reviewItemId, input.projectId);

      try {
        const { reviewItemId } = await ReviewItemRouter.getInstance().applyReviewItem(input.projectId, {
          op: 'resolve',
          actor: 'user',
          reviewItemId: input.reviewItemId,
          ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
        });

        // Aggregate-unblock auto-resume for a blocking, run-bound item.
        let resumed = false;
        if (before?.blocking === 1 && before.runId) {
          resumed = await HumanStepManager.getInstance().maybeResumeRun(before.runId);
        }
        return { reviewItemId, resumed };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Dismiss a review item (triage — cruft). Forwards op='dismiss' as actor='user'.
   */
  dismiss: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        reviewItemId: z.string().min(1),
        resolution: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ input, ctx }): Promise<{ reviewItemId: string }> => {
      const db = requireDb(ctx.db, 'dismiss');
      assertNotOpenQuestionGate(db, input.reviewItemId, input.projectId);
      try {
        const { reviewItemId } = await ReviewItemRouter.getInstance().applyReviewItem(input.projectId, {
          op: 'dismiss',
          actor: 'user',
          reviewItemId: input.reviewItemId,
          ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
        });
        return { reviewItemId };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Promote a review item to a real task — the only TWO-chokepoint triage op.
   *
   * Mints a task via TaskChangeRouter.applyChange (actor='user', entityType='task')
   * THEN resolves the review item via ReviewItemRouter, recording the minted task
   * id in the resolution ('promoted:<taskId>').
   *
   * GUARD: the item must NOT already be linked to an entity (entity_id must be
   * null) — an item already bound to an idea/epic/task is not a promotion
   * candidate (code:'invalid_entity' / BAD_REQUEST).
   *
   * The task mint runs FIRST so that if it fails, the review item is left pending
   * (no partial promotion). The two chokepoints serialize independently per
   * project; the resolve cannot be skipped once the task is minted because a
   * resolve-side failure surfaces the error to the caller with the task already
   * created (the resolution note is the audit trail to reconcile).
   */
  promoteToTask: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        reviewItemId: z.string().min(1),
        /** Override the minted task's title (defaults to the review item's title). */
        title: z.string().optional(),
        /** Override the minted task's body (defaults to the review item's body). */
        body: z.string().nullable().optional(),
        priority: z.enum(['P0', 'P1', 'P2']).optional(),
        repo: z.string().nullable().optional(),
        boardId: z.string().optional(),
        initialStageId: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }): Promise<{ reviewItemId: string; taskId: string }> => {
      const db = requireDb(ctx.db, 'promoteToTask');

      // Read the source item to validate the promotion guard + derive defaults.
      const row = db
        .prepare('SELECT * FROM review_items WHERE id = ? AND project_id = ?')
        .get(input.reviewItemId, input.projectId) as ReviewItemDbRow | undefined;
      if (!row) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `not_found: review item ${input.reviewItemId} not found for project ${input.projectId}`,
        });
      }
      if (row.status !== 'pending') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: `invalid_status: review item ${input.reviewItemId} is already '${row.status}'`,
        });
      }
      // GUARD: an item already bound to an entity is not a promotion candidate.
      if (row.entity_id !== null) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `invalid_entity: review item ${input.reviewItemId} is already linked to ${row.entity_type} ${row.entity_id}; cannot promote`,
        });
      }

      try {
        // 1) Mint the task through the OTHER chokepoint.
        const { taskId } = await TaskChangeRouter.getInstance().applyChange(input.projectId, {
          actor: 'user',
          entityType: 'task',
          title: input.title ?? row.title,
          body: input.body !== undefined ? input.body : row.body,
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.repo !== undefined ? { repo: input.repo } : {}),
          ...(input.boardId !== undefined ? { boardId: input.boardId } : {}),
          ...(input.initialStageId !== undefined ? { initialStageId: input.initialStageId } : {}),
        });

        // 2) Resolve the review item through ITS chokepoint, recording the link.
        const { reviewItemId } = await ReviewItemRouter.getInstance().applyReviewItem(input.projectId, {
          op: 'resolve',
          actor: 'user',
          reviewItemId: input.reviewItemId,
          resolution: `promoted:${taskId}`,
          ...(row.run_id !== null ? { runId: row.run_id } : {}),
        });

        return { reviewItemId, taskId };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Re-tag a finding (findings triage). Forwards op='mutate' with the new
   * proposedTarget as actor='user' to the chokepoint, which rewrites the item's
   * payload (applied-not-consumed; untriaged-only). A non-finding or already-
   * staged item surfaces ReviewItemError -> TRPCError ('invalid_payload' ->
   * BAD_REQUEST, 'invalid_status' -> CONFLICT).
   */
  setTag: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        reviewItemId: z.string().min(1),
        proposedTarget: z.enum(['backlog', 'docs', 'prompt', 'fix']),
      }),
    )
    .mutation(async ({ input, ctx }): Promise<{ reviewItemId: string }> => {
      requireDb(ctx.db, 'setTag');
      try {
        const { reviewItemId } = await ReviewItemRouter.getInstance().applyReviewItem(input.projectId, {
          op: 'mutate',
          actor: 'user',
          reviewItemId: input.reviewItemId,
          proposedTarget: input.proposedTarget,
        });
        return { reviewItemId };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Re-prioritize a finding (findings triage). Forwards op='mutate' with the new
   * priority as actor='user' to the chokepoint (applied-not-consumed; untriaged-
   * only). An already-staged item surfaces 'invalid_status' -> CONFLICT.
   */
  setPriority: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        reviewItemId: z.string().min(1),
        priority: z.enum(['P0', 'P1', 'P2']),
      }),
    )
    .mutation(async ({ input, ctx }): Promise<{ reviewItemId: string }> => {
      requireDb(ctx.db, 'setPriority');
      try {
        const { reviewItemId } = await ReviewItemRouter.getInstance().applyReviewItem(input.projectId, {
          op: 'mutate',
          actor: 'user',
          reviewItemId: input.reviewItemId,
          priority: input.priority,
        });
        return { reviewItemId };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Approve an untriaged finding into READY-to-compound (findings triage).
   * Forwards op='approve' as actor='user'; the chokepoint sets
   * `staged_at = CURRENT_TIMESTAMP, selected = 1` (untriaged-only). A non-pending
   * or already-staged item surfaces 'invalid_status' -> CONFLICT.
   */
  approve: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        reviewItemId: z.string().min(1),
      }),
    )
    .mutation(async ({ input, ctx }): Promise<{ reviewItemId: string; staged: true }> => {
      requireDb(ctx.db, 'approve');
      try {
        const { reviewItemId } = await ReviewItemRouter.getInstance().applyReviewItem(input.projectId, {
          op: 'approve',
          actor: 'user',
          reviewItemId: input.reviewItemId,
        });
        return { reviewItemId, staged: true };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Batch-toggle the compound-selection flag on one or more READY findings
   * (findings triage). Forwards op='set-selected' as actor='user'; the chokepoint
   * UPDATEs `selected` over the explicit id list (only staged items are
   * selectable) and emits one 'selection-changed' event per affected id. Returns
   * the count of ids requested (the renderer reconciles via the per-id events).
   */
  setSelected: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        reviewItemIds: z.array(z.string().min(1)).min(1),
        selected: z.boolean(),
      }),
    )
    .mutation(async ({ input, ctx }): Promise<{ count: number }> => {
      requireDb(ctx.db, 'setSelected');
      try {
        await ReviewItemRouter.getInstance().applyReviewItem(input.projectId, {
          op: 'set-selected',
          actor: 'user',
          reviewItemIds: input.reviewItemIds,
          selected: input.selected,
        });
        return { count: input.reviewItemIds.length };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Subscribe to review-item-changed notifications for a single project.
   *
   * Bridges the module-level `reviewItemChangeEvents` EventEmitter (exported from
   * reviewItemRouter.ts, NOT events.ts) on the project-scoped channel
   * reviewItemProjectChannel(projectId) = 'review-project-<projectId>'. The
   * chokepoint emits a ReviewItemChangedEvent on that channel after every
   * committed change (created / resolved / dismissed).
   *
   * No throttle: review-item mutations are user/agent-gated and each must surface.
   */
  onReviewItemChanged: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .subscription(async function* ({ input, signal }): AsyncGenerator<ReviewItemChangedEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<ReviewItemChangedEvent>(
        reviewItemChangeEvents,
        reviewItemProjectChannel(input.projectId),
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),
});
