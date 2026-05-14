/**
 * Unit tests for the tRPC appRouter shape and createContext.
 *
 * Uses tRPC's createCaller to invoke procedures in-process — no IPC link
 * required, which is the supported tRPC v11 unit-test idiom.
 *
 * Tests:
 *   1. createContext() returns { userId: 'local' }.
 *   2. protectedProcedure accepts a context with userId defined (no UNAUTHORIZED).
 *   3. appRouter.cyboflow.runs.list throws NOT_IMPLEMENTED.
 *   4. appRouter.cyboflow.approvals.listPending throws NOT_IMPLEMENTED.
 *   5. appRouter.cyboflow.workflows.list throws NOT_IMPLEMENTED.
 *   6. appRouter.cyboflow.workflows.get throws NOT_IMPLEMENTED.
 */
import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import { createContext } from '../context';
import { appRouter } from '../router';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNotImplemented(err: unknown): boolean {
  return err instanceof TRPCError && err.code === 'NOT_IMPLEMENTED';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createContext', () => {
  it("returns { userId: 'local' }", () => {
    const ctx = createContext();
    expect(ctx).toEqual({ userId: 'local' });
  });
});

describe('appRouter (createCaller)', () => {
  const caller = appRouter.createCaller(createContext());

  it('cyboflow.runs.list throws NOT_IMPLEMENTED', async () => {
    await expect(caller.cyboflow.runs.list({})).rejects.toSatisfy(isNotImplemented);
  });

  it('cyboflow.runs.start throws NOT_IMPLEMENTED', async () => {
    await expect(
      caller.cyboflow.runs.start({ workflowId: 'wf-1', projectId: 'proj-1' }),
    ).rejects.toSatisfy(isNotImplemented);
  });

  it('cyboflow.runs.cancel throws NOT_IMPLEMENTED', async () => {
    await expect(caller.cyboflow.runs.cancel({ runId: 'run-1' })).rejects.toSatisfy(
      isNotImplemented,
    );
  });

  it('cyboflow.runs.get throws NOT_IMPLEMENTED', async () => {
    await expect(caller.cyboflow.runs.get({ runId: 'run-1' })).rejects.toSatisfy(
      isNotImplemented,
    );
  });

  it('cyboflow.approvals.listPending throws NOT_IMPLEMENTED', async () => {
    await expect(caller.cyboflow.approvals.listPending()).rejects.toSatisfy(isNotImplemented);
  });

  it('cyboflow.approvals.approve throws NOT_IMPLEMENTED', async () => {
    await expect(
      caller.cyboflow.approvals.approve({ approvalId: 'a-1' }),
    ).rejects.toSatisfy(isNotImplemented);
  });

  it('cyboflow.approvals.reject throws NOT_IMPLEMENTED', async () => {
    await expect(
      caller.cyboflow.approvals.reject({ approvalId: 'a-1' }),
    ).rejects.toSatisfy(isNotImplemented);
  });

  it('cyboflow.workflows.list throws NOT_IMPLEMENTED', async () => {
    await expect(caller.cyboflow.workflows.list()).rejects.toSatisfy(isNotImplemented);
  });

  it('cyboflow.workflows.get throws NOT_IMPLEMENTED', async () => {
    await expect(
      caller.cyboflow.workflows.get({ workflowId: 'wf-1' }),
    ).rejects.toSatisfy(isNotImplemented);
  });

  it('protectedProcedure accepts a context with userId defined (no UNAUTHORIZED)', async () => {
    // All procedures use protectedProcedure; if any threw UNAUTHORIZED we
    // would have seen it in the tests above. This test makes the intent
    // explicit by asserting the error code is NOT_IMPLEMENTED, not UNAUTHORIZED.
    const err = await caller.cyboflow.runs.list({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('NOT_IMPLEMENTED');
    expect((err as TRPCError).code).not.toBe('UNAUTHORIZED');
  });
});
