/**
 * cyboflow.workflows sub-router.
 *
 * Implements list/get (read) and getDefinition/updateSpec/resetSpec/createCustom
 * (blueprint-editor) procedures backed by WorkflowRegistry.
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
import { workflowDefinitionSchema } from '../../workflowDefinitionSchema';
import { resolveWorkflowDefinition } from '../../../../../shared/types/workflows';
import type { WorkflowRow, WorkflowDefinition } from '../../../../../shared/types/workflows';

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

  /**
   * Resolve the effective `WorkflowDefinition` for a workflow (the graph the
   * editor seeds from and the canvas renders).
   *
   * Resolution order is `resolveWorkflowDefinition`: a valid non-empty
   * `spec_json` wins, else the built-in fallback for a `SoloFlowWorkflowName`,
   * else null. NOT_FOUND when the row is missing OR resolution is null (a
   * custom flow whose spec is missing/broken).
   */
  getDefinition: protectedProcedure
    .input(z.object({ workflowId: z.string().min(1) }))
    .query(async ({ ctx, input }): Promise<WorkflowDefinition> => {
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
      const definition = resolveWorkflowDefinition(row.name, row.spec_json);
      if (definition === null) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `No workflow definition for workflow ${input.workflowId} (name '${row.name}')`,
        });
      }
      return definition;
    }),

  /**
   * Persist an edited definition onto the workflow's `spec_json` ("Save").
   *
   * The `workflowDefinitionSchema` runs as `.input()`, so a malformed
   * definition is rejected as BAD_REQUEST by tRPC before the body runs. A
   * missing workflow row maps to NOT_FOUND.
   */
  updateSpec: protectedProcedure
    .input(z.object({ workflowId: z.string().min(1), definition: workflowDefinitionSchema }))
    .mutation(async ({ ctx, input }): Promise<{ ok: true }> => {
      if (!ctx.workflowRegistry) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'workflowRegistry not wired into tRPC context',
        });
      }
      try {
        ctx.workflowRegistry.updateSpec(input.workflowId, input.definition);
      } catch (err) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return { ok: true };
    }),

  /**
   * Reset a built-in workflow's spec back to its static default ("Reset to
   * default"). BAD_REQUEST when the target is a custom flow (no built-in
   * fallback), NOT_FOUND when the row is missing.
   */
  resetSpec: protectedProcedure
    .input(z.object({ workflowId: z.string().min(1) }))
    .mutation(async ({ ctx, input }): Promise<{ ok: true }> => {
      if (!ctx.workflowRegistry) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'workflowRegistry not wired into tRPC context',
        });
      }
      try {
        ctx.workflowRegistry.resetSpec(input.workflowId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = message.includes('not found') ? 'NOT_FOUND' : 'BAD_REQUEST';
        throw new TRPCError({ code, message });
      }
      return { ok: true };
    }),

  /**
   * Create a brand-new custom workflow from an edited definition ("Save as new
   * flow"). The `workflowDefinitionSchema` validates `definition` as `.input()`
   * (BAD_REQUEST on failure); a name collision maps to CONFLICT.
   */
  createCustom: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        name: z.string().min(1),
        definition: workflowDefinitionSchema,
        permissionMode: z.enum(['default', 'acceptEdits', 'dontAsk']).optional(),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<WorkflowRow> => {
      if (!ctx.workflowRegistry) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'workflowRegistry not wired into tRPC context',
        });
      }
      try {
        return ctx.workflowRegistry.createCustom(
          input.projectId,
          input.name,
          input.definition,
          input.permissionMode ?? 'default',
        );
      } catch (err) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
});
