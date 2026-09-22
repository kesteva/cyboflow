/**
 * Tests for the cyboflow.sessions tRPC router — batch 1 of the session-surface
 * IPC→tRPC migration (docs/CODE-PATTERNS.md), following the `config` PILOT,
 * `workspaceFiles` and `sessionGit` slices' test conventions. Exercises, for a
 * representative subset of procedures:
 *   (a) delegation to ctx.sessionOps and envelope passthrough — including the
 *       RETURNED failure envelopes the migrated mutations answer a malformed
 *       payload with, which is exactly what a zod enum here would have
 *       destroyed.
 *   (b) zod rejection of malformed input, never reaching ctx.sessionOps — and,
 *       just as importantly, the inputs zod must NOT reject: a null
 *       setActiveSession, an omitted listQuick projectId, an arbitrary
 *       permission-mode string.
 *   (c) PRECONDITION_FAILED when ctx.sessionOps is absent.
 */
import { describe, it, expect, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import type { SessionOpsLike } from '../../contracts/sessionOps';

function isPrecond(err: unknown): boolean {
  return err instanceof TRPCError && err.code === 'PRECONDITION_FAILED';
}

function isBadRequest(err: unknown): boolean {
  return err instanceof TRPCError && err.code === 'BAD_REQUEST';
}

type FakeOps = SessionOpsLike & Record<keyof SessionOpsLike, ReturnType<typeof vi.fn>>;

function makeFakeOps(): FakeOps {
  return {
    getAll: vi.fn().mockResolvedValue({ success: true, data: [] }),
    get: vi.fn().mockResolvedValue({ success: true, data: { id: 's1' } }),
    getAllWithProjects: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getSummary: vi.fn().mockResolvedValue({
      success: true,
      data: { enabled: true, summary: null, updatedAt: null, entries: [] },
    }),
    listQuick: vi.fn().mockResolvedValue({ success: true, data: [] }),
    getStatistics: vi.fn().mockResolvedValue({ success: true, data: { session: { id: 's1' } } }),
    getArchiveProgress: vi
      .fn()
      .mockResolvedValue({ success: true, data: { tasks: [], activeCount: 0, totalCount: 0 } }),
    markViewed: vi.fn().mockResolvedValue({ success: true }),
    dismissAsk: vi.fn().mockResolvedValue({ success: true }),
    rename: vi.fn().mockResolvedValue({ success: true, data: { id: 's1', name: 'renamed' } }),
    toggleFavorite: vi.fn().mockResolvedValue({ success: true, data: { isFavorite: true } }),
    updateAgentPermissionMode: vi.fn().mockResolvedValue({ success: true }),
    updateSessionMcps: vi.fn().mockResolvedValue({ success: true }),
    updateSessionPlugins: vi.fn().mockResolvedValue({ success: true }),
    reorder: vi.fn().mockResolvedValue({ success: true }),
    setActiveSession: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as FakeOps;
}

describe('cyboflow.sessions', () => {
  // -------------------------------------------------------------------------
  // (a) Delegation + envelope passthrough for a representative subset.
  // -------------------------------------------------------------------------
  describe('(a) delegates to ctx.sessionOps and returns its envelope untouched', () => {
    it('getAll takes no input and passes the list through', async () => {
      const sessionOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      const result = await caller.cyboflow.sessions.getAll();
      expect(sessionOps.getAll).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: true, data: [] });
    });

    it('get forwards its sessionId', async () => {
      const sessionOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      const result = await caller.cyboflow.sessions.get({ sessionId: 's1' });
      expect(sessionOps.get).toHaveBeenCalledWith({ sessionId: 's1' });
      expect(result).toEqual({ success: true, data: { id: 's1' } });
    });

    it('getSummary forwards the flattened catchUp flag', async () => {
      const sessionOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      await caller.cyboflow.sessions.getSummary({ sessionId: 's1', catchUp: false });
      expect(sessionOps.getSummary).toHaveBeenCalledWith({ sessionId: 's1', catchUp: false });
    });

    it("getSummary's validation-failure envelope passes through byte-identical", async () => {
      // createValidationError's string is what the renderer surfaces; a reshape
      // here would silently change what the user reads.
      const sessionOps = makeFakeOps();
      sessionOps.getSummary.mockResolvedValue({ success: false, error: 'Session s1 is archived' });
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      const result = await caller.cyboflow.sessions.getSummary({ sessionId: 's1' });
      expect(result).toEqual({ success: false, error: 'Session s1 is archived' });
    });

    it('rename forwards both fields and echoes the updated row back', async () => {
      const sessionOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      const result = await caller.cyboflow.sessions.rename({ sessionId: 's1', newName: 'renamed' });
      expect(sessionOps.rename).toHaveBeenCalledWith({ sessionId: 's1', newName: 'renamed' });
      expect(result).toEqual({ success: true, data: { id: 's1', name: 'renamed' } });
    });

    it('dismissAsk forwards the sessionId and passes the envelope through', async () => {
      const sessionOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      const result = await caller.cyboflow.sessions.dismissAsk({ sessionId: 's1' });
      expect(sessionOps.dismissAsk).toHaveBeenCalledWith({ sessionId: 's1' });
      expect(result).toEqual({ success: true });
    });

    it("dismissAsk's validation-failure envelope passes through byte-identical", async () => {
      const sessionOps = makeFakeOps();
      sessionOps.dismissAsk.mockResolvedValue({ success: false, error: 'Session s1 not found' });
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      const result = await caller.cyboflow.sessions.dismissAsk({ sessionId: 's1' });
      expect(result).toEqual({ success: false, error: 'Session s1 not found' });
    });

    it('toggleFavorite passes the new favourite state through', async () => {
      const sessionOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      const result = await caller.cyboflow.sessions.toggleFavorite({ sessionId: 's1' });
      expect(result).toEqual({ success: true, data: { isFavorite: true } });
    });

    it("updateAgentPermissionMode's invalid-mode failure is a RETURNED envelope, not a throw", async () => {
      // The whole reason `mode` is z.string() rather than z.enum: the legacy
      // channel answered an unrecognized mode with this envelope, and the
      // composer pill reads `error` off it. A zod enum would have turned it into
      // a BAD_REQUEST rejection instead.
      const sessionOps = makeFakeOps();
      sessionOps.updateAgentPermissionMode.mockResolvedValue({
        success: false,
        error: 'Invalid agent permission mode: nonsense',
      });
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      const result = await caller.cyboflow.sessions.updateAgentPermissionMode({
        sessionId: 's1',
        mode: 'nonsense',
      });
      expect(sessionOps.updateAgentPermissionMode).toHaveBeenCalledWith({
        sessionId: 's1',
        mode: 'nonsense',
      });
      expect(result).toEqual({ success: false, error: 'Invalid agent permission mode: nonsense' });
    });

    it('updateSessionMcps forwards the deny list', async () => {
      const sessionOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      await caller.cyboflow.sessions.updateSessionMcps({
        sessionId: 's1',
        disabledMcpServers: ['peekaboo', 'playwright'],
      });
      expect(sessionOps.updateSessionMcps).toHaveBeenCalledWith({
        sessionId: 's1',
        disabledMcpServers: ['peekaboo', 'playwright'],
      });
    });

    it('reorder forwards the whole ordering array', async () => {
      const sessionOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      await caller.cyboflow.sessions.reorder({
        sessionOrders: [{ id: 's1', displayOrder: 0 }, { id: 's2', displayOrder: 1 }],
      });
      expect(sessionOps.reorder).toHaveBeenCalledWith({
        sessionOrders: [{ id: 's1', displayOrder: 0 }, { id: 's2', displayOrder: 1 }],
      });
    });

    it('getArchiveProgress takes no input and passes the payload through', async () => {
      const sessionOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      const result = await caller.cyboflow.sessions.getArchiveProgress();
      expect(result).toEqual({ success: true, data: { tasks: [], activeCount: 0, totalCount: 0 } });
    });

    it('a plain failure envelope also passes through untouched', async () => {
      const sessionOps = makeFakeOps();
      sessionOps.get.mockResolvedValue({ success: false, error: 'Session not found' });
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      const result = await caller.cyboflow.sessions.get({ sessionId: 's1' });
      expect(result).toEqual({ success: false, error: 'Session not found' });
    });
  });

  // -------------------------------------------------------------------------
  // (b) zod's boundary — what it rejects, and what it must let past.
  // -------------------------------------------------------------------------
  describe('(b) rejects malformed input before it reaches sessionOps', () => {
    it('get rejects an empty sessionId (min length 1)', async () => {
      const sessionOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      await expect(caller.cyboflow.sessions.get({ sessionId: '' })).rejects.toSatisfy(isBadRequest);
      expect(sessionOps.get).not.toHaveBeenCalled();
    });

    it('rename rejects an empty newName', async () => {
      const sessionOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      await expect(
        caller.cyboflow.sessions.rename({ sessionId: 's1', newName: '' }),
      ).rejects.toSatisfy(isBadRequest);
      expect(sessionOps.rename).not.toHaveBeenCalled();
    });

    it('listQuick rejects a non-integer projectId', async () => {
      const sessionOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      await expect(caller.cyboflow.sessions.listQuick({ projectId: 1.5 })).rejects.toSatisfy(
        isBadRequest,
      );
      expect(sessionOps.listQuick).not.toHaveBeenCalled();
    });

    it('updateSessionPlugins rejects a non-string entry in the allow list', async () => {
      const sessionOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      await expect(
        caller.cyboflow.sessions.updateSessionPlugins({
          sessionId: 's1',
          enabledPlugins: [42 as unknown as string],
        }),
      ).rejects.toSatisfy(isBadRequest);
      expect(sessionOps.updateSessionPlugins).not.toHaveBeenCalled();
    });

    it('reorder rejects a non-integer displayOrder', async () => {
      const sessionOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      await expect(
        caller.cyboflow.sessions.reorder({ sessionOrders: [{ id: 's1', displayOrder: 0.5 }] }),
      ).rejects.toSatisfy(isBadRequest);
      expect(sessionOps.reorder).not.toHaveBeenCalled();
    });
  });

  describe('(b2) the inputs the schema must NOT reject', () => {
    it('setActiveSession accepts null — that is how the sidebar clears the selection', async () => {
      const sessionOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      const result = await caller.cyboflow.sessions.setActiveSession({ sessionId: null });
      expect(sessionOps.setActiveSession).toHaveBeenCalledWith({ sessionId: null });
      expect(result).toEqual({ success: true });
    });

    it('listQuick accepts an omitted projectId — the cross-project review home', async () => {
      const sessionOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      await caller.cyboflow.sessions.listQuick({});
      expect(sessionOps.listQuick).toHaveBeenCalledWith({});
    });

    it('updateAgentPermissionMode accepts an arbitrary mode string, leaving the verdict to ops', async () => {
      const sessionOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      await caller.cyboflow.sessions.updateAgentPermissionMode({ sessionId: 's1', mode: 'nonsense' });
      expect(sessionOps.updateAgentPermissionMode).toHaveBeenCalledWith({
        sessionId: 's1',
        mode: 'nonsense',
      });
    });

    it('updateSessionMcps accepts an empty deny list (the all-servers-load default)', async () => {
      const sessionOps = makeFakeOps();
      const caller = appRouter.createCaller(createContext({ sessionOps }));
      await caller.cyboflow.sessions.updateSessionMcps({ sessionId: 's1', disabledMcpServers: [] });
      expect(sessionOps.updateSessionMcps).toHaveBeenCalledWith({
        sessionId: 's1',
        disabledMcpServers: [],
      });
    });
  });

  // -------------------------------------------------------------------------
  // (c) Missing ctx.sessionOps → PRECONDITION_FAILED.
  // -------------------------------------------------------------------------
  describe('(c) missing ctx.sessionOps → PRECONDITION_FAILED', () => {
    it('getAll', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(caller.cyboflow.sessions.getAll()).rejects.toSatisfy(isPrecond);
    });

    it('getStatistics', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(caller.cyboflow.sessions.getStatistics({ sessionId: 's1' })).rejects.toSatisfy(
        isPrecond,
      );
    });

    it('getArchiveProgress', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(caller.cyboflow.sessions.getArchiveProgress()).rejects.toSatisfy(isPrecond);
    });

    it('rename', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(
        caller.cyboflow.sessions.rename({ sessionId: 's1', newName: 'x' }),
      ).rejects.toSatisfy(isPrecond);
    });

    it('setActiveSession', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(
        caller.cyboflow.sessions.setActiveSession({ sessionId: null }),
      ).rejects.toSatisfy(isPrecond);
    });

    it('dismissAsk', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(
        caller.cyboflow.sessions.dismissAsk({ sessionId: 's1' }),
      ).rejects.toSatisfy(isPrecond);
    });
  });
});
