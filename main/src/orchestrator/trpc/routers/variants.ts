/**
 * cyboflow.variants sub-router (A/B testing, migration 048).
 *
 * CRUD over a workflow's named variants, backed by WorkflowRegistry's variant
 * lifecycle methods (mirroring the workflows router conventions). All
 * `protectedProcedure`, explicit return types, `workflowRegistry` off ctx.
 * Registry errors are mapped to TRPCError codes by their distinguishable message
 * substrings ('not found' / 'run history' / 'already exists' / reserved).
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { workflowDefinitionSchema } from '../../workflowDefinitionSchema';
import type { WorkflowVariantRow } from '../../../../../shared/types/experiments';

/**
 * A per-agent variant delta map: `{ [agentKey]: { systemPrompt?, model? } }`.
 * Both fields optional (a delta may touch only the prompt, only the model, or
 * both). Serialized to workflow_variants.agent_overrides_json by the registry.
 */
const variantAgentOverridesSchema = z.record(
  z.string().min(1),
  z.object({
    systemPrompt: z.string().optional(),
    model: z.string().optional(),
  }),
);

/** Map a registry Error to the appropriate TRPCError code by message substring. */
function mapRegistryError(err: unknown): TRPCError {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('not found')) {
    return new TRPCError({ code: 'NOT_FOUND', message });
  }
  if (message.includes('run history') || message.includes('already exists')) {
    return new TRPCError({ code: 'CONFLICT', message });
  }
  // reserved sentinel / unresolvable definition / non-empty label / bad weight.
  return new TRPCError({ code: 'BAD_REQUEST', message });
}

export const variantsRouter = router({
  /** List a workflow's variants (newest-first). */
  list: protectedProcedure
    .input(z.object({ workflowId: z.string().min(1) }))
    .query(async ({ ctx, input }): Promise<WorkflowVariantRow[]> => {
      if (!ctx.workflowRegistry) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'workflowRegistry not wired into tRPC context',
        });
      }
      return ctx.workflowRegistry.listVariants(input.workflowId);
    }),

  /**
   * Create a variant snapshotting the workflow's current resolved definition
   * ("Create variant from current"). Seeds status='draft'. CONFLICT on a label
   * collision; BAD_REQUEST on an unresolvable/reserved workflow; NOT_FOUND when
   * the workflow is missing.
   */
  create: protectedProcedure
    .input(z.object({ workflowId: z.string().min(1), label: z.string().min(1) }))
    .mutation(async ({ ctx, input }): Promise<WorkflowVariantRow> => {
      if (!ctx.workflowRegistry) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'workflowRegistry not wired into tRPC context',
        });
      }
      try {
        return ctx.workflowRegistry.createVariantFromCurrent(input.workflowId, input.label);
      } catch (err) {
        throw mapRegistryError(err);
      }
    }),

  /**
   * Patch a variant in place (re-snapshot). `definition` is validated by the
   * strict write-path schema and serialized to spec_json; `agentOverrides` is
   * serialized to agent_overrides_json (null clears it). Past runs are unaffected
   * (each froze its own spec_hash). NOT_FOUND when the variant is missing.
   */
  update: protectedProcedure
    .input(
      z.object({
        variantId: z.string().min(1),
        definition: workflowDefinitionSchema.optional(),
        agentOverrides: variantAgentOverridesSchema.nullable().optional(),
        model: z.string().min(1).nullable().optional(),
        executionModel: z.enum(['orchestrated', 'programmatic']).nullable().optional(),
        weight: z.number().int().min(0).optional(),
        label: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<{ ok: true }> => {
      if (!ctx.workflowRegistry) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'workflowRegistry not wired into tRPC context',
        });
      }
      try {
        ctx.workflowRegistry.updateVariant(input.variantId, {
          ...(input.definition !== undefined ? { specJson: JSON.stringify(input.definition) } : {}),
          ...(input.agentOverrides !== undefined
            ? { agentOverridesJson: input.agentOverrides === null ? null : JSON.stringify(input.agentOverrides) }
            : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.executionModel !== undefined ? { executionModel: input.executionModel } : {}),
          ...(input.weight !== undefined ? { weight: input.weight } : {}),
          ...(input.label !== undefined ? { label: input.label } : {}),
        });
      } catch (err) {
        throw mapRegistryError(err);
      }
      return { ok: true };
    }),

  /** Transition a variant's rotation status. NOT_FOUND when the variant is missing. */
  setStatus: protectedProcedure
    .input(
      z.object({
        variantId: z.string().min(1),
        status: z.enum(['draft', 'active', 'paused', 'retired']),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<{ ok: true }> => {
      if (!ctx.workflowRegistry) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'workflowRegistry not wired into tRPC context',
        });
      }
      try {
        ctx.workflowRegistry.setVariantStatus(input.variantId, input.status);
      } catch (err) {
        throw mapRegistryError(err);
      }
      return { ok: true };
    }),

  /**
   * Delete a variant. CONFLICT when workflow_runs reference it (retire instead);
   * NOT_FOUND when the variant is missing.
   */
  delete: protectedProcedure
    .input(z.object({ variantId: z.string().min(1) }))
    .mutation(async ({ ctx, input }): Promise<{ ok: true }> => {
      if (!ctx.workflowRegistry) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'workflowRegistry not wired into tRPC context',
        });
      }
      try {
        ctx.workflowRegistry.deleteVariant(input.variantId);
      } catch (err) {
        throw mapRegistryError(err);
      }
      return { ok: true };
    }),

  /**
   * Read a workflow's BASELINE rotation participation (migration 054). The baseline
   * is the workflow's live definition; when in rotation it competes with active
   * variants (weight = its share). NOT_FOUND when the workflow is missing.
   */
  getBaselineRotation: protectedProcedure
    .input(z.object({ workflowId: z.string().min(1) }))
    .query(async ({ ctx, input }): Promise<{ inRotation: boolean; weight: number }> => {
      if (!ctx.workflowRegistry) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'workflowRegistry not wired into tRPC context',
        });
      }
      const row = ctx.workflowRegistry.getBaselineRotation(input.workflowId);
      if (row === null) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `workflow ${input.workflowId} not found` });
      }
      return row;
    }),

  /**
   * Patch a workflow's BASELINE rotation participation (migration 054): opt the live
   * baseline into/out of rotation (`inRotation`) and/or set its rotation `weight`.
   * NOT_FOUND when the workflow is missing; BAD_REQUEST on a negative weight.
   */
  setBaselineRotation: protectedProcedure
    .input(
      z.object({
        workflowId: z.string().min(1),
        inRotation: z.boolean().optional(),
        weight: z.number().int().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<{ ok: true }> => {
      if (!ctx.workflowRegistry) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'workflowRegistry not wired into tRPC context',
        });
      }
      try {
        ctx.workflowRegistry.setBaselineRotation(input.workflowId, {
          ...(input.inRotation !== undefined ? { inRotation: input.inRotation } : {}),
          ...(input.weight !== undefined ? { weight: input.weight } : {}),
        });
      } catch (err) {
        throw mapRegistryError(err);
      }
      return { ok: true };
    }),
});
