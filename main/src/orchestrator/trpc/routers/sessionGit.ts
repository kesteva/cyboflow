/**
 * cyboflow.sessionGit sub-router — the session-worktree git surface: commit,
 * the combined diff, merge-to-main (squash or preserve), push, and the
 * delivery/mark-complete bookkeeping the dismiss and Create-PR dialogs read.
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
 * (`needsRebase` / `alreadyUpToDate` / `gitError`). See the contract for why
 * each exists.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { EventEmitter } from 'events';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';
import { eventToAsyncIterable } from './events';
import type {
  MergeToMainResult,
  PullPushGitError,
  SessionGitDiffResult,
  SessionGitError,
} from '../contracts/sessionGitOps';
import type { ComparisonBases } from '../../../../../shared/types/runFiles';

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
  commit: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1), message: z.string().min(1) }))
    .mutation(async ({ ctx, input }): Promise<{ success: true } | SessionGitError> => {
      return requireOps(ctx.sessionGitOps).commit(input);
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
      | {
          success: true;
          data: {
            delivered: boolean;
            landed: boolean;
            ownCommits: number;
            completedNoCode: boolean;
            integratedLaneCount?: number;
          };
        }
      | SessionGitError
    > => {
      return requireOps(ctx.sessionGitOps).getDeliveryState(input);
    }),

  markComplete: protectedProcedure
    .input(sessionInput)
    .mutation(async ({
      ctx,
      input,
    }): Promise<
      | { success: true; data: { stamped: number; laneTasksLeftOpen?: number; tasksMovedToDone?: number } }
      | SessionGitError
    > => {
      return requireOps(ctx.sessionGitOps).markComplete(input);
    }),

  getBranchCommitSubjects: protectedProcedure
    .input(sessionInput)
    .query(async ({ ctx, input }): Promise<{ success: true; data: { subjects: string[] } } | SessionGitError> => {
      return requireOps(ctx.sessionGitOps).getBranchCommitSubjects(input);
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
      | { success: true; data: ComparisonBases }
      | SessionGitError
    > => {
      return requireOps(ctx.sessionGitOps).getComparisonBases(input);
    }),

  /**
   * Live "this session's worktree changed" stream for the rail's Diff tab.
   * The SUBSCRIPTION'S LIFETIME IS THE WATCH: subscribing starts the
   * per-worktree watcher (via SessionGitOpsLike.subscribeWorktreeChanges) and
   * the abort signal — the client's unsubscribe, or the tRPC link dropping —
   * tears it down. Events carry no payload: the consumer refetches
   * getCombinedDiff and lets that response be the truth. A session whose
   * worktree cannot be resolved rejects the subscription (PRECONDITION_FAILED)
   * rather than silently never emitting.
   */
  onWorktreeChanged: protectedProcedure
    .input(sessionInput)
    .subscription(async function* ({ ctx, input, signal }): AsyncGenerator<{ sessionId: string }> {
      const abortSignal = signal ?? new AbortController().signal;
      const emitter = new EventEmitter();
      const started = await requireOps(ctx.sessionGitOps).subscribeWorktreeChanges(input, () => {
        emitter.emit('change', { sessionId: input.sessionId });
      });
      if (!started.success) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: started.error });
      }
      try {
        const source = eventToAsyncIterable<{ sessionId: string }>(emitter, 'change', abortSignal);
        for await (const ev of source) {
          yield ev;
        }
      } finally {
        started.unsubscribe();
      }
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

  cancelStatusForProject: protectedProcedure
    .input(z.object({ projectId: z.number().int() }))
    .mutation(async ({ ctx, input }): Promise<{ success: true } | SessionGitError> => {
      return requireOps(ctx.sessionGitOps).cancelStatusForProject(input);
    }),
});
