/**
 * Tests for the cyboflow.workspaceFiles tRPC router — slice 2 of the
 * IPC→tRPC migration (docs/CODE-PATTERNS.md), following the `config` PILOT
 * slice's test conventions. Exercises, for both procedures:
 *   (a) delegation to ctx.workspaceFileOps and envelope passthrough (the
 *       router does no re-shaping, including a failure envelope).
 *   (b) zod rejection of malformed input, never reaching ctx.workspaceFileOps.
 *   (c) PRECONDITION_FAILED when ctx.workspaceFileOps is absent.
 */
import { describe, it, expect, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import type { WorkspaceFileOpsLike } from '../../contracts/workspaceFileOps';

function isPrecond(err: unknown): boolean {
  return err instanceof TRPCError && err.code === 'PRECONDITION_FAILED';
}

function isBadRequest(err: unknown): boolean {
  return err instanceof TRPCError && err.code === 'BAD_REQUEST';
}

function makeFakeOps(): WorkspaceFileOpsLike & {
  search: ReturnType<typeof vi.fn>;
  gitRestore: ReturnType<typeof vi.fn>;
} {
  return {
    search: vi.fn().mockResolvedValue({ success: true, files: [] }),
    gitRestore: vi.fn().mockResolvedValue({ success: true }),
  };
}

describe('cyboflow.workspaceFiles', () => {
  // -------------------------------------------------------------------------
  // (a) Delegation + envelope passthrough.
  // -------------------------------------------------------------------------
  describe('(a) delegates to ctx.workspaceFileOps and returns its envelope untouched', () => {
    it('search', async () => {
      const workspaceFileOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ workspaceFileOps }));
      const result = await caller.cyboflow.workspaceFiles.search({ projectId: 1, pattern: 'foo', limit: 10 });
      expect(workspaceFileOps.search).toHaveBeenCalledWith({ projectId: 1, pattern: 'foo', limit: 10 });
      expect(result).toEqual({ success: true, files: [] });
    });

    it('a failure envelope from ctx.workspaceFileOps also passes through untouched', async () => {
      const workspaceFileOps = makeFakeOps();
      workspaceFileOps.gitRestore.mockResolvedValue({ success: false, error: 'boom' });
      const caller = appRouter.createCaller(createContext({ workspaceFileOps }));
      const result = await caller.cyboflow.workspaceFiles.gitRestore({ sessionId: 's1' });
      expect(result).toEqual({ success: false, error: 'boom' });
    });

    it("search's failure envelope carries files: [] through untouched", async () => {
      const workspaceFileOps = makeFakeOps();
      workspaceFileOps.search.mockResolvedValue({ success: false, error: 'boom', files: [] });
      const caller = appRouter.createCaller(createContext({ workspaceFileOps }));
      const result = await caller.cyboflow.workspaceFiles.search({ projectId: 1, pattern: 'foo' });
      expect(result).toEqual({ success: false, error: 'boom', files: [] });
    });
  });

  // -------------------------------------------------------------------------
  // (b) zod rejection of malformed input, never delegated.
  // -------------------------------------------------------------------------
  describe('(b) rejects malformed input before it reaches workspaceFileOps', () => {
    it('gitRestore rejects a missing sessionId', async () => {
      const workspaceFileOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ workspaceFileOps }));
      await expect(
        caller.cyboflow.workspaceFiles.gitRestore({} as never),
      ).rejects.toSatisfy(isBadRequest);
      expect(workspaceFileOps.gitRestore).not.toHaveBeenCalled();
    });

    it('gitRestore rejects an empty sessionId (min length 1)', async () => {
      const workspaceFileOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ workspaceFileOps }));
      await expect(
        caller.cyboflow.workspaceFiles.gitRestore({ sessionId: '' }),
      ).rejects.toSatisfy(isBadRequest);
      expect(workspaceFileOps.gitRestore).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // (c) Missing ctx.workspaceFileOps → PRECONDITION_FAILED.
  // -------------------------------------------------------------------------
  describe('(c) missing ctx.workspaceFileOps → PRECONDITION_FAILED', () => {
    it('search', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(
        caller.cyboflow.workspaceFiles.search({ projectId: 1, pattern: 'foo' }),
      ).rejects.toSatisfy(isPrecond);
    });

    it('gitRestore', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(
        caller.cyboflow.workspaceFiles.gitRestore({ sessionId: 's1' }),
      ).rejects.toSatisfy(isPrecond);
    });
  });
});
