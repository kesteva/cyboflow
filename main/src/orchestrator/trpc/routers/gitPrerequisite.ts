/**
 * cyboflow.gitPrerequisite sub-router — the onboarding git probe and the
 * identity writer (shared/types/gitPrerequisite.ts). Zod validates the input
 * at the boundary; the business logic is {@link GitPrerequisiteOpsLike}
 * (ctx.gitPrerequisiteOps, injected from main/src/index.ts via
 * createGitPrerequisiteOps). Envelope passthrough is total.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import type { GitPrerequisiteResult } from '../../../../../shared/types/gitPrerequisite';
import type { GitIdentityWriteResult, GitPrerequisiteOpsLike } from '../contracts/gitPrerequisiteOps';

function requireOps(ops: GitPrerequisiteOpsLike | undefined): GitPrerequisiteOpsLike {
  if (!ops) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'gitPrerequisiteOps not wired into tRPC context',
    });
  }
  return ops;
}

export const gitPrerequisiteRouter = router({
  /**
   * cyboflow.gitPrerequisite.detect — `refresh: true` drops the memoized shell
   * PATH + git resolution first (the "Check again" after an install).
   */
  detect: protectedProcedure
    .input(z.object({ refresh: z.boolean() }))
    .query(async ({ ctx, input }): Promise<GitPrerequisiteResult> => {
      return requireOps(ctx.gitPrerequisiteOps).detect(input);
    }),

  /** cyboflow.gitPrerequisite.setIdentity — the ops impl trims + sanity-checks the fields. */
  setIdentity: protectedProcedure
    .input(z.object({ name: z.string(), email: z.string() }))
    .mutation(async ({ ctx, input }): Promise<GitIdentityWriteResult> => {
      return requireOps(ctx.gitPrerequisiteOps).setIdentity(input);
    }),
});
