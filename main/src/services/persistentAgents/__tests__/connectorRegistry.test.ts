import { describe, it, expect, vi } from 'vitest';
import { ConnectorRegistry, validateConnectorDefinition } from '../connectorRegistry';
import type { ConnectorDeps } from '../connectorContract';
import type { ConnectorDefinition } from '../../../../../shared/types/persistentAgents';
import { BRIDGE_FIXTURE_DEFINITION, CMA_DEFINITION } from '../../../../../shared/types/__tests__/persistentAgentsFixtures';
import { createFakeConnector, makeLogger } from './fakeConnector';

const deps = (): ConnectorDeps => ({
  fetch: globalThis.fetch, now: () => new Date(), log: makeLogger(), secret: async () => 'secret',
});

describe('ConnectorRegistry', () => {
  it('duplicate registration throws unless override', () => {
    const r = new ConnectorRegistry();
    const a = createFakeConnector();
    r.register(a.registration);
    expect(() => r.register(a.registration)).toThrow(/already registered/);
    const b = createFakeConnector();
    r.configure(deps());
    r.get('bridge');
    r.register(b.registration, { override: true });
    expect(a.disposed).toBe(1);
    expect(r.get('bridge')).toBe(b.connector);
  });

  it('factory is called once with the configured deps', () => {
    const r = new ConnectorRegistry();
    const d = deps();
    const fake = createFakeConnector();
    const factory = vi.fn(() => fake.connector);
    r.register({ definition: fake.registration.definition, factory });
    r.configure(d);
    expect(r.get('bridge')).toBe(fake.connector);
    expect(r.get('bridge')).toBe(fake.connector);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(d);
  });

  it('get before configure throws; unregistered → undefined', () => {
    const r = new ConnectorRegistry();
    r.register(createFakeConnector().registration);
    expect(() => r.get('bridge')).toThrow(/configure/);
    expect(r.get('nope')).toBeUndefined();
  });

  it('list keeps registration order; unregister and disposeAll dispose instances', () => {
    const r = new ConnectorRegistry();
    r.configure(deps());
    const br = createFakeConnector();
    const na = createFakeConnector({ kind: 'native' });
    r.register(br.registration);
    r.register(na.registration);
    expect(r.list().map((d) => d.id)).toEqual(['bridge', 'claude-managed-agents']);
    r.get('bridge');
    r.get('claude-managed-agents');
    expect(r.unregister('bridge')).toBe(true);
    expect(br.disposed).toBe(1);
    expect(r.unregister('bridge')).toBe(false);
    r.disposeAll();
    expect(na.disposed).toBe(1);
  });

  it('two registries never share connectors', () => {
    const a = new ConnectorRegistry();
    const b = new ConnectorRegistry();
    a.register(createFakeConnector().registration);
    expect(b.getDefinition('bridge')).toBeUndefined();
  });

  describe('validateConnectorDefinition', () => {
    const cases: Array<[string, Partial<ConnectorDefinition>]> = [
      ['empty id', { id: '' }],
      ['bad id', { id: 'Bad_Id' }],
      ['bad kind', { kind: 'cloud' as ConnectorDefinition['kind'] }],
      ['zero version', { version: 0 }],
      ['fractional version', { version: 1.5 }],
      ['no vendors', { vendors: [] }],
      ['unknown vendor', { vendors: ['acme' as ConnectorDefinition['vendors'][number]] }],
      ['message limit too big', { limits: { maxMessageBytes: 70_000, maxLinks: 20 } }],
      ['message limit < 1', { limits: { maxMessageBytes: 0, maxLinks: 20 } }],
      ['too many links', { limits: { maxMessageBytes: 1000, maxLinks: 21 } }],
      ['bad verb', { capabilities: { ...BRIDGE_FIXTURE_DEFINITION.capabilities, control: ['explode' as never] } }],
      ['bridge with credential', { credentialVendor: 'anthropic' }],
    ];
    for (const [name, patch] of cases) {
      it(`rejects ${name}`, () => {
        expect(() => validateConnectorDefinition({ ...BRIDGE_FIXTURE_DEFINITION, ...patch })).toThrow(/Invalid connector definition/);
      });
    }
    it('rejects a native connector without a credential vendor', () => {
      expect(() => validateConnectorDefinition({ ...CMA_DEFINITION, credentialVendor: null })).toThrow(/needs a vendor credential/);
    });
    it('accepts the fixtures', () => {
      expect(() => validateConnectorDefinition(BRIDGE_FIXTURE_DEFINITION)).not.toThrow();
      expect(() => validateConnectorDefinition(CMA_DEFINITION)).not.toThrow();
    });
  });
});
