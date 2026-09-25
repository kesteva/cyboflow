/**
 * cyboflow.sessions sub-router — the session-record surface: the sidebar's
 * session reads, the quick-session status board, the per-session summary read,
 * the statistics poll behind the session meter, the archive-progress poll, and
 * the small mutations the sidebar and composer pills drive (rename, favourite,
 * permission mode, per-session MCP/plugin toggles, reorder, active-session
 * selection).
 *
 * Batch 1 of the session-surface IPC→tRPC migration (docs/CODE-PATTERNS.md),
 * following the `config` PILOT, `workspaceFiles` and `sessionGit` slices
 * exactly: 15 migrated `sessions:*` / `archive:*` ipcMain.handle channels
 * (main/src/ipc/session.ts) moved here, with zod input validation at the
 * boundary and the business logic delegated to the SessionOpsLike contract
 * (ctx.sessionOps, injected from main/src/index.ts via createSessionOps).
 * `debug:get-table-structure` was NOT migrated — it was deleted outright, since
 * it had zero preload/frontend callers, exactly as `file:getPath` and
 * `sessions:check-rebase-conflicts` were in the earlier slices.
 * DatabaseService.getTableStructure itself is untouched.
 *
 * The session LIFECYCLE channels (create / create-quick / delete / input /
 * stop / continue / conversation + output reads / interactive resume /
 * attachments, and every `panels:*` channel) stay legacy in this batch and are
 * still registered by registerSessionHandlers.
 *
 * Multi-arg legacy channels became single input OBJECTS (`{ sessionId, mode }`
 * rather than positional args), which is why the ops contract takes a request
 * object per method.
 *
 * Envelope passthrough is total: this router never re-shapes what the ops layer
 * returns. One mutation extends that to its VALIDATION failure:
 * `updateAgentPermissionMode` takes `mode: z.string()` here precisely so the
 * `isPermissionMode` check can stay in the ops body and keep answering the
 * legacy `{ success: false, error: 'Invalid agent permission mode: …' }`
 * envelope. The two array mutations (`updateSessionMcps` /
 * `updateSessionPlugins`) do NOT share that quirk: their `z.array(z.string())`
 * schemas reject a malformed payload with a thrown BAD_REQUEST before ops is
 * ever reached — a deliberate tightening over the legacy channels (no typed
 * renderer caller can produce one), with the ops-body guards retained as
 * defense-in-depth for direct ops callers only. See the contract for the rest.
 *
 * `getSummary` and `listQuick` are QUERIES even though each has a
 * fire-and-forget side effect (the lazy summarizer catch-up kick and the
 * throttled git-cache warm respectively): both are semantically reads, and both
 * side effects are ones the legacy handlers always had.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import type {
  ArchiveProgressPayload,
  ProjectWithSessions,
  RenamedSessionRow,
  SessionOpsError,
  SessionStatisticsPayload,
} from '../contracts/sessionOps';
import type { Session } from '../../../types/session';
import type { QuickSessionRow } from '../../../../../shared/types/quickSessions';
import type { SessionSummaryPayload } from '../../../../../shared/types/sessionSummary';

function requireOps<T>(ops: T | undefined): T {
  if (!ops) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'sessionOps not wired into tRPC context',
    });
  }
  return ops;
}

/** The input shape of every procedure keyed by a single session id. */
const sessionInput = z.object({ sessionId: z.string().min(1) });

export const sessionsRouter = router({
  getAll: protectedProcedure.query(
    async ({ ctx }): Promise<{ success: true; data: Session[] } | SessionOpsError> => {
      return requireOps(ctx.sessionOps).getAll();
    },
  ),

  get: protectedProcedure
    .input(sessionInput)
    .query(async ({ ctx, input }): Promise<{ success: true; data: Session } | SessionOpsError> => {
      return requireOps(ctx.sessionOps).get(input);
    }),

  getAllWithProjects: protectedProcedure.query(
    async ({ ctx }): Promise<{ success: true; data: ProjectWithSessions[] } | SessionOpsError> => {
      return requireOps(ctx.sessionOps).getAllWithProjects();
    },
  ),

  getSummary: protectedProcedure
    // The legacy channel took `(sessionId, opts?: { catchUp?: boolean })`;
    // flattened here. The default (true) deliberately lives in the ops impl,
    // not in the schema — it is the legacy handler's own default and moved with
    // the body.
    .input(z.object({ sessionId: z.string().min(1), catchUp: z.boolean().optional() }))
    .query(async ({ ctx, input }): Promise<{ success: true; data: SessionSummaryPayload } | SessionOpsError> => {
      return requireOps(ctx.sessionOps).getSummary(input);
    }),

  listQuick: protectedProcedure
    .input(z.object({ projectId: z.number().int().optional() }))
    .query(async ({ ctx, input }): Promise<{ success: true; data: QuickSessionRow[] } | SessionOpsError> => {
      return requireOps(ctx.sessionOps).listQuick(input);
    }),

  getStatistics: protectedProcedure
    // TASK-278: baseRef is the caller's persisted BaseSelector selection
    // (optional — absent preserves the pre-TASK-278 branch-point-only
    // behavior). Its own schema, not the shared `sessionInput`, since no
    // other procedure on this router takes it.
    .input(sessionInput.extend({ baseRef: z.string().optional() }))
    .query(async ({ ctx, input }): Promise<{ success: true; data: SessionStatisticsPayload } | SessionOpsError> => {
      return requireOps(ctx.sessionOps).getStatistics(input);
    }),

  getArchiveProgress: protectedProcedure.query(
    async ({ ctx }): Promise<{ success: true; data: ArchiveProgressPayload } | SessionOpsError> => {
      return requireOps(ctx.sessionOps).getArchiveProgress();
    },
  ),

  markViewed: protectedProcedure
    .input(sessionInput)
    .mutation(async ({ ctx, input }): Promise<{ success: true } | SessionOpsError> => {
      return requireOps(ctx.sessionOps).markViewed(input);
    }),

  dismissAsk: protectedProcedure
    .input(sessionInput)
    .mutation(async ({ ctx, input }): Promise<{ success: true } | SessionOpsError> => {
      return requireOps(ctx.sessionOps).dismissAsk(input);
    }),

  rename: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1), newName: z.string().min(1) }))
    .mutation(async ({ ctx, input }): Promise<{ success: true; data: RenamedSessionRow } | SessionOpsError> => {
      return requireOps(ctx.sessionOps).rename(input);
    }),

  toggleFavorite: protectedProcedure
    .input(sessionInput)
    .mutation(async ({ ctx, input }): Promise<{ success: true; data: { isFavorite: boolean } } | SessionOpsError> => {
      return requireOps(ctx.sessionOps).toggleFavorite(input);
    }),

  updateAgentPermissionMode: protectedProcedure
    // `mode` is a plain string ON PURPOSE — an unrecognized mode must come back
    // as the legacy failure ENVELOPE, and a z.enum here would turn it into a
    // BAD_REQUEST throw instead. The isPermissionMode check stayed in the ops
    // body with the rest of the handler.
    .input(z.object({ sessionId: z.string().min(1), mode: z.string() }))
    .mutation(async ({ ctx, input }): Promise<{ success: true } | SessionOpsError> => {
      return requireOps(ctx.sessionOps).updateAgentPermissionMode(input);
    }),

  updateSessionMcps: protectedProcedure
    // UNLIKE updateAgentPermissionMode, this schema is strict: a malformed
    // array is a thrown BAD_REQUEST at this boundary, so the ops body's
    // `'Invalid MCP selection'` envelope only answers DIRECT ops callers
    // (defense-in-depth) — via the router it is unreachable.
    .input(z.object({ sessionId: z.string().min(1), disabledMcpServers: z.array(z.string()) }))
    .mutation(async ({ ctx, input }): Promise<{ success: true } | SessionOpsError> => {
      return requireOps(ctx.sessionOps).updateSessionMcps(input);
    }),

  updateSessionPlugins: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1), enabledPlugins: z.array(z.string()) }))
    .mutation(async ({ ctx, input }): Promise<{ success: true } | SessionOpsError> => {
      return requireOps(ctx.sessionOps).updateSessionPlugins(input);
    }),

  reorder: protectedProcedure
    .input(
      z.object({
        sessionOrders: z.array(z.object({ id: z.string().min(1), displayOrder: z.number().int() })),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<{ success: true } | SessionOpsError> => {
      return requireOps(ctx.sessionOps).reorder(input);
    }),

  setActiveSession: protectedProcedure
    // Nullable, not optional: `null` is the meaningful "no session is active"
    // value the sidebar sends when the selection is cleared.
    .input(z.object({ sessionId: z.string().min(1).nullable() }))
    .mutation(async ({ ctx, input }): Promise<{ success: true } | SessionOpsError> => {
      return requireOps(ctx.sessionOps).setActiveSession(input);
    }),
});
