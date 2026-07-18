/**
 * useUnifiedRunMessages tests — the run-scoped message source for the unified
 * chat, focused on the identity-preserving merge layer added to stop the
 * transcript re-parsing/re-rendering on every debounced live refetch.
 *
 * Covers:
 *   - mergeUnifiedMessages (pure): grown segments, tool-result mutation,
 *     deletion, identical snapshot returns the prior array reference.
 *   - the run-selection token guard: a live response for a run that is no longer
 *     selected is discarded.
 *   - the trailing debounced settle refetch still fires when streamEvents grow.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedMessage } from '../../../../../../shared/types/unifiedMessage';
import { useCyboflowStore } from '../../../../stores/cyboflowStore';
import type { StreamEvent } from '../../../../utils/cyboflowApi';
import {
  mergeUnifiedMessages,
  unifiedMessagesEqual,
  useUnifiedRunMessages,
} from '../useUnifiedRunMessages';

// The store starts an IPC subscription on setActiveRun — stub it out.
vi.mock('../../../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
}));

const mockList = vi.fn<(args: { runId: string }) => Promise<UnifiedMessage[]>>(async () => []);

vi.mock('../../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      runs: {
        listUnifiedMessages: {
          query: (args: { runId: string }) => mockList(args),
        },
      },
    },
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function user(id: string, text: string): UnifiedMessage {
  return { id, role: 'user', timestamp: '2026-07-17T00:00:00Z', segments: [{ type: 'text', content: text }] };
}
function assistant(id: string, ...segments: UnifiedMessage['segments']): UnifiedMessage {
  return { id, role: 'assistant', timestamp: '2026-07-17T00:00:01Z', segments };
}

/** A fresh structural clone so the next-snapshot objects are new instances. */
function clone(message: UnifiedMessage): UnifiedMessage {
  return JSON.parse(JSON.stringify(message)) as UnifiedMessage;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const streamEvent: StreamEvent = {
  type: 'assistant',
  payload: {
    type: 'assistant',
    message: { id: 'x', model: 'm', role: 'assistant', content: [{ type: 'text', text: 'delta' }] },
  },
  timestamp: '2026-07-17T00:00:02Z',
} as unknown as StreamEvent;

beforeEach(() => {
  mockList.mockReset();
  mockList.mockResolvedValue([]);
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
  });
});

// ---------------------------------------------------------------------------
// mergeUnifiedMessages (pure)
// ---------------------------------------------------------------------------

describe('mergeUnifiedMessages', () => {
  it('(a) reuses untouched rows and replaces a same-id assistant message whose segments grew', () => {
    const u1 = user('u1', 'hi');
    const a1 = assistant('a1', { type: 'text', content: 'partial' });
    const prev = [u1, a1];

    // Next snapshot: fresh objects; a1 gained a tool_call segment.
    const next = [
      clone(u1),
      assistant('a1', { type: 'text', content: 'partial' }, {
        type: 'tool_call',
        tool: { id: 't1', name: 'Read', status: 'success' },
      }),
    ];

    const merged = mergeUnifiedMessages(prev, next);

    expect(merged).not.toBe(prev);
    expect(merged[0]).toBe(u1); // untouched row reference-reused
    expect(merged[1]).toBe(next[1]); // grown row replaced with the new object
    expect(merged[1]).not.toBe(a1);
  });

  it('(b) replaces a row whose tool result mutated, reusing the sibling', () => {
    const u1 = user('u1', 'hi');
    const a1 = assistant('a1', {
      type: 'tool_call',
      tool: { id: 't1', name: 'Bash', status: 'pending' },
    });
    const prev = [u1, a1];

    const next = [
      clone(u1),
      assistant('a1', {
        type: 'tool_call',
        tool: { id: 't1', name: 'Bash', status: 'success', result: { content: 'done' } },
      }),
    ];

    const merged = mergeUnifiedMessages(prev, next);

    expect(merged[0]).toBe(u1);
    expect(merged[1]).toBe(next[1]);
    expect(merged[1]).not.toBe(a1);
  });

  it('(c) drops a message that disappeared from the snapshot', () => {
    const u1 = user('u1', 'hi');
    const a1 = assistant('a1', { type: 'text', content: 'reply' });
    const prev = [u1, a1];

    const next = [clone(u1)]; // a1 gone

    const merged = mergeUnifiedMessages(prev, next);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(u1);
    expect(merged.find((m) => m.id === 'a1')).toBeUndefined();
  });

  it('(d) returns the PRIOR array reference for an identical snapshot', () => {
    const prev = [user('u1', 'hi'), assistant('a1', { type: 'text', content: 'reply' })];
    const next = prev.map(clone); // deep-equal, all-new instances

    const merged = mergeUnifiedMessages(prev, next);

    expect(merged).toBe(prev); // whole-array identity preserved
  });

  it('does not resurrect an id that is only in prev, and respects fetched order', () => {
    const a = assistant('a', { type: 'text', content: 'a' });
    const b = assistant('b', { type: 'text', content: 'b' });
    const prev = [a, b];
    // Reordered snapshot (b before a) with fresh instances.
    const next = [clone(b), clone(a)];

    const merged = mergeUnifiedMessages(prev, next);

    expect(merged).not.toBe(prev);
    expect(merged.map((m) => m.id)).toEqual(['b', 'a']);
    expect(merged[0]).toBe(b);
    expect(merged[1]).toBe(a);
  });

  it('unifiedMessagesEqual compares the complete value, not just id', () => {
    const base = assistant('a1', { type: 'text', content: 'x' });
    expect(unifiedMessagesEqual(base, clone(base))).toBe(true);
    expect(
      unifiedMessagesEqual(base, assistant('a1', { type: 'text', content: 'y' })),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hook — token guard + settle refetch
// ---------------------------------------------------------------------------

describe('useUnifiedRunMessages — live path', () => {
  it('(f) fires the trailing debounced settle refetch when streamEvents grow', async () => {
    act(() => {
      useCyboflowStore.getState().setActiveRun('run-1');
    });

    renderHook(() => useUnifiedRunMessages('run-1'));

    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1)); // initial load

    act(() => {
      useCyboflowStore.getState().appendStreamEvent(streamEvent);
    });

    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(mockList).toHaveBeenLastCalledWith({ runId: 'run-1' });
  });

  it('(e) discards a live response for a run that is no longer selected', async () => {
    const deferreds: Deferred<UnifiedMessage[]>[] = [];
    mockList.mockImplementation(() => {
      const d = createDeferred<UnifiedMessage[]>();
      deferreds.push(d);
      return d.promise;
    });

    act(() => {
      useCyboflowStore.getState().setActiveRun('run-A');
    });

    const { result, rerender } = renderHook(({ runId }) => useUnifiedRunMessages(runId), {
      initialProps: { runId: 'run-A' },
    });

    // #0 = run-A initial load → resolve empty.
    await waitFor(() => expect(deferreds.length).toBe(1));
    await act(async () => {
      deferreds[0].resolve([]);
    });

    // Arm + fire the debounced live refetch for run-A; keep it pending.
    act(() => {
      useCyboflowStore.getState().appendStreamEvent(streamEvent);
    });
    await waitFor(() => expect(deferreds.length).toBe(2), { timeout: 2000 }); // #1 = run-A live (pending)

    // Switch to run-B before run-A's live response lands.
    const msgB = assistant('b1', { type: 'text', content: 'from B' });
    rerender({ runId: 'run-B' });
    await waitFor(() => expect(deferreds.length).toBe(3)); // #2 = run-B initial
    await act(async () => {
      deferreds[2].resolve([msgB]);
    });
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(['b1']));

    // The stale run-A response now arrives — it must NOT overwrite run-B.
    const staleA = assistant('a1', { type: 'text', content: 'stale from A' });
    await act(async () => {
      deferreds[1].resolve([staleA]);
    });

    expect(result.current.messages.map((m) => m.id)).toEqual(['b1']);
  });

  it('(j) commits only the LATEST of two overlapping same-run refetches (reverse-order resolution)', async () => {
    const deferreds: Deferred<UnifiedMessage[]>[] = [];
    mockList.mockImplementation(() => {
      const d = createDeferred<UnifiedMessage[]>();
      deferreds.push(d);
      return d.promise;
    });

    act(() => {
      useCyboflowStore.getState().setActiveRun('run-1');
    });
    const { result } = renderHook(() => useUnifiedRunMessages('run-1'));

    // #0 = initial load → resolve empty.
    await waitFor(() => expect(deferreds.length).toBe(1));
    await act(async () => {
      deferreds[0].resolve([]);
    });

    // Two debounced live refetches, both left pending: #1 (older), #2 (newer).
    act(() => {
      useCyboflowStore.getState().appendStreamEvent(streamEvent);
    });
    await waitFor(() => expect(deferreds.length).toBe(2), { timeout: 2000 });
    act(() => {
      useCyboflowStore.getState().appendStreamEvent(streamEvent);
    });
    await waitFor(() => expect(deferreds.length).toBe(3), { timeout: 2000 });

    // The NEWER request resolves first with the settled transcript...
    const settled = assistant('m1', { type: 'text', content: 'final reply' });
    await act(async () => {
      deferreds[2].resolve([settled]);
    });
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(['m1']));

    // ...then the OLDER request resolves with a pre-settlement snapshot. It has
    // no post-result trigger left behind it, so committing it would leave the
    // transcript stale — it must be discarded.
    await act(async () => {
      deferreds[1].resolve([]);
    });
    expect(result.current.messages.map((m) => m.id)).toEqual(['m1']);
    expect(result.current.messages[0].segments).toEqual([{ type: 'text', content: 'final reply' }]);
  });

  it('(k) an in-flight initial load cannot overwrite a newer live refetch', async () => {
    const deferreds: Deferred<UnifiedMessage[]>[] = [];
    mockList.mockImplementation(() => {
      const d = createDeferred<UnifiedMessage[]>();
      deferreds.push(d);
      return d.promise;
    });

    act(() => {
      useCyboflowStore.getState().setActiveRun('run-1');
    });
    const { result } = renderHook(() => useUnifiedRunMessages('run-1'));

    // #0 = initial load, left PENDING while a live refetch overtakes it.
    await waitFor(() => expect(deferreds.length).toBe(1));
    act(() => {
      useCyboflowStore.getState().appendStreamEvent(streamEvent);
    });
    await waitFor(() => expect(deferreds.length).toBe(2), { timeout: 2000 });

    // The newer live refetch (#1) lands with content...
    const settled = assistant('m1', { type: 'text', content: 'live wins' });
    await act(async () => {
      deferreds[1].resolve([settled]);
    });
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(['m1']));

    // ...then the older initial load (#0) finally resolves empty — it must not
    // wipe the newer snapshot, and must not resurrect a loading state.
    await act(async () => {
      deferreds[0].resolve([]);
    });
    expect(result.current.messages.map((m) => m.id)).toEqual(['m1']);
    expect(result.current.isLoading).toBe(false);
  });
});
