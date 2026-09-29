/**
 * cyboflow.config sub-router — app-wide configuration (config.json).
 *
 * PILOT slice of the IPC→tRPC migration (docs/CODE-PATTERNS.md): the 5
 * legacy `config:*` ipcMain.handle channels moved here verbatim, with zod
 * input validation at the boundary and the business logic delegated to
 * {@link ConfigOpsLike} (ctx.configOps, injected from main/src/index.ts via
 * createConfigOps). Member-level normalization (agentProviderAccess floors,
 * sprintMaxTasks clamping) happens inside the ops impl — that is business
 * normalization carried over from the legacy handler, not boundary
 * validation, so it is not duplicated here.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import type { AppConfig, UpdateConfigRequest } from '../../../types/config';
import type { RunTypeDefaults } from '../../../../../shared/types/sessionDefaults';
import { ALL_AGENT_RUNTIMES } from '../../../../../shared/types/agentRuntime';
import { ALL_EFFORT_LEVELS } from '../../../../../shared/types/reasoningEffort';
import { PERMISSION_MODES } from '../../../../../shared/types/workflows';
import type { ConfigOpsResult, SessionCreationPreferences } from '../contracts/configOps';

const runTypeDefaultsFields = {
  // trim().min(1): a whitespace-only or empty model string still passes a
  // bare `z.string()`, and getDefaultLaunchModel resolves via `stored?.model
  // ?? globals?.model ?? floor` — an empty string is neither null (delete)
  // nor undefined (fall through), so it suppresses the floor and can produce
  // an invalid launch model with no error anywhere.
  model: z.string().trim().min(1).optional().nullable(),
  permissionMode: z.enum(PERMISSION_MODES).optional().nullable(),
  substrate: z.enum(['sdk', 'interactive']).optional().nullable(),
  // The persisted run-type default is not scoped to one launch kind, so it
  // validates against the FULL runtime union; each launch surface re-narrows to
  // its own set.
  agentRuntime: z.enum(ALL_AGENT_RUNTIMES).optional().nullable(),
  reasoningEffort: z.enum(ALL_EFFORT_LEVELS).optional().nullable(),
};

const runTypeDefaultsOpSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('merge'),
    value: z.object(runTypeDefaultsFields).strict(),
  }),
  z.object({
    kind: z.literal('replace'),
    value: z.object({
      ...runTypeDefaultsFields,
      model: z.string().trim().min(1).optional(),
      permissionMode: z.enum(PERMISSION_MODES).optional(),
      substrate: z.enum(['sdk', 'interactive']).optional(),
      agentRuntime: z.enum(ALL_AGENT_RUNTIMES).optional(),
      reasoningEffort: z.enum(ALL_EFFORT_LEVELS).optional(),
    }).strict().nullable(),
  }),
]);

export const configRouter = router({
  get: protectedProcedure.query(async ({ ctx }): Promise<ConfigOpsResult<AppConfig>> => {
    if (!ctx.configOps) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'configOps not wired into tRPC context',
      });
    }
    return ctx.configOps.getConfig();
  }),

  update: protectedProcedure
    // Member-level validation/normalization (agentProviderAccess,
    // sprintMaxTasks) happens in the ops impl, moved verbatim from the
    // legacy handler — this only asserts the payload is a plain object.
    .input(z.custom<UpdateConfigRequest>((v) => typeof v === 'object' && v !== null && !Array.isArray(v)))
    .mutation(async ({ ctx, input }): Promise<ConfigOpsResult> => {
      if (!ctx.configOps) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'configOps not wired into tRPC context',
        });
      }
      return ctx.configOps.updateConfig(input);
    }),

  applyRunTypeDefault: protectedProcedure
    // trim().min(1): a whitespace-only key passes a bare min(1) (its length is
    // still >= 1) and would persist as a run-type-defaults entry no launch
    // surface's runTypeKindForKey/`workflow:` parsing can ever resolve back to.
    .input(z.object({ key: z.string().trim().min(1), op: runTypeDefaultsOpSchema }))
    .mutation(async ({
      ctx,
      input,
    }): Promise<ConfigOpsResult<{ previous: RunTypeDefaults | undefined; config: AppConfig }>> => {
      if (!ctx.configOps) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'configOps not wired into tRPC context',
        });
      }
      return ctx.configOps.applyRunTypeDefault(input.key, input.op);
    }),

  getSessionPreferences: protectedProcedure.query(
    async ({ ctx }): Promise<ConfigOpsResult<SessionCreationPreferences>> => {
      if (!ctx.configOps) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'configOps not wired into tRPC context',
        });
      }
      return ctx.configOps.getSessionPreferences();
    },
  ),

  updateSessionPreferences: protectedProcedure
    // Same treatment as `update`: shape-only assertion here, member handling
    // in the ops impl.
    .input(z.custom<SessionCreationPreferences>((v) => typeof v === 'object' && v !== null && !Array.isArray(v)))
    .mutation(async ({ ctx, input }): Promise<ConfigOpsResult> => {
      if (!ctx.configOps) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'configOps not wired into tRPC context',
        });
      }
      return ctx.configOps.updateSessionPreferences(input);
    }),
});
