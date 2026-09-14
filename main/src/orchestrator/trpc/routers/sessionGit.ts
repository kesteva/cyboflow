/**
 * cyboflow.sessionGit sub-router — the session-worktree git surface: commit
 * history and diffs, rebase-from-main, merge-to-main (squash or preserve),
 * pull/push, the delivery/mark-complete bookkeeping the dismiss and Create-PR
 * dialogs read, and the git-status reads the sidebar drives.
 *
 * Slice 3 — the FINAL slice — of the IPC→tRPC migration
 * (docs/CODE-PATTERNS.md), following the `config` PILOT and `workspaceFiles`
 * slices exactly: the 20 migrated `sessions:*` / `git:*` ipcMain.handle channels
 * (main/src/ipc/git.ts, now deleted) moved here, with zod input validation at
 * the boundary and the business logic delegated to the SessionGitOpsLike contract
 * (ctx.sessionGitOps, injected from main/src/index.ts via createGitOps).
 * `sessions:check-rebase-conflicts` was NOT migrated — it had zero
 * preload/frontend callers.
 *
 * Multi-arg legacy channels became single input OBJECTS (`{ sessionId,
 * commitMessage }` rather than positional args), which is why the ops contract
 * takes a request object per method.
 *
 * Envelope passthrough is total: this router never re-shapes what the ops layer
 * returns, including the irregular envelopes the merge/dismiss dialogs depend on
 * (`needsRebase` / `alreadyUpToDate` / `gitError`, and getGitStatus's
 * `gitStatus`-keyed success). See the contract for why each exists.
 *
 * `getGitStatus` is a QUERY even though it can kick off a background refresh:
 * it is semantically a read, and the refresh is a cache-warming side effect the
 * legacy handler always had.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import type {
  MergeToMainResult,
  PullPushGitError,
  RebaseFromMainGitError,
  SessionExecutionRow,
  SessionGitDiffResult,
  SessionGitError,
  SessionLastCommitRow,
} from '../contracts/sessionGitOps';
import type { GitStatus } from '../../../types/session';

function requireOps<T>(ops: T | undefined): T {
  if (!ops) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'sessionGitOps not wired into tRPC context',
    });
  }
  return ops;
}

/** Every one of these procedures is keyed by a session id. */
const sessionInput = z.object({ sessionId: z.string().min(1) });

export const sessionGitRouter = router({
  getExecutions: protectedProcedure
    .input(sessionInput)
    .query(async ({ ctx, input }): Promise<{ success: true; data: SessionExecutionRow[] } | SessionGitError> => {
      return requireOps(ctx.sessionGitOps).getExecutions(input);
    }),

  getExecutionDiff: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1), executionId: z.string().min(1) }))
    .query(async ({ ctx, input }): Promise<{ success: true; data: SessionGitDiffResult } | SessionGitError> => {
      return requireOps(ctx.sessionGitOps).getExecutionDiff(input);
    }),

  commit: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1), message: z.string().min(1) }))
    .mutation(async ({ ctx, input }): Promise<{ success: true } | SessionGitError> => {
      return requireOps(ctx.sessionGitOps).commit(input);
    }),

  diff: protectedProcedure
    .input(sessionInput)
    .query(async ({ ctx, input }): Promise<{ success: true; data: SessionGitDiffResult } | SessionGitError> => {
      return requireOps(ctx.sessionGitOps).diff(input);
    }),

  getCombinedDiff: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().min(1),
        executionIds: z.array(z.number().int()).optional(),
        // TASK-212 (Seam B): both wire fields, forwarded into the ops call
        // below — zod strips anything NOT declared here before the resolver
        // ever sees it, so omitting either would silently drop it.
        comparisonRef: z.string().min(1).optional(),
        scope: z.enum(['unstaged', 'staged', 'untracked', 'committed']).optional(),
      }),
    )
    .query(async ({ ctx, input }): Promise<{ success: true; data: SessionGitDiffResult } | SessionGitError> => {
      return requireOps(ctx.sessionGitOps).getCombinedDiff(input);
    }),

  rebaseMainIntoWorktree: protectedProcedure
    .input(sessionInput)
    .mutation(async ({
      ctx,
      input,
    }): Promise<
      | { success: true; data: { message: string } }
      | { success: false; error: string; gitError?: RebaseFromMainGitError }
    > => {
      return requireOps(ctx.sessionGitOps).rebaseMainIntoWorktree(input);
    }),

  abortRebaseAndUseClaude: protectedProcedure
    .input(sessionInput)
    .mutation(async ({
      ctx,
      input,
    }): Promise<{ success: true; data: { message: string; panelId: string } } | SessionGitError> => {
      return requireOps(ctx.sessionGitOps).abortRebaseAndUseClaude(input);
    }),

  squashAndRebaseToMain: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1), commitMessage: z.string().min(1) }))
    .mutation(async ({ ctx, input }): Promise<MergeToMainResult> => {
      return requireOps(ctx.sessionGitOps).squashAndRebaseToMain(input);
    }),

  rebaseToMain: protectedProcedure
    .input(sessionInput)
    .mutation(async ({ ctx, input }): Promise<MergeToMainResult> => {
      return requireOps(ctx.sessionGitOps).rebaseToMain(input);
    }),

  pull: protectedProcedure
    .input(sessionInput)
    .mutation(async ({
      ctx,
      input,
    }): Promise<
      | { success: true; data: { output: string } }
      | { success: false; error: string; isMergeConflict?: boolean; gitError?: PullPushGitError }
    > => {
      return requireOps(ctx.sessionGitOps).pull(input);
    }),

  push: protectedProcedure
    .input(sessionInput)
    .mutation(async ({
      ctx,
      input,
    }): Promise<
      | { success: true; data: { output: string } }
      | { success: false; error: string; gitError?: PullPushGitError }
    > => {
      return requireOps(ctx.sessionGitOps).push(input);
    }),

  getDeliveryState: protectedProcedure
    .input(sessionInput)
    .query(async ({
      ctx,
      input,
    }): Promise<
      { success: true; data: { delivered: boolean; landed: boolean; ownCommits: number } } | SessionGitError
    > => {
      return requireOps(ctx.sessionGitOps).getDeliveryState(input);
    }),

  markComplete: protectedProcedure
    .input(sessionInput)
    .mutation(async ({ ctx, input }): Promise<{ success: true; data: { stamped: number } } | SessionGitError> => {
      return requireOps(ctx.sessionGitOps).markComplete(input);
    }),

  getBranchCommitSubjects: protectedProcedure
    .input(sessionInput)
    .query(async ({ ctx, input }): Promise<{ success: true; data: { subjects: string[] } } | SessionGitError> => {
      return requireOps(ctx.sessionGitOps).getBranchCommitSubjects(input);
    }),

  getLastCommits: protectedProcedure
    // The default (50) deliberately lives in the ops impl, not here — it is the
    // legacy handler's own default and moved with the body.
    .input(z.object({ sessionId: z.string().min(1), count: z.number().int().positive().optional() }))
    .query(async ({ ctx, input }): Promise<{ success: true; data: SessionLastCommitRow[] } | SessionGitError> => {
      return requireOps(ctx.sessionGitOps).getLastCommits(input);
    }),

  hasChangesToRebase: protectedProcedure
    .input(sessionInput)
    .query(async ({ ctx, input }): Promise<{ success: true; data: boolean } | SessionGitError> => {
      return requireOps(ctx.sessionGitOps).hasChangesToRebase(input);
    }),

  getGitCommands: protectedProcedure
    .input(sessionInput)
    .query(async ({
      ctx,
      input,
    }): Promise<
      | {
          success: true;
          data: {
            rebaseCommands: string[];
            squashCommands: string[];
            mergeCommands: string[];
            mainBranch: string;
            originBranch?: string;
            currentBranch: string;
          };
        }
      | SessionGitError
    > => {
      return requireOps(ctx.sessionGitOps).getGitCommands(input);
    }),

  /**
   * New (TASK-216): the future BaseSelector menu's data source — every
   * candidate base the picker can offer, resolved server-side. See
   * SessionGitOpsLike.getComparisonBases for the per-leg degradation
   * contract (each leg is `null`, never fabricated, when it can't be
   * answered).
   */
  getComparisonBases: protectedProcedure
    .input(sessionInput)
    .query(async ({
      ctx,
      input,
    }): Promise<
      | {
          success: true;
          data: {
            branchPoint: { ref: string; shortSha: string } | null;
            defaultBranch: string | null;
            localDefault: { ref: string; behind: number } | null;
            originDefault: { ref: string; behind: number; fetchedAt: string | null } | null;
          };
        }
      | SessionGitError
    > => {
      return requireOps(ctx.sessionGitOps).getComparisonBases(input);
    }),

  getCurrentBranch: protectedProcedure
    .input(sessionInput)
    .query(async ({
      ctx,
      input,
    }): Promise<{ success: true; data: { branch: string | null } } | SessionGitError> => {
      return requireOps(ctx.sessionGitOps).getCurrentBranch(input);
    }),

  getRemoteUrl: protectedProcedure
    .input(sessionInput)
    .query(async ({
      ctx,
      input,
    }): Promise<{ success: true; data: { remoteUrl: string; branchName: string } } | SessionGitError> => {
      return requireOps(ctx.sessionGitOps).getRemoteUrl(input);
    }),

  getGitStatus: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().min(1),
        nonBlocking: z.boolean().optional(),
        isInitialLoad: z.boolean().optional(),
      }),
    )
    .query(async ({
      ctx,
      input,
    }): Promise<
      { success: true; gitStatus: GitStatus | null; backgroundRefresh?: boolean } | SessionGitError
    > => {
      return requireOps(ctx.sessionGitOps).getGitStatus(input);
    }),

  cancelStatusForProject: protectedProcedure
    .input(z.object({ projectId: z.number().int() }))
    .mutation(async ({ ctx, input }): Promise<{ success: true } | SessionGitError> => {
      return requireOps(ctx.sessionGitOps).cancelStatusForProject(input);
    }),
});
