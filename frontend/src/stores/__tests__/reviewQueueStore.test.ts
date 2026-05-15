/**
 * Unit tests for the reviewQueueStore pure reducers.
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
import { describe, it, expect, vi } from 'vitest';
import type { Approval } from '../../../../shared/types/approvals';

// Mock trpc-electron/renderer before any reviewQueueStore import so the
// module evaluates without the Electron IPC bridge.
// Path is relative to this test file: ../../utils/trpcClient resolves to
// frontend/src/utils/trpcClient.ts (two dirs up from __tests__, then utils/).
vi.mock('../../utils/trpcClient', () => ({
  trpc: {
    cyboflow: {
      approvals: {
        listPending: { query: vi.fn().mockResolvedValue([]) },
      },
      events: {
        onApprovalCreated: {
          subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
        },
      },
    },
  },
}));

import {
  pureAddApproval,
  pureRemoveApproval,
  pureReplaceAll,
} from '../reviewQueueStore';

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
    const result = pureReplaceAll([A], [A]);
    expect(result).not.toBe([A]); // reference inequality
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
