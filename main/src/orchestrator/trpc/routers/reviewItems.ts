/**
 * cyboflow.reviewItems sub-router.
 *
 * Provides the typed tRPC contract for the renderer's review-queue inbox:
 *   - list             : query        -> ReviewItem[] (project inbox, filtered)
 *   - get              : query        -> ReviewItem | null (single item)
 *   - resolve          : mutation     -> { reviewItemId } (ReviewItemRouter triage)
 *   - dismiss          : mutation     -> { reviewItemId } (ReviewItemRouter triage)
 *   - promoteToTask    : mutation     -> { reviewItemId, taskId } (TWO chokepoints)
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

export const reviewItemsRouter = router({
  /**
   * List the review inbox for a project, newest-first, with optional filters on
   * status / kind / blocking / runId. Returns ReviewItem[] so the inferred
   * AppRouter type carries the full read-model (incl. parsed payload + boolean
   * `blocking`) to the renderer.
   */
  list: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        status: statusSchema.optional(),
        kind: kindSchema.optional(),
        blocking: z.boolean().optional(),
        runId: z.string().min(1).optional(),
      }),
    )
    .query(async ({ input, ctx }): Promise<ReviewItem[]> => {
      const db = requireDb(ctx.db, 'list');
      const clauses: string[] = ['project_id = ?'];
      const params: unknown[] = [input.projectId];
      if (input.status !== undefined) {
        clauses.push('status = ?');
        params.push(input.status);
      }
      if (input.kind !== undefined) {
        clauses.push('kind = ?');
        params.push(input.kind);
      }
      if (input.blocking !== undefined) {
        clauses.push('blocking = ?');
        params.push(input.blocking ? 1 : 0);
      }
      if (input.runId !== undefined) {
        clauses.push('run_id = ?');
        params.push(input.runId);
      }
      const rows = db
        .prepare(
          `SELECT * FROM review_items WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC`,
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
    .mutation(async ({ input }): Promise<{ reviewItemId: string }> => {
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
