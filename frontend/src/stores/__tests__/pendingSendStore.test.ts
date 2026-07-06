/**
 * pendingSendStore — optimistic-echo model unit tests.
 *
 * Covers:
 *   - addPending / setStatus / removePending basics (host-keyed)
 *   - reconcile: timestamp-windowed greedy match drops in-flight rows once the
 *     real user turn lands; leaves 'failed' rows; ignores stale/older messages;
 *     maps identical repeat sends one-to-one
 *   - requestReopen: removes the entry and stages a nonce-bumped draft request
 *   - clearDraftRequest / resetHost
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { usePendingSendStore } from '../pendingSendStore';
import type { UnifiedMessage } from '../../../../shared/types/unifiedMessage';

const HOST = 'panel-1';

function userMsg(text: string, timestamp: string): UnifiedMessage {
  return {
    id: `u-${timestamp}-${text}`,
    role: 'user',
    timestamp,
    segments: [{ type: 'text', content: text }],
  };
}

beforeEach(() => {
  usePendingSendStore.setState({ byHost: {}, draftRequest: {} });
});

describe('pendingSendStore — basics', () => {
  it('addPending appends a host-keyed entry and returns its id (default sending)', () => {
    const id = usePendingSendStore.getState().addPending(HOST, 'hello');
    const list = usePendingSendStore.getState().byHost[HOST];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, text: 'hello', status: 'sending' });
    expect(typeof list[0].createdAt).toBe('number');
  });

  it('setStatus flips a single entry; removePending drops it', () => {
    const s = usePendingSendStore.getState();
    const id = s.addPending(HOST, 'x', 'queued');
    s.setStatus(HOST, id, 'failed');
    expect(usePendingSendStore.getState().byHost[HOST][0].status).toBe('failed');
    s.removePending(HOST, id);
    expect(usePendingSendStore.getState().byHost[HOST]).toHaveLength(0);
  });

  it('entries are isolated per host key', () => {
    const s = usePendingSendStore.getState();
    s.addPending('a', 'ma');
    s.addPending('b', 'mb');
    expect(usePendingSendStore.getState().byHost['a']).toHaveLength(1);
    expect(usePendingSendStore.getState().byHost['b']).toHaveLength(1);
  });
});

describe('pendingSendStore — reconcile', () => {
  it('drops a sending entry once a matching user turn lands at/after createdAt', () => {
    const s = usePendingSendStore.getState();
    s.addPending(HOST, 'do the thing');
    // A user turn timestamped now (>= createdAt) with matching text.
    s.reconcile(HOST, [userMsg('do the thing', new Date().toISOString())]);
    expect(usePendingSendStore.getState().byHost[HOST]).toHaveLength(0);
  });

  it('does NOT drop when the only matching message predates the entry window (stale history)', () => {
    const s = usePendingSendStore.getState();
    s.addPending(HOST, 'repeat me');
    // A message from long before this send must not reconcile it.
    const old = new Date(Date.now() - 60_000).toISOString();
    s.reconcile(HOST, [userMsg('repeat me', old)]);
    expect(usePendingSendStore.getState().byHost[HOST]).toHaveLength(1);
  });

  it('leaves failed entries in place (they await user action)', () => {
    const s = usePendingSendStore.getState();
    const id = s.addPending(HOST, 'oops');
    s.setStatus(HOST, id, 'failed');
    s.reconcile(HOST, [userMsg('oops', new Date().toISOString())]);
    expect(usePendingSendStore.getState().byHost[HOST]).toHaveLength(1);
    expect(usePendingSendStore.getState().byHost[HOST][0].status).toBe('failed');
  });

  it('maps identical repeat sends one-to-one (two entries, two messages → both drop)', () => {
    const s = usePendingSendStore.getState();
    s.addPending(HOST, 'same');
    s.addPending(HOST, 'same');
    const now = Date.now();
    s.reconcile(HOST, [
      userMsg('same', new Date(now).toISOString()),
      userMsg('same', new Date(now + 10).toISOString()),
    ]);
    expect(usePendingSendStore.getState().byHost[HOST]).toHaveLength(0);
  });

  it('one message drops exactly one of two identical entries', () => {
    const s = usePendingSendStore.getState();
    s.addPending(HOST, 'same');
    s.addPending(HOST, 'same');
    s.reconcile(HOST, [userMsg('same', new Date().toISOString())]);
    expect(usePendingSendStore.getState().byHost[HOST]).toHaveLength(1);
  });
});

describe('pendingSendStore — reopen', () => {
  it('requestReopen removes the entry and stages a nonce-bumped draft request', () => {
    const s = usePendingSendStore.getState();
    const id = s.addPending(HOST, 'bring me back', 'queued');
    s.requestReopen(HOST, id);
    const state = usePendingSendStore.getState();
    expect(state.byHost[HOST]).toHaveLength(0);
    expect(state.draftRequest[HOST]).toMatchObject({ text: 'bring me back' });
    const firstNonce = state.draftRequest[HOST]!.nonce;

    // A second reopen of a fresh identical entry bumps the nonce so the consumer
    // effect fires again.
    const id2 = usePendingSendStore.getState().addPending(HOST, 'bring me back', 'failed');
    usePendingSendStore.getState().requestReopen(HOST, id2);
    expect(usePendingSendStore.getState().draftRequest[HOST]!.nonce).toBe(firstNonce + 1);
  });

  it('clearDraftRequest clears the staged request', () => {
    const s = usePendingSendStore.getState();
    const id = s.addPending(HOST, 'x', 'failed');
    s.requestReopen(HOST, id);
    usePendingSendStore.getState().clearDraftRequest(HOST);
    expect(usePendingSendStore.getState().draftRequest[HOST]).toBeUndefined();
  });

  it('resetHost wipes entries and draft request for a host', () => {
    const s = usePendingSendStore.getState();
    s.addPending(HOST, 'x');
    s.resetHost(HOST);
    expect(usePendingSendStore.getState().byHost[HOST]).toEqual([]);
    expect(usePendingSendStore.getState().draftRequest[HOST]).toBeUndefined();
  });
});
