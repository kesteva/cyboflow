/**
 * Secrets never cross IPC: the REAL persistent-agents service (composed over an in-memory database with
 * scripted fake connectors) behind the real `cyboflow.persistentAgents` router, called through
 * appRouter.createCaller.
 *
 * A vendor key added through addCredential never appears in ANY response or change event. A Bridge
 * one-time token and its instruction brief appear ONLY in the responses of connect / switchConnection /
 * repairPairing — never in getPairing, listAgents, getThread, listCredentials or any other procedure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import {
  _resetPersistentAgentsFacadeForTesting,
  persistentAgentEvents,
} from '../../../persistentAgentsBridge';
import type { ConfigManager } from '../../../../services/configManager';
import {
  composePersistentAgents,
  type PersistentAgentsComposition,
  type PersistentAgentsCompositionDeps,
} from '../../../../persistentAgentsComposition';
import type { ConnectOutcome, ConnectRequest, RepairOutcome } from '../../../../services/persistentAgents/connectorContract';
import {
  createFakeConnector,
  makeLogger,
  makeTestDb,
  type FakeConnector,
} from '../../../../services/persistentAgents/__tests__/fakeConnector';

const SECRET = 'sk-ant-TEST-SECRET-123456';
const ROTATED_SECRET = 'sk-ant-TEST-ROTATED-654321';
const CONNECT_TOKEN = 'cbh_TESTTOKEN';
const SWITCH_TOKEN = 'cbh_TESTTOKEN_SWITCH';
const REPAIR_TOKEN = 'cbh_TESTTOKEN_REPAIR';
const ALL_TOKENS = [CONNECT_TOKEN, SWITCH_TOKEN, REPAIR_TOKEN];
const COLD_ROUTER_IMPORT_TIMEOUT_MS = 30_000;

class FakeConfig extends EventEmitter {
  isAgentsAvailable(): boolean { return true; }
  isAgentsEnabled(): boolean { return true; }
  getConfig(): ReturnType<ConfigManager['getConfig']> {
    return { agents: { enabled: true } } as ReturnType<ConfigManager['getConfig']>;
  }
}

function brief(token: string, httpBase: string): string {
  return `POST your replies to ${httpBase} with the header Authorization: Bearer ${token}`;
}

/** A relay-http connect outcome carrying a one-time token + a brief that contains it. */
function httpOutcome(fake: FakeConnector, token: string, n: number): ConnectOutcome {
  const req = fake.calls.at(-1)?.args[0] as ConnectRequest;
  const httpBase = `https://relay.example.test/http/remote-http-${n}`;
  return {
    remoteId: `remote-http-${n}`,
    remote: { httpBase, mcpUrl: `https://relay.example.test/mcp/remote-http-${n}`, label: 'x' },
    transport: 'relay-http',
    inboundCursor: null,
    relayEpoch: 1,
    pairing: {
      kind: 'bridge',
      connectionId: req.connectionId,
      transport: 'relay-http',
      mcpUrl: `https://relay.example.test/mcp/remote-http-${n}`,
      httpBase,
      pairingCode: null,
      pairingExpiresAt: null,
      oneTimeToken: token,
      instructionBrief: brief(token, httpBase),
    },
    facts: [{ key: 'token-issued', label: 'Token issued', at: new Date().toISOString(), status: 'done' }],
  };
}

let raw: Database.Database;
let comp: PersistentAgentsComposition;
let bridge: FakeConnector;
let native: FakeConnector;
let logger: ReturnType<typeof makeLogger>;
let capture: ReturnType<typeof vi.fn>;
let events: unknown[];
let emitSpy: { mockRestore(): void };

function pa() {
  return appRouter.createCaller(createContext()).cyboflow.persistentAgents;
}

beforeEach(() => {
  const t = makeTestDb();
  raw = t.raw;
  bridge = createFakeConnector({ kind: 'bridge' });
  native = createFakeConnector({ kind: 'native' });
  logger = makeLogger();
  capture = vi.fn();
  events = [];
  const deps: PersistentAgentsCompositionDeps = {
    db: t.db,
    configManager: new FakeConfig() as unknown as PersistentAgentsCompositionDeps['configManager'],
    logger,
    cloud: null,
    captureSeamError: capture,
    // Reversible but not the identity, so a stored ciphertext never equals the secret.
    encrypt: (plain) => Buffer.from(plain.split('').reverse().join(''), 'utf-8'),
    decrypt: (cipher) => cipher.toString('utf-8').split('').reverse().join(''),
    wireConnectors: (ctx) => {
      ctx.register(bridge.registration);
      ctx.register(native.registration);
      return { start() {}, stop() {} };
    },
  };
  comp = composePersistentAgents(deps);
  comp.start();
  const spy = vi.spyOn(persistentAgentEvents, 'emit');
  spy.mockImplementation(function (this: EventEmitter, event: string | symbol, ...args: unknown[]): boolean {
    events.push(args);
    return EventEmitter.prototype.emit.call(this, event, ...args);
  });
  emitSpy = spy;
});

afterEach(() => {
  emitSpy.mockRestore();
  comp.stop();
  _resetPersistentAgentsFacadeForTesting();
  persistentAgentEvents.removeAllListeners();
  raw.close();
});

describe('cyboflow.persistentAgents: secrets never appear', () => {
  it('vendor keys never, one-time tokens only in connect / switchConnection / repairPairing', async () => {
    const api = pa();
    /** Responses that must contain NO token and NO secret. */
    const clean: Array<[string, unknown]> = [];
    /** Responses allowed to carry a token (never a secret). */
    const tokenBearing: Array<[string, unknown]> = [];

    // Credentials
    const added = await api.addCredential({ vendor: 'anthropic', label: 'Work key', secret: SECRET });
    expect(added.ok).toBe(true);
    clean.push(['addCredential', added]);
    const credentialId = added.ok ? added.credential.id : '';
    clean.push(['listCredentials', await api.listCredentials()]);

    // Bridge connect (relay-http): token + brief returned once
    bridge.script.pushConnect(async () => httpOutcome(bridge, CONNECT_TOKEN, 1));
    const connected = await api.connect({
      agent: { displayName: 'Dots', vendor: 'openai-dots' },
      connection: { kind: 'bridge', connectorId: 'bridge', transport: 'relay-http' },
    });
    expect(connected.ok).toBe(true);
    if (!connected.ok) throw new Error(connected.message);
    expect(connected.pairing?.oneTimeToken).toBe(CONNECT_TOKEN);
    expect(connected.pairing?.instructionBrief).toContain(CONNECT_TOKEN);
    tokenBearing.push(['connect', connected]);
    const bridgeAgentId = connected.agentId;
    const bridgeConnectionId = connected.connectionId;

    // Native connect using the stored key
    const nativeConnected = await api.connect({
      agent: { displayName: 'Worker', vendor: 'anthropic-cma' },
      connection: { kind: 'native', connectorId: 'claude-managed-agents', remote: {}, credential: { mode: 'existing', credentialId } },
    });
    expect(nativeConnected.ok).toBe(true);
    if (!nativeConnected.ok) throw new Error(nativeConnected.message);
    clean.push(['connect(native)', nativeConnected]);

    // Reads
    const pairing = await api.getPairing({ connectionId: bridgeConnectionId });
    expect(pairing).not.toBeNull();
    expect(pairing?.oneTimeToken).toBeNull();
    expect(pairing?.instructionBrief).toBeNull();
    clean.push(['getPairing', pairing]);
    clean.push(['status', await api.status()]);
    clean.push(['listConnectors', await api.listConnectors()]);
    clean.push(['listAgents', await api.listAgents()]);
    clean.push(['listAgents(archived)', await api.listAgents({ includeArchived: true })]);

    // Thread traffic
    clean.push(['send', await api.send({ agentId: bridgeAgentId, text: 'hello agent' })]);
    bridge.script.pushVerify({ facts: [{ key: 'token-issued', label: 'Token issued', at: null, status: 'done' }] });
    clean.push(['verify', await api.verify({ connectionId: bridgeConnectionId })]);
    clean.push(['getThread', await api.getThread({ agentId: bridgeAgentId })]);
    clean.push(['getThread(native)', await api.getThread({ agentId: nativeConnected.agentId })]);
    clean.push(['markRead', await api.markRead({ agentId: bridgeAgentId })]);
    clean.push(['getActivity', await api.getActivity({ agentId: bridgeAgentId })]);
    clean.push(['getUsage', await api.getUsage({ agentId: bridgeAgentId })]);

    // repairPairing: a NEW token, returned once
    const repairOutcome = (): RepairOutcome => {
      const httpBase = 'https://relay.example.test/http/remote-http-1';
      return {
        pairing: {
          kind: 'bridge', connectionId: bridgeConnectionId, transport: 'relay-http',
          mcpUrl: 'https://relay.example.test/mcp/remote-http-1', httpBase,
          pairingCode: null, pairingExpiresAt: null,
          oneTimeToken: REPAIR_TOKEN, instructionBrief: brief(REPAIR_TOKEN, httpBase),
        },
        remotePatch: { pairedClient: null },
        relayEpoch: 2,
        inboundCursor: 'bridge:v1:2:0',
      };
    };
    bridge.script.pushRepair(repairOutcome());
    const repaired = await api.repairPairing({ connectionId: bridgeConnectionId });
    expect(repaired.ok).toBe(true);
    if (!repaired.ok) throw new Error(repaired.message);
    expect(repaired.pairing.oneTimeToken).toBe(REPAIR_TOKEN);
    tokenBearing.push(['repairPairing', repaired]);
    clean.push(['getPairing(after repair)', await api.getPairing({ connectionId: bridgeConnectionId })]);

    // switchConnection: another token, returned once
    bridge.script.pushConnect(async () => httpOutcome(bridge, SWITCH_TOKEN, 2));
    const switched = await api.switchConnection({
      agentId: bridgeAgentId,
      connection: { kind: 'bridge', connectorId: 'bridge', transport: 'relay-http' },
    });
    expect(switched.ok).toBe(true);
    if (!switched.ok) throw new Error(switched.message);
    expect(switched.pairing?.oneTimeToken).toBe(SWITCH_TOKEN);
    tokenBearing.push(['switchConnection', switched]);
    clean.push(['getPairing(switch)', await api.getPairing({ connectionId: switched.connectionId })]);
    clean.push(['listAgents(after switch)', await api.listAgents()]);
    clean.push(['getThread(after switch)', await api.getThread({ agentId: bridgeAgentId })]);
    clean.push(['cancelSwitch', await api.cancelSwitch({ agentId: bridgeAgentId })]);

    // Key lifecycle
    const rotated = await api.rotateCredential({ id: credentialId, secret: ROTATED_SECRET });
    expect(rotated.ok).toBe(true);
    clean.push(['rotateCredential', rotated]);
    const refused = await api.forgetCredential({ id: credentialId, detach: false });
    expect(refused).toMatchObject({ ok: false, error: 'in_use' });
    clean.push(['forgetCredential(in use)', refused]);
    clean.push(['listCredentials(after rotate)', await api.listCredentials()]);

    // Teardown
    clean.push(['disconnect', await api.disconnect({ agentId: nativeConnected.agentId })]);
    clean.push(['archiveAgent', await api.archiveAgent({ agentId: nativeConnected.agentId })]);
    clean.push(['listAgents(final)', await api.listAgents({ includeArchived: true })]);
    clean.push(['listCredentials(final)', await api.listCredentials()]);

    // ---- assertions --------------------------------------------------------------------------------
    for (const [name, response] of clean) {
      const text = JSON.stringify(response) ?? '';
      expect(text, name).not.toContain(SECRET);
      expect(text, name).not.toContain(ROTATED_SECRET);
      expect(text, name).not.toMatch(/cbh_/);
      for (const t of ALL_TOKENS) expect(text, name).not.toContain(t);
    }
    for (const [name, response] of tokenBearing) {
      const text = JSON.stringify(response);
      expect(text, name).not.toContain(SECRET);
      expect(text, name).not.toContain(ROTATED_SECRET);
    }
    // Change events reach the renderer through subscriptions: they carry neither kind of secret.
    expect(events.length).toBeGreaterThan(0);
    const eventText = JSON.stringify(events);
    expect(eventText).not.toContain(SECRET);
    expect(eventText).not.toContain(ROTATED_SECRET);
    expect(eventText).not.toMatch(/cbh_/);
    // Nor do logs or seam captures.
    const sinks = JSON.stringify([logger.calls, capture.mock.calls]);
    expect(sinks).not.toContain(SECRET);
    expect(sinks).not.toContain(ROTATED_SECRET);
    expect(sinks).not.toMatch(/cbh_/);
    // The database holds the key only as ciphertext and never holds a one-time token.
    const stored = ['vendor_credentials', 'persistent_agents', 'persistent_agent_connections', 'persistent_agent_messages', 'persistent_agent_events']
      .map((t) => JSON.stringify(raw.prepare(`SELECT * FROM ${t}`).all()))
      .join('\n');
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain(ROTATED_SECRET);
    expect(stored).not.toMatch(/cbh_/);
  }, COLD_ROUTER_IMPORT_TIMEOUT_MS);
});
