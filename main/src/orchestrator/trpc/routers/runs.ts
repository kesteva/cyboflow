/**
 * cyboflow.runs sub-router.
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

export const runsRouter = router({
  /** List workflow runs, optionally filtered by project. */
  list: protectedProcedure
    .input(z.object({ projectId: z.string().optional() }))
    .query(() => {
      throw new TRPCError({ code: 'NOT_IMPLEMENTED', message: NOT_IMPLEMENTED_MSG });
    }),

  /** Start a new workflow run for the given workflow and project. */
  start: protectedProcedure
    .input(z.object({ workflowId: z.string(), projectId: z.string() }))
    .mutation(() => {
      throw new TRPCError({ code: 'NOT_IMPLEMENTED', message: NOT_IMPLEMENTED_MSG });
    }),

  /** Cancel a running workflow run by ID. */
  cancel: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(() => {
      throw new TRPCError({ code: 'NOT_IMPLEMENTED', message: NOT_IMPLEMENTED_MSG });
    }),

  /** Get a single workflow run by ID. */
  get: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(() => {
      throw new TRPCError({ code: 'NOT_IMPLEMENTED', message: NOT_IMPLEMENTED_MSG });
    }),
});
