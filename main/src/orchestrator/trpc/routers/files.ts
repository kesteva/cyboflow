/**
 * cyboflow.files sub-router — the CANONICAL, SESSION-keyed File Explorer.
 *
 * The File Explorer tab binds to the SELECTED session's git worktree
 * (sessions.worktree_path), NOT to any active workflow run. Because session-hosted
 * runs execute IN the session worktree, this surfaces the same tree whether or not
 * a run is active — and crucially it works for a session with NO active run.
 *
 * Mirrors the legacy run-keyed cyboflow.runs.listFiles / readFile routes exactly,
 * but keyed by sessionId. The RunFileError -> TRPCError mapping is shared via
 * withRunFileErrorMapping (trpc/runFileErrors.ts).
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { listSessionFiles, readSessionFile } from '../../runFileExplorer';
import { withRunFileErrorMapping } from '../runFileErrors';
import type { RunFileEntry, RunFileContent } from '../../../../../shared/types/runFiles';

export const filesRouter = router({
  /**
   * List one directory level of a SESSION's git worktree for the File Explorer
   * tab. `path` is relative to the worktree root (omit for the root). Directories
   * sort first, then files; the `.git` directory is excluded. Read-only.
   *
   * Throws:
   *   PRECONDITION_FAILED — ctx.db missing, or the session has no worktree /
   *                         the worktree no longer exists on disk.
   *   NOT_FOUND           — unknown sessionId, or the target directory is missing.
   *   BAD_REQUEST         — path escapes the worktree or is not a directory.
   */
  list: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1), path: z.string().optional() }))
    .query(async ({ ctx, input }): Promise<RunFileEntry[]> => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'db not wired into tRPC context',
        });
      }
      const db = ctx.db;
      return withRunFileErrorMapping(() => listSessionFiles(db, input.sessionId, input.path));
    }),

  /**
   * Read a single file from a SESSION's git worktree as UTF-8 text for the File
   * Explorer viewer. Binary or oversized files return `content: null` with an
   * `unviewableReason` instead of throwing. Read-only.
   *
   * Throws:
   *   PRECONDITION_FAILED — ctx.db missing, or the session has no worktree /
   *                         the worktree no longer exists on disk.
   *   NOT_FOUND           — unknown sessionId, or the file is missing.
   *   BAD_REQUEST         — path escapes the worktree or is a directory.
   */
  read: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1), path: z.string().min(1) }))
    .query(async ({ ctx, input }): Promise<RunFileContent> => {
      if (!ctx.db) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'db not wired into tRPC context',
        });
      }
      const db = ctx.db;
      return withRunFileErrorMapping(() => readSessionFile(db, input.sessionId, input.path));
    }),
});
