/**
 * cyboflow.workflows sub-router.
 *
 * All procedure bodies are deliberate NOT_IMPLEMENTED placeholders.
 * They will be filled in during the workflow-runs epic.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';

const NOT_IMPLEMENTED_MSG = 'TODO: implemented in workflow-runs epic';

export const workflowsRouter = router({
  /** List all workflows for the current user. */
  list: protectedProcedure
    .query(() => {
      throw new TRPCError({ code: 'NOT_IMPLEMENTED', message: NOT_IMPLEMENTED_MSG });
    }),

  /** Get a single workflow by ID. */
  get: protectedProcedure
    .input(z.object({ workflowId: z.string() }))
    .query(() => {
      throw new TRPCError({ code: 'NOT_IMPLEMENTED', message: NOT_IMPLEMENTED_MSG });
    }),
});
