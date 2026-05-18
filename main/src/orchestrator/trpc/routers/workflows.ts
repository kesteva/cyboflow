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
    // STUB — raw-IPC equivalent (cyboflow:listWorkflows) in main/src/ipc/cyboflow.ts is the live surface. TBD-tRPC-cutover migration replaces this stub.
    .query(() => throwNotImplemented('workflow-runs')),

  /** Get a single workflow by ID. */
  get: protectedProcedure
    .input(z.object({ workflowId: z.string() }))
    // STUB — raw-IPC equivalent (cyboflow:listWorkflows) in main/src/ipc/cyboflow.ts is the live surface. TBD-tRPC-cutover migration replaces this stub.
    .query(() => throwNotImplemented('workflow-runs')),
});
