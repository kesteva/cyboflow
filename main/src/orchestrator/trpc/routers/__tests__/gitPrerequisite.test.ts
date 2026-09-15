/**
 * Tests for the cyboflow.gitPrerequisite tRPC router — the onboarding git
 * probe + identity writer. Exercises: (a) each procedure delegates to
 * ctx.gitPrerequisiteOps and returns its result untouched, (b) zod rejects a
 * malformed input before the ops layer is reached, (c) PRECONDITION_FAILED
 * when the ops are absent (the createContext default).
 */
import { describe, it, expect, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import type { GitPrerequisiteOpsLike } from '../../contracts/gitPrerequisiteOps';
import type { GitPrerequisiteResult } from '../../../../../../shared/types/gitPrerequisite';

const READY: GitPrerequisiteResult = {
  platform: 'darwin',
  binary: { found: true, path: '/usr/bin/git', version: '2.45.2' },
  identity: { name: 'Ada', email: 'ada@example.com' },
  state: 'ready',
};

function makeFakeOps(): GitPrerequisiteOpsLike & {
  detect: ReturnType<typeof vi.fn>;
  setIdentity: ReturnType<typeof vi.fn>;
} {
  return {
    detect: vi.fn().mockResolvedValue(READY),
    setIdentity: vi.fn().mockResolvedValue({ success: true, data: READY }),
  };
}

describe('cyboflow.gitPrerequisite', () => {
  it('detect delegates the refresh flag and returns the probe result untouched', async () => {
    const ops = makeFakeOps();
    const caller = appRouter.createCaller(createContext({ gitPrerequisiteOps: ops }));
    expect(await caller.cyboflow.gitPrerequisite.detect({ refresh: true })).toEqual(READY);
    expect(ops.detect).toHaveBeenCalledWith({ refresh: true });
  });

  it('setIdentity delegates the fields and returns the envelope untouched (either arm)', async () => {
    const ops = makeFakeOps();
    const caller = appRouter.createCaller(createContext({ gitPrerequisiteOps: ops }));
    expect(await caller.cyboflow.gitPrerequisite.setIdentity({ name: 'Ada', email: 'ada@example.com' })).toEqual({
      success: true,
      data: READY,
    });
    expect(ops.setIdentity).toHaveBeenCalledWith({ name: 'Ada', email: 'ada@example.com' });

    ops.setIdentity.mockResolvedValueOnce({ success: false, error: 'Enter a valid email address.' });
    expect(await caller.cyboflow.gitPrerequisite.setIdentity({ name: 'Ada', email: 'nope' })).toEqual({
      success: false,
      error: 'Enter a valid email address.',
    });
  });

  it('rejects malformed input with BAD_REQUEST before reaching the ops', async () => {
    const ops = makeFakeOps();
    const caller = appRouter.createCaller(createContext({ gitPrerequisiteOps: ops }));
    await expect(
      caller.cyboflow.gitPrerequisite.detect({ refresh: 'yes' } as unknown as { refresh: boolean }),
    ).rejects.toSatisfy((e) => e instanceof TRPCError && e.code === 'BAD_REQUEST');
    await expect(
      caller.cyboflow.gitPrerequisite.setIdentity({ name: 'Ada' } as unknown as { name: string; email: string }),
    ).rejects.toSatisfy((e) => e instanceof TRPCError && e.code === 'BAD_REQUEST');
    expect(ops.detect).not.toHaveBeenCalled();
    expect(ops.setIdentity).not.toHaveBeenCalled();
  });

  it('throws PRECONDITION_FAILED when the ops are not wired', async () => {
    const caller = appRouter.createCaller(createContext({}));
    await expect(caller.cyboflow.gitPrerequisite.detect({ refresh: false })).rejects.toSatisfy(
      (e) => e instanceof TRPCError && e.code === 'PRECONDITION_FAILED',
    );
  });
});
