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
let mockSendMessageMutate: ReturnType<typeof vi.fn>;
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
        sendMessage: { get mutate() { return mockSendMessageMutate; } },
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
  mockSendMessageMutate = vi.fn().mockResolvedValue({ ok: true });
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

    const onData = mockOnThreadEventSubscribe.mock.calls[0][1].onData as () => void;
    onData();
    onData();
    onData();
    // Still debounced — no tick bump yet.
    expect(useAgentThreadStore.getState().liveTailTick).toBe(0);

    await vi.advanceTimersByTimeAsync(150);

    expect(useAgentThreadStore.getState().liveTailTick).toBe(1);
    expect(mockListProposalsQuery).toHaveBeenCalledTimes(2);
  });

  it('captures stream_event envelopes into liveEvents, unthrottled (no debounce wait needed)', async () => {
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());

    const onData = mockOnThreadEventSubscribe.mock.calls[0][1].onData as (value: unknown) => void;
    const env1 = makeStreamEventEnvelope({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
    const env2 = makeStreamEventEnvelope({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hi' },
    });
    onData(env1);
    onData(env2);

    expect(useAgentThreadStore.getState().liveEvents).toEqual([env1, env2]);
  });

  it('resets liveEvents to [] on a terminal result envelope', async () => {
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());

    const onData = mockOnThreadEventSubscribe.mock.calls[0][1].onData as (value: unknown) => void;
    onData(makeStreamEventEnvelope({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    expect(useAgentThreadStore.getState().liveEvents).toHaveLength(1);

    onData(makeResultEnvelope());
    expect(useAgentThreadStore.getState().liveEvents).toEqual([]);
  });

  it('ignores a malformed (non-envelope-shaped) onData value', async () => {
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());

    const onData = mockOnThreadEventSubscribe.mock.calls[0][1].onData as (value: unknown) => void;
    onData(undefined);
    onData('not an envelope');
    onData({ type: 'stream_event' }); // missing payload/timestamp
    expect(useAgentThreadStore.getState().liveEvents).toEqual([]);
  });

  it('caps liveEvents at MAX_LIVE_EVENTS (2000), dropping the oldest', async () => {
    unsub = useAgentThreadStore.getState().init();
    await vi.waitFor(() => expect(useAgentThreadStore.getState().thread).not.toBeNull());

    const onData = mockOnThreadEventSubscribe.mock.calls[0][1].onData as (value: unknown) => void;
    for (let i = 0; i < 2005; i++) {
      onData(
        makeStreamEventEnvelope({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: String(i) } }),
      );
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
    second.onData(undefined);
    await vi.advanceTimersByTimeAsync(150);
    expect(useAgentThreadStore.getState().liveTailTick).toBe(1);

    // A late callback from the SUPERSEDED subscription is ignored.
    first.onData(undefined);
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
