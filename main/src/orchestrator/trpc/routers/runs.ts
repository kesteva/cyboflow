/**
 * cyboflow.runs sub-router.
 *
 * All procedure bodies are deliberate not-implemented placeholders.
 * They will be filled in during the workflow-runs epic — grep for
 * `throwNotImplemented` to find every remaining stub.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { z } from 'zod';
import { router, protectedProcedure, throwNotImplemented } from '../trpc';

export const runsRouter = router({
  /** List workflow runs, optionally filtered by project. */
  list: protectedProcedure
    .input(z.object({ projectId: z.string().optional() }))
    .query(() => throwNotImplemented('workflow-runs')),

  /** Start a new workflow run for the given workflow and project. */
  start: protectedProcedure
    .input(z.object({ workflowId: z.string(), projectId: z.string() }))
    .mutation(() => throwNotImplemented('workflow-runs')),

  /** Cancel a running workflow run by ID. */
  cancel: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .mutation(() => throwNotImplemented('workflow-runs')),

  /** Get a single workflow run by ID. */
  get: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(() => throwNotImplemented('workflow-runs')),
});
