/**
 * cyboflow.substrates sub-router (feat/parallel-sprint, P3).
 *
 * Exposes the effective substrate the resolver ladder would pick for a launch,
 * so the batch picker can apply the right selection cap N (15 for sdk, 10 for
 * interactive) BEFORE creating a batch — matching exactly what
 * WorkflowRegistry.createRun would stamp.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*. resolveSubstrate is a pure function over its inputs.
 */
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { resolveSubstrate } from '../../substrateResolver';
import type { CliSubstrate } from '../../../../../shared/types/substrate';

export const substratesRouter = router({
  /**
   * Resolve the substrate the launch path would actually use given an optional
   * per-run request. Mirrors what WorkflowRegistry.createRun stamps:
   *   1. The forced pin (ctx.getForcedSubstrate) outranks everything — demo mode
   *      ('sdk') or the global interactive-PTY-only lock ('interactive'). Applied
   *      here so the batch-cap preview stays truthful under a lock.
   *   2. Otherwise the resolver ladder (requestedSubstrate + env + the 'sdk'
   *      floor); the remaining ladder levels are not threaded today, so this
   *      stays a faithful preview of the stamped value.
   */
  resolveEffective: protectedProcedure
    .input(z.object({ requestedSubstrate: z.enum(['sdk', 'interactive']).optional() }))
    .query(({ input, ctx }): { substrate: CliSubstrate } => {
      const forced = ctx.getForcedSubstrate?.() ?? null;
      const substrate =
        forced ??
        resolveSubstrate({
          requestedSubstrate: input.requestedSubstrate,
          env: process.env,
        });
      return { substrate };
    }),
});
