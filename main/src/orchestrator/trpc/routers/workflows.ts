/**
 * cyboflow.workflows sub-router.
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

export const workflowsRouter = router({
  /** List all workflows for the current user. */
  list: protectedProcedure
    .query(() => throwNotImplemented('workflow-runs')),

  /** Get a single workflow by ID. */
  get: protectedProcedure
    .input(z.object({ workflowId: z.string() }))
    .query(() => throwNotImplemented('workflow-runs')),
});
