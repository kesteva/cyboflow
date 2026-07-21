/**
 * cyboflow.feedback sub-router — in-artifact feedback on the idea-spec /
 * arch-design document tabs (IDEA-033).
 *
 * Typed tRPC contract for the renderer's highlight+comment feedback surface:
 *   - list              : query        -> { comments, batches } (a run's feedback)
 *   - createComment     : mutation     -> { commentId }
 *   - updateComment     : mutation     -> { commentId }
 *   - deleteComment     : mutation     -> { commentId }
 *   - sendBatch         : mutation     -> SendFeedbackResult (refusals are DATA)
 *   - onFeedbackChanged : subscription -> FeedbackChangedEvent (project-scoped)
 *
 * Comment CRUD forwards to the FeedbackRouter chokepoint (getInstance()); sendBatch
 * forwards to sendFeedbackHandler (guards + detached revision launch). `projectId`
 * for every write is resolved from workflow_runs — a client-supplied projectId is
 * never trusted. Refusals from sendBatch are returned as `{ noOp, reason }` data,
 * not thrown; FeedbackRouter chokepoint errors are surfaced as typed TRPCErrors.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*. The service-backed revision launcher is injected at boot
 * via setRevisionLauncher (sendFeedbackHandler.ts) and read here through
 * getRevisionLauncher().
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import type { DatabaseLike } from '../../types';
import type {
  FeedbackBatch,
  FeedbackChangedEvent,
  FeedbackComment,
} from '../../../../../shared/types/feedback';
import type { SendFeedbackResult } from '../../../../../shared/types/feedback';
import { FeedbackRouter, FeedbackError } from '../../feedbackRouter';
import { sendFeedbackHandler, getRevisionLauncher } from '../../sendFeedbackHandler';
import { eventToAsyncIterable, feedbackEvents, feedbackProjectChannel } from './events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireDb(db: DatabaseLike | undefined, where: string): DatabaseLike {
  if (!db) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `[feedback.${where}] db not wired into tRPC context`,
    });
  }
  return db;
}

/** Resolve the run's project (writes never trust a client-supplied projectId). */
function resolveProjectId(db: DatabaseLike, runId: string, where: string): number {
  const run = db
    .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE id = ?')
    .get(runId) as { projectId: number } | undefined;
  if (!run) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `[feedback.${where}] run ${runId} not found` });
  }
  return run.projectId;
}

/** Map a FeedbackError code to a TRPCError (code carried in the message). */
function rethrowAsTRPCError(err: unknown): never {
  if (err instanceof FeedbackError) {
    const codeMap: Record<FeedbackError['code'], TRPCError['code']> = {
      not_found: 'NOT_FOUND',
      invalid_atype: 'BAD_REQUEST',
      invalid_body: 'BAD_REQUEST',
      not_draft: 'CONFLICT',
      busy: 'CONFLICT',
      no_comments: 'BAD_REQUEST',
      invalid_op: 'BAD_REQUEST',
    };
    throw new TRPCError({ code: codeMap[err.code], message: `${err.code}: ${err.message}`, cause: err });
  }
  throw err;
}

const feedbackAtypeSchema = z.enum(['idea-spec', 'arch-design']);
const anchorSchema = z.object({
  quote: z.string(),
  occurrence: z.number().int().min(0),
  bodyHash: z.string(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const feedbackRouter = router({
  /** All feedback comments + batches for a run (optionally scoped by document). */
  list: protectedProcedure
    .input(
      z.object({
        runId: z.string().min(1),
        atype: feedbackAtypeSchema.optional(),
        sourceRef: z.string().min(1).optional(),
      }),
    )
    .query(
      ({ input }): { comments: FeedbackComment[]; batches: FeedbackBatch[] } => {
        const feedback = FeedbackRouter.getInstance();
        return {
          comments: feedback.listComments(input.runId, input.atype, input.sourceRef),
          batches: feedback.listBatches(input.runId, input.atype, input.sourceRef),
        };
      },
    ),

  /** Create a draft comment on a document. */
  createComment: protectedProcedure
    .input(
      z.object({
        runId: z.string().min(1),
        atype: feedbackAtypeSchema,
        sourceRef: z.string().min(1),
        anchor: anchorSchema,
        body: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }): Promise<{ commentId: string }> => {
      const db = requireDb(ctx.db, 'createComment');
      const projectId = resolveProjectId(db, input.runId, 'createComment');
      try {
        return await FeedbackRouter.getInstance().apply(projectId, {
          op: 'create-comment',
          runId: input.runId,
          atype: input.atype,
          sourceRef: input.sourceRef,
          anchor: input.anchor,
          body: input.body,
        });
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /** Edit a draft comment's body and/or anchor. */
  updateComment: protectedProcedure
    .input(
      z.object({
        runId: z.string().min(1),
        commentId: z.string().min(1),
        body: z.string().optional(),
        anchor: anchorSchema.optional(),
      }),
    )
    .mutation(async ({ input, ctx }): Promise<{ commentId: string }> => {
      const db = requireDb(ctx.db, 'updateComment');
      const projectId = resolveProjectId(db, input.runId, 'updateComment');
      try {
        return await FeedbackRouter.getInstance().apply(projectId, {
          op: 'update-comment',
          commentId: input.commentId,
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.anchor !== undefined ? { anchor: input.anchor } : {}),
        });
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /** Hard-delete a draft comment. */
  deleteComment: protectedProcedure
    .input(z.object({ runId: z.string().min(1), commentId: z.string().min(1) }))
    .mutation(async ({ input, ctx }): Promise<{ commentId: string }> => {
      const db = requireDb(ctx.db, 'deleteComment');
      const projectId = resolveProjectId(db, input.runId, 'deleteComment');
      try {
        return await FeedbackRouter.getInstance().apply(projectId, {
          op: 'delete-comment',
          commentId: input.commentId,
        });
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * "Send feedback": guard the request and, on success, fire the host-driven
   * revision detached. Refusals are DATA (`{ noOp, reason }`), never thrown.
   */
  sendBatch: protectedProcedure
    .input(
      z.object({
        runId: z.string().min(1),
        atype: feedbackAtypeSchema,
        sourceRef: z.string().min(1),
      }),
    )
    .mutation(async ({ input, ctx }): Promise<SendFeedbackResult> => {
      const db = requireDb(ctx.db, 'sendBatch');
      return sendFeedbackHandler(
        { runId: input.runId, atype: input.atype, sourceRef: input.sourceRef },
        {
          db,
          feedbackRouter: FeedbackRouter.getInstance(),
          launchRevision: getRevisionLauncher(),
        },
      );
    }),

  /** Project-scoped feedback change stream (comment + batch lifecycle). */
  onFeedbackChanged: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .subscription(async function* ({ input, signal }): AsyncGenerator<FeedbackChangedEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<FeedbackChangedEvent>(
        feedbackEvents,
        feedbackProjectChannel(input.projectId),
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),
});
