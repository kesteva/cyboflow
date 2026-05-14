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
 *   7. cyboflow.events.onStreamEvent is a placeholder: yields zero events before
 *      signal abort and terminates cleanly when the signal is aborted.
 *   8. cyboflow.events.onApprovalCreated is a placeholder: yields zero events
 *      before signal abort and terminates cleanly when the signal is aborted.
 */
import { describe, it, expect } from 'vitest';
import { TRPCError, callProcedure, isAsyncIterable } from '@trpc/server/unstable-core-do-not-import';
import { createContext } from '../context';
import { appRouter } from '../router';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNotImplemented(err: unknown): boolean {
  return err instanceof TRPCError && err.code === 'METHOD_NOT_SUPPORTED';
}

/**
 * Invoke a subscription procedure via tRPC's internal `callProcedure` API
 * and return the result as-is (should be an AsyncIterable for v11 subscriptions).
 *
 * We use `callProcedure` rather than `createCaller` because `createCaller` in
 * tRPC v11 only supports queries and mutations, not subscriptions.
 */
async function callSubscription(
  path: string,
  input: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  return callProcedure({
    router: appRouter,
    ctx: createContext(),
    path,
    type: 'subscription',
    getRawInput: async () => input,
    input,
    signal,
    batchIndex: 0,
  });
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
    // explicit by asserting the error code is METHOD_NOT_SUPPORTED, not UNAUTHORIZED.
    const err = await caller.cyboflow.runs.list({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('METHOD_NOT_SUPPORTED');
    expect((err as TRPCError).code).not.toBe('UNAUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// Subscription placeholder tests
//
// These tests verify that the events.onStreamEvent and events.onApprovalCreated
// subscription procedures satisfy AC #5: they yield ZERO events before the
// abort signal fires, and terminate cleanly (no hang) once the signal is
// aborted.
//
// The test races the subscription drain against an immediate abort, then asserts
// the iterable produced no items.
// ---------------------------------------------------------------------------

describe('appRouter subscription placeholders', () => {
  it('cyboflow.events.onStreamEvent yields zero events and terminates on abort', async () => {
    const controller = new AbortController();

    // Invoke the subscription — for tRPC v11 async-generator subscriptions,
    // callProcedure returns the generator directly.
    const result = await callSubscription(
      'cyboflow.events.onStreamEvent',
      { runId: 'run-1' },
      controller.signal,
    );

    expect(isAsyncIterable(result)).toBe(true);

    const iterable = result as AsyncIterable<unknown>;
    const collected: unknown[] = [];

    // Abort immediately before draining — the placeholder awaits the abort
    // signal, so this causes it to return without yielding any event.
    controller.abort();

    for await (const ev of iterable) {
      collected.push(ev);
    }

    expect(collected).toHaveLength(0);
  });

  it('cyboflow.events.onApprovalCreated yields zero events and terminates on abort', async () => {
    const controller = new AbortController();

    const result = await callSubscription(
      'cyboflow.events.onApprovalCreated',
      undefined,
      controller.signal,
    );

    expect(isAsyncIterable(result)).toBe(true);

    const iterable = result as AsyncIterable<unknown>;
    const collected: unknown[] = [];

    controller.abort();

    for await (const ev of iterable) {
      collected.push(ev);
    }

    expect(collected).toHaveLength(0);
  });
});
