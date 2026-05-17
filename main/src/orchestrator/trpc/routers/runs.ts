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
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, throwNotImplemented } from '../trpc';
import type { StuckInspectionResult } from '../../../../../shared/types/stuckInspection';

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

  /**
   * Return diagnostic data for a stuck run: stuck reason, pending approval
   * payload, and the latest 10 raw_events rows.
   *
   * Principal scoping: v1 uses userId === 'local' for all runs. The guard
   * is structurally present for forward compatibility when the v2 team-tier
   * swap introduces real per-user scoping.
   *
   * Implementation note: ctx.db is not yet wired into the tRPC context
   * (pending approval-router epic). The handler function
   * `getStuckInspectionHandler` in main/src/trpc/routers/runs.ts is
   * directly testable without the tRPC wrapper; the procedure stub throws
   * NOT_IMPLEMENTED until ctx.db is wired.
   *
   * TODO(workflow-runs epic): replace stub with:
   *   if (ctx.principal.userId !== 'local') {
   *     throw new TRPCError({ code: 'FORBIDDEN' });
   *   }
   *   const result = getStuckInspectionHandler(ctx.db, input.runId);
   *   if (!result) throw new TRPCError({ code: 'NOT_FOUND' });
   *   return result;
   */
  getStuckInspection: protectedProcedure
    .input(z.object({ runId: z.string() }))
    .query(async ({ ctx, input }): Promise<StuckInspectionResult> => {
      // Principal scoping — structurally present for v2 forward-compat.
      // In v1, ctx.userId is always 'local', matching the implicit run ownership.
      if (ctx.userId !== 'local') {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      // DB not yet wired into tRPC context (approval-router epic).
      // Throw NOT_IMPLEMENTED so the modal surfaces a visible error rather than
      // silently returning empty data.
      void input; // consumed once DB is wired
      throw new TRPCError({
        code: 'NOT_IMPLEMENTED',
        message: `getStuckInspection is not wired yet (workflow-runs epic). runId=${input.runId}`,
      });
    }),
});
