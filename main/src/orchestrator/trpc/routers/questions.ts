/**
 * cyboflow.questions sub-router.
 *
 * Provides the typed tRPC contract for the renderer's question-queue UI:
 *   - listPending        : query    → Question[] (reads questions JOIN workflow_runs JOIN workflows)
 *   - answer             : mutation → { success: true } (resolves in-process QuestionRouter promise)
 *   - onQuestionCreated  : subscription → QuestionCreatedEvent
 *   - onQuestionAnswered : subscription → QuestionAnsweredEvent
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import type { Question, QuestionCreatedEvent, QuestionAnsweredEvent } from '../../../../../shared/types/questions';
import { QuestionRouter, QuestionNotFoundError } from '../../questionRouter';
import { selectPendingQuestions } from '../../questionListing';
import { questionEvents, eventToAsyncIterable } from './events';

export const questionsRouter = router({
  /**
   * List all pending questions across all runs.
   *
   * Delegates to selectPendingQuestions from questionListing.ts.
   * Returns Question[] ordered oldest-first (created_at ASC).
   */
  listPending: protectedProcedure
    .query(async ({ ctx }): Promise<Question[]> => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: '[questions.listPending] db not wired into tRPC context',
        });
      }
      return selectPendingQuestions(ctx.db);
    }),

  /**
   * Submit the user's answer for an in-flight question.
   *
   * Delegates to QuestionRouter.getInstance().respond() which:
   *  1. Resolves the in-process answerPromise (unblocks the SDK PreToolUse hook).
   *  2. Updates the DB row (questions.status → 'answered').
   *  3. Updates workflow_runs.status → 'running'.
   *
   * Maps QuestionNotFoundError → TRPCError code:'NOT_FOUND'.
   */
  answer: protectedProcedure
    .input(z.object({
      questionId: z.string(),
      answers: z.record(
        z.string(),
        z.union([z.string(), z.array(z.string())]),
      ),
      /**
       * Absolute file paths of images the user attached when answering (already
       * saved to disk via `sessions:save-images` in the renderer). Folded into
       * the answer text by QuestionRouter.respond via the `<attachments>`
       * convention. Optional — absent when no image was attached.
       */
      attachments: z.array(z.string()).optional(),
    }))
    .mutation(async ({ input }): Promise<{ success: true }> => {
      try {
        // QuestionAnswer.answers is Record<string, string>; the Zod union allows
        // arrays for multi-select UI convenience but we join them to a single
        // comma-delimited string before handing to QuestionRouter.
        const normalizedAnswers: Record<string, string> = {};
        for (const [key, value] of Object.entries(input.answers)) {
          normalizedAnswers[key] = Array.isArray(value) ? value.join(', ') : value;
        }
        await QuestionRouter.getInstance().respond(input.questionId, {
          answers: normalizedAnswers,
          ...(input.attachments && input.attachments.length > 0
            ? { attachments: input.attachments }
            : {}),
        });
        return { success: true };
      } catch (err) {
        if (err instanceof QuestionNotFoundError) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `Question ${input.questionId} is not pending or does not exist`,
          });
        }
        throw err;
      }
    }),

  /**
   * Subscribe to question-created notifications (all runs).
   *
   * Backed by the module-level `questionEvents` EventEmitter in events.ts.
   * The bridge in main/src/index.ts emits on this emitter when a question gate
   * is opened via QuestionRouter.requestQuestion().
   */
  onQuestionCreated: protectedProcedure
    .subscription(async function* ({ signal }): AsyncGenerator<QuestionCreatedEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<QuestionCreatedEvent>(
        questionEvents,
        'created',
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),

  /**
   * Subscribe to question-answered notifications (all runs).
   *
   * Emitted when a question gate is answered or times out.
   * The store removes the item from the queue on receipt.
   */
  onQuestionAnswered: protectedProcedure
    .subscription(async function* ({ signal }): AsyncGenerator<QuestionAnsweredEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<QuestionAnsweredEvent>(
        questionEvents,
        'answered',
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),
});
