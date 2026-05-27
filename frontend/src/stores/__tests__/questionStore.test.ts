/**
 * Unit tests for the questionStore pure reducers and init() idempotency.
 *
 * These tests exercise the pure-function exports from questionStore.ts
 * without requiring a live tRPC connection or a real Zustand store instance.
 * The three reducers under test have well-defined correctness properties:
 *
 *   1. replaceAll     — atomic queue replacement
 *   2. addQuestion    — idempotent on duplicate id
 *   3. removeQuestion — no-op on missing id
 *
 * The tRPC client is mocked at the module level so the test can import
 * from questionStore.ts without a live Electron IPC bridge.
 *
 * NOTE: The questions subscriptions live under trpc.cyboflow.questions
 * (not trpc.cyboflow.events), mirroring the questionsRouter definition.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Question } from '../../../../shared/types/questions';

// ---------------------------------------------------------------------------
// Mutable mock references — replaced in beforeEach so each test gets fresh spies.
// Use the mutable-reference pattern from reviewQueueStore.test.ts so that
// resetting references in beforeEach affects the factory-captured getter.
// ---------------------------------------------------------------------------

let mockListPendingQuery: ReturnType<typeof vi.fn>;
let mockCreatedSubscribeUnsubscribe: ReturnType<typeof vi.fn>;
let mockCreatedSubscribe: ReturnType<typeof vi.fn>;
let mockAnsweredSubscribeUnsubscribe: ReturnType<typeof vi.fn>;
let mockAnsweredSubscribe: ReturnType<typeof vi.fn>;

// Mock trpc/client before any questionStore import so the module evaluates
// without the Electron IPC bridge.
// The factory uses getter properties that delegate to the outer-scope mutable
// references — replacing the references in beforeEach affects each test.
vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      questions: {
        listPending: {
          get query() { return mockListPendingQuery; },
        },
        onQuestionCreated: {
          get subscribe() { return mockCreatedSubscribe; },
        },
        onQuestionAnswered: {
          get subscribe() { return mockAnsweredSubscribe; },
        },
      },
    },
  },
}));

import {
  pureAddQuestion,
  pureRemoveQuestion,
  pureReplaceAll,
  useQuestionStore,
} from '../questionStore';

// ---------------------------------------------------------------------------
// Reset mock spies before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockListPendingQuery = vi.fn().mockResolvedValue([]);
  mockCreatedSubscribeUnsubscribe = vi.fn();
  mockCreatedSubscribe = vi.fn().mockReturnValue({ unsubscribe: mockCreatedSubscribeUnsubscribe });
  mockAnsweredSubscribeUnsubscribe = vi.fn();
  mockAnsweredSubscribe = vi.fn().mockReturnValue({ unsubscribe: mockAnsweredSubscribeUnsubscribe });

  // Reset the store's Zustand state. The closure-private `initialized` flag
  // resets only via the unsubscribe path — each init() test manages its own
  // cleanup via afterEach(activeUnsub) as in reviewQueueStore.test.ts.
  useQuestionStore.setState({ queue: [], connectionStatus: 'idle', otherText: {} });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQuestion(overrides: Partial<Question> & { id: string }): Question {
  return {
    id: overrides.id,
    runId: overrides.runId ?? 'run-1',
    workflowName: overrides.workflowName ?? 'Test Workflow',
    toolUseId: overrides.toolUseId ?? 'tool-use-1',
    questions: overrides.questions ?? [
      {
        question: 'What color?',
        header: 'Color',
        multiSelect: false,
        options: [
          { label: 'Red' },
          { label: 'Blue' },
        ],
      },
    ],
    status: overrides.status ?? 'pending',
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    answeredAt: overrides.answeredAt ?? null,
    answerJson: overrides.answerJson ?? null,
  };
}

const Q_A = makeQuestion({ id: 'question-a' });
const Q_B = makeQuestion({ id: 'question-b' });
const Q_C = makeQuestion({ id: 'question-c' });

// ---------------------------------------------------------------------------
// pureReplaceAll
// ---------------------------------------------------------------------------

describe('pureReplaceAll', () => {
  it('replaces a populated queue with an empty list', () => {
    const queue = [Q_A, Q_B];
    const result = pureReplaceAll(queue, []);
    expect(result).toHaveLength(0);
  });

  it('replaces an empty queue with a populated list', () => {
    const result = pureReplaceAll([], [Q_A, Q_B, Q_C]);
    expect(result).toHaveLength(3);
    expect(result.map((q) => q.id)).toEqual(['question-a', 'question-b', 'question-c']);
  });

  it('replaces atomically — original queue is not mutated', () => {
    const original = [Q_A, Q_B];
    const replacement = [Q_C];
    const result = pureReplaceAll(original, replacement);
    expect(result).not.toBe(original);
    expect(original).toHaveLength(2); // original unchanged
    expect(result).toHaveLength(1);
  });

  it('returns a new array even when items are identical', () => {
    const replacement = [Q_A];
    const result = pureReplaceAll([], replacement);
    expect(result).not.toBe(replacement); // reference inequality between input and output
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// pureAddQuestion (idempotency)
// ---------------------------------------------------------------------------

describe('pureAddQuestion', () => {
  it('adds a question that is not yet in the queue', () => {
    const result = pureAddQuestion([], Q_A);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('question-a');
  });

  it('is idempotent — adding the same id twice keeps length at 1', () => {
    const after1 = pureAddQuestion([], Q_A);
    const after2 = pureAddQuestion(after1, Q_A);
    expect(after2).toHaveLength(1);
  });

  it('returns the same array reference when idempotent (no-op path)', () => {
    const existing = [Q_A];
    const result = pureAddQuestion(existing, Q_A);
    expect(result).toBe(existing); // same reference — no allocation
  });

  it('appends to end of queue when id is new', () => {
    const result = pureAddQuestion([Q_A, Q_B], Q_C);
    expect(result.map((q) => q.id)).toEqual(['question-a', 'question-b', 'question-c']);
  });
});

// ---------------------------------------------------------------------------
// pureRemoveQuestion (no-op on missing id)
// ---------------------------------------------------------------------------

describe('pureRemoveQuestion', () => {
  it('removes a question that is present', () => {
    const result = pureRemoveQuestion([Q_A, Q_B, Q_C], 'question-b');
    expect(result.map((q) => q.id)).toEqual(['question-a', 'question-c']);
  });

  it('is a no-op when the id is not present — does not throw', () => {
    expect(() => pureRemoveQuestion([], 'nonexistent')).not.toThrow();
    const result = pureRemoveQuestion([], 'nonexistent');
    expect(result).toHaveLength(0);
  });

  it('returns a new array even when no item was removed', () => {
    const original = [Q_A];
    const result = pureRemoveQuestion(original, 'nonexistent');
    // Filter always returns a new array in JS, length unchanged
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('question-a');
  });

  it('handles removing from a single-element queue', () => {
    const result = pureRemoveQuestion([Q_A], 'question-a');
    expect(result).toHaveLength(0);
  });

  it('does not remove questions with a different id prefix', () => {
    const x = makeQuestion({ id: 'question-ab' });
    const result = pureRemoveQuestion([Q_A, x], 'question-a');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('question-ab');
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

  it('double init() — listPending.query called exactly once and subscribe called exactly twice (once per subscription)', () => {
    // First init — starts the subscriptions
    const unsub1 = useQuestionStore.getState().init();
    activeUnsub = unsub1;

    // Second init before any unsubscribe — must be a no-op
    const unsub2 = useQuestionStore.getState().init();

    expect(mockListPendingQuery).toHaveBeenCalledTimes(1);
    // Both subscriptions fire once on first init, and not again on second
    expect(mockCreatedSubscribe).toHaveBeenCalledTimes(1);
    expect(mockAnsweredSubscribe).toHaveBeenCalledTimes(1);

    // Both calls should return the same unsubscribe function
    expect(unsub1).toBe(unsub2);
  });

  it('unsubscribe then init() re-subscribes — subscribe called twice per subscription', () => {
    // First init
    const unsub1 = useQuestionStore.getState().init();
    expect(mockCreatedSubscribe).toHaveBeenCalledTimes(1);
    expect(mockAnsweredSubscribe).toHaveBeenCalledTimes(1);

    // Unsubscribe — resets the initialized flag
    unsub1();
    expect(mockCreatedSubscribeUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockAnsweredSubscribeUnsubscribe).toHaveBeenCalledTimes(1);

    // Second init after unsubscribe — should re-subscribe
    const unsub2 = useQuestionStore.getState().init();
    activeUnsub = unsub2;

    expect(mockCreatedSubscribe).toHaveBeenCalledTimes(2);
    expect(mockAnsweredSubscribe).toHaveBeenCalledTimes(2);
    expect(mockListPendingQuery).toHaveBeenCalledTimes(2);
  });

  it('onError on onQuestionCreated resets closure state so a subsequent init() re-subscribes', () => {
    // First init — captures the onError callback for onQuestionCreated
    let capturedOnError: ((err: unknown) => void) | undefined;
    mockCreatedSubscribe = vi.fn().mockImplementation((_input: undefined, handlers: { onError?: (err: unknown) => void }) => {
      capturedOnError = handlers.onError;
      return { unsubscribe: mockCreatedSubscribeUnsubscribe };
    });

    const unsub1 = useQuestionStore.getState().init();
    activeUnsub = unsub1;

    expect(mockCreatedSubscribe).toHaveBeenCalledTimes(1);
    expect(capturedOnError).toBeDefined();

    // Trigger the subscription error
    capturedOnError!(new Error('connection lost'));

    // The store should be disconnected and closure state cleared
    expect(useQuestionStore.getState().connectionStatus).toBe('disconnected');
    expect(mockCreatedSubscribeUnsubscribe).toHaveBeenCalledTimes(1);

    // Now a second init() should NOT be a no-op — it must re-subscribe
    // Reset mocks for the fresh subscription
    mockCreatedSubscribeUnsubscribe = vi.fn();
    mockCreatedSubscribe = vi.fn().mockImplementation((_input: undefined, handlers: { onError?: (err: unknown) => void }) => {
      capturedOnError = handlers.onError;
      return { unsubscribe: mockCreatedSubscribeUnsubscribe };
    });
    mockAnsweredSubscribeUnsubscribe = vi.fn();
    mockAnsweredSubscribe = vi.fn().mockReturnValue({ unsubscribe: mockAnsweredSubscribeUnsubscribe });

    const unsub2 = useQuestionStore.getState().init();
    activeUnsub = unsub2;

    expect(mockCreatedSubscribe).toHaveBeenCalledTimes(1); // second subscribe call
    expect(mockListPendingQuery).toHaveBeenCalledTimes(2); // listPending called again
  });

  it('onError on onQuestionAnswered resets closure state so a subsequent init() re-subscribes', () => {
    let capturedAnsweredOnError: ((err: unknown) => void) | undefined;
    mockAnsweredSubscribe = vi.fn().mockImplementation((_input: undefined, handlers: { onError?: (err: unknown) => void }) => {
      capturedAnsweredOnError = handlers.onError;
      return { unsubscribe: mockAnsweredSubscribeUnsubscribe };
    });

    const unsub1 = useQuestionStore.getState().init();
    activeUnsub = unsub1;

    expect(mockCreatedSubscribe).toHaveBeenCalledTimes(1);
    expect(mockAnsweredSubscribe).toHaveBeenCalledTimes(1);
    expect(capturedAnsweredOnError).toBeDefined();

    capturedAnsweredOnError!(new Error('answered channel dropped'));

    expect(useQuestionStore.getState().connectionStatus).toBe('disconnected');
    expect(mockCreatedSubscribeUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockAnsweredSubscribeUnsubscribe).toHaveBeenCalledTimes(1);

    mockCreatedSubscribeUnsubscribe = vi.fn();
    mockCreatedSubscribe = vi.fn().mockReturnValue({ unsubscribe: mockCreatedSubscribeUnsubscribe });
    mockAnsweredSubscribeUnsubscribe = vi.fn();
    mockAnsweredSubscribe = vi.fn().mockReturnValue({ unsubscribe: mockAnsweredSubscribeUnsubscribe });

    const unsub2 = useQuestionStore.getState().init();
    activeUnsub = unsub2;

    expect(mockCreatedSubscribe).toHaveBeenCalledTimes(1);
    expect(mockAnsweredSubscribe).toHaveBeenCalledTimes(1);
    expect(mockListPendingQuery).toHaveBeenCalledTimes(2);
  });

  it('StrictMode double-invoke — exactly one live subscription set after both mount effects settle', () => {
    // React StrictMode in development invokes effects twice: mount → cleanup → mount.
    // Simulate: init() → unsubscribe() → init()

    // First effect mount
    const unsub1 = useQuestionStore.getState().init();

    // StrictMode unmount cleanup — React calls the returned unsubscribe
    unsub1();

    // StrictMode second mount — React mounts again
    const unsub2 = useQuestionStore.getState().init();
    activeUnsub = unsub2;

    // After the StrictMode sequence there must be exactly ONE live subscription set.
    // Each subscribe was called twice (once per mount), but unsubscribe was called
    // once (for the first mount's cleanup), so exactly one live subscription remains.
    expect(mockCreatedSubscribe).toHaveBeenCalledTimes(2);
    expect(mockAnsweredSubscribe).toHaveBeenCalledTimes(2);
    expect(mockCreatedSubscribeUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockAnsweredSubscribeUnsubscribe).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Delta event dispatch
// ---------------------------------------------------------------------------

describe('onQuestionCreated event triggers addQuestion', () => {
  let activeUnsub: (() => void) | null = null;

  afterEach(() => {
    if (activeUnsub) {
      activeUnsub();
      activeUnsub = null;
    }
  });

  it('adds a question to the store when onQuestionCreated fires with valid event', () => {
    let capturedOnData: ((evt: unknown) => void) | undefined;
    mockCreatedSubscribe = vi.fn().mockImplementation((_input: undefined, handlers: { onData?: (evt: unknown) => void }) => {
      capturedOnData = handlers.onData;
      return { unsubscribe: mockCreatedSubscribeUnsubscribe };
    });

    const unsub = useQuestionStore.getState().init();
    activeUnsub = unsub;

    expect(capturedOnData).toBeDefined();

    // Simulate an onQuestionCreated event
    capturedOnData!({ question: Q_A });

    expect(useQuestionStore.getState().queue).toHaveLength(1);
    expect(useQuestionStore.getState().queue[0].id).toBe('question-a');
  });

  it('ignores malformed onQuestionCreated events (no question property)', () => {
    let capturedOnData: ((evt: unknown) => void) | undefined;
    mockCreatedSubscribe = vi.fn().mockImplementation((_input: undefined, handlers: { onData?: (evt: unknown) => void }) => {
      capturedOnData = handlers.onData;
      return { unsubscribe: mockCreatedSubscribeUnsubscribe };
    });

    const unsub = useQuestionStore.getState().init();
    activeUnsub = unsub;

    // Malformed events — should be silently ignored
    capturedOnData!({ notQuestion: 'bad' });
    capturedOnData!(null);
    capturedOnData!(undefined);
    capturedOnData!('string');

    expect(useQuestionStore.getState().queue).toHaveLength(0);
  });
});

describe('onQuestionAnswered event triggers removeQuestion', () => {
  let activeUnsub: (() => void) | null = null;

  afterEach(() => {
    if (activeUnsub) {
      activeUnsub();
      activeUnsub = null;
    }
  });

  it('removes a question from the store when onQuestionAnswered fires with valid event', () => {
    // Pre-populate the queue
    useQuestionStore.setState({ queue: [Q_A, Q_B] });

    let capturedOnData: ((evt: unknown) => void) | undefined;
    mockAnsweredSubscribe = vi.fn().mockImplementation((_input: undefined, handlers: { onData?: (evt: unknown) => void }) => {
      capturedOnData = handlers.onData;
      return { unsubscribe: mockAnsweredSubscribeUnsubscribe };
    });

    const unsub = useQuestionStore.getState().init();
    activeUnsub = unsub;

    expect(capturedOnData).toBeDefined();

    // Simulate an onQuestionAnswered event
    capturedOnData!({ questionId: 'question-a', status: 'answered' });

    expect(useQuestionStore.getState().queue).toHaveLength(1);
    expect(useQuestionStore.getState().queue[0].id).toBe('question-b');
  });

  it('ignores malformed onQuestionAnswered events (no questionId)', () => {
    useQuestionStore.setState({ queue: [Q_A] });

    let capturedOnData: ((evt: unknown) => void) | undefined;
    mockAnsweredSubscribe = vi.fn().mockImplementation((_input: undefined, handlers: { onData?: (evt: unknown) => void }) => {
      capturedOnData = handlers.onData;
      return { unsubscribe: mockAnsweredSubscribeUnsubscribe };
    });

    const unsub = useQuestionStore.getState().init();
    activeUnsub = unsub;

    // Malformed event — should be silently ignored
    capturedOnData!({ notQuestionId: 'bad' });
    capturedOnData!(null);

    expect(useQuestionStore.getState().queue).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// otherText bus — setOtherText / clearOtherText reducers (TASK-762)
// ---------------------------------------------------------------------------

describe('setOtherText', () => {
  it('sets text for a new questionId', () => {
    useQuestionStore.getState().setOtherText('q-1', 'hello');
    expect(useQuestionStore.getState().otherText['q-1']).toBe('hello');
  });

  it('overwrites text for an existing questionId', () => {
    useQuestionStore.getState().setOtherText('q-1', 'first');
    useQuestionStore.getState().setOtherText('q-1', 'second');
    expect(useQuestionStore.getState().otherText['q-1']).toBe('second');
  });

  it('sets text for multiple distinct questionIds independently', () => {
    useQuestionStore.getState().setOtherText('q-1', 'alpha');
    useQuestionStore.getState().setOtherText('q-2', 'beta');
    const { otherText } = useQuestionStore.getState();
    expect(otherText['q-1']).toBe('alpha');
    expect(otherText['q-2']).toBe('beta');
  });

  it('does not mutate other keys when setting one key', () => {
    useQuestionStore.getState().setOtherText('q-1', 'alpha');
    useQuestionStore.getState().setOtherText('q-2', 'beta');
    // Overwrite q-1 only
    useQuestionStore.getState().setOtherText('q-1', 'updated');
    const { otherText } = useQuestionStore.getState();
    expect(otherText['q-1']).toBe('updated');
    expect(otherText['q-2']).toBe('beta');
  });
});

describe('clearOtherText', () => {
  it('removes the key for a given questionId', () => {
    useQuestionStore.getState().setOtherText('q-1', 'some text');
    useQuestionStore.getState().clearOtherText('q-1');
    expect(useQuestionStore.getState().otherText['q-1']).toBeUndefined();
    expect('q-1' in useQuestionStore.getState().otherText).toBe(false);
  });

  it('is a no-op for a questionId that was never set — does not throw', () => {
    expect(() => {
      useQuestionStore.getState().clearOtherText('nonexistent');
    }).not.toThrow();
    expect(useQuestionStore.getState().otherText).toEqual({});
  });

  it('does not affect other keys when clearing one key', () => {
    useQuestionStore.getState().setOtherText('q-1', 'keep');
    useQuestionStore.getState().setOtherText('q-2', 'remove');
    useQuestionStore.getState().clearOtherText('q-2');
    const { otherText } = useQuestionStore.getState();
    expect(otherText['q-1']).toBe('keep');
    expect('q-2' in otherText).toBe(false);
  });
});

describe('otherText — initial state and replaceAll interaction', () => {
  it('otherText is empty on store initialisation', () => {
    expect(useQuestionStore.getState().otherText).toEqual({});
  });

  it('replaceAll (queue resync) does NOT clear otherText — text survives an init() cycle', () => {
    // Simulate ChatInput having set other text before a store resync
    useQuestionStore.getState().setOtherText('q-sticky', 'typed text');

    // replaceAll replaces only the queue; otherText must be preserved
    useQuestionStore.getState().replaceAll([Q_A, Q_B]);

    expect(useQuestionStore.getState().queue).toHaveLength(2);
    // The key regression assertion: otherText survives the queue replacement
    expect(useQuestionStore.getState().otherText['q-sticky']).toBe('typed text');
  });
});
