/**
 * tRPC initialisation and procedure factory exports.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import type { Context } from './context';

const t = initTRPC.context<Context>().create({ transformer: superjson });

/** Create a tRPC router. */
export const router = t.router;

/** Procedure callable by any client — no auth assertion. */
export const publicProcedure = t.procedure;

/**
 * Middleware that asserts `ctx.userId` is defined.
 *
 * In v1 `userId` is always `'local'`, so this never throws; the check exists
 * so that the v2 session-token swap only needs to update `createContext()` —
 * all protected procedures automatically gain real auth enforcement.
 */
const isAuthed = t.middleware(({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return next({ ctx: { userId: ctx.userId } });
});

/** Procedure that requires an authenticated session (userId defined). */
export const protectedProcedure = t.procedure.use(isAuthed);
