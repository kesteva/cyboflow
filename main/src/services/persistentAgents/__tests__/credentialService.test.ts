import { describe, it, expect, afterEach } from 'vitest';
import { SecretsUnavailableError } from '../../secrets/safeStorageSecret';
import { credentialFingerprint } from '../credentialService';
import { ConnectorError } from '../connectorErrors';
import { CredentialUndecryptableError, InvalidAgentInputError } from '../errors';
import { createFakeConnector, emptyBatch, makeHarness, type FakeConnector, type Harness } from './fakeConnector';

const SECRET = 'sk-ant-TEST-SECRET-123456';
let h: Harness;
afterEach(() => { h?.raw.close(); });

async function connectNative(fake: FakeConnector, secret = SECRET): Promise<{ agentId: string; connectionId: string; credentialId: string }> {
  const r = await h.connections.connect({
    agent: { displayName: 'Cma', vendor: 'anthropic-cma' },
    connection: { kind: 'native', connectorId: fake.registration.definition.id, credential: { mode: 'new', label: 'Work key', secret }, remote: {} },
  });
  const credentialId = String((h.raw.prepare('SELECT credential_id AS c FROM persistent_agent_connections WHERE id = ?').get(r.connectionId) as { c: string }).c);
  return { ...r, credentialId };
}

/** Serializes spy calls including Error messages and causes (JSON.stringify alone renders an Error as {}). */
const dump = (calls: unknown): string =>
  JSON.stringify(calls, (_k, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message, cause: v.cause } : v));

const connState = (id: string): string =>
  (h.raw.prepare('SELECT state FROM persistent_agent_connections WHERE id = ?').get(id) as { state: string }).state;
const credState = (id: string): string =>
  (h.raw.prepare('SELECT state FROM vendor_credentials WHERE id = ?').get(id) as { state: string }).state;

/** One pull of a connection through the real store, like the pump does. */
async function pullOnce(fake: FakeConnector, connectionId: string): Promise<void> {
  const handle = h.buildHandle(connectionId);
  if (!handle) throw new Error('no handle');
  const batch = await fake.connector.pull(handle, handle.inboundCursor, { signal: new AbortController().signal });
  await h.store.applyInboundBatch(connectionId, batch, { expectedRelayEpoch: handle.relayEpoch });
}

describe('CredentialService', () => {
  it('add encrypts and never returns or logs the secret', async () => {
    h = makeHarness();
    const view = await h.credentials.add({ vendor: 'anthropic', label: ' Work key ', secret: SECRET });
    expect(view.label).toBe('Work key');
    expect(view.fingerprint).toBe(credentialFingerprint(SECRET));
    expect(view.fingerprint.startsWith('…3456 · ')).toBe(true);
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(JSON.stringify(h.credentials.list())).not.toContain(SECRET);
    expect(JSON.stringify(h.logger.calls)).not.toContain(SECRET);
    expect(dump(h.capture.mock.calls)).not.toContain(SECRET);
    const stored = h.raw.prepare('SELECT secret_ciphertext AS c FROM vendor_credentials').get() as { c: Buffer };
    expect(stored.c.toString('utf8')).toBe(`enc:${SECRET}`);
    expect(await h.credentials.secret(view.id)).toBe(SECRET);
  });

  it('SecretsUnavailableError when encryption unavailable stores nothing', async () => {
    h = makeHarness({ encrypt: () => { throw new SecretsUnavailableError(); } });
    await expect(h.credentials.add({ vendor: 'anthropic', label: 'k', secret: SECRET })).rejects.toBeInstanceOf(SecretsUnavailableError);
    expect((h.raw.prepare('SELECT COUNT(*) AS n FROM vendor_credentials').get() as { n: number }).n).toBe(0);
  });

  it('validation rejects a bad label or secret', async () => {
    h = makeHarness();
    await expect(h.credentials.add({ vendor: 'anthropic', label: '', secret: SECRET })).rejects.toBeInstanceOf(InvalidAgentInputError);
    await expect(h.credentials.add({ vendor: 'anthropic', label: 'k', secret: 'short' })).rejects.toMatchObject({ field: 'secret' });
  });

  it('rotate keeps connection, cursor and thread', async () => {
    const fake = createFakeConnector({ kind: 'native' });
    h = makeHarness({ connectors: [fake] });
    const { agentId, connectionId, credentialId } = await connectNative(fake);
    fake.script.pushPull(emptyBatch({ messages: [{ remoteEventId: 'e1', author: 'agent', kind: 'text', body: 'hi', links: [], remoteCreatedAt: null }], nextCursor: 'c-7' }));
    await pullOnce(fake, connectionId);
    await h.credentials.rotate({ id: credentialId, secret: 'sk-ant-NEW-KEY-654321' });
    const row = h.raw.prepare('SELECT id, inbound_cursor, is_current FROM persistent_agent_connections WHERE agent_id = ?').all(agentId);
    expect(row).toEqual([{ id: connectionId, inbound_cursor: 'c-7', is_current: 1 }]);
    expect(h.store.getThreadPage(agentId, null, 10).rows).toHaveLength(1);
    expect(await h.credentials.secret(credentialId)).toBe('sk-ant-NEW-KEY-654321');
  });

  it('the cached client is rebuilt after rotate', async () => {
    const fake = createFakeConnector({ kind: 'native' });
    h = makeHarness({ connectors: [fake] });
    const { connectionId, credentialId } = await connectNative(fake);
    await pullOnce(fake, connectionId);
    await h.credentials.rotate({ id: credentialId, secret: 'sk-ant-NEW-KEY-654321' });
    await pullOnce(fake, connectionId);
    const versions = fake.calls.filter((c) => c.method === 'pull').map((c) => c.handle?.credential?.version);
    expect(versions).toEqual([1, 2]);
  });

  it('auth_failed connections return to ok after one successful call', async () => {
    const fake = createFakeConnector({ kind: 'native' });
    h = makeHarness({ connectors: [fake] });
    const { connectionId, credentialId } = await connectNative(fake);
    await h.connections.onAuthFailure(connectionId, new ConnectorError('auth', 'API key rejected', { httpStatus: 401 }));
    expect(connState(connectionId)).toBe('auth_failed');
    expect(credState(credentialId)).toBe('auth_failed');
    const reopenedKicks: string[] = [];
    h.pump.kick = (id: string) => { reopenedKicks.push(id); };
    await h.credentials.rotate({ id: credentialId, secret: 'sk-ant-NEW-KEY-654321' });
    expect(reopenedKicks).toEqual([connectionId]);
    await pullOnce(fake, connectionId);
    expect(connState(connectionId)).toBe('pending');
    expect(credState(credentialId)).toBe('ok');
  });

  it('forget is refused while referenced', async () => {
    const fake = createFakeConnector({ kind: 'native' });
    h = makeHarness({ connectors: [fake] });
    const { agentId, connectionId, credentialId } = await connectNative(fake);
    expect(await h.credentials.forget(credentialId, false)).toEqual({
      forgotten: false, referencedBy: [{ agentId, displayName: 'Cma', connectionId }],
    });
    expect(h.credentials.list()).toHaveLength(1);
    expect(h.credentials.list()[0].referencedBy).toEqual([{ agentId, displayName: 'Cma', connectionId }]);
  });

  it('an undecryptable row recovers by rotate', async () => {
    let broken = true;
    const fake = createFakeConnector({ kind: 'native' });
    h = makeHarness({
      connectors: [fake],
      decrypt: (c) => {
        if (broken) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
        return c.toString('utf8').replace(/^enc:/, '');
      },
    });
    const { connectionId, credentialId } = await connectNative(fake);
    h.raw.prepare(`UPDATE persistent_agent_connections SET state = 'verified', verified_at = ? WHERE id = ?`).run(h.clock.now().toISOString(), connectionId);
    await expect(h.credentials.secret(credentialId)).rejects.toBeInstanceOf(CredentialUndecryptableError);
    expect(credState(credentialId)).toBe('undecryptable');
    expect(connState(connectionId)).toBe('auth_failed');
    const lastError = (h.raw.prepare('SELECT last_error AS e FROM persistent_agent_connections WHERE id = ?').get(connectionId) as { e: string }).e;
    expect(lastError).toBe('Stored key cannot be decrypted on this computer');
    broken = false;
    await h.credentials.rotate({ id: credentialId, secret: 'sk-ant-NEW-KEY-654321' });
    expect(credState(credentialId)).toBe('ok');
    await pullOnce(fake, connectionId);
    expect(connState(connectionId)).toBe('verified');
    expect(await h.credentials.secret(credentialId)).toBe('sk-ant-NEW-KEY-654321');
    for (const s of [SECRET, 'sk-ant-NEW-KEY-654321']) {
      expect(dump(h.logger.calls)).not.toContain(s);
      expect(dump(h.capture.mock.calls)).not.toContain(s);
    }
  });

  it('SecretsUnavailableError on decrypt is rethrown without marking the row', async () => {
    h = makeHarness({ decrypt: () => { throw new SecretsUnavailableError(); } });
    const v = await h.credentials.add({ vendor: 'anthropic', label: 'k', secret: SECRET });
    await expect(h.credentials.secret(v.id)).rejects.toBeInstanceOf(SecretsUnavailableError);
    expect(credState(v.id)).toBe('ok');
  });
});
