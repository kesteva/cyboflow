/**
 * Unit tests for useFeedback.
 *
 * Focus:
 *  1. Doc-scoped seed + live merge: an onFeedbackChanged event for the SAME
 *     (atype, sourceRef) replaces local state; a different atype/sourceRef is
 *     ignored.
 *  2. Run-scoped (no atype/sourceRef): every event for the run is applied, and
 *     mergeFeedbackEvent only replaces the touched document's slice.
 *  3. Events for a different runId are always ignored.
 *  4. The subscription is unsubscribed on unmount.
 *  5. A null projectId/runId yields the empty state and never subscribes.
 *  6. mergeFeedbackEvent (pure) leaves other documents' entries untouched.
 *  7. Doc-scoped createComment/sendBatch forward the bound atype+sourceRef;
 *     run-scoped mutation calls throw (no atype/sourceRef to bind).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type {
  FeedbackBatch,
  FeedbackChangedEvent,
  FeedbackComment,
} from '../../../../shared/types/feedback';

type OnDataFn = (event: FeedbackChangedEvent) => void;

interface DeferredSeed {
  promise: Promise<{ comments: FeedbackComment[]; batches: FeedbackBatch[] }>;
  resolve: (rows: { comments: FeedbackComment[]; batches: FeedbackBatch[] }) => void;
}

function deferSeed(): DeferredSeed {
  let resolve!: (rows: { comments: FeedbackComment[]; batches: FeedbackBatch[] }) => void;
  const promise = new Promise<{ comments: FeedbackComment[]; batches: FeedbackBatch[] }>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let seedDeferred: DeferredSeed;
let lastOnData: OnDataFn | null;
let unsubscribeSpy: ReturnType<typeof vi.fn>;
let subscribeSpy: ReturnType<typeof vi.fn>;
let listQuerySpy: ReturnType<typeof vi.fn>;
let createCommentSpy: ReturnType<typeof vi.fn>;
let sendBatchSpy: ReturnType<typeof vi.fn>;

vi.mock('../../trpc/client', () => {
  return {
    trpc: {
      cyboflow: {
        feedback: {
          list: {
            query: (...args: unknown[]) => {
              listQuerySpy(...args);
              return seedDeferred.promise;
            },
          },
          createComment: { mutate: (...args: unknown[]) => createCommentSpy(...args) },
          updateComment: { mutate: vi.fn() },
          deleteComment: { mutate: vi.fn() },
          sendBatch: { mutate: (...args: unknown[]) => sendBatchSpy(...args) },
          onFeedbackChanged: {
            subscribe: (
              input: { projectId: number },
              handlers: { onData: OnDataFn; onError: (e: unknown) => void },
            ) => {
              subscribeSpy(input);
              lastOnData = handlers.onData;
              return { unsubscribe: unsubscribeSpy };
            },
          },
        },
      },
    },
  };
});

const { useFeedback, mergeFeedbackEvent } = await import('../useFeedback');

const RUN = 'run-aaa';
const PROJECT = 7;

function makeComment(overrides: Partial<FeedbackComment> = {}): FeedbackComment {
  return {
    id: 'cmt-1',
    projectId: PROJECT,
    runId: RUN,
    atype: 'idea-spec',
    sourceRef: 'idea-1',
    batchId: null,
    anchor: { quote: 'hello', occurrence: 0, bodyHash: 'abc' },
    body: 'please clarify',
    status: 'draft',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    sentAt: null,
    addressedAt: null,
    ...overrides,
  };
}

function makeBatch(overrides: Partial<FeedbackBatch> = {}): FeedbackBatch {
  return {
    id: 'batch-1',
    projectId: PROJECT,
    runId: RUN,
    atype: 'idea-spec',
    sourceRef: 'idea-1',
    round: 1,
    status: 'pending',
    error: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    appliedAt: null,
    ...overrides,
  };
}

function changedEvent(overrides: Partial<FeedbackChangedEvent> = {}): FeedbackChangedEvent {
  return {
    projectId: PROJECT,
    runId: RUN,
    atype: 'idea-spec',
    sourceRef: 'idea-1',
    comments: [],
    batches: [],
    ...overrides,
  };
}

beforeEach(() => {
  seedDeferred = deferSeed();
  lastOnData = null;
  unsubscribeSpy = vi.fn();
  subscribeSpy = vi.fn();
  listQuerySpy = vi.fn();
  createCommentSpy = vi.fn().mockResolvedValue(undefined);
  sendBatchSpy = vi.fn().mockResolvedValue({ sent: true, batchId: 'batch-1', round: 2 });
});

describe('useFeedback', () => {
  it('returns the empty state and does not subscribe when projectId/runId are null', () => {
    const { result } = renderHook(() => useFeedback(null, null, 'idea-spec', 'idea-1'));
    expect(result.current.comments).toEqual([]);
    expect(result.current.batches).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(listQuerySpy).not.toHaveBeenCalled();
  });

  it('doc-scoped: seeds scoped by atype+sourceRef and resolves loading', async () => {
    const { result } = renderHook(() => useFeedback(PROJECT, RUN, 'idea-spec', 'idea-1'));
    expect(result.current.loading).toBe(true);
    expect(listQuerySpy).toHaveBeenCalledWith({ runId: RUN, atype: 'idea-spec', sourceRef: 'idea-1' });

    const seeded = [makeComment()];
    await act(async () => {
      seedDeferred.resolve({ comments: seeded, batches: [] });
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.comments).toEqual(seeded);
  });

  it('run-scoped: seeds with only runId (no atype/sourceRef)', () => {
    renderHook(() => useFeedback(PROJECT, RUN));
    expect(listQuerySpy).toHaveBeenCalledWith({ runId: RUN });
  });

  it('doc-scoped: a matching event replaces local state; a different doc is ignored', async () => {
    const { result } = renderHook(() => useFeedback(PROJECT, RUN, 'idea-spec', 'idea-1'));
    await act(async () => {
      seedDeferred.resolve({ comments: [], batches: [] });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Different document (arch-design) — ignored.
    act(() => {
      lastOnData?.(changedEvent({ atype: 'arch-design', comments: [makeComment({ atype: 'arch-design' })] }));
    });
    expect(result.current.comments).toEqual([]);

    // Same document — applied.
    const matching = [makeComment()];
    act(() => {
      lastOnData?.(changedEvent({ comments: matching }));
    });
    expect(result.current.comments).toEqual(matching);
  });

  it('ignores events for a different runId', async () => {
    const { result } = renderHook(() => useFeedback(PROJECT, RUN, 'idea-spec', 'idea-1'));
    await act(async () => {
      seedDeferred.resolve({ comments: [], batches: [] });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      lastOnData?.({ ...changedEvent(), runId: 'other-run', comments: [makeComment()] });
    });
    expect(result.current.comments).toEqual([]);
  });

  it('run-scoped: an event only replaces the touched document, leaving others intact', async () => {
    const { result } = renderHook(() => useFeedback(PROJECT, RUN));
    const seededComments = [
      makeComment({ id: 'c-spec', atype: 'idea-spec', sourceRef: 'idea-1' }),
      makeComment({ id: 'c-arch', atype: 'arch-design', sourceRef: 'idea-2' }),
    ];
    await act(async () => {
      seedDeferred.resolve({ comments: seededComments, batches: [] });
    });
    await waitFor(() => expect(result.current.comments).toEqual(seededComments));

    // Event touches ONLY (idea-spec, idea-1) — replaces just that slice.
    act(() => {
      lastOnData?.(
        changedEvent({
          atype: 'idea-spec',
          sourceRef: 'idea-1',
          comments: [makeComment({ id: 'c-spec-v2', atype: 'idea-spec', sourceRef: 'idea-1' })],
        }),
      );
    });
    expect(result.current.comments.map((c) => c.id)).toEqual(['c-arch', 'c-spec-v2']);
  });

  it('unsubscribes on unmount', async () => {
    const { unmount } = renderHook(() => useFeedback(PROJECT, RUN, 'idea-spec', 'idea-1'));
    await act(async () => {
      seedDeferred.resolve({ comments: [], batches: [] });
    });
    unmount();
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
  });

  it('doc-scoped createComment/sendBatch bind atype+sourceRef', async () => {
    const { result } = renderHook(() => useFeedback(PROJECT, RUN, 'idea-spec', 'idea-1'));
    await act(async () => {
      seedDeferred.resolve({ comments: [], batches: [] });
    });

    await act(async () => {
      await result.current.createComment({ quote: 'x', occurrence: 0, bodyHash: 'h' }, 'do this');
    });
    expect(createCommentSpy).toHaveBeenCalledWith({
      runId: RUN,
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: { quote: 'x', occurrence: 0, bodyHash: 'h' },
      body: 'do this',
    });

    await act(async () => {
      await result.current.sendBatch();
    });
    expect(sendBatchSpy).toHaveBeenCalledWith({ runId: RUN, atype: 'idea-spec', sourceRef: 'idea-1' });
  });

  it('run-scoped createComment/sendBatch reject — no atype/sourceRef to bind', async () => {
    const { result } = renderHook(() => useFeedback(PROJECT, RUN));
    await act(async () => {
      seedDeferred.resolve({ comments: [], batches: [] });
    });

    await expect(result.current.createComment({ quote: 'x', occurrence: 0, bodyHash: 'h' }, 'y')).rejects.toThrow();
    await expect(result.current.sendBatch()).rejects.toThrow();
  });
});

describe('mergeFeedbackEvent', () => {
  it('replaces only the touched (atype, sourceRef) entries', () => {
    const prev = {
      comments: [
        makeComment({ id: 'c1', atype: 'idea-spec', sourceRef: 'idea-1' }),
        makeComment({ id: 'c2', atype: 'arch-design', sourceRef: 'idea-1' }),
      ],
      batches: [makeBatch({ id: 'b1', atype: 'idea-spec', sourceRef: 'idea-1' })],
    };
    const event = changedEvent({
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      comments: [makeComment({ id: 'c1-new', atype: 'idea-spec', sourceRef: 'idea-1' })],
      batches: [],
    });
    const next = mergeFeedbackEvent(prev, event);
    expect(next.comments.map((c) => c.id)).toEqual(['c2', 'c1-new']);
    expect(next.batches).toEqual([]);
  });
});
