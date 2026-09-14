/**
 * Tests for the cyboflow.sessionGit tRPC router — slice 3 (the final slice) of
 * the IPC→tRPC migration (docs/CODE-PATTERNS.md), following the `config` PILOT
 * and `workspaceFiles` slices' test conventions. Exercises, for a
 * representative subset of procedures:
 *   (a) delegation to ctx.sessionGitOps and envelope passthrough — including
 *       the IRREGULAR envelopes the merge/dismiss dialogs depend on
 *       (`alreadyUpToDate` + `gitError` on a merge failure, and getGitStatus's
 *       `gitStatus`-keyed rather than `data`-keyed success).
 *   (b) zod rejection of malformed input, never reaching ctx.sessionGitOps.
 *   (c) PRECONDITION_FAILED when ctx.sessionGitOps is absent.
 */
import { describe, it, expect, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import type { SessionGitOpsLike } from '../../contracts/sessionGitOps';

function isPrecond(err: unknown): boolean {
  return err instanceof TRPCError && err.code === 'PRECONDITION_FAILED';
}

function isBadRequest(err: unknown): boolean {
  return err instanceof TRPCError && err.code === 'BAD_REQUEST';
}

type FakeOps = SessionGitOpsLike & Record<keyof SessionGitOpsLike, ReturnType<typeof vi.fn>>;

/** A minimal WorktreeStatusPayload for the SessionGitDiffResult mocks below. */
const emptyWorktree = { entries: [], groups: [], committedUnavailable: true };

function makeFakeOps(): FakeOps {
  return {
    getExecutions: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getExecutionDiff: vi.fn().mockResolvedValue({
      success: true,
      data: {
        diff: '',
        stats: { additions: 0, deletions: 0, filesChanged: 0 },
        changedFiles: [],
        resolvedBase: null,
        worktree: emptyWorktree,
      },
    }),
    commit: vi.fn().mockResolvedValue({ success: true }),
    diff: vi.fn().mockResolvedValue({
      success: true,
      data: {
        diff: '',
        stats: { additions: 0, deletions: 0, filesChanged: 0 },
        changedFiles: [],
        resolvedBase: null,
        worktree: emptyWorktree,
      },
    }),
    getCombinedDiff: vi.fn().mockResolvedValue({
      success: true,
      data: {
        diff: '',
        stats: { additions: 0, deletions: 0, filesChanged: 0 },
        changedFiles: [],
        resolvedBase: null,
        worktree: emptyWorktree,
      },
    }),
    rebaseMainIntoWorktree: vi.fn().mockResolvedValue({ success: true, data: { message: 'ok' } }),
    abortRebaseAndUseClaude: vi.fn().mockResolvedValue({ success: true, data: { message: 'ok', panelId: 'p1' } }),
    squashAndRebaseToMain: vi.fn().mockResolvedValue({ success: true, data: { message: 'merged' } }),
    rebaseToMain: vi.fn().mockResolvedValue({ success: true, data: { message: 'merged' } }),
    pull: vi.fn().mockResolvedValue({ success: true, data: { output: '' } }),
    push: vi.fn().mockResolvedValue({ success: true, data: { output: '' } }),
    getDeliveryState: vi
      .fn()
      .mockResolvedValue({ success: true, data: { delivered: false, landed: false, ownCommits: 0 } }),
    markComplete: vi.fn().mockResolvedValue({ success: true, data: { stamped: 1 } }),
    getBranchCommitSubjects: vi.fn().mockResolvedValue({ success: true, data: { subjects: [] } }),
    getLastCommits: vi.fn().mockResolvedValue({ success: true, data: [] }),
    hasChangesToRebase: vi.fn().mockResolvedValue({ success: true, data: false }),
    getGitCommands: vi.fn().mockResolvedValue({
      success: true,
      data: {
        rebaseCommands: [],
        squashCommands: [],
        mergeCommands: [],
        mainBranch: 'main',
        currentBranch: 'feature',
      },
    }),
    getCurrentBranch: vi.fn().mockResolvedValue({ success: true, data: { branch: 'feature' } }),
    getComparisonBases: vi.fn().mockResolvedValue({
      success: true,
      data: {
        branchPoint: { ref: 'a'.repeat(40), shortSha: 'a'.repeat(7) },
        defaultBranch: 'main',
        localDefault: { ref: 'main', behind: 0 },
        originDefault: { ref: 'origin/main', behind: 0, fetchedAt: '2026-09-14T00:00:00.000Z' },
      },
    }),
    getRemoteUrl: vi.fn().mockResolvedValue({ success: true, data: { remoteUrl: '', branchName: '' } }),
    getGitStatus: vi.fn().mockResolvedValue({ success: true, gitStatus: { state: 'clean' } }),
    cancelStatusForProject: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as FakeOps;
}

describe('cyboflow.sessionGit', () => {
  // -------------------------------------------------------------------------
  // (a) Delegation + envelope passthrough for a representative subset.
  // -------------------------------------------------------------------------
  describe('(a) delegates to ctx.sessionGitOps and returns its envelope untouched', () => {
    it('getExecutions', async () => {
      const sessionGitOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionGitOps }));
      const result = await caller.cyboflow.sessionGit.getExecutions({ sessionId: 's1' });
      expect(sessionGitOps.getExecutions).toHaveBeenCalledWith({ sessionId: 's1' });
      expect(result).toEqual({ success: true, data: [] });
    });

    it('commit', async () => {
      const sessionGitOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionGitOps }));
      const result = await caller.cyboflow.sessionGit.commit({ sessionId: 's1', message: 'feat: thing' });
      expect(sessionGitOps.commit).toHaveBeenCalledWith({ sessionId: 's1', message: 'feat: thing' });
      expect(result).toEqual({ success: true });
    });

    it('getCombinedDiff forwards its optional executionIds', async () => {
      const sessionGitOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionGitOps }));
      await caller.cyboflow.sessionGit.getCombinedDiff({ sessionId: 's1', executionIds: [1, 2] });
      expect(sessionGitOps.getCombinedDiff).toHaveBeenCalledWith({ sessionId: 's1', executionIds: [1, 2] });
    });

    // TASK-212 (Seam B): comparisonRef and scope are wire fields, not merely
    // hook arguments — zod must NOT strip either before the resolver reaches
    // them (the critical silent-drop trap the zod schema change guards
    // against).
    it('getCombinedDiff forwards its optional comparisonRef and scope', async () => {
      const sessionGitOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionGitOps }));
      await caller.cyboflow.sessionGit.getCombinedDiff({
        sessionId: 's1',
        comparisonRef: 'abc123',
        scope: 'staged',
      });
      expect(sessionGitOps.getCombinedDiff).toHaveBeenCalledWith({
        sessionId: 's1',
        comparisonRef: 'abc123',
        scope: 'staged',
      });
    });

    it('squashAndRebaseToMain', async () => {
      const sessionGitOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionGitOps }));
      const result = await caller.cyboflow.sessionGit.squashAndRebaseToMain({
        sessionId: 's1',
        commitMessage: 'feat: squashed',
      });
      expect(sessionGitOps.squashAndRebaseToMain).toHaveBeenCalledWith({
        sessionId: 's1',
        commitMessage: 'feat: squashed',
      });
      expect(result).toEqual({ success: true, data: { message: 'merged' } });
    });

    it("squashAndRebaseToMain's alreadyUpToDate + gitError failure envelope passes through untouched", async () => {
      // The merge dialog reads BOTH extras: alreadyUpToDate turns the error into
      // a Mark-complete offer, and gitError drives the detail panel. Losing
      // either at this boundary would silently degrade that dialog.
      const sessionGitOps = makeFakeOps();
      sessionGitOps.squashAndRebaseToMain.mockResolvedValue({
        success: false,
        alreadyUpToDate: true,
        error: 'Branch is already up to date with main',
        gitError: {
          commands: ['git merge --squash feature'],
          output: 'Already up to date.',
          workingDirectory: '/wt',
          projectPath: '/proj',
          originalError: 'nothing to merge',
        },
      });
      const caller = appRouter.createCaller(createContext({ sessionGitOps }));
      const result = await caller.cyboflow.sessionGit.squashAndRebaseToMain({
        sessionId: 's1',
        commitMessage: 'feat: squashed',
      });
      expect(result).toEqual({
        success: false,
        alreadyUpToDate: true,
        error: 'Branch is already up to date with main',
        gitError: {
          commands: ['git merge --squash feature'],
          output: 'Already up to date.',
          workingDirectory: '/wt',
          projectPath: '/proj',
          originalError: 'nothing to merge',
        },
      });
    });

    it("rebaseToMain's needsRebase block passes through untouched", async () => {
      const sessionGitOps = makeFakeOps();
      sessionGitOps.rebaseToMain.mockResolvedValue({
        success: false,
        needsRebase: true,
        error: 'main has new commits since this branch started.',
      });
      const caller = appRouter.createCaller(createContext({ sessionGitOps }));
      const result = await caller.cyboflow.sessionGit.rebaseToMain({ sessionId: 's1' });
      expect(result).toEqual({
        success: false,
        needsRebase: true,
        error: 'main has new commits since this branch started.',
      });
    });

    it("getGitStatus's success envelope keys the status on gitStatus, not data", async () => {
      const sessionGitOps = makeFakeOps();
      sessionGitOps.getGitStatus.mockResolvedValue({
        success: true,
        gitStatus: { state: 'modified', ahead: 2 },
        backgroundRefresh: true,
      });
      const caller = appRouter.createCaller(createContext({ sessionGitOps }));
      const result = await caller.cyboflow.sessionGit.getGitStatus({ sessionId: 's1', isInitialLoad: true });
      expect(sessionGitOps.getGitStatus).toHaveBeenCalledWith({ sessionId: 's1', isInitialLoad: true });
      expect(result).toEqual({
        success: true,
        gitStatus: { state: 'modified', ahead: 2 },
        backgroundRefresh: true,
      });
    });

    it('getCurrentBranch', async () => {
      const sessionGitOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionGitOps }));
      const result = await caller.cyboflow.sessionGit.getCurrentBranch({ sessionId: 's1' });
      expect(sessionGitOps.getCurrentBranch).toHaveBeenCalledWith({ sessionId: 's1' });
      expect(result).toEqual({ success: true, data: { branch: 'feature' } });
    });

    it('getComparisonBases', async () => {
      const sessionGitOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionGitOps }));
      const result = await caller.cyboflow.sessionGit.getComparisonBases({ sessionId: 's1' });
      expect(sessionGitOps.getComparisonBases).toHaveBeenCalledWith({ sessionId: 's1' });
      expect(result).toEqual({
        success: true,
        data: {
          branchPoint: { ref: 'a'.repeat(40), shortSha: 'a'.repeat(7) },
          defaultBranch: 'main',
          localDefault: { ref: 'main', behind: 0 },
          originDefault: { ref: 'origin/main', behind: 0, fetchedAt: '2026-09-14T00:00:00.000Z' },
        },
      });
    });

    it('a plain failure envelope also passes through untouched', async () => {
      const sessionGitOps = makeFakeOps();
      sessionGitOps.getExecutions.mockResolvedValue({ success: false, error: 'Session or worktree path not found' });
      const caller = appRouter.createCaller(createContext({ sessionGitOps }));
      const result = await caller.cyboflow.sessionGit.getExecutions({ sessionId: 's1' });
      expect(result).toEqual({ success: false, error: 'Session or worktree path not found' });
    });
  });

  // -------------------------------------------------------------------------
  // (b) zod rejection of malformed input, never delegated.
  // -------------------------------------------------------------------------
  describe('(b) rejects malformed input before it reaches sessionGitOps', () => {
    it('getExecutions rejects an empty sessionId (min length 1)', async () => {
      const sessionGitOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionGitOps }));
      await expect(caller.cyboflow.sessionGit.getExecutions({ sessionId: '' })).rejects.toSatisfy(isBadRequest);
      expect(sessionGitOps.getExecutions).not.toHaveBeenCalled();
    });

    it('commit rejects an empty message (min length 1)', async () => {
      const sessionGitOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionGitOps }));
      await expect(caller.cyboflow.sessionGit.commit({ sessionId: 's1', message: '' })).rejects.toSatisfy(
        isBadRequest,
      );
      expect(sessionGitOps.commit).not.toHaveBeenCalled();
    });

    it('squashAndRebaseToMain rejects an empty commitMessage', async () => {
      const sessionGitOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionGitOps }));
      await expect(
        caller.cyboflow.sessionGit.squashAndRebaseToMain({ sessionId: 's1', commitMessage: '' }),
      ).rejects.toSatisfy(isBadRequest);
      expect(sessionGitOps.squashAndRebaseToMain).not.toHaveBeenCalled();
    });

    it('cancelStatusForProject rejects a non-integer projectId', async () => {
      const sessionGitOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionGitOps }));
      await expect(
        caller.cyboflow.sessionGit.cancelStatusForProject({ projectId: 1.5 }),
      ).rejects.toSatisfy(isBadRequest);
      expect(sessionGitOps.cancelStatusForProject).not.toHaveBeenCalled();
    });

    it('getCombinedDiff rejects non-integer executionIds', async () => {
      const sessionGitOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionGitOps }));
      await expect(
        caller.cyboflow.sessionGit.getCombinedDiff({ sessionId: 's1', executionIds: [1.5] }),
      ).rejects.toSatisfy(isBadRequest);
      expect(sessionGitOps.getCombinedDiff).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // (c) Missing ctx.sessionGitOps → PRECONDITION_FAILED.
  // -------------------------------------------------------------------------
  describe('(c) missing ctx.sessionGitOps → PRECONDITION_FAILED', () => {
    it('getExecutions', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(caller.cyboflow.sessionGit.getExecutions({ sessionId: 's1' })).rejects.toSatisfy(isPrecond);
    });

    it('squashAndRebaseToMain', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(
        caller.cyboflow.sessionGit.squashAndRebaseToMain({ sessionId: 's1', commitMessage: 'm' }),
      ).rejects.toSatisfy(isPrecond);
    });

    it('getGitStatus', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(caller.cyboflow.sessionGit.getGitStatus({ sessionId: 's1' })).rejects.toSatisfy(isPrecond);
    });

    it('getCurrentBranch', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(caller.cyboflow.sessionGit.getCurrentBranch({ sessionId: 's1' })).rejects.toSatisfy(isPrecond);
    });

    it('cancelStatusForProject', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(caller.cyboflow.sessionGit.cancelStatusForProject({ projectId: 1 })).rejects.toSatisfy(isPrecond);
    });

    it('getComparisonBases', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(caller.cyboflow.sessionGit.getComparisonBases({ sessionId: 's1' })).rejects.toSatisfy(isPrecond);
    });
  });
});
