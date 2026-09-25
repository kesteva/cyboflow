/**
 * Tests for the cyboflow.config tRPC router — the PILOT slice of the
 * IPC→tRPC migration (docs/CODE-PATTERNS.md). Exercises:
 *   (a) each procedure delegates to ctx.configOps and returns its envelope
 *       untouched (the router does no re-shaping).
 *   (b) applyRunTypeDefault rejects a malformed `op` with a zod BAD_REQUEST,
 *       never reaching ctx.configOps.
 *   (c) every procedure throws PRECONDITION_FAILED when ctx.configOps is
 *       absent (the createContext default).
 *   (d) update rejects a non-object input before it reaches ctx.configOps.
 */
import { describe, it, expect, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import type { ConfigOpsLike } from '../../contracts/configOps';
import type { AppConfig, UpdateConfigRequest } from '../../../../types/config';

function isPrecond(err: unknown): boolean {
  return err instanceof TRPCError && err.code === 'PRECONDITION_FAILED';
}

function isBadRequest(err: unknown): boolean {
  return err instanceof TRPCError && err.code === 'BAD_REQUEST';
}

function makeFakeConfigOps(): ConfigOpsLike & {
  getConfig: ReturnType<typeof vi.fn>;
  updateConfig: ReturnType<typeof vi.fn>;
  applyRunTypeDefault: ReturnType<typeof vi.fn>;
  getSessionPreferences: ReturnType<typeof vi.fn>;
  updateSessionPreferences: ReturnType<typeof vi.fn>;
} {
  return {
    getConfig: vi.fn().mockResolvedValue({ success: true, data: { verbose: true } as AppConfig }),
    updateConfig: vi.fn().mockResolvedValue({ success: true }),
    applyRunTypeDefault: vi.fn().mockResolvedValue({
      success: true,
      data: { previous: undefined, config: {} as AppConfig },
    }),
    getSessionPreferences: vi.fn().mockResolvedValue({
      success: true,
      data: { sessionCount: 1, toolType: 'none' },
    }),
    updateSessionPreferences: vi.fn().mockResolvedValue({ success: true }),
  };
}

describe('cyboflow.config', () => {
  // -------------------------------------------------------------------------
  // (a) Delegation: the router passes through ctx.configOps's envelope as-is.
  // -------------------------------------------------------------------------
  describe('(a) delegates to ctx.configOps and returns its envelope untouched', () => {
    it('get', async () => {
      const configOps = makeFakeConfigOps();
      const caller = appRouter.createCaller(createContext({ configOps }));
      const result = await caller.cyboflow.config.get();
      expect(configOps.getConfig).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: true, data: { verbose: true } });
    });

    it('update', async () => {
      const configOps = makeFakeConfigOps();
      const caller = appRouter.createCaller(createContext({ configOps }));
      const updates: UpdateConfigRequest = { verbose: false };
      const result = await caller.cyboflow.config.update(updates);
      expect(configOps.updateConfig).toHaveBeenCalledWith(updates);
      expect(result).toEqual({ success: true });
    });

    it('applyRunTypeDefault', async () => {
      const configOps = makeFakeConfigOps();
      const caller = appRouter.createCaller(createContext({ configOps }));
      const result = await caller.cyboflow.config.applyRunTypeDefault({
        key: 'quick',
        op: { kind: 'merge', value: { model: 'opus' } },
      });
      expect(configOps.applyRunTypeDefault).toHaveBeenCalledWith('quick', {
        kind: 'merge',
        value: { model: 'opus' },
      });
      expect(result).toEqual({
        success: true,
        data: { previous: undefined, config: {} },
      });
    });

    it('getSessionPreferences', async () => {
      const configOps = makeFakeConfigOps();
      const caller = appRouter.createCaller(createContext({ configOps }));
      const result = await caller.cyboflow.config.getSessionPreferences();
      expect(configOps.getSessionPreferences).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: true, data: { sessionCount: 1, toolType: 'none' } });
    });

    it('updateSessionPreferences', async () => {
      const configOps = makeFakeConfigOps();
      const caller = appRouter.createCaller(createContext({ configOps }));
      const preferences = { sessionCount: 2, toolType: 'claude' as const };
      const result = await caller.cyboflow.config.updateSessionPreferences(preferences);
      expect(configOps.updateSessionPreferences).toHaveBeenCalledWith(preferences);
      expect(result).toEqual({ success: true });
    });

    it('a failure envelope from ctx.configOps also passes through untouched', async () => {
      const configOps = makeFakeConfigOps();
      configOps.getConfig.mockResolvedValue({ success: false, error: 'boom' });
      const caller = appRouter.createCaller(createContext({ configOps }));
      const result = await caller.cyboflow.config.get();
      expect(result).toEqual({ success: false, error: 'boom' });
    });
  });

  // -------------------------------------------------------------------------
  // (b) applyRunTypeDefault: malformed op → zod BAD_REQUEST, never delegated.
  // -------------------------------------------------------------------------
  describe('(b) applyRunTypeDefault rejects a malformed op', () => {
    it('an unknown discriminant kind is rejected before reaching configOps', async () => {
      const configOps = makeFakeConfigOps();
      const caller = appRouter.createCaller(createContext({ configOps }));
      await expect(
        caller.cyboflow.config.applyRunTypeDefault({
          key: 'quick',
          op: { kind: 'delete' } as never,
        }),
      ).rejects.toSatisfy(isBadRequest);
      expect(configOps.applyRunTypeDefault).not.toHaveBeenCalled();
    });

    it('an empty key is rejected (min length 1)', async () => {
      const configOps = makeFakeConfigOps();
      const caller = appRouter.createCaller(createContext({ configOps }));
      await expect(
        caller.cyboflow.config.applyRunTypeDefault({
          key: '',
          op: { kind: 'merge', value: {} },
        }),
      ).rejects.toSatisfy(isBadRequest);
      expect(configOps.applyRunTypeDefault).not.toHaveBeenCalled();
    });

    it('an unrecognized field on a merge value is rejected (.strict())', async () => {
      const configOps = makeFakeConfigOps();
      const caller = appRouter.createCaller(createContext({ configOps }));
      await expect(
        caller.cyboflow.config.applyRunTypeDefault({
          key: 'quick',
          op: { kind: 'merge', value: { notAField: true } } as never,
        }),
      ).rejects.toSatisfy(isBadRequest);
      expect(configOps.applyRunTypeDefault).not.toHaveBeenCalled();
    });

    it('a whitespace-only key is rejected, not just an empty one', async () => {
      const configOps = makeFakeConfigOps();
      const caller = appRouter.createCaller(createContext({ configOps }));
      await expect(
        caller.cyboflow.config.applyRunTypeDefault({
          key: '   ',
          op: { kind: 'merge', value: {} },
        }),
      ).rejects.toSatisfy(isBadRequest);
      expect(configOps.applyRunTypeDefault).not.toHaveBeenCalled();
    });

    it('a blank/whitespace-only merge model is rejected rather than suppressing the launch-model floor', async () => {
      const configOps = makeFakeConfigOps();
      const caller = appRouter.createCaller(createContext({ configOps }));
      await expect(
        caller.cyboflow.config.applyRunTypeDefault({
          key: 'quick',
          op: { kind: 'merge', value: { model: '   ' } },
        }),
      ).rejects.toSatisfy(isBadRequest);
      expect(configOps.applyRunTypeDefault).not.toHaveBeenCalled();
    });

    it('a blank/whitespace-only replace model is rejected', async () => {
      const configOps = makeFakeConfigOps();
      const caller = appRouter.createCaller(createContext({ configOps }));
      await expect(
        caller.cyboflow.config.applyRunTypeDefault({
          key: 'quick',
          op: { kind: 'replace', value: { model: '' } },
        }),
      ).rejects.toSatisfy(isBadRequest);
      expect(configOps.applyRunTypeDefault).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // (c) Missing ctx.configOps → PRECONDITION_FAILED on every procedure.
  // -------------------------------------------------------------------------
  describe('(c) missing ctx.configOps → PRECONDITION_FAILED', () => {
    it('get', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(caller.cyboflow.config.get()).rejects.toSatisfy(isPrecond);
    });

    it('update', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(caller.cyboflow.config.update({ verbose: true })).rejects.toSatisfy(isPrecond);
    });

    it('applyRunTypeDefault', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(
        caller.cyboflow.config.applyRunTypeDefault({ key: 'quick', op: { kind: 'merge', value: {} } }),
      ).rejects.toSatisfy(isPrecond);
    });

    it('getSessionPreferences', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(caller.cyboflow.config.getSessionPreferences()).rejects.toSatisfy(isPrecond);
    });

    it('updateSessionPreferences', async () => {
      const caller = appRouter.createCaller(createContext());
      await expect(
        caller.cyboflow.config.updateSessionPreferences({ sessionCount: 1, toolType: 'none' }),
      ).rejects.toSatisfy(isPrecond);
    });
  });

  // -------------------------------------------------------------------------
  // (d) update rejects a non-object input before it reaches ctx.configOps.
  // -------------------------------------------------------------------------
  describe('(d) update rejects a non-object input', () => {
    it('null is rejected', async () => {
      const configOps = makeFakeConfigOps();
      const caller = appRouter.createCaller(createContext({ configOps }));
      await expect(caller.cyboflow.config.update(null as never)).rejects.toSatisfy(isBadRequest);
      expect(configOps.updateConfig).not.toHaveBeenCalled();
    });

    it('an array is rejected', async () => {
      const configOps = makeFakeConfigOps();
      const caller = appRouter.createCaller(createContext({ configOps }));
      await expect(caller.cyboflow.config.update([] as never)).rejects.toSatisfy(isBadRequest);
      expect(configOps.updateConfig).not.toHaveBeenCalled();
    });

    it('a string is rejected', async () => {
      const configOps = makeFakeConfigOps();
      const caller = appRouter.createCaller(createContext({ configOps }));
      await expect(caller.cyboflow.config.update('nope' as never)).rejects.toSatisfy(isBadRequest);
      expect(configOps.updateConfig).not.toHaveBeenCalled();
    });
  });
});
