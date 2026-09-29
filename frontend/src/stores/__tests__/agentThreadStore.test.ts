/**
 * Unit tests for agentThreadStore — init() bootstrap/idempotency, the debounced
 * onThreadEvent → (liveTailTick bump + proposals refetch) path, the targeted
 * onProposalUpdate refetch, and the sendMessage `sending` gate.
 *
 * The tRPC client is mocked at module level (mirrors backlogStore.test.ts /
 * reviewQueueStore.test.ts) so importing the store does not require a live
 * Electron IPC bridge.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentThread, AgentProposal } from '../../../../shared/types/agentThread';
import type { StreamEvent } from '../../utils/cyboflowApi';

// Mutable mock refs — replaced in beforeEach so each test gets fresh spies.
let mockGetThreadQuery: ReturnType<typeof vi.fn>;
let mockListProposalsQuery: ReturnType<typeof vi.fn>;
let mockTurnStateQuery: ReturnType<typeof vi.fn>;
let mockSendMessageMutate: ReturnType<typeof vi.fn>;
let mockInterruptTurnMutate: ReturnType<typeof vi.fn>;
let mockConfirmProposalMutate: ReturnType<typeof vi.fn>;
let mockDismissProposalMutate: ReturnType<typeof vi.fn>;
let mockOnThreadEventSubscribe: ReturnType<typeof vi.fn>;
let mockOnThreadEventUnsubscribe: ReturnType<typeof vi.fn>;
let mockOnProposalUpdateSubscribe: ReturnType<typeof vi.fn>;
let mockOnProposalUpdateUnsubscribe: ReturnType<typeof vi.fn>;

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      agentThread: {
        getThread: { get query() { return mockGetThreadQuery; } },
        listProposals: { get query() { return mockListProposalsQuery; } },
        turnState: { get query() { return mockTurnStateQuery; } },
        sendMessage: { get mutate() { return mockSendMessageMutate; } },
        interruptTurn: { get mutate() { return mockInterruptTurnMutate; } },
        confirmProposal: { get mutate() { return mockConfirmProposalMutate; } },
        dismissProposal: { get mutate() { return mockDismissProposalMutate; } },
        onThreadEvent: { get subscribe() { return mockOnThreadEventSubscribe; } },
        onProposalUpdate: { get subscribe() { return mockOnProposalUpdateSubscribe; } },
      },
    },
  },
}));

import { useAgentThreadStore } from '../agentThreadStore';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeThread(overrides: Partial<AgentThread> = {}): AgentThread {
  return {
    id: 'thread-1',
    scope: 'global',
    model: null,
    claudeSessionId: null,
    sessionRuntime: null,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

/** A synthetic `stream_event` envelope matching AgentThreadService.toEnvelope's
 *  `{type, payload, timestamp}` shape (payload = the raw SDK `stream_event` message,
 *  carrying the nested `.event`). */
function makeStreamEventEnvelope(event: Record<string, unknown>): StreamEvent {
  return {
    type: 'stream_event',
    payload: { type: 'stream_event', event },
    timestamp: '2026-09-21T00:00:00.000Z',
  } as StreamEvent;
}

/** A synthetic terminal `result` envelope, same wrapper shape. */
function makeResultEnvelope(): StreamEvent {
  return {
    type: 'result',
    payload: { type: 'result' },
    timestamp: '2026-09-21T00:00:00.000Z',
  } as StreamEvent;
}

/** The Stop control's terminal marker (TASK-297) — same wrapper shape. */
function makeInterruptedEnvelope(): StreamEvent {
  return {
    type: 'system',
    payload: { type: 'system', subtype: 'assistant_interrupted' },
    timestamp: '2026-09-21T00:00:00.000Z',
  } as StreamEvent;
}

function makeProposal(overrides: Partial<AgentProposal> & { id: string }): AgentProposal {
  return {
    id: overrides.id,
    threadId: overrides.threadId ?? 'thread-1',
    kind: overrides.kind ?? 'open-session',
    payload: overrides.payload ?? { kind: 'open-session', navigation: { target: 'run', runId: 'run-1' } },
    preconditions: overrides.preconditions ?? null,
    status: overrides.status ?? 'proposed',
    result: overrides.result ?? null,
    idempotencyKey: overrides.idempotencyKey ?? null,
    createdAt: overrides.createdAt ?? '2026-07-17T00:00:00.000Z',
    decidedAt: overrides.decidedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let unsub: (() => void) | null = null;

beforeEach(() => {
  mockGetThreadQuery = vi.fn().mockResolvedValue(makeThread());
  mockListProposalsQuery = vi.fn().mockResolvedValue([]);
  mockTurnStateQuery = vi.fn().mockResolvedValue({ inFlight: false });
  mockSendMessageMutate = vi.fn().mockResolvedValue({ ok: true });
  mockInterruptTurnMutate = vi.fn().mockResolvedValue({ interrupted: true });
  mockConfirmProposalMutate = vi.fn().mockResolvedValue({ ok: true, dismissed: false });
  mockDismissProposalMutate = vi.fn().mockResolvedValue({ ok: true, dismissed: true });
  mockOnThreadEventUnsubscribe = vi.fn();
  // A fresh handle per call: the store tells a superseded subscription from
  // the live one by handle identity.
  mockOnThreadEventSubscribe = vi.fn().mockImplementation(() => ({ unsubscribe: mockOnThreadEventUnsubscribe }));
  mockOnProposalUpdateUnsubscribe = vi.fn();
  mockOnProposalUpdateSubscribe = vi.fn().mockImplementation(() => ({ unsubscribe: mockOnProposalUpdateUnsubscribe }));

  useAgentThreadStore.setState({
    thread: null,
    proposals: [],
    loading: false,
    sending: false,
    liveTailTick: 0,
    liveEvents: [],
    composerDraft: null,
    pendingContextHint: null,
    queuedTurn: null,
  });
});

afterEach(() => {
  if (unsub) {
    unsub();
    unsub = null;
  }
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// init() — bootstrap + idempotency
// ---------------------------------------------------------------------------

describe('init()', () => {
  it('fetches getThread then listProposals, and wires both subscriptions', async () => {
    unsub = useAgentThreadStore.getState().init();

    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());

    expect(mockGetThreadQuery).toHaveBeenCalledTimes(1);
    expect(mockListProposalsQuery).toHaveBeenCalledTimes(1);
    expect(mockListProposalsQuery).toHaveBeenCalledWith({ threadId: 'thread-1' });
    expect(mockOnThreadEventSubscribe).toHaveBeenCalledTimes(1);
    expect(mockOnThreadEventSubscribe).toHaveBeenCalledWith(
      { threadId: 'thread-1' },
      expect.objectContaining({ onData: expect.any(Function) }),
    );
    expect(mockOnProposalUpdateSubscribe).toHaveBeenCalledTimes(1);
    expect(useAgentThreadStore.getState().loading).toBe(false);
  });

  it('is idempotent — a second call before teardown returns the same unsubscribe and does not re-fetch', async () => {
    const first = useAgentThreadStore.getState().init();
    unsub = first;
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());

    const second = useAgentThreadStore.getState().init();
    expect(second).toBe(first);
    expect(mockGetThreadQuery).toHaveBeenCalledTimes(1);
    expect(mockOnThreadEventSubscribe).toHaveBeenCalledTimes(1);
    expect(mockOnProposalUpdateSubscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe tears down both subscriptions; a subsequent init() re-subscribes', async () => {
    const first = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());

    first();
    expect(mockOnThreadEventUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockOnProposalUpdateUnsubscribe).toHaveBeenCalledTimes(1);

    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(mockGetThreadQuery).toHaveBeenCalledTimes(2));
  });

  it('a getThread failure clears loading without throwing', async () => {
    mockGetThreadQuery = vi.fn().mockRejectedValue(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().loading).toBe(false));

    expect(useAgentThreadStore.getState().thread).toBeNull();
    errSpy.mockRestore();
  });

  it('hydrates `sending` true from turnState when a turn is already in flight (a reload mid-turn)', async () => {
    mockTurnStateQuery = vi.fn().mockResolvedValue({ inFlight: true });

    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().sending).toBe(true));

    expect(mockTurnStateQuery).toHaveBeenCalledWith({ threadId: 'thread-1' });
  });

  it('leaves `sending` false when turnState reports the thread idle', async () => {
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());
    await vi.waitFor(() => expect(mockTurnStateQuery).toHaveBeenCalled());

    expect(useAgentThreadStore.getState().sending).toBe(false);
  });

  it('a turnState failure is swallowed and leaves `sending` at its default', async () => {
    mockTurnStateQuery = vi.fn().mockRejectedValue(new Error('boom'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().loading).toBe(false));

    expect(useAgentThreadStore.getState().sending).toBe(false);
    warnSpy.mockRestore();
  });

  it('opens the onThreadEvent subscription BEFORE querying turnState (so a terminal event during the query is observable)', async () => {
    const order: string[] = [];
    mockOnThreadEventSubscribe = vi.fn().mockImplementation(() => {
      order.push('subscribe');
      return { unsubscribe: mockOnThreadEventUnsubscribe };
    });
    mockTurnStateQuery = vi.fn().mockImplementation(() => {
      order.push('turnState');
      return Promise.resolve({ inFlight: false });
    });

    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(mockTurnStateQuery).toHaveBeenCalled());

    expect(order).toEqual(['subscribe', 'turnState']);
  });

  it('ignores a stale turnState inFlight:true answer when a terminal event already arrived while the query was in flight (attempt-3 regression: subscription used to open AFTER turnState, so this race was unobservable)', async () => {
    let resolveTurnState: ((v: { inFlight: boolean }) => void) | undefined;
    mockTurnStateQuery = vi.fn().mockReturnValue(
      new Promise<{ inFlight: boolean }>((resolve) => {
        resolveTurnState = resolve;
      }),
    );

    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(mockOnThreadEventSubscribe).toHaveBeenCalled());

    // The turn ends WHILE turnState is still in flight.
    const onData = mockOnThreadEventSubscribe.mock.calls[0][1].onData as (values: unknown[]) => void;
    onData([makeResultEnvelope()]);

    // The query's stale answer arrives after the turn already ended.
    resolveTurnState?.({ inFlight: true });
    await vi.waitFor(() => expect(useAgentThreadStore.getState().loading).toBe(false));

    expect(useAgentThreadStore.getState().sending).toBe(false);
    // No reconcile poll should have started off a discarded, stale answer.
    expect(mockTurnStateQuery).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale turnState inFlight:false answer when a LOCAL send started while the query was in flight (Send must not re-enable mid-turn)', async () => {
    let resolveTurnState: ((v: { inFlight: boolean }) => void) | undefined;
    mockTurnStateQuery = vi.fn().mockReturnValue(
      new Promise<{ inFlight: boolean }>((resolve) => {
        resolveTurnState = resolve;
      }),
    );
    // The local turn stays in flight for the whole test.
    mockSendMessageMutate = vi.fn().mockReturnValue(new Promise(() => {}));

    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(mockTurnStateQuery).toHaveBeenCalled());

    // The thread is usable while turnState is pending — the user sends.
    void useAgentThreadStore.getState().sendMessage('hello');
    expect(useAgentThreadStore.getState().sending).toBe(true);

    // The query's answer predates the send reaching the server.
    resolveTurnState?.({ inFlight: false });
    await vi.waitFor(() => expect(useAgentThreadStore.getState().loading).toBe(false));

    expect(useAgentThreadStore.getState().sending).toBe(true);
  });

  it('reconciles a hydrated `sending` flag by polling turnState until it reports idle, when no terminal event ever arrives on this renderer', async () => {
    vi.useFakeTimers();
    let calls = 0;
    mockTurnStateQuery = vi.fn().mockImplementation(() => {
      calls += 1;
      return Promise.resolve({ inFlight: calls === 1 });
    });

    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().sending).toBe(true));

    await vi.advanceTimersByTimeAsync(2_500);

    expect(useAgentThreadStore.getState().sending).toBe(false);
    expect(mockTurnStateQuery).toHaveBeenCalledTimes(2);

    // The poll must have stopped — no further calls on continued elapsed time.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockTurnStateQuery).toHaveBeenCalledTimes(2);
  });

  it('negative control: keeps polling (and `sending` stays true) while turnState genuinely still reports the turn in flight', async () => {
    vi.useFakeTimers();
    mockTurnStateQuery = vi.fn().mockResolvedValue({ inFlight: true });

    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().sending).toBe(true));

    await vi.advanceTimersByTimeAsync(2_500);
    expect(useAgentThreadStore.getState().sending).toBe(true);
    expect(mockTurnStateQuery.mock.calls.length).toBeGreaterThanOrEqual(2);

    await vi.advanceTimersByTimeAsync(2_500);
    expect(useAgentThreadStore.getState().sending).toBe(true);
    expect(mockTurnStateQuery.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('stops the reconcile poll on teardown', async () => {
    vi.useFakeTimers();
    mockTurnStateQuery = vi.fn().mockResolvedValue({ inFlight: true });

    const teardown = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().sending).toBe(true));
    const callsBeforeTeardown = mockTurnStateQuery.mock.calls.length;

    teardown();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockTurnStateQuery.mock.calls.length).toBe(callsBeforeTeardown);
  });
});

// ---------------------------------------------------------------------------
// onThreadEvent → debounced (liveTailTick bump + proposals refetch)
// ---------------------------------------------------------------------------

describe('onThreadEvent live-tail', () => {
  it('debounces a burst of events into ONE liveTailTick bump + ONE proposals refetch (~150ms)', async () => {
    vi.useFakeTimers();
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());

    // listProposals was already called once during bootstrap.
    expect(mockListProposalsQuery).toHaveBeenCalledTimes(1);

    const onData = mockOnThreadEventSubscribe.mock.calls[0][1].onData as (values: unknown[]) => void;
    onData([]);
    onData([]);
    onData([]);
    // Still debounced — no tick bump yet.
    expect(useAgentThreadStore.getState().liveTailTick).toBe(0);

    await vi.advanceTimersByTimeAsync(150);

    expect(useAgentThreadStore.getState().liveTailTick).toBe(1);
    expect(mockListProposalsQuery).toHaveBeenCalledTimes(2);
  });

  it('captures every envelope in a single onData batch into liveEvents, in order — lossless (regression: server used to coalesce to the LATEST envelope per tick, dropping the rest)', async () => {
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());

    const onData = mockOnThreadEventSubscribe.mock.calls[0][1].onData as (values: unknown[]) => void;
    const env1 = makeStreamEventEnvelope({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
    const env2 = makeStreamEventEnvelope({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hi' },
    });
    // Both envelopes arrive together in ONE onData call — mirrors the server
    // batching multiple same-tick deltas into a single emission.
    onData([env1, env2]);

    expect(useAgentThreadStore.getState().liveEvents).toEqual([env1, env2]);
  });

  it('resets liveEvents to [] on a terminal result envelope', async () => {
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());

    const onData = mockOnThreadEventSubscribe.mock.calls[0][1].onData as (values: unknown[]) => void;
    onData([makeStreamEventEnvelope({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })]);
    expect(useAgentThreadStore.getState().liveEvents).toHaveLength(1);

    onData([makeResultEnvelope()]);
    expect(useAgentThreadStore.getState().liveEvents).toEqual([]);
  });

  it('resets on a result envelope in the MIDDLE of a batch, keeping only what follows it', async () => {
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());

    const onData = mockOnThreadEventSubscribe.mock.calls[0][1].onData as (values: unknown[]) => void;
    const before = makeStreamEventEnvelope({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
    const after = makeStreamEventEnvelope({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'new turn' },
    });
    onData([before, makeResultEnvelope(), after]);

    expect(useAgentThreadStore.getState().liveEvents).toEqual([after]);
  });

  it('ignores a malformed (non-envelope-shaped) onData value', async () => {
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());

    const onData = mockOnThreadEventSubscribe.mock.calls[0][1].onData as (values: unknown[]) => void;
    onData([undefined, 'not an envelope', { type: 'stream_event' }]); // last is missing payload/timestamp
    expect(useAgentThreadStore.getState().liveEvents).toEqual([]);
  });

  it('caps liveEvents at MAX_LIVE_EVENTS (2000), dropping the oldest', async () => {
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());

    const onData = mockOnThreadEventSubscribe.mock.calls[0][1].onData as (values: unknown[]) => void;
    for (let i = 0; i < 2005; i++) {
      onData([
        makeStreamEventEnvelope({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: String(i) } }),
      ]);
    }

    const events = useAgentThreadStore.getState().liveEvents;
    expect(events).toHaveLength(2000);
    const firstEvent = events[0] as unknown as { payload: { event: { delta: { text: string } } } };
    const lastEvent = events[events.length - 1] as unknown as { payload: { event: { delta: { text: string } } } };
    expect(firstEvent.payload.event.delta.text).toBe('5');
    expect(lastEvent.payload.event.delta.text).toBe('2004');
  });

  it('resets liveEvents on a fresh bootstrap (thread re-init)', async () => {
    useAgentThreadStore.setState({ liveEvents: [makeResultEnvelope()] });

    unsub = useAgentThreadStore.getState().init();
    expect(useAgentThreadStore.getState().liveEvents).toEqual([]);
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());
  });

  it('resets liveEvents to [] when sendMessage starts a new turn', async () => {
    useAgentThreadStore.setState({
      thread: makeThread(),
      liveEvents: [
        makeStreamEventEnvelope({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      ],
    });
    expect(useAgentThreadStore.getState().liveEvents).toHaveLength(1);

    const sendPromise = useAgentThreadStore.getState().sendMessage('hello again');
    // Cleared synchronously, before the mutation resolves.
    expect(useAgentThreadStore.getState().liveEvents).toEqual([]);

    await sendPromise;
    expect(useAgentThreadStore.getState().liveEvents).toEqual([]);
  });

  it('clears `sending` on a terminal result envelope even with no live sendMessage call on this renderer (a reload mid-turn: sending was hydrated from turnState, never from a promise this renderer holds)', async () => {
    mockTurnStateQuery = vi.fn().mockResolvedValue({ inFlight: true });
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().sending).toBe(true));

    const onData = mockOnThreadEventSubscribe.mock.calls[0][1].onData as (values: unknown[]) => void;
    onData([makeResultEnvelope()]);

    expect(useAgentThreadStore.getState().sending).toBe(false);
  });

  it('clears `sending` on an assistant_interrupted marker with no live sendMessage call on this renderer', async () => {
    mockTurnStateQuery = vi.fn().mockResolvedValue({ inFlight: true });
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().sending).toBe(true));

    const onData = mockOnThreadEventSubscribe.mock.calls[0][1].onData as (values: unknown[]) => void;
    onData([makeInterruptedEnvelope()]);

    expect(useAgentThreadStore.getState().sending).toBe(false);
  });

  it('a non-terminal envelope does not clear `sending` (still mid-turn)', async () => {
    mockTurnStateQuery = vi.fn().mockResolvedValue({ inFlight: true });
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().sending).toBe(true));

    const onData = mockOnThreadEventSubscribe.mock.calls[0][1].onData as (values: unknown[]) => void;
    onData([makeStreamEventEnvelope({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })]);

    expect(useAgentThreadStore.getState().sending).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Subscription self-healing — a server-ended or errored subscription reopens
// ---------------------------------------------------------------------------

describe('subscription self-healing', () => {
  type Handlers = {
    onData: (value: unknown) => void;
    onError: (err: unknown) => void;
    onStopped: () => void;
    onComplete: () => void;
  };

  it('reopens onThreadEvent after the server stops it (trpc-electron abort → stopped + complete)', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());
    expect(mockOnThreadEventSubscribe).toHaveBeenCalledTimes(1);

    const first = mockOnThreadEventSubscribe.mock.calls[0][1] as Handlers;
    // The main side aborts the subscription: the link delivers `stopped` then
    // completes the observer. Exactly ONE reopen must be scheduled for the pair.
    first.onStopped();
    first.onComplete();
    expect(mockOnThreadEventSubscribe).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('onThreadEvent subscription ended');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockOnThreadEventSubscribe).toHaveBeenCalledTimes(2);
    expect(mockOnThreadEventSubscribe.mock.calls[1][0]).toEqual({ threadId: 'thread-1' });

    // Events on the reopened subscription drive the live tail again.
    const second = mockOnThreadEventSubscribe.mock.calls[1][1] as Handlers;
    second.onData([]);
    await vi.advanceTimersByTimeAsync(150);
    expect(useAgentThreadStore.getState().liveTailTick).toBe(1);

    // A late callback from the SUPERSEDED subscription is ignored.
    first.onData([]);
    await vi.advanceTimersByTimeAsync(150);
    expect(useAgentThreadStore.getState().liveTailTick).toBe(1);
    warn.mockRestore();
  });

  it('reopens onProposalUpdate after an error', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());
    expect(mockOnProposalUpdateSubscribe).toHaveBeenCalledTimes(1);

    const first = mockOnProposalUpdateSubscribe.mock.calls[0][1] as Handlers;
    first.onError(new Error('boom'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockOnProposalUpdateSubscribe).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0][0])).toContain('error: boom');
    warn.mockRestore();
  });

  it('does NOT reopen after the store\'s own teardown', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const teardown = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());
    const first = mockOnThreadEventSubscribe.mock.calls[0][1] as Handlers;

    teardown();
    expect(mockOnThreadEventUnsubscribe).toHaveBeenCalledTimes(1);
    // The link completes the observer on unsubscribe — that must stay silent.
    first.onComplete();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockOnThreadEventSubscribe).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a pending reopen is cancelled by teardown', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const teardown = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());
    const first = mockOnThreadEventSubscribe.mock.calls[0][1] as Handlers;
    first.onStopped();
    teardown();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockOnThreadEventSubscribe).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// onProposalUpdate — targeted, unthrottled proposals-only refetch
// ---------------------------------------------------------------------------

describe('onProposalUpdate', () => {
  it('refetches proposals immediately (no debounce, no liveTailTick bump) for a matching threadId', async () => {
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());
    expect(mockListProposalsQuery).toHaveBeenCalledTimes(1);

    mockListProposalsQuery.mockResolvedValueOnce([makeProposal({ id: 'p1', status: 'executed' })]);
    const onData = mockOnProposalUpdateSubscribe.mock.calls[0][1].onData as (e: {
      proposalId: string;
      threadId: string;
      status: string;
    }) => void;
    onData({ proposalId: 'p1', threadId: 'thread-1', status: 'executed' });

    await vi.waitFor(() => expect(useAgentThreadStore.getState().proposals).toHaveLength(1));
    expect(mockListProposalsQuery).toHaveBeenCalledTimes(2);
    expect(useAgentThreadStore.getState().liveTailTick).toBe(0);
  });

  it('ignores an event for a different threadId', async () => {
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());
    expect(mockListProposalsQuery).toHaveBeenCalledTimes(1);

    const onData = mockOnProposalUpdateSubscribe.mock.calls[0][1].onData as (e: {
      proposalId: string;
      threadId: string;
      status: string;
    }) => void;
    onData({ proposalId: 'p1', threadId: 'some-other-thread', status: 'executed' });

    // Give any (incorrect) refetch a chance to land, then assert it did not.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockListProposalsQuery).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// sendMessage — the composer's `sending` gate
// ---------------------------------------------------------------------------

describe('sendMessage', () => {
  it('sets sending true while in flight, calls the mutation, then clears it', async () => {
    useAgentThreadStore.setState({ thread: makeThread() });
    let resolveSend: (() => void) | undefined;
    mockSendMessageMutate = vi.fn().mockReturnValue(
      new Promise<{ ok: true }>((resolve) => {
        resolveSend = () => resolve({ ok: true });
      }),
    );

    const sendPromise = useAgentThreadStore.getState().sendMessage('hello');
    expect(useAgentThreadStore.getState().sending).toBe(true);

    resolveSend?.();
    await sendPromise;

    expect(useAgentThreadStore.getState().sending).toBe(false);
    expect(mockSendMessageMutate).toHaveBeenCalledTimes(1);
    expect(mockSendMessageMutate).toHaveBeenCalledWith({
      threadId: 'thread-1',
      text: 'hello',
    });
  });

  it('forces one transcript + proposals refetch when the turn settles, without the live tail', async () => {
    useAgentThreadStore.setState({ thread: makeThread() });
    expect(useAgentThreadStore.getState().liveTailTick).toBe(0);
    await useAgentThreadStore.getState().sendMessage('hello');
    expect(useAgentThreadStore.getState().liveTailTick).toBe(1);
    await vi.waitFor(() => expect(mockListProposalsQuery).toHaveBeenCalledTimes(1));
    expect(mockListProposalsQuery).toHaveBeenCalledWith({ threadId: 'thread-1' });
  });

  it('is a no-op (warns, does not call the mutation) before the thread has loaded', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await useAgentThreadStore.getState().sendMessage('too early');
    expect(mockSendMessageMutate).not.toHaveBeenCalled();
    expect(useAgentThreadStore.getState().sending).toBe(false);
    warnSpy.mockRestore();
  });

  it('forwards image attachments to the mutation', async () => {
    useAgentThreadStore.setState({ thread: makeThread() });
    const images = [{ name: 'shot.png', mediaType: 'image/png' as const, base64: 'iVBORw0KGgo=' }];

    await useAgentThreadStore.getState().sendMessage('', { images });

    expect(mockSendMessageMutate).toHaveBeenCalledWith({ threadId: 'thread-1', text: '', images });
  });

  it('omits the images key entirely on a text-only turn', async () => {
    useAgentThreadStore.setState({ thread: makeThread() });

    await useAgentThreadStore.getState().sendMessage('hello', { images: [] });

    expect(mockSendMessageMutate).toHaveBeenCalledWith({ threadId: 'thread-1', text: 'hello' });
  });

  it('resets liveEvents when a new turn starts', async () => {
    useAgentThreadStore.setState({ thread: makeThread(), liveEvents: [makeResultEnvelope()] });

    await useAgentThreadStore.getState().sendMessage('hello');

    expect(useAgentThreadStore.getState().liveEvents).toEqual([]);
  });

  it('clears sending even when the mutation rejects', async () => {
    useAgentThreadStore.setState({ thread: makeThread() });
    mockSendMessageMutate = vi.fn().mockRejectedValue(new Error('spawn failed'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await useAgentThreadStore.getState().sendMessage('hello');

    expect(useAgentThreadStore.getState().sending).toBe(false);
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// interrupt — TASK-297's Stop control
// ---------------------------------------------------------------------------

describe('interrupt', () => {
  it('calls interruptTurn.mutate with the current thread id', async () => {
    useAgentThreadStore.setState({ thread: makeThread() });

    await useAgentThreadStore.getState().interrupt();

    expect(mockInterruptTurnMutate).toHaveBeenCalledWith({ threadId: 'thread-1' });
  });

  it('is a no-op (does not call the mutation) before the thread has loaded', async () => {
    await useAgentThreadStore.getState().interrupt();
    expect(mockInterruptTurnMutate).not.toHaveBeenCalled();
  });

  it('swallows a rejected mutation (console.error, does not throw)', async () => {
    useAgentThreadStore.setState({ thread: makeThread() });
    mockInterruptTurnMutate = vi.fn().mockRejectedValue(new Error('no live turn'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(useAgentThreadStore.getState().interrupt()).resolves.toBeUndefined();

    errSpy.mockRestore();
  });

  it('the resulting sendMessage settling is what actually clears `sending` — interrupt itself never touches it', async () => {
    useAgentThreadStore.setState({ thread: makeThread() });
    let resolveSend: (() => void) | undefined;
    mockSendMessageMutate = vi.fn().mockReturnValue(
      new Promise<{ ok: true }>((resolve) => {
        resolveSend = () => resolve({ ok: true });
      }),
    );

    const sendPromise = useAgentThreadStore.getState().sendMessage('do something long');
    expect(useAgentThreadStore.getState().sending).toBe(true);

    await useAgentThreadStore.getState().interrupt();
    expect(useAgentThreadStore.getState().sending).toBe(true); // interrupt alone does not clear it

    resolveSend?.(); // simulates the server settling the interrupted sendMessage call
    await sendPromise;
    expect(useAgentThreadStore.getState().sending).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// queueTurn / cancelQueuedTurn / interruptAndSend — TASK-301
// ---------------------------------------------------------------------------

describe('queueTurn / interruptAndSend (TASK-301)', () => {
  it('queueTurn buffers the turn without sending it', () => {
    useAgentThreadStore.setState({ thread: makeThread() });

    useAgentThreadStore.getState().queueTurn('do this next');

    expect(useAgentThreadStore.getState().queuedTurn).toEqual({ text: 'do this next' });
    expect(mockSendMessageMutate).not.toHaveBeenCalled();
  });

  it('a SECOND queueTurn call accumulates onto the first instead of overwriting it (TASK-301 attempt 3, blocker B)', () => {
    useAgentThreadStore.setState({ thread: makeThread() });
    const imageA = { name: 'a.png', mediaType: 'image/png' as const, base64: 'aaaa' };
    const imageB = { name: 'b.png', mediaType: 'image/png' as const, base64: 'bbbb' };

    useAgentThreadStore.getState().queueTurn('first message', [imageA]);
    useAgentThreadStore.getState().queueTurn('second message', [imageB]);

    // Both messages and both images must survive — a naive `set({ queuedTurn:
    // {...} })` overwrite (the pre-fix behavior) would leave only the second
    // call's payload here, silently discarding "first message" + imageA.
    expect(useAgentThreadStore.getState().queuedTurn).toEqual({
      text: 'first message\n\nsecond message',
      images: [imageA, imageB],
    });
  });

  it('proof of failure: attempt 2\'s overwrite reducer drops the first queued message (negative control for the test above)', () => {
    // The exact pre-fix `queueTurn` body from attempt 2 (agentThreadStore.ts,
    // before this attempt's fix): `set({ queuedTurn: { text, ...images } })`,
    // an unconditional replace with no accumulation. Reproduced here verbatim
    // (not by editing the production file — this worktree is shared with
    // sibling lanes) to prove the assertion above is discriminating: run it
    // through the SAME two-call sequence and the SAME assertion, and it fails.
    let queuedTurn: { text: string; images?: Array<{ name: string; mediaType: string; base64: string }> } | null =
      null;
    const preFixQueueTurn = (
      text: string,
      images?: Array<{ name: string; mediaType: string; base64: string }>,
    ): void => {
      queuedTurn = { text, ...(images !== undefined ? { images } : {}) };
    };
    const imageA = { name: 'a.png', mediaType: 'image/png' as const, base64: 'aaaa' };
    const imageB = { name: 'b.png', mediaType: 'image/png' as const, base64: 'bbbb' };

    preFixQueueTurn('first message', [imageA]);
    preFixQueueTurn('second message', [imageB]);

    // Against the pre-fix reducer this is FALSE — `queuedTurn` is just
    // `{ text: 'second message', images: [imageB] }`, silently discarding
    // "first message" + imageA. This assertion documents that failure so the
    // reducer's discriminating power (and this attempt's fix) is on record.
    expect(queuedTurn).not.toEqual({
      text: 'first message\n\nsecond message',
      images: [imageA, imageB],
    });
    expect(queuedTurn).toEqual({ text: 'second message', images: [imageB] });
  });

  it('cancelQueuedTurn clears a pending queue without ever sending it', () => {
    useAgentThreadStore.setState({ thread: makeThread() });
    useAgentThreadStore.getState().queueTurn('never mind');

    useAgentThreadStore.getState().cancelQueuedTurn();

    expect(useAgentThreadStore.getState().queuedTurn).toBeNull();
    expect(mockSendMessageMutate).not.toHaveBeenCalled();
  });

  it('delivers the queued turn the instant the in-flight sendMessage call settles', async () => {
    useAgentThreadStore.setState({ thread: makeThread() });
    let resolveFirst: (() => void) | undefined;
    mockSendMessageMutate = vi.fn().mockImplementation(() =>
      mockSendMessageMutate.mock.calls.length === 1
        ? new Promise<{ ok: true }>((resolve) => {
            resolveFirst = () => resolve({ ok: true });
          })
        : Promise.resolve({ ok: true }),
    );

    const firstSend = useAgentThreadStore.getState().sendMessage('first turn');
    useAgentThreadStore.getState().queueTurn('queued follow-up');
    expect(mockSendMessageMutate).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await firstSend;

    // The queued turn was auto-delivered as soon as the first one landed.
    await vi.waitFor(() => expect(mockSendMessageMutate).toHaveBeenCalledTimes(2));
    expect(mockSendMessageMutate).toHaveBeenLastCalledWith({
      threadId: 'thread-1',
      text: 'queued follow-up',
    });
    expect(useAgentThreadStore.getState().queuedTurn).toBeNull();
  });

  it('does NOT double-deliver a queued turn when the server publishes the terminal envelope WHILE this renderer\'s own sendMessage call is still in flight (blocker 3 race: AgentThreadService.spawn() emits the terminal envelope BEFORE spawn() — and therefore the mutate() promise — resolves)', async () => {
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());

    let resolveFirst: (() => void) | undefined;
    mockSendMessageMutate = vi.fn().mockImplementation(() =>
      mockSendMessageMutate.mock.calls.length === 1
        ? new Promise<{ ok: true }>((resolve) => {
            resolveFirst = () => resolve({ ok: true });
          })
        : Promise.resolve({ ok: true }),
    );

    const firstSend = useAgentThreadStore.getState().sendMessage('first turn');
    useAgentThreadStore.getState().queueTurn('queued follow-up');
    expect(mockSendMessageMutate).toHaveBeenCalledTimes(1);

    // The server publishes the terminal `result` envelope over the live tail
    // WHILE this renderer's own `sendMessage.mutate()` call is still pending —
    // the exact race: the server's onOutput fires the terminal envelope from
    // inside AgentThreadService.spawn(), before spawn() itself (and therefore
    // this mutate() call) returns.
    const onData = mockOnThreadEventSubscribe.mock.calls[0][1].onData as (values: unknown[]) => void;
    onData([makeResultEnvelope()]);

    // Must NOT have double-spawned yet: this renderer holds a local
    // currentSendPromise for the in-flight turn, so delivery is owned
    // exclusively by that call's own `finally` once it truly settles — never
    // from the terminal-marker handler too.
    expect(mockSendMessageMutate).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await firstSend;

    // NOW it delivers — exactly once, from the first send's own `finally`.
    await vi.waitFor(() => expect(mockSendMessageMutate).toHaveBeenCalledTimes(2));
    expect(mockSendMessageMutate).toHaveBeenLastCalledWith({
      threadId: 'thread-1',
      text: 'queued follow-up',
    });
    expect(useAgentThreadStore.getState().queuedTurn).toBeNull();
  });

  it('delivers a queued turn threaded with images', async () => {
    useAgentThreadStore.setState({ thread: makeThread() });
    const images = [{ name: 'shot.png', mediaType: 'image/png' as const, base64: 'iVBORw0KGgo=' }];
    let resolveFirst: (() => void) | undefined;
    mockSendMessageMutate = vi.fn().mockImplementation(() =>
      mockSendMessageMutate.mock.calls.length === 1
        ? new Promise<{ ok: true }>((resolve) => {
            resolveFirst = () => resolve({ ok: true });
          })
        : Promise.resolve({ ok: true }),
    );

    const firstSend = useAgentThreadStore.getState().sendMessage('first turn');
    useAgentThreadStore.getState().queueTurn('with a picture', images);
    resolveFirst?.();
    await firstSend;

    await vi.waitFor(() => expect(mockSendMessageMutate).toHaveBeenCalledTimes(2));
    expect(mockSendMessageMutate).toHaveBeenLastCalledWith({
      threadId: 'thread-1',
      text: 'with a picture',
      images,
    });
  });

  it('delivers a queued turn on a terminal live-tail marker even with no local sendMessage promise (reload mid-turn)', async () => {
    mockTurnStateQuery = vi.fn().mockResolvedValue({ inFlight: true });
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().sending).toBe(true));

    useAgentThreadStore.getState().queueTurn('deliver me on terminal marker');
    const onData = mockOnThreadEventSubscribe.mock.calls[0][1].onData as (values: unknown[]) => void;
    onData([makeResultEnvelope()]);

    await vi.waitFor(() => expect(mockSendMessageMutate).toHaveBeenCalledTimes(1));
    expect(mockSendMessageMutate).toHaveBeenCalledWith({
      threadId: 'thread-1',
      text: 'deliver me on terminal marker',
    });
    expect(useAgentThreadStore.getState().queuedTurn).toBeNull();
  });

  it('interruptAndSend calls interruptTurn, then sends once the interrupted call settles, preserving thread continuity', async () => {
    useAgentThreadStore.setState({ thread: makeThread({ claudeSessionId: 'sess-1' }) });
    let resolveFirst: (() => void) | undefined;
    mockSendMessageMutate = vi.fn().mockImplementation(() =>
      mockSendMessageMutate.mock.calls.length === 1
        ? new Promise<{ ok: true }>((resolve) => {
            resolveFirst = () => resolve({ ok: true });
          })
        : Promise.resolve({ ok: true }),
    );

    const firstSend = useAgentThreadStore.getState().sendMessage('long turn');
    expect(useAgentThreadStore.getState().sending).toBe(true);

    const interruptAndSendPromise = useAgentThreadStore.getState().interruptAndSend('abort and send this now');
    await vi.waitFor(() => expect(mockInterruptTurnMutate).toHaveBeenCalledWith({ threadId: 'thread-1' }));

    // The second send must NOT fire before the first one's own call settles —
    // AgentThreadService has no per-thread send queue of its own.
    expect(mockSendMessageMutate).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await firstSend;
    await interruptAndSendPromise;

    expect(mockSendMessageMutate).toHaveBeenCalledTimes(2);
    expect(mockSendMessageMutate).toHaveBeenLastCalledWith({
      threadId: 'thread-1',
      text: 'abort and send this now',
    });
  });

  it('interruptAndSend drops a pending queued turn (an explicit interrupt supersedes it)', async () => {
    useAgentThreadStore.setState({ thread: makeThread() });
    useAgentThreadStore.getState().queueTurn('stale queued text');

    await useAgentThreadStore.getState().interruptAndSend('fresh text instead');

    expect(useAgentThreadStore.getState().queuedTurn).toBeNull();
    expect(mockSendMessageMutate).toHaveBeenCalledTimes(1);
    expect(mockSendMessageMutate).toHaveBeenCalledWith({ threadId: 'thread-1', text: 'fresh text instead' });
  });

  it('interruptAndSend is a no-op before the thread has loaded', async () => {
    await useAgentThreadStore.getState().interruptAndSend('too early');
    expect(mockInterruptTurnMutate).not.toHaveBeenCalled();
    expect(mockSendMessageMutate).not.toHaveBeenCalled();
  });

  it('negative control: interrupting while genuinely idle (no queued/in-flight turn) never calls sendMessage from queue delivery', async () => {
    // No turn in flight, nothing queued — a terminal-marker-style event must
    // never fabricate a delivery when queuedTurn is null.
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());
    const onData = mockOnThreadEventSubscribe.mock.calls[0][1].onData as (values: unknown[]) => void;
    onData([makeResultEnvelope()]);

    expect(mockSendMessageMutate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// composerDraft / pendingContextHint — Custom Views §7.1's authoring kickoff
// ---------------------------------------------------------------------------

describe('composerDraft / pendingContextHint', () => {
  it('setComposerDraft / setPendingContextHint set and clear (null)', () => {
    useAgentThreadStore.getState().setComposerDraft('Build me a widget…');
    expect(useAgentThreadStore.getState().composerDraft).toBe('Build me a widget…');
    useAgentThreadStore.getState().setComposerDraft(null);
    expect(useAgentThreadStore.getState().composerDraft).toBeNull();

    useAgentThreadStore.getState().setPendingContextHint('[custom-widget-session]\n...');
    expect(useAgentThreadStore.getState().pendingContextHint).toBe('[custom-widget-session]\n...');
    useAgentThreadStore.getState().setPendingContextHint(null);
    expect(useAgentThreadStore.getState().pendingContextHint).toBeNull();
  });

  it('sendMessage attaches a pending contextHint to the NEXT turn only, then clears it', async () => {
    useAgentThreadStore.setState({ thread: makeThread() });
    useAgentThreadStore.getState().setPendingContextHint('[custom-widget-session]\nsessionId=s1');

    await useAgentThreadStore.getState().sendMessage('here is my widget');

    expect(mockSendMessageMutate).toHaveBeenCalledWith({
      threadId: 'thread-1',
      text: 'here is my widget',
      contextHint: '[custom-widget-session]\nsessionId=s1',
    });
    expect(useAgentThreadStore.getState().pendingContextHint).toBeNull();

    // A second send carries no hint — it was one-shot.
    await useAgentThreadStore.getState().sendMessage('a follow-up');
    expect(mockSendMessageMutate).toHaveBeenLastCalledWith({ threadId: 'thread-1', text: 'a follow-up' });
  });

  it('an explicit opts.contextHint wins over a pending one', async () => {
    useAgentThreadStore.setState({ thread: makeThread() });
    useAgentThreadStore.getState().setPendingContextHint('[custom-widget-session]\nsessionId=s1');

    await useAgentThreadStore.getState().sendMessage('hello', { contextHint: 'widget:i1' });

    expect(mockSendMessageMutate).toHaveBeenCalledWith({
      threadId: 'thread-1',
      text: 'hello',
      contextHint: 'widget:i1',
    });
    // Still consumed/cleared even though it lost.
    expect(useAgentThreadStore.getState().pendingContextHint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// confirmProposal / dismissProposal — propagate + refresh
// ---------------------------------------------------------------------------

describe('confirmProposal / dismissProposal', () => {
  it('confirmProposal returns the mutation result and refreshes proposals', async () => {
    useAgentThreadStore.setState({ thread: makeThread() });
    mockListProposalsQuery.mockResolvedValueOnce([makeProposal({ id: 'p1', status: 'executed' })]);

    const result = await useAgentThreadStore.getState().confirmProposal('p1');

    expect(result).toEqual({ ok: true, dismissed: false });
    expect(mockConfirmProposalMutate).toHaveBeenCalledTimes(1);
    expect(mockConfirmProposalMutate).toHaveBeenCalledWith({ proposalId: 'p1' });
    expect(useAgentThreadStore.getState().proposals).toHaveLength(1);
  });

  it('dismissProposal returns the mutation result and refreshes proposals', async () => {
    useAgentThreadStore.setState({ thread: makeThread() });
    mockListProposalsQuery.mockResolvedValueOnce([]);

    const result = await useAgentThreadStore.getState().dismissProposal('p1');

    expect(result).toEqual({ ok: true, dismissed: true });
    expect(mockDismissProposalMutate).toHaveBeenCalledTimes(1);
    expect(mockDismissProposalMutate).toHaveBeenCalledWith({ proposalId: 'p1' });
  });
});
