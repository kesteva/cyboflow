/**
 * Unit tests for the reviewQueueStore pure reducers and init() idempotency.
 *
 * These tests exercise the pure-function exports from reviewQueueStore.ts
 * without requiring a live tRPC connection or a real Zustand store instance.
 * The three reducers under test have well-defined correctness properties:
 *
 *   1. replaceAll  — atomic queue replacement
 *   2. addApproval — idempotent on duplicate id
 *   3. removeApproval — no-op on missing id
 *
 * The tRPC client is mocked at the module level so the test can import
 * from reviewQueueStore.ts without a live Electron IPC bridge.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Approval } from '../../../../shared/types/approvals';

// Mutable mock references — replaced in beforeEach so each test gets a fresh spy.
let mockListPendingQuery: ReturnType<typeof vi.fn>;
let mockSubscribeUnsubscribe: ReturnType<typeof vi.fn>;
let mockSubscribe: ReturnType<typeof vi.fn>;

// Mock trpc-electron/renderer before any reviewQueueStore import so the
// module evaluates without the Electron IPC bridge.
// Path is relative to this test file: ../../trpc/client resolves to
// frontend/src/trpc/client.ts (canonical renderer-side tRPC client).
vi.mock('../../trpc/client', () => {
  // These factory functions defer to the outer-scope mutable references so
  // that replacing the references in beforeEach affects each test.
  return {
    trpc: {
      cyboflow: {
        approvals: {
          listPending: {
            get query() { return mockListPendingQuery; },
          },
        },
        events: {
          onApprovalCreated: {
            get subscribe() { return mockSubscribe; },
          },
          setBadgeCount: {
            mutate: vi.fn().mockResolvedValue(undefined),
          },
        },
      },
    },
  };
});

import {
  pureAddApproval,
  pureRemoveApproval,
  pureReplaceAll,
  useReviewQueueStore,
} from '../reviewQueueStore';

// ---------------------------------------------------------------------------
// Reset mock spies before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockListPendingQuery = vi.fn().mockResolvedValue([]);
  mockSubscribeUnsubscribe = vi.fn();
  mockSubscribe = vi.fn().mockReturnValue({ unsubscribe: mockSubscribeUnsubscribe });

  // Reset the store's closure-private `initialized` flag by calling the
  // returned unsubscribe from any prior init(), then resetting Zustand state.
  // We reach inside via getState() — the closure guard is reset only through
  // the unsubscribe path, so we must call it if init was previously invoked.
  // For safety, forcibly reset by re-creating the store's internal state to
  // 'idle'; the initialized flag resets via the unsubscribe path in each test.
  useReviewQueueStore.setState({ queue: [], connectionStatus: 'idle' });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApproval(overrides: Partial<Approval> & { id: string }): Approval {
  return {
    id: overrides.id,
    runId: overrides.runId ?? 'run-1',
    workflowName: overrides.workflowName ?? 'Test Workflow',
    toolName: overrides.toolName ?? 'Bash',
    payloadPreview: overrides.payloadPreview ?? 'echo hello',
    rationale: overrides.rationale ?? null,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    status: overrides.status ?? 'pending',
  };
}

const A = makeApproval({ id: 'approval-a' });
const B = makeApproval({ id: 'approval-b' });
const C = makeApproval({ id: 'approval-c' });

// ---------------------------------------------------------------------------
// replaceAll
// ---------------------------------------------------------------------------

describe('pureReplaceAll', () => {
  it('replaces a populated queue with an empty list', () => {
    const queue = [A, B];
    const result = pureReplaceAll(queue, []);
    expect(result).toHaveLength(0);
  });

  it('replaces an empty queue with a populated list', () => {
    const result = pureReplaceAll([], [A, B, C]);
    expect(result).toHaveLength(3);
    expect(result.map((a) => a.id)).toEqual(['approval-a', 'approval-b', 'approval-c']);
  });

  it('replaces atomically — original queue is not mutated', () => {
    const original = [A, B];
    const replacement = [C];
    const result = pureReplaceAll(original, replacement);
    expect(result).not.toBe(original);
    expect(original).toHaveLength(2); // original unchanged
    expect(result).toHaveLength(1);
  });

  it('returns a new array even when items are identical', () => {
    const replacement = [A];
    const result = pureReplaceAll([], replacement);
    expect(result).not.toBe(replacement); // reference inequality between input and output
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// addApproval (idempotency)
// ---------------------------------------------------------------------------

describe('pureAddApproval', () => {
  it('adds an approval that is not yet in the queue', () => {
    const result = pureAddApproval([], A);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('approval-a');
  });

  it('is idempotent — adding the same id twice keeps length at 1', () => {
    const after1 = pureAddApproval([], A);
    const after2 = pureAddApproval(after1, A);
    expect(after2).toHaveLength(1);
  });

  it('returns the same array reference when idempotent (no-op path)', () => {
    const existing = [A];
    const result = pureAddApproval(existing, A);
    expect(result).toBe(existing); // same reference — no allocation
  });

  it('appends to end of queue when id is new', () => {
    const result = pureAddApproval([A, B], C);
    expect(result.map((a) => a.id)).toEqual(['approval-a', 'approval-b', 'approval-c']);
  });
});

// ---------------------------------------------------------------------------
// removeApproval (no-op on missing id)
// ---------------------------------------------------------------------------

describe('pureRemoveApproval', () => {
  it('removes an approval that is present', () => {
    const result = pureRemoveApproval([A, B, C], 'approval-b');
    expect(result.map((a) => a.id)).toEqual(['approval-a', 'approval-c']);
  });

  it('is a no-op when the id is not present — does not throw', () => {
    expect(() => pureRemoveApproval([], 'nonexistent')).not.toThrow();
    const result = pureRemoveApproval([], 'nonexistent');
    expect(result).toHaveLength(0);
  });

  it('returns a new array even when no item was removed', () => {
    const original = [A];
    const result = pureRemoveApproval(original, 'nonexistent');
    // Filter always returns a new array in JS, length unchanged
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('approval-a');
  });

  it('handles removing from a single-element queue', () => {
    const result = pureRemoveApproval([A], 'approval-a');
    expect(result).toHaveLength(0);
  });

  it('does not remove approvals with a different id prefix', () => {
    const x = makeApproval({ id: 'approval-ab' });
    const result = pureRemoveApproval([A, x], 'approval-a');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('approval-ab');
  });
});

// ---------------------------------------------------------------------------
// init() idempotency
// ---------------------------------------------------------------------------

describe('init() idempotency', () => {
  // Track any unsubscribe that a test may not clean up itself, so afterEach
  // can reset the closure-private initialized flag even if the test threw.
  let activeUnsub: (() => void) | null = null;

  afterEach(() => {
    if (activeUnsub) {
      activeUnsub();
      activeUnsub = null;
    }
  });

  it('double init() — listPending.query called exactly once and subscribe called exactly once', () => {
    // First init — starts the subscription
    const unsub1 = useReviewQueueStore.getState().init();
    activeUnsub = unsub1;

    // Second init before any unsubscribe — must be a no-op
    const unsub2 = useReviewQueueStore.getState().init();

    expect(mockListPendingQuery).toHaveBeenCalledTimes(1);
    expect(mockSubscribe).toHaveBeenCalledTimes(1);

    // Both calls should return the same unsubscribe function
    expect(unsub1).toBe(unsub2);
  });

  it('unsubscribe then init() re-subscribes — subscribe called twice', () => {
    // First init
    const unsub1 = useReviewQueueStore.getState().init();
    expect(mockSubscribe).toHaveBeenCalledTimes(1);

    // Unsubscribe — resets the initialized flag
    unsub1();
    expect(mockSubscribeUnsubscribe).toHaveBeenCalledTimes(1);

    // Second init after unsubscribe — should re-subscribe
    const unsub2 = useReviewQueueStore.getState().init();
    activeUnsub = unsub2;

    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect(mockListPendingQuery).toHaveBeenCalledTimes(2);
  });

  it('onError resets closure state so a subsequent init() re-subscribes', () => {
    // First init — captures the onError callback
    let capturedOnError: ((err: unknown) => void) | undefined;
    mockSubscribe = vi.fn().mockImplementation((_input, handlers: { onError?: (err: unknown) => void }) => {
      capturedOnError = handlers.onError;
      return { unsubscribe: mockSubscribeUnsubscribe };
    });

    const unsub1 = useReviewQueueStore.getState().init();
    activeUnsub = unsub1;

    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(capturedOnError).toBeDefined();

    // Trigger the subscription error
    capturedOnError!(new Error('connection lost'));

    // The store should be disconnected and closure state cleared
    expect(useReviewQueueStore.getState().connectionStatus).toBe('disconnected');
    expect(mockSubscribeUnsubscribe).toHaveBeenCalledTimes(1);

    // Now a second init() should NOT be a no-op — it must re-subscribe
    // Reset mockSubscribeUnsubscribe for the fresh subscription
    mockSubscribeUnsubscribe = vi.fn();
    mockSubscribe = vi.fn().mockImplementation((_input, handlers: { onError?: (err: unknown) => void }) => {
      capturedOnError = handlers.onError;
      return { unsubscribe: mockSubscribeUnsubscribe };
    });

    const unsub2 = useReviewQueueStore.getState().init();
    activeUnsub = unsub2;

    expect(mockSubscribe).toHaveBeenCalledTimes(1); // second subscribe call
    expect(mockListPendingQuery).toHaveBeenCalledTimes(2); // listPending called again
  });

  it('StrictMode double-invoke — exactly one live subscription after both mount effects settle', () => {
    // React StrictMode in development invokes effects twice: mount → cleanup → mount.
    // Simulate: init() → unsubscribe() → init()

    // First effect mount
    const unsub1 = useReviewQueueStore.getState().init();

    // StrictMode unmount cleanup — React calls the returned unsubscribe
    unsub1();

    // StrictMode second mount — React mounts again
    const unsub2 = useReviewQueueStore.getState().init();
    activeUnsub = unsub2;

    // After the StrictMode sequence there must be exactly ONE live subscription.
    // subscribe was called twice (once per mount), but unsubscribe was called
    // once (for the first mount's cleanup), so exactly one live subscription remains.
    expect(mockSubscribe).toHaveBeenCalledTimes(2);
    expect(mockSubscribeUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
