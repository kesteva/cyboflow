/**
 * Unit tests for the cyboflow.agentThread router (S0.6).
 *
 * Exercised via appRouter.createCaller(createContext({...})) with FAKE narrow
 * deps (service / store / executor) — the same createCaller idiom questions.test
 * uses. The store fake carries realistic CAS semantics (claim/finalize/dismiss
 * guarded on current status) so the open-session immediate-execute path is a real
 * transition, not a stub.
 *
 * Covers: getThread, sendMessage, triggerDigest, listProposals, listMessages,
 * the open-session Confirm (CAS-claim → finalize executed → navigation), the
 * executor delegation path, the superseded loopback-injection call, dismiss,
 * not-found, and that onProposalUpdate fires on every terminal transition.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import type {
  AgentThreadServiceLike,
  AgentThreadStoreLike,
  AgentProposalExecutorLike,
} from '../../context';
import { agentThreadProposalEvents, type AgentProposalUpdateEvent } from '../agentThread';
import type { DatabaseLike, PreparedStatement } from '../../../types';
import type {
  AgentProposal,
  AgentProposalPayload,
  AgentProposalStatus,
  AgentThread,
} from '../../../../../../shared/types/agentThread';
import type { ExecuteProposalResult } from '../../../agentThread/proposalExecutor';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const THREAD: AgentThread = {
  id: 'thread-1',
  scope: 'global',
  model: null,
  claudeSessionId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function makeProposal(overrides: Partial<AgentProposal> & { payload: AgentProposalPayload }): AgentProposal {
  return {
    id: overrides.id ?? 'prop-1',
    threadId: overrides.threadId ?? 'thread-1',
    kind: overrides.payload.kind,
    payload: overrides.payload,
    preconditions: overrides.preconditions ?? null,
    status: overrides.status ?? 'proposed',
    result: overrides.result ?? null,
    idempotencyKey: overrides.idempotencyKey ?? null,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00Z',
    decidedAt: overrides.decidedAt ?? null,
  };
}

/** In-memory AgentThreadStoreLike with realistic CAS-guarded transitions. */
class FakeStore implements AgentThreadStoreLike {
  private readonly proposals = new Map<string, AgentProposal>();

  seed(p: AgentProposal): void {
    this.proposals.set(p.id, p);
  }

  listProposals(threadId: string): AgentProposal[] {
    return [...this.proposals.values()].filter((p) => p.threadId === threadId);
  }

  getProposal(id: string): AgentProposal | null {
    return this.proposals.get(id) ?? null;
  }

  claimProposal(id: string, idempotencyKey: string): boolean {
    const p = this.proposals.get(id);
    if (!p || p.status !== 'proposed') return false;
    this.proposals.set(id, { ...p, status: 'executing', idempotencyKey });
    return true;
  }

  finalizeProposal(id: string, status: 'executed' | 'failed', resultJson: string | null): boolean {
    const p = this.proposals.get(id);
    if (!p || p.status !== 'executing') return false;
    this.proposals.set(id, {
      ...p,
      status,
      result: resultJson ? (JSON.parse(resultJson) as unknown) : null,
      decidedAt: 'now',
    });
    return true;
  }

  dismissProposal(id: string): boolean {
    const p = this.proposals.get(id);
    if (!p || p.status !== 'proposed') return false;
    this.proposals.set(id, { ...p, status: 'dismissed', decidedAt: 'now' });
    return true;
  }

  statusOf(id: string): AgentProposalStatus | undefined {
    return this.proposals.get(id)?.status;
  }
}

function makeService(): AgentThreadServiceLike & {
  ensureGlobalThread: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  triggerDigest: ReturnType<typeof vi.fn>;
} {
  return {
    ensureGlobalThread: vi.fn(() => THREAD),
    sendMessage: vi.fn(async () => undefined),
    triggerDigest: vi.fn(async () => ({ triggered: true as const })),
  };
}

/** Mock DatabaseLike for listMessages: returns canned agent_thread_events rows filtered by threadId. */
function makeMockDb(
  rows: { id: number; threadId: string; payloadJson: string; createdAt: string }[],
): DatabaseLike {
  const stmt: PreparedStatement = {
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    get: () => undefined,
    all: (...params: unknown[]) => rows.filter((r) => r.threadId === (params[0] as string)),
  };
  return { prepare: () => stmt, transaction: <T>(fn: (...a: unknown[]) => T) => fn };
}

function collectUpdates(): { events: AgentProposalUpdateEvent[]; stop: () => void } {
  const events: AgentProposalUpdateEvent[] = [];
  const listener = (ev: AgentProposalUpdateEvent): void => {
    events.push(ev);
  };
  agentThreadProposalEvents.on('update', listener);
  return { events, stop: () => agentThreadProposalEvents.off('update', listener) };
}

afterEach(() => {
  agentThreadProposalEvents.removeAllListeners();
});

// ---------------------------------------------------------------------------
// Read/simple procedures
// ---------------------------------------------------------------------------

describe('cyboflow.agentThread read/simple procedures', () => {
  it('getThread ensures + returns the global thread', async () => {
    const service = makeService();
    const caller = appRouter.createCaller(createContext({ agentThreadService: service }));
    const result = await caller.cyboflow.agentThread.getThread();
    expect(result).toEqual(THREAD);
    expect(service.ensureGlobalThread).toHaveBeenCalledTimes(1);
  });

  it('sendMessage forwards to the service and returns { ok: true }', async () => {
    const service = makeService();
    const caller = appRouter.createCaller(createContext({ agentThreadService: service }));
    const result = await caller.cyboflow.agentThread.sendMessage({ threadId: 'thread-1', text: 'hi' });
    expect(result).toEqual({ ok: true });
    expect(service.sendMessage).toHaveBeenCalledWith('thread-1', 'hi');
  });

  it('triggerDigest returns the service throttle result', async () => {
    const service = makeService();
    service.triggerDigest.mockResolvedValueOnce({ triggered: false, reason: 'throttled' });
    const caller = appRouter.createCaller(createContext({ agentThreadService: service }));
    const result = await caller.cyboflow.agentThread.triggerDigest({ threadId: 'thread-1' });
    expect(result).toEqual({ triggered: false, reason: 'throttled' });
  });

  it('listProposals returns the store rows for the thread', async () => {
    const store = new FakeStore();
    store.seed(makeProposal({ id: 'p-1', payload: { kind: 'open-session', navigation: { target: 'run', runId: 'r1' } } }));
    const caller = appRouter.createCaller(createContext({ agentThreadStore: store }));
    const result = await caller.cyboflow.agentThread.listProposals({ threadId: 'thread-1' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p-1');
  });

  it('listMessages projects agent_thread_events rows through the shared pipeline', async () => {
    const db = makeMockDb([
      {
        id: 1,
        threadId: 'thread-1',
        createdAt: '2026-01-01T00:00:01Z',
        payloadJson: JSON.stringify({
          type: 'assistant',
          message: { id: 'm1', model: 'claude-opus-4', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        }),
      },
    ]);
    const caller = appRouter.createCaller(createContext({ db }));
    const result = await caller.cyboflow.agentThread.listMessages({ threadId: 'thread-1' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('m1');
    expect(result[0].segments[0]).toEqual({ type: 'text', content: 'hello' });
  });
});

// ---------------------------------------------------------------------------
// confirmProposal
// ---------------------------------------------------------------------------

describe('cyboflow.agentThread.confirmProposal', () => {
  it('open-session: CAS-claims, finalizes executed, returns navigation, fires onProposalUpdate', async () => {
    const store = new FakeStore();
    store.seed(
      makeProposal({ id: 'p-open', payload: { kind: 'open-session', navigation: { target: 'quick-session', sessionId: 's1' } } }),
    );
    const executor: AgentProposalExecutorLike = { execute: vi.fn() };
    const { events, stop } = collectUpdates();

    const caller = appRouter.createCaller(
      createContext({ agentThreadStore: store, agentProposalExecutor: executor }),
    );
    const result = await caller.cyboflow.agentThread.confirmProposal({ proposalId: 'p-open' });
    stop();

    expect(result).toEqual({
      ok: true,
      kind: 'open-session',
      proposalId: 'p-open',
      status: 'executed',
      navigation: { target: 'quick-session', sessionId: 's1' },
    });
    // The executor is NEVER invoked for open-session (renderer navigation only).
    expect(executor.execute).not.toHaveBeenCalled();
    // The row transitioned to executed via the router's store calls.
    expect(store.statusOf('p-open')).toBe('executed');
    // onProposalUpdate fired with the executed status.
    expect(events).toEqual([{ proposalId: 'p-open', threadId: 'thread-1', status: 'executed' }]);
  });

  it('open-session double-confirm loser is rejected with reason:claimed', async () => {
    const store = new FakeStore();
    store.seed(makeProposal({ id: 'p-dup', payload: { kind: 'open-session', navigation: { target: 'run', runId: 'r9' } } }));
    const caller = appRouter.createCaller(createContext({ agentThreadStore: store }));

    const first = await caller.cyboflow.agentThread.confirmProposal({ proposalId: 'p-dup' });
    expect(first.ok).toBe(true);
    const second = await caller.cyboflow.agentThread.confirmProposal({ proposalId: 'p-dup' });
    expect(second).toEqual({ ok: false, reason: 'claimed' });
  });

  it('executable kind: delegates to the executor and returns its result, fires onProposalUpdate', async () => {
    const store = new FakeStore();
    store.seed(
      makeProposal({
        id: 'p-repri',
        payload: { kind: 'reprioritize-backlog', projectId: 1, items: [{ taskId: 'TASK-1', priority: 'P0' }] },
      }),
    );
    const executed: ExecuteProposalResult = {
      ok: true,
      proposalId: 'p-repri',
      kind: 'reprioritize-backlog',
      status: 'executed',
      result: { kind: 'reprioritize-backlog', status: 'executed', items: [{ taskId: 'TASK-1', ok: true }] },
    };
    // The real executor uses the SAME store to claim+finalize; the fake mirrors that
    // so the router's post-transition onProposalUpdate reflects a terminal status.
    const executor: AgentProposalExecutorLike = {
      execute: vi.fn(async (id: string) => {
        store.claimProposal(id, 'k');
        store.finalizeProposal(id, 'executed', JSON.stringify(executed.result));
        return executed;
      }),
    };
    const service = makeService();
    const { events, stop } = collectUpdates();

    const caller = appRouter.createCaller(
      createContext({ agentThreadStore: store, agentProposalExecutor: executor, agentThreadService: service }),
    );
    const result = await caller.cyboflow.agentThread.confirmProposal({ proposalId: 'p-repri' });
    stop();

    expect(executor.execute).toHaveBeenCalledWith('p-repri');
    expect(result).toEqual(executed);
    // No loopback for a successful executable proposal.
    expect(service.sendMessage).not.toHaveBeenCalled();
    expect(events).toEqual([{ proposalId: 'p-repri', threadId: 'thread-1', status: 'executed' }]);
  });

  it('superseded: injects the loopback turn into the thread and returns superseded', async () => {
    const store = new FakeStore();
    store.seed(
      makeProposal({
        id: 'p-edit',
        threadId: 'thread-1',
        payload: { kind: 'edit-workflow', workflowId: 'wf-1', definitionJson: '{}' },
      }),
    );
    const superseded: ExecuteProposalResult = {
      ok: false,
      reason: 'superseded',
      loopbackTurn: 'The workflow changed — re-read and re-propose.',
    };
    const executor: AgentProposalExecutorLike = { execute: vi.fn(async () => superseded) };
    const service = makeService();
    const { events, stop } = collectUpdates();

    const caller = appRouter.createCaller(
      createContext({ agentThreadStore: store, agentProposalExecutor: executor, agentThreadService: service }),
    );
    const result = await caller.cyboflow.agentThread.confirmProposal({ proposalId: 'p-edit' });
    // Let the fire-and-forget loopback microtask settle.
    await Promise.resolve();
    stop();

    expect(result).toEqual(superseded);
    // The loopback turn is injected as a new agent turn on the proposal's thread.
    expect(service.sendMessage).toHaveBeenCalledWith('thread-1', superseded.loopbackTurn);
    // onProposalUpdate still fires (terminal path).
    expect(events).toHaveLength(1);
    expect(events[0].proposalId).toBe('p-edit');
  });

  it('validation-failed: also injects the loopback turn', async () => {
    const store = new FakeStore();
    store.seed(
      makeProposal({ id: 'p-bad', payload: { kind: 'edit-workflow', workflowId: 'wf-2', definitionJson: 'not json' } }),
    );
    const failed: ExecuteProposalResult = {
      ok: false,
      reason: 'validation-failed',
      loopbackTurn: 'The edit did not validate — fix and re-propose.',
    };
    const executor: AgentProposalExecutorLike = { execute: vi.fn(async () => failed) };
    const service = makeService();

    const caller = appRouter.createCaller(
      createContext({ agentThreadStore: store, agentProposalExecutor: executor, agentThreadService: service }),
    );
    const result = await caller.cyboflow.agentThread.confirmProposal({ proposalId: 'p-bad' });
    await Promise.resolve();

    expect(result).toEqual(failed);
    expect(service.sendMessage).toHaveBeenCalledWith('thread-1', failed.loopbackTurn);
  });

  it('not-found: returns reason:not-found without touching the executor', async () => {
    const store = new FakeStore();
    const executor: AgentProposalExecutorLike = { execute: vi.fn() };
    const caller = appRouter.createCaller(createContext({ agentThreadStore: store, agentProposalExecutor: executor }));
    const result = await caller.cyboflow.agentThread.confirmProposal({ proposalId: 'nope' });
    expect(result).toEqual({ ok: false, reason: 'not-found' });
    expect(executor.execute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// dismissProposal
// ---------------------------------------------------------------------------

describe('cyboflow.agentThread.dismissProposal', () => {
  it('dismisses a proposed proposal and fires onProposalUpdate', async () => {
    const store = new FakeStore();
    store.seed(makeProposal({ id: 'p-dismiss', payload: { kind: 'open-session', navigation: { target: 'run', runId: 'r1' } } }));
    const { events, stop } = collectUpdates();

    const caller = appRouter.createCaller(createContext({ agentThreadStore: store }));
    const result = await caller.cyboflow.agentThread.dismissProposal({ proposalId: 'p-dismiss' });
    stop();

    expect(result).toEqual({ ok: true, dismissed: true });
    expect(store.statusOf('p-dismiss')).toBe('dismissed');
    expect(events).toEqual([{ proposalId: 'p-dismiss', threadId: 'thread-1', status: 'dismissed' }]);
  });

  it('dismiss returns dismissed:false when the proposal is not in proposed state', async () => {
    const store = new FakeStore();
    store.seed(makeProposal({ id: 'p-done', status: 'executed', payload: { kind: 'open-session', navigation: { target: 'run', runId: 'r1' } } }));
    const caller = appRouter.createCaller(createContext({ agentThreadStore: store }));
    const result = await caller.cyboflow.agentThread.dismissProposal({ proposalId: 'p-done' });
    expect(result).toEqual({ ok: true, dismissed: false });
  });
});

// ---------------------------------------------------------------------------
// Subscriptions + precondition guards
// ---------------------------------------------------------------------------

describe('cyboflow.agentThread.onProposalUpdate', () => {
  it('yields an AgentProposalUpdateEvent emitted on agentThreadProposalEvents', async () => {
    const caller = appRouter.createCaller(createContext({}));
    const subscription = await caller.cyboflow.agentThread.onProposalUpdate();

    const resultPromise = (async () => {
      for await (const ev of subscription as AsyncIterable<AgentProposalUpdateEvent>) {
        return ev;
      }
      return undefined;
    })();

    const payload: AgentProposalUpdateEvent = { proposalId: 'p-x', threadId: 'thread-1', status: 'executed' };
    setImmediate(() => agentThreadProposalEvents.emit('update', payload));

    expect(await resultPromise).toEqual(payload);
  });
});

describe('cyboflow.agentThread precondition guards', () => {
  it('getThread throws PRECONDITION_FAILED when the service is unwired', async () => {
    const caller = appRouter.createCaller(createContext({}));
    await expect(caller.cyboflow.agentThread.getThread()).rejects.toThrow(/AgentThreadService not wired/);
  });

  it('confirmProposal throws PRECONDITION_FAILED for an executable kind when the executor is unwired', async () => {
    const store = new FakeStore();
    store.seed(makeProposal({ id: 'p-noexec', payload: { kind: 'reprioritize-backlog', projectId: 1, items: [] } }));
    const caller = appRouter.createCaller(createContext({ agentThreadStore: store }));
    await expect(
      caller.cyboflow.agentThread.confirmProposal({ proposalId: 'p-noexec' }),
    ).rejects.toThrow(/proposal executor not wired/);
  });
});
