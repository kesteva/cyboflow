/**
 * cyboflow.workflows sub-router.
 *
 * Implements list and get procedures backed by WorkflowRegistry.
 * Auto-seeds the 5 default SoloFlow workflows when a project has none.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { z } from 'zod';
import * as os from 'os';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { buildDefaultSoloFlowWorkflows, resolveSoloFlowPluginRoot } from '../../workflowRegistry';
import type { WorkflowRow } from '../../../../../shared/types/workflows';

export const workflowsRouter = router({
  /** List all workflows for a project, auto-seeding defaults when none exist. */
  list: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .query(async ({ ctx, input }): Promise<WorkflowRow[]> => {
      if (!ctx.workflowRegistry) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'workflowRegistry not wired into tRPC context',
        });
      }
      let workflows = ctx.workflowRegistry.listByProject(input.projectId);
      if (workflows.length === 0) {
        const { root: pluginRoot } = resolveSoloFlowPluginRoot(os.homedir());
        const descriptors = buildDefaultSoloFlowWorkflows(pluginRoot);
        ctx.workflowRegistry.seed(input.projectId, descriptors);
        workflows = ctx.workflowRegistry.listByProject(input.projectId);
      }
      return workflows;
    }),

  /** Get a single workflow by ID. */
  get: protectedProcedure
    .input(z.object({ workflowId: z.string().min(1) }))
    .query(async ({ ctx, input }): Promise<WorkflowRow> => {
      if (!ctx.workflowRegistry) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'workflowRegistry not wired into tRPC context',
        });
      }
      const row = ctx.workflowRegistry.getById(input.workflowId);
      if (!row) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Workflow ${input.workflowId} not found`,
        });
      }
      return row;
    }),
});
