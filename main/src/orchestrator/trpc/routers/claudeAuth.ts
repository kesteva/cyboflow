/**
 * cyboflow.claudeAuth sub-router — the in-app Claude sign-in
 * (shared/types/claudeAuth.ts). Zod validates the input at the boundary; the
 * business logic is {@link ClaudeAuthOpsLike} (ctx.claudeAuthOps, injected
 * from main/src/index.ts via createClaudeAuthOps).
 *
 * The authorization code is a short-lived, single-use OAuth code the user
 * pastes from the browser; it crosses this boundary once, straight into the
 * CLI's stdin, and is never logged or persisted (see ClaudeAuthLoginService).
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import type { ClaudeAuthAccount, ClaudeLoginState } from '../../../../../shared/types/claudeAuth';
import type { ClaudeAuthOpsLike } from '../contracts/claudeAuthOps';

function requireOps(ops: ClaudeAuthOpsLike | undefined): ClaudeAuthOpsLike {
  if (!ops) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'claudeAuthOps not wired into tRPC context',
    });
  }
  return ops;
}

export const claudeAuthRouter = router({
  /** cyboflow.claudeAuth.account — a fresh `claude auth status` probe. */
  account: protectedProcedure.query(async ({ ctx }): Promise<ClaudeAuthAccount | null> => {
    return requireOps(ctx.claudeAuthOps).probeAccount();
  }),

  /** cyboflow.claudeAuth.loginState — polled by the sign-in dialog. */
  loginState: protectedProcedure.query(({ ctx }): ClaudeLoginState => {
    return requireOps(ctx.claudeAuthOps).getLoginState();
  }),

  startLogin: protectedProcedure.mutation(({ ctx }): ClaudeLoginState => {
    return requireOps(ctx.claudeAuthOps).startLogin();
  }),

  submitLoginCode: protectedProcedure
    .input(z.object({ code: z.string().min(1).max(4096) }))
    .mutation(({ ctx, input }): ClaudeLoginState => {
      return requireOps(ctx.claudeAuthOps).submitLoginCode(input.code);
    }),

  cancelLogin: protectedProcedure.mutation(({ ctx }): ClaudeLoginState => {
    return requireOps(ctx.claudeAuthOps).cancelLogin();
  }),
});
