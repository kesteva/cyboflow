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
   * per-run request. Mirrors the inputs WorkflowRegistry.createRun threads into
   * resolveSubstrate today (requestedSubstrate + env); the remaining ladder
   * levels resolve from env + the 'sdk' floor, so this query stays a faithful
   * preview of the stamped value.
   */
  resolveEffective: protectedProcedure
    .input(z.object({ requestedSubstrate: z.enum(['sdk', 'interactive']).optional() }))
    .query(({ input }): { substrate: CliSubstrate } => {
      const substrate = resolveSubstrate({
        requestedSubstrate: input.requestedSubstrate,
        env: process.env,
      });
      return { substrate };
    }),
});
