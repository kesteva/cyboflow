/**
 * cyboflow.persistentAgents router: the "off" answers for an unset facade, zod input rejection, the
 * by-NAME error conversion into result unions (mutations) and TRPCErrors (queries), and the two
 * subscriptions. The facade is a fake; this file never touches services/*.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { toPersistentAgentsFailure } from '../persistentAgents';
import {
  _resetPersistentAgentsFacadeForTesting,
  emitPersistentAgentsChanged,
  emitPersistentAgentThreadEvent,
  persistentAgentEvents,
  persistentAgentThreadChannel,
  PERSISTENT_AGENTS_CHANNEL,
  setPersistentAgentsFacade,
  type DisconnectOutcome,
  type ForgetCredentialOutcome,
  type PersistentAgentsFacade,
} from '../../../persistentAgentsBridge';
import {
  DISABLED_PERSISTENT_AGENTS_STATUS,
  PERSISTENT_AGENT_MAX_MESSAGE_BYTES,
  type ActivityView,
  type AgentView,
  type ConnectorAvailability,
  type ConnectorView,
  type ConnectResultData,
  type CredentialView,
  type PairingPayload,
  type PersistentAgentsChangedEvent,
  type PersistentAgentsStatus,
  type PersistentAgentThreadEvent,
  type ThreadPage,
  type UsageView,
  type VerifyView,
} from '../../../../../../shared/types/persistentAgents';

// The router module is imported once (statically); each case swaps the facade instead of
// re-importing, so the cold appRouter import cost is paid once.
const COLD_ROUTER_IMPORT_TIMEOUT_MS = 30_000;

function unexpected(): never {
  throw new Error('unexpected facade call');
}

class FakeFacade implements PersistentAgentsFacade {
  status(): PersistentAgentsStatus { return unexpected(); }
  listConnectors(): ConnectorView[] { return unexpected(); }
  listAgents(_input: { includeArchived: boolean }): AgentView[] { return unexpected(); }
  getThread(_input: { agentId: string; before?: string; limit: number }): ThreadPage { return unexpected(); }
  async send(_input: { agentId: string; text: string; links?: string[] }): Promise<{ messageId: string }> { return unexpected(); }
  async connect(): Promise<ConnectResultData> { return unexpected(); }
  async verify(_input: { connectionId: string }): Promise<VerifyView> { return unexpected(); }
  async switchConnection(): Promise<ConnectResultData> { return unexpected(); }
  async cancelSwitch(_input: { agentId: string }): Promise<void> { return unexpected(); }
  async disconnect(_input: { agentId: string }): Promise<DisconnectOutcome> { return unexpected(); }
  async archiveAgent(_input: { agentId: string }): Promise<void> { return unexpected(); }
  async control(): Promise<void> { return unexpected(); }
  async markRead(_input: { agentId: string; upTo?: string }): Promise<{ unread: number }> { return unexpected(); }
  listCredentials(): CredentialView[] { return unexpected(); }
  async addCredential(): Promise<CredentialView> { return unexpected(); }
  async rotateCredential(): Promise<CredentialView> { return unexpected(); }
  async forgetCredential(_input: { id: string; detach: boolean }): Promise<ForgetCredentialOutcome> { return unexpected(); }
  getActivity(): ActivityView[] { return unexpected(); }
  getUsage(): UsageView { return unexpected(); }
  async repairPairing(_input: { connectionId: string }): Promise<PairingPayload> { return unexpected(); }
  getPairing(_input: { connectionId: string }): PairingPayload | null { return unexpected(); }
}

function caller(signal?: AbortSignal) {
  return appRouter.createCaller(createContext(), signal ? { signal } : undefined).cyboflow.persistentAgents;
}

/** An Error with the given name and extra structural fields, as the service would throw it. */
function named(name: string, message: string, fields: Record<string, unknown> = {}): Error {
  const err = new Error(message);
  err.name = name;
  Object.assign(err, fields);
  return err;
}

async function codeOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (err) {
    return (err as TRPCError).code;
  }
  throw new Error('expected the call to reject');
}

const PAIRING: PairingPayload = {
  kind: 'bridge',
  connectionId: 'c1',
  transport: 'relay-mcp',
  mcpUrl: 'https://cloud-staging.cyboflow.com/bridge/mcp/x',
  httpBase: 'https://cloud-staging.cyboflow.com/bridge/http/x',
  pairingCode: 'AMBER-RIVER-4821',
  pairingExpiresAt: '2026-10-07T12:09:55.000Z',
  oneTimeToken: null,
  instructionBrief: null,
};

const BRIDGE_CONNECT = {
  agent: { displayName: 'Dots', vendor: 'openai-dots' as const },
  connection: { kind: 'bridge' as const, connectorId: 'bridge' as const, transport: 'relay-mcp' as const },
};

beforeEach(() => {
  _resetPersistentAgentsFacadeForTesting();
});

afterEach(() => {
  _resetPersistentAgentsFacadeForTesting();
  persistentAgentEvents.removeAllListeners();
});

// ---------------------------------------------------------------------------

describe('unset facade', () => {
  it('queries answer "off"', async () => {
    const pa = caller();
    expect(await pa.status()).toEqual(DISABLED_PERSISTENT_AGENTS_STATUS);
    expect(await pa.listAgents()).toEqual([]);
    expect(await pa.listConnectors()).toEqual([]);
    expect(await pa.listCredentials()).toEqual([]);
    expect(await pa.getPairing({ connectionId: 'c1' })).toBeNull();
  }, COLD_ROUTER_IMPORT_TIMEOUT_MS);

  it('every mutation returns feature_disabled', async () => {
    const pa = caller();
    const results = await Promise.all([
      pa.send({ agentId: 'a1', text: 'hi' }),
      pa.connect(BRIDGE_CONNECT),
      pa.verify({ connectionId: 'c1' }),
      pa.switchConnection({ agentId: 'a1', connection: BRIDGE_CONNECT.connection }),
      pa.cancelSwitch({ agentId: 'a1' }),
      pa.disconnect({ agentId: 'a1' }),
      pa.archiveAgent({ agentId: 'a1' }),
      pa.control({ agentId: 'a1', verb: 'interrupt' }),
      pa.addCredential({ vendor: 'anthropic', label: 'Key', secret: 'sk-ant-12345678' }),
      pa.rotateCredential({ id: 'k1', secret: 'sk-ant-12345678' }),
      pa.forgetCredential({ id: 'k1' }),
      pa.repairPairing({ connectionId: 'c1' }),
    ]);
    for (const r of results) {
      expect(r).toMatchObject({ ok: false, error: 'feature_disabled' });
    }
  });

  it('markRead and the facade-backed queries throw PRECONDITION_FAILED', async () => {
    const pa = caller();
    expect(await codeOf(pa.markRead({ agentId: 'a1' }))).toBe('PRECONDITION_FAILED');
    expect(await codeOf(pa.getThread({ agentId: 'a1' }))).toBe('PRECONDITION_FAILED');
    expect(await codeOf(pa.getUsage({ agentId: 'a1' }))).toBe('PRECONDITION_FAILED');
  });
});

// ---------------------------------------------------------------------------

describe('zod input rejection', () => {
  beforeEach(() => setPersistentAgentsFacade(new FakeFacade()));

  it('rejects malformed inputs with BAD_REQUEST', async () => {
    const pa = caller();
    const link = 'https://example.com/x';
    const cases: Array<Promise<unknown>> = [
      pa.send({ agentId: 'a1', text: 'x'.repeat(PERSISTENT_AGENT_MAX_MESSAGE_BYTES + 1) }),
      pa.send({ agentId: 'a1', text: 'hi', links: Array.from({ length: 21 }, () => link) }),
      pa.send({ agentId: 'a1', text: 'hi', links: ['javascript:alert(1)'] }),
      pa.connect({ ...BRIDGE_CONNECT, agent: { ...BRIDGE_CONNECT.agent, handle: 'Bad_Handle' } }),
      pa.connect({ ...BRIDGE_CONNECT, agent: { ...BRIDGE_CONNECT.agent, displayName: 'x'.repeat(81) } }),
      pa.connect({ ...BRIDGE_CONNECT, agent: { ...BRIDGE_CONNECT.agent, displayName: 'two\nlines' } }),
      pa.control({ agentId: 'a1', verb: 'restart' as never }),
      pa.connect({ ...BRIDGE_CONNECT, connection: { ...BRIDGE_CONNECT.connection, transport: 'poll' as never } }),
      pa.verify({ connectionId: 'c1', extra: true } as never),
      pa.connect({ ...BRIDGE_CONNECT, agent: { ...BRIDGE_CONNECT.agent, extra: 1 } as never }),
    ];
    for (const call of cases) {
      expect(await codeOf(call)).toBe('BAD_REQUEST');
    }
  });
});

// ---------------------------------------------------------------------------

describe('toPersistentAgentsFailure (one case per mapping row)', () => {
  const availability = (state: ConnectorAvailability['state'], retryAt: string | null = null): ConnectorAvailability =>
    ({ state, message: `msg:${state}`, retryAt });

  const rows: Array<[string, Error, Record<string, unknown>]> = [
    ['not initialized', named('PersistentAgentsNotInitializedError', 'x'),
      { error: 'feature_disabled', message: 'Agents & Environments is turned off.' }],
    ['disabled', named('PersistentAgentsDisabledError', 'x'),
      { error: 'feature_disabled', message: 'Agents & Environments is turned off.' }],
    ['agent not found', named('AgentNotFoundError', 'Agent a1 not found'), { error: 'not_found', message: 'Agent a1 not found' }],
    ['connection not found', named('ConnectionNotFoundError', 'c'), { error: 'not_found', message: 'c' }],
    ['credential not found', named('CredentialNotFoundError', 'k'), { error: 'not_found', message: 'k' }],
    ['connector not registered', named('ConnectorNotRegisteredError', 'x'),
      { error: 'connector_unavailable', message: "This connector isn't available in this build." }],
    ['control not supported', named('ControlNotSupportedError', 'no stop'), { error: 'control_not_supported', message: 'no stop' }],
    ['not sendable: archived', named('AgentNotSendableError', 'archived', { reason: 'archived' }), { error: 'agent_archived' }],
    ['not sendable: no connection', named('AgentNotSendableError', 'none', { reason: 'no_connection' }), { error: 'no_connection' }],
    ['not sendable: revoked', named('AgentNotSendableError', 'revoked', { reason: 'revoked' }), { error: 'connection_revoked' }],
    ['swap in progress', named('SwapInProgressError', 's'), { error: 'swap_in_progress', message: 's' }],
    ['no swap in progress', named('NoSwapInProgressError', 'n'), { error: 'no_swap_in_progress', message: 'n' }],
    ['invalid input: too large', named('InvalidAgentInputError', 'big', { reason: 'too_large', field: 'text' }),
      { error: 'too_large', message: 'big', field: 'text' }],
    ['invalid input: invalid', named('InvalidAgentInputError', 'bad', { reason: 'invalid', field: 'handle' }),
      { error: 'invalid_input', message: 'bad', field: 'handle' }],
    ['handle taken', named('HandleTakenError', 'x'),
      { error: 'handle_taken', message: 'Another agent already uses this handle.', field: 'handle' }],
    ['pairing not supported', named('PairingNotSupportedError', 'p'), { error: 'pairing_not_supported', message: 'p' }],
    ['secrets unavailable', named('SecretsUnavailableError', 'x'),
      { error: 'secrets_unavailable', message: "This computer's keychain isn't available; nothing was saved." }],
    ['credential undecryptable', named('CredentialUndecryptableError', 'x'),
      { error: 'credential_undecryptable', message: "The stored key can't be read on this computer. Re-enter it." }],
  ];

  for (const [name, err, expected] of rows) {
    it(name, () => {
      expect(toPersistentAgentsFailure(err)).toMatchObject({ ok: false, ...expected });
    });
  }

  it('ConnectorUnavailableError maps every availability state and carries message + retryAt', () => {
    const table: Array<[ConnectorAvailability['state'], string]> = [
      ['signed_out', 'not_signed_in'], ['locked', 'cloud_locked'], ['device_revoked', 'device_revoked'],
      ['needs_update', 'upgrade_required'], ['not_entitled', 'not_entitled'], ['other_account', 'other_account'],
      ['disabled', 'connector_disabled'], ['unavailable', 'service_unavailable'],
    ];
    for (const [state, code] of table) {
      const retryAt = state === 'unavailable' ? '2026-10-07T12:05:00.000Z' : null;
      const err = named('ConnectorUnavailableError', 'fallback', { availability: availability(state, retryAt) });
      expect(toPersistentAgentsFailure(err)).toEqual({ ok: false, error: code, message: `msg:${state}`, retryAt });
    }
    const noMessage = named('ConnectorUnavailableError', 'fallback text', {
      availability: { state: 'locked', message: null, retryAt: null },
    });
    expect(toPersistentAgentsFailure(noMessage)?.message).toBe('fallback text');
  });

  it('ConnectorError maps every kind', () => {
    const table: Array<[string, string | null, string]> = [
      ['auth', null, 'auth_rejected'],
      ['device_auth', null, 'device_revoked'],
      ['paused', 'signed_out', 'not_signed_in'],
      ['paused', 'locked', 'cloud_locked'],
      ['paused', 'needs_sign_in', 'device_revoked'],
      ['paused', 'needs_update', 'upgrade_required'],
      ['paused', 'not_entitled', 'not_entitled'],
      ['paused', 'other_account', 'other_account'],
      ['paused', 'disabled', 'connector_disabled'],
      ['paused', 'something_else', 'connector_unavailable'],
      ['not_entitled', null, 'not_entitled'],
      ['upgrade_required', null, 'upgrade_required'],
      ['rate_limited', null, 'rate_limited'],
      ['retryable', null, 'service_unavailable'],
      ['not_found', null, 'connection_gone'],
      ['revoked', null, 'connection_gone'],
      ['invalid', null, 'invalid_input'],
      ['invalid', 'message_too_large', 'too_large'],
      ['conflict', 'connection_limit', 'connection_limit'],
      ['conflict', 'other', 'conflict'],
      ['permanent', null, 'unknown'],
    ];
    for (const [kind, code, expected] of table) {
      const err = named('ConnectorError', `relay request failed (${kind})`, { kind, code, retryAfterMs: null });
      expect(toPersistentAgentsFailure(err)).toEqual({
        ok: false, error: expected, message: `relay request failed (${kind})`, retryAt: null,
      });
    }
  });

  it('ConnectorError retryAfterMs becomes an ISO retryAt', () => {
    const before = Date.now();
    const failure = toPersistentAgentsFailure(named('ConnectorError', 'slow down', { kind: 'rate_limited', retryAfterMs: 60_000 }));
    expect(failure?.error).toBe('rate_limited');
    const retryAt = Date.parse(failure?.retryAt ?? '');
    expect(retryAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(retryAt).toBeLessThan(before + 70_000);
  });

  it('returns null for an unknown kind or an unknown error', () => {
    expect(toPersistentAgentsFailure(named('ConnectorError', 'x', { kind: 'weird' }))).toBeNull();
    expect(toPersistentAgentsFailure(new Error('boom'))).toBeNull();
    expect(toPersistentAgentsFailure('boom')).toBeNull();
    expect(toPersistentAgentsFailure(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('mutations through the router', () => {
  it('a known service error becomes the exact failure', async () => {
    const facade = new FakeFacade();
    facade.send = async () => { throw named('AgentNotSendableError', 'This agent is archived.', { reason: 'archived' }); };
    setPersistentAgentsFacade(facade);
    expect(await caller().send({ agentId: 'a1', text: 'hi' })).toEqual({
      ok: false, error: 'agent_archived', message: 'This agent is archived.',
    });
  });

  it('an unknown thrown error surfaces as INTERNAL_SERVER_ERROR', async () => {
    const facade = new FakeFacade();
    facade.send = async () => { throw new Error('kaboom'); };
    setPersistentAgentsFacade(facade);
    expect(await codeOf(caller().send({ agentId: 'a1', text: 'hi' }))).toBe('INTERNAL_SERVER_ERROR');
  });

  it('success spreads the facade result under ok:true', async () => {
    const facade = new FakeFacade();
    const seen: unknown[] = [];
    facade.send = async (input) => { seen.push(input); return { messageId: 'm1' }; };
    facade.connect = async () => ({ agentId: 'a1', connectionId: 'c1', pairing: PAIRING });
    facade.repairPairing = async () => PAIRING;
    facade.disconnect = async () => ({ connectionId: 'c1', remoteRevoke: 'pending', offerForgetCredentialId: null });
    setPersistentAgentsFacade(facade);
    const pa = caller();
    expect(await pa.send({ agentId: 'a1', text: 'hi', links: ['https://example.com'] }))
      .toEqual({ ok: true, messageId: 'm1' });
    expect(seen).toEqual([{ agentId: 'a1', text: 'hi', links: ['https://example.com'] }]);
    expect(await pa.connect(BRIDGE_CONNECT)).toEqual({ ok: true, agentId: 'a1', connectionId: 'c1', pairing: PAIRING });
    expect(await pa.repairPairing({ connectionId: 'c1' })).toEqual({ ok: true, pairing: PAIRING });
    expect(await pa.disconnect({ agentId: 'a1' }))
      .toEqual({ ok: true, connectionId: 'c1', remoteRevoke: 'pending', offerForgetCredentialId: null });
  });

  it('void facade methods return {ok:true}', async () => {
    const facade = new FakeFacade();
    facade.cancelSwitch = async () => undefined;
    facade.archiveAgent = async () => undefined;
    facade.control = async () => undefined;
    setPersistentAgentsFacade(facade);
    const pa = caller();
    expect(await pa.cancelSwitch({ agentId: 'a1' })).toEqual({ ok: true });
    expect(await pa.archiveAgent({ agentId: 'a1' })).toEqual({ ok: true });
    expect(await pa.control({ agentId: 'a1', verb: 'end' })).toEqual({ ok: true });
  });

  it('forgetCredential converts the outcome and defaults detach to false', async () => {
    const facade = new FakeFacade();
    const seen: Array<{ id: string; detach: boolean }> = [];
    const referencedBy = [{ agentId: 'a1', displayName: 'Dots', connectionId: 'c1' }];
    facade.forgetCredential = async (input) => {
      seen.push(input);
      return input.detach ? { forgotten: true } : { forgotten: false, referencedBy };
    };
    setPersistentAgentsFacade(facade);
    const pa = caller();
    expect(await pa.forgetCredential({ id: 'k1' }))
      .toEqual({ ok: false, error: 'in_use', message: 'This key is in use.', referencedBy });
    expect(await pa.forgetCredential({ id: 'k1', detach: true })).toEqual({ ok: true });
    expect(seen).toEqual([{ id: 'k1', detach: false }, { id: 'k1', detach: true }]);
  });

  it('forgetCredential converts a thrown service error', async () => {
    const facade = new FakeFacade();
    facade.forgetCredential = async () => { throw named('CredentialNotFoundError', 'Credential k1 not found'); };
    setPersistentAgentsFacade(facade);
    expect(await caller().forgetCredential({ id: 'k1' }))
      .toEqual({ ok: false, error: 'not_found', message: 'Credential k1 not found' });
  });
});

// ---------------------------------------------------------------------------

describe('queries through the router', () => {
  it('delegates with defaults applied', async () => {
    const facade = new FakeFacade();
    const seen: unknown[] = [];
    facade.status = () => ({ ...DISABLED_PERSISTENT_AGENTS_STATUS, devBuild: true });
    facade.listAgents = (input) => { seen.push(input); return []; };
    facade.getThread = (input) => { seen.push(input); return { agentId: input.agentId, messages: [], hasMore: false }; };
    setPersistentAgentsFacade(facade);
    const pa = caller();
    expect((await pa.status()).devBuild).toBe(true);
    await pa.listAgents();
    await pa.listAgents({ includeArchived: true });
    expect(await pa.getThread({ agentId: 'a1' })).toEqual({ agentId: 'a1', messages: [], hasMore: false });
    expect(seen).toEqual([{ includeArchived: false }, { includeArchived: true }, { agentId: 'a1', limit: 50 }]);
  });

  it('rethrowAsTRPCError: not-found → NOT_FOUND, disabled → PRECONDITION_FAILED, else rethrown', async () => {
    const facade = new FakeFacade();
    facade.getThread = () => { throw named('AgentNotFoundError', 'Agent a1 not found'); };
    facade.getUsage = () => { throw named('PersistentAgentsDisabledError', 'off'); };
    facade.markRead = async () => { throw named('AgentNotFoundError', 'Agent a1 not found'); };
    facade.getActivity = () => { throw new Error('boom'); };
    setPersistentAgentsFacade(facade);
    const pa = caller();
    expect(await codeOf(pa.getThread({ agentId: 'a1' }))).toBe('NOT_FOUND');
    expect(await codeOf(pa.getUsage({ agentId: 'a1' }))).toBe('PRECONDITION_FAILED');
    expect(await codeOf(pa.markRead({ agentId: 'a1' }))).toBe('NOT_FOUND');
    expect(await codeOf(pa.getActivity({ agentId: 'a1' }))).toBe('INTERNAL_SERVER_ERROR');
  });

  it('status never throws', async () => {
    const facade = new FakeFacade();
    facade.status = () => { throw new Error('boom'); };
    setPersistentAgentsFacade(facade);
    expect(await caller().status()).toEqual(DISABLED_PERSISTENT_AGENTS_STATUS);
  });
});

// ---------------------------------------------------------------------------

describe('subscriptions', () => {
  it('onAgentsChanged yields emitted events and detaches on abort', async () => {
    const ac = new AbortController();
    const sub = await caller(ac.signal).onAgentsChanged();
    const received: PersistentAgentsChangedEvent[] = [];
    const done = (async () => {
      for await (const ev of sub as AsyncIterable<PersistentAgentsChangedEvent>) {
        received.push(ev);
        if (received.length === 2) ac.abort();
      }
    })();
    setImmediate(() => {
      emitPersistentAgentsChanged({ kind: 'agents', agentId: null });
      emitPersistentAgentsChanged({ kind: 'unread', agentId: 'a1' });
    });
    await done;
    expect(received).toEqual([{ kind: 'agents', agentId: null }, { kind: 'unread', agentId: 'a1' }]);
    expect(persistentAgentEvents.listenerCount(PERSISTENT_AGENTS_CHANNEL)).toBe(0);
  });

  it('onThreadEvent yields only its agent and detaches on abort', async () => {
    const ac = new AbortController();
    const sub = await caller(ac.signal).onThreadEvent({ agentId: 'a1' });
    const received: PersistentAgentThreadEvent[] = [];
    const done = (async () => {
      for await (const ev of sub as AsyncIterable<PersistentAgentThreadEvent>) {
        received.push(ev);
        ac.abort();
      }
    })();
    setImmediate(() => {
      emitPersistentAgentThreadEvent({ agentId: 'a2', kind: 'messages', messageIds: ['x'] });
      emitPersistentAgentThreadEvent({ agentId: 'a1', kind: 'receipts', messageIds: ['m1'] });
    });
    await done;
    expect(received).toEqual([{ agentId: 'a1', kind: 'receipts', messageIds: ['m1'] }]);
    expect(persistentAgentEvents.listenerCount(persistentAgentThreadChannel('a1'))).toBe(0);
  });
});
