/**
 * cyboflow.workspaceFiles sub-router — workspace file search and the
 * worktree-scoped git restore that has always lived alongside it.
 *
 * Slice 2 of the IPC→tRPC migration (docs/CODE-PATTERNS.md), following the
 * `config` PILOT slice's pattern exactly: the 12 legacy `file:*`/`git:*`
 * ipcMain.handle channels (main/src/ipc/file.ts, now deleted) moved here, with
 * zod input validation at the boundary and the business logic delegated to
 * {@link WorkspaceFileOpsLike} (ctx.workspaceFileOps, injected from
 * main/src/index.ts via createFileOps). `file:getPath` was NOT migrated — it
 * had zero preload/frontend callers. The session-worktree read/write/list/
 * delete/readAtRevision and commit/revert procedures were later deleted with
 * the central Diff panel and the hidden file editor, their only callers, and
 * the project-directory readProject/writeProject/gitExecuteProject procedures
 * with the retired setup-tasks panel.
 *
 * Distinct from the existing `cyboflow.files` router (routers/files.ts), which
 * is the read-only, SESSION-keyed File Explorer surface
 * (listSessionFiles/readSessionFile). This router is the surface the
 * file-path autocomplete and worktree strip use.
 *
 * Containment (realpath) validation of the search root STAYS in the ops
 * implementation, moved verbatim from the legacy handlers — zod here only
 * asserts input SHAPE, not path safety.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import type { FileItem, FileErrorResult } from '../contracts/workspaceFileOps';

function requireOps<T>(ops: T | undefined): T {
  if (!ops) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'workspaceFileOps not wired into tRPC context',
    });
  }
  return ops;
}

export const workspaceFilesRouter = router({
  search: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().optional(),
        projectId: z.number().optional(),
        pattern: z.string(),
        limit: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ ctx, input }): Promise<{ success: true; files: FileItem[] } | (FileErrorResult & { files: [] })> => {
      return requireOps(ctx.workspaceFileOps).search(input);
    }),

  gitRestore: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }): Promise<{ success: true } | FileErrorResult> => {
      return requireOps(ctx.workspaceFileOps).gitRestore(input);
    }),
});
