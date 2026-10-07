import { describe, it, expect, afterEach } from 'vitest';
import { PersistentAgentsService } from '../persistentAgentsService';
import { InvalidAgentInputError, PersistentAgentsDisabledError } from '../errors';
import type { PersistentAgentsFacade } from '../../../orchestrator/persistentAgentsBridge';
import { createFakeConnector, makeHarness, type Harness } from './fakeConnector';

let h: Harness;
afterEach(() => { h?.raw.close(); });

interface Flags { available: boolean; configEnabled: boolean; enabled: boolean; killed: boolean; bridgeKilled: boolean }

function makeService(flags: Flags): PersistentAgentsService {
  return new PersistentAgentsService({
    store: h.store, registry: h.registry, connections: h.connections, credentials: h.credentials,
    pump: h.pump, outbox: h.outbox, now: h.clock.now, logger: h.logger,
    isAvailable: () => flags.available,
    isConfigEnabled: () => flags.configEnabled,
    isEnabled: () => flags.enabled,
    isKilled: () => flags.killed,
    isBridgeKilled: () => flags.bridgeKilled,
  });
}
const ON: Flags = { available: true, configEnabled: true, enabled: true, killed: false, bridgeKilled: false };

describe('PersistentAgentsService', () => {
  it('status() derives every field from its own input', () => {
    h = makeHarness();
    expect(makeService(ON).status()).toEqual({
      devBuild: true, configEnabled: true, enabled: true, killed: false, running: true, bridgeDisabled: false,
    });
    expect(makeService({ ...ON, available: false }).status().devBuild).toBe(false);
    expect(makeService({ ...ON, configEnabled: false }).status().configEnabled).toBe(false);
    const disabled = makeService({ ...ON, enabled: false }).status();
    expect(disabled).toMatchObject({ enabled: false, running: false });
    const killed = makeService({ ...ON, killed: true }).status();
    expect(killed).toMatchObject({ enabled: true, killed: true, running: false });
    expect(makeService({ ...ON, bridgeKilled: true }).status()).toMatchObject({ bridgeDisabled: true, running: true });
  });

  it('every mutation refuses when not running; reads still answer', async () => {
    h = makeHarness({ connectors: [createFakeConnector()] });
    const live = makeService(ON);
    const { agentId, connectionId } = await live.connect({ agent: { displayName: 'Dot', vendor: 'openai-dots' }, connection: { kind: 'bridge', connectorId: 'bridge', transport: 'relay-mcp' } });
    const off = makeService({ ...ON, killed: true });
    const mutations: Array<[string, (f: PersistentAgentsFacade) => Promise<unknown>]> = [
      ['send', (f) => f.send({ agentId, text: 'x' })],
      ['connect', (f) => f.connect({ agent: { displayName: 'X', vendor: 'other' }, connection: { kind: 'bridge', connectorId: 'bridge', transport: 'relay-mcp' } })],
      ['verify', (f) => f.verify({ connectionId })],
      ['switchConnection', (f) => f.switchConnection({ agentId, connection: { kind: 'bridge', connectorId: 'bridge', transport: 'relay-mcp' } })],
      ['cancelSwitch', (f) => f.cancelSwitch({ agentId })],
      ['disconnect', (f) => f.disconnect({ agentId })],
      ['archiveAgent', (f) => f.archiveAgent({ agentId })],
      ['control', (f) => f.control({ agentId, verb: 'interrupt' })],
      ['markRead', (f) => f.markRead({ agentId })],
      ['addCredential', (f) => f.addCredential({ vendor: 'anthropic', label: 'k', secret: 'sk-ant-12345678' })],
      ['rotateCredential', (f) => f.rotateCredential({ id: 'x', secret: 'sk-ant-12345678' })],
      ['forgetCredential', (f) => f.forgetCredential({ id: 'x', detach: false })],
      ['repairPairing', (f) => f.repairPairing({ connectionId })],
    ];
    for (const [name, call] of mutations) {
      await expect(call(off), name).rejects.toBeInstanceOf(PersistentAgentsDisabledError);
    }
    expect(off.listAgents({ includeArchived: false })).toHaveLength(1);
    expect(off.getThread({ agentId, limit: 10 }).messages).toEqual([]);
    expect(off.listCredentials()).toEqual([]);
    expect(off.listConnectors().map((c) => c.definition.id)).toEqual(['bridge']);
  });

  it('send over the connector byte limit → too_large on text', async () => {
    const fake = createFakeConnector({ definition: { limits: { maxMessageBytes: 10, maxLinks: 2 } } });
    h = makeHarness({ connectors: [fake] });
    const svc = makeService(ON);
    const { agentId } = await svc.connect({ agent: { displayName: 'Dot', vendor: 'openai-dots' }, connection: { kind: 'bridge', connectorId: 'bridge', transport: 'relay-mcp' } });
    // 'é' is 2 UTF-8 bytes: 6 chars = 12 bytes > 10
    await expect(svc.send({ agentId, text: 'éééééé' })).rejects.toMatchObject({ name: 'InvalidAgentInputError', reason: 'too_large', field: 'text' });
    await expect(svc.send({ agentId, text: '' })).rejects.toBeInstanceOf(InvalidAgentInputError);
    await expect(svc.send({ agentId, text: 'ok', links: ['javascript:alert(1)'] })).rejects.toBeInstanceOf(InvalidAgentInputError);
    await expect(svc.send({ agentId, text: 'ok', links: ['https://a.test', 'https://b.test', 'https://c.test'] })).rejects.toBeInstanceOf(InvalidAgentInputError);
    const ok = await svc.send({ agentId, text: 'éééee' });
    expect(ok.messageId).toBeTruthy();
  });

  it('listAgents orders by most recent message, else creation', async () => {
    h = makeHarness({ connectors: [createFakeConnector()] });
    const svc = makeService(ON);
    const mk = (name: string) => svc.connect({ agent: { displayName: name, vendor: 'openai-dots' }, connection: { kind: 'bridge', connectorId: 'bridge', transport: 'relay-mcp' } });
    const a = await mk('First');
    h.clock.advance(1_000);
    const b = await mk('Second');
    h.clock.advance(1_000);
    const c = await mk('Third');
    h.clock.advance(1_000);
    await h.store.enqueueOutbound(a.agentId, { kind: 'text', body: 'bump', links: [] });
    expect(svc.listAgents({ includeArchived: false }).map((v) => v.id)).toEqual([a.agentId, c.agentId, b.agentId]);
  });
});
