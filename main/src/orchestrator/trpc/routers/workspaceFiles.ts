/**
 * cyboflow.workspaceFiles sub-router — workspace file search, project-directory
 * file I/O, and the worktree/project-scoped git mutations that have always
 * lived alongside it (restore/execute).
 *
 * Slice 2 of the IPC→tRPC migration (docs/CODE-PATTERNS.md), following the
 * `config` PILOT slice's pattern exactly: the 12 legacy `file:*`/`git:*`
 * ipcMain.handle channels (main/src/ipc/file.ts, now deleted) moved here, with
 * zod input validation at the boundary and the business logic delegated to
 * {@link WorkspaceFileOpsLike} (ctx.workspaceFileOps, injected from
 * main/src/index.ts via createFileOps). `file:getPath` was NOT migrated — it
 * had zero preload/frontend callers. The session-worktree read/write/list/
 * delete/readAtRevision and commit/revert procedures were later deleted with
 * the central Diff panel and the hidden file editor, their only callers.
 *
 * Distinct from the existing `cyboflow.files` router (routers/files.ts), which
 * is the read-only, SESSION-keyed File Explorer surface
 * (listSessionFiles/readSessionFile). This router is the mutable file/git
 * surface the file-path autocomplete, worktree strip, and setup-tasks panel use.
 *
 * Path-traversal (`..`/absolute) and containment (realpath) validation STAYS
 * in the ops implementation, moved verbatim from the legacy handlers — zod
 * here only asserts input SHAPE, not path safety. Likewise the
 * `git:execute-project` subcommand allowlist enforcement stays in the ops impl
 * (PROJECT_GIT_SUBCOMMANDS in fileOps.ts — a SECURITY BOUNDARY); zod only
 * asserts `args` is a non-empty string array.
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

  readProject: protectedProcedure
    .input(z.object({ projectId: z.number(), filePath: z.string().min(1) }))
    .query(async ({ ctx, input }): Promise<{ success: true; data: string | null } | FileErrorResult> => {
      return requireOps(ctx.workspaceFileOps).readProject(input);
    }),

  writeProject: protectedProcedure
    .input(z.object({ projectId: z.number(), filePath: z.string().min(1), content: z.string() }))
    .mutation(async ({ ctx, input }): Promise<{ success: true } | FileErrorResult> => {
      return requireOps(ctx.workspaceFileOps).writeProject(input);
    }),

  gitRestore: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }): Promise<{ success: true } | FileErrorResult> => {
      return requireOps(ctx.workspaceFileOps).gitRestore(input);
    }),

  gitExecuteProject: protectedProcedure
    .input(z.object({ projectId: z.number().int(), args: z.array(z.string()).min(1) }))
    .mutation(async ({ ctx, input }): Promise<{ success: true; output: string } | FileErrorResult> => {
      return requireOps(ctx.workspaceFileOps).gitExecuteProject(input);
    }),
});
