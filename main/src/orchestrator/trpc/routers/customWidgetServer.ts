/**
 * cyboflow.customWidgetServer sub-router — the renderer's typed contract for
 * the Custom Views tier-3 widget document server
 * (docs/proposals/CUSTOM-VIEWS.md §5.4, §9 row S3).
 *
 * A SINGLE process-global server (unlike Design Mode's per-run
 * `designPrototypeServer`), so both procedures take no input: `ensure`
 * spins it up (or returns the already-live one) and `stop` tears it down.
 * `main/src/ipc/__tests__/noNewIpcHandlers.test.ts` freezes the legacy
 * `ipcMain.handle` surface — this is why the plan's §5.4 sketch ("preload +
 * IPC mirroring designPrototypeServer") is a tRPC router here instead; the
 * renderer calls `trpc.cyboflow.customWidgetServer.ensure.mutate()` over the
 * existing electronTRPC link the same way every other `cyboflow.*` router is
 * consumed, no preload/electron.d.ts surface needed.
 *
 * Standalone-typecheck invariant: only the narrow `CustomWidgetServerLike`
 * seam is imported — never the concrete `CustomWidgetServerManager` or
 * `node:http`.
 */
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import type { Context } from '../context';
import type { CustomWidgetServerLike } from '../context';

function requireCustomWidgetServer(ctx: Context): CustomWidgetServerLike {
  if (!ctx.customWidgetServer) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: '[customWidgetServer] CustomWidgetServerManager not wired into tRPC context',
    });
  }
  return ctx.customWidgetServer;
}

export const customWidgetServerRouter = router({
  /** Spin up (or return the already-running) server. Idempotent. */
  ensure: protectedProcedure.mutation(async ({ ctx }): Promise<{ baseUrl: string; origin: string }> => {
    return requireCustomWidgetServer(ctx).ensure();
  }),

  /** Tear down the server. Idempotent — `stopped: false` when nothing was running. */
  stop: protectedProcedure.mutation(async ({ ctx }): Promise<{ stopped: boolean }> => {
    const stopped = await requireCustomWidgetServer(ctx).stop();
    return { stopped };
  }),
});
