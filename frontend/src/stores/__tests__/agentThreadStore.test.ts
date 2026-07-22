/**
 * Unit tests for agentThreadStore — init() bootstrap/idempotency, the debounced
 * onThreadEvent → (liveTailTick bump + proposals refetch) path, the targeted
 * onProposalUpdate refetch, and the sendMessage/triggerDigest `sending` gate.
 *
 * The tRPC client is mocked at module level (mirrors backlogStore.test.ts /
 * reviewQueueStore.test.ts) so importing the store does not require a live
 * Electron IPC bridge.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentThread, AgentProposal } from '../../../../shared/types/agentThread';

// Mutable mock refs — replaced in beforeEach so each test gets fresh spies.
let mockGetThreadQuery: ReturnType<typeof vi.fn>;
let mockListProposalsQuery: ReturnType<typeof vi.fn>;
let mockSendMessageMutate: ReturnType<typeof vi.fn>;
let mockTriggerDigestMutate: ReturnType<typeof vi.fn>;
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
        triggerDigest: { get mutate() { return mockTriggerDigestMutate; } },
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
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
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
  mockTriggerDigestMutate = vi.fn().mockResolvedValue({ triggered: true });
  mockConfirmProposalMutate = vi.fn().mockResolvedValue({ ok: true, dismissed: false });
  mockDismissProposalMutate = vi.fn().mockResolvedValue({ ok: true, dismissed: true });
  mockOnThreadEventUnsubscribe = vi.fn();
  mockOnThreadEventSubscribe = vi.fn().mockReturnValue({ unsubscribe: mockOnThreadEventUnsubscribe });
  mockOnProposalUpdateUnsubscribe = vi.fn();
  mockOnProposalUpdateSubscribe = vi.fn().mockReturnValue({ unsubscribe: mockOnProposalUpdateUnsubscribe });

  useAgentThreadStore.setState({
    thread: null,
    proposals: [],
    loading: false,
    sending: false,
    liveTailTick: 0,
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
// sendMessage / triggerDigest — the composer's `sending` gate
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

  it('is a no-op (warns, does not call the mutation) before the thread has loaded', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await useAgentThreadStore.getState().sendMessage('too early');
    expect(mockSendMessageMutate).not.toHaveBeenCalled();
    expect(useAgentThreadStore.getState().sending).toBe(false);
    warnSpy.mockRestore();
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

describe('triggerDigest', () => {
  it('sets sending true while in flight, calls the mutation, and returns "consumed" when triggered', async () => {
    useAgentThreadStore.setState({ thread: makeThread() });
    let resolveDigest: (() => void) | undefined;
    mockTriggerDigestMutate = vi.fn().mockReturnValue(
      new Promise<{ triggered: true }>((resolve) => {
        resolveDigest = () => resolve({ triggered: true });
      }),
    );

    const promise = useAgentThreadStore.getState().triggerDigest();
    expect(useAgentThreadStore.getState().sending).toBe(true);

    resolveDigest?.();
    const outcome = await promise;

    expect(outcome).toBe('consumed');
    expect(useAgentThreadStore.getState().sending).toBe(false);
    expect(mockTriggerDigestMutate).toHaveBeenCalledTimes(1);
    expect(mockTriggerDigestMutate).toHaveBeenCalledWith({ threadId: 'thread-1' });
  });

  it('returns "consumed" when the backend reports the day already fired (throttled)', async () => {
    useAgentThreadStore.setState({ thread: makeThread() });
    mockTriggerDigestMutate = vi.fn().mockResolvedValue({ triggered: false, reason: 'throttled' });

    const outcome = await useAgentThreadStore.getState().triggerDigest();
    expect(outcome).toBe('consumed');
  });

  it('returns "retry" when the assistant is disabled (nothing was stamped)', async () => {
    useAgentThreadStore.setState({ thread: makeThread() });
    mockTriggerDigestMutate = vi.fn().mockResolvedValue({ triggered: false, reason: 'disabled' });

    const outcome = await useAgentThreadStore.getState().triggerDigest();
    expect(outcome).toBe('retry');
  });

  it('returns "retry" and swallows the error when the mutation rejects', async () => {
    useAgentThreadStore.setState({ thread: makeThread() });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockTriggerDigestMutate = vi.fn().mockRejectedValue(new Error('ipc down'));

    const outcome = await useAgentThreadStore.getState().triggerDigest();
    expect(outcome).toBe('retry');
    expect(useAgentThreadStore.getState().sending).toBe(false);
    errSpy.mockRestore();
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
