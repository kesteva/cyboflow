/**
 * persistentAgentsComposition — the composition root of the persistent-agents core (Agents &
 * Environments): store, connector registry, token buckets, credentials, outbox, inbound pump, connection
 * service and the facade the tRPC router calls. A SIBLING of index.ts (like webViewerComposition.ts), so it
 * may import services and electron-backed seams that orchestrator/** may not.
 *
 * Constructing touches no keychain and no network. start() boots only when the feature is running
 * (dev build + Settings toggle, no kill switch); the config toggle applies LIVE (off stops pump, outbox
 * and connector wiring with data kept; on restarts them). stop() is the synchronous quit-drain hook.
 */
import type { ConfigManager } from './services/configManager';
import type { DatabaseLike, LoggerLike } from './orchestrator/types';
import type { CloudAccountHandle } from './services/cloud/cloudAccountHandle';
import {
  emitPersistentAgentsChanged,
  persistentAgentEvents,
  PERSISTENT_AGENTS_CHANNEL,
  setPersistentAgentsFacade,
} from './orchestrator/persistentAgentsBridge';
import { PersistentAgentStore } from './orchestrator/persistentAgents/persistentAgentStore';
import { toConnectionHandle, type ConnectionRow } from './orchestrator/persistentAgents/rows';
import type { PersistentAgentsChangedEvent } from '../../shared/types/persistentAgents';
import { captureSeamError as defaultCaptureSeamError } from './services/telemetry';
import { decryptSecret, encryptSecret } from './services/secrets/safeStorageSecret';
import type {
  ConnectionHandle,
  ConnectorWiring,
  ConnectorWiringContext,
} from './services/persistentAgents/connectorContract';
import { ConnectorRegistry } from './services/persistentAgents/connectorRegistry';
import { ConnectionService } from './services/persistentAgents/connectionService';
import { CredentialService } from './services/persistentAgents/credentialService';
import { isBridgeKilled, isPersistentAgentsKilled } from './services/persistentAgents/flags';
import { InboundPump } from './services/persistentAgents/inboundPump';
import { OutboxWorker } from './services/persistentAgents/outbox';
import { PersistentAgentsService } from './services/persistentAgents/persistentAgentsService';
import { TokenBuckets } from './services/persistentAgents/tokenBucket';

export const RETENTION_FIRST_SWEEP_MS = 60_000;
export const RETENTION_SWEEP_INTERVAL_MS = 24 * 3_600_000;
export const EVENT_RETENTION_MS = 30 * 24 * 3_600_000;

export interface PersistentAgentsCompositionDeps {
  db: DatabaseLike;
  configManager: Pick<ConfigManager, 'isAgentsAvailable' | 'isAgentsEnabled' | 'getConfig' | 'on' | 'off'>;
  logger: LoggerLike;
  cloud: CloudAccountHandle | null;
  /** Connector wiring (the Bridge); omitted → no connector is registered. */
  wireConnectors?: (ctx: ConnectorWiringContext) => ConnectorWiring;
  // ---- test seams (production omits them) ----
  now?: () => Date;
  encrypt?: (plain: string) => Buffer;
  decrypt?: (cipher: Buffer) => string;
  captureSeamError?: (seam: string, err: unknown, tags?: Record<string, string>) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface PersistentAgentsComposition {
  service: PersistentAgentsService;
  /** The composition-owned registry (never a process singleton). */
  registry: ConnectorRegistry;
  /** Idempotent. */
  start(): void;
  /** Synchronous and idempotent (quit drain): no timers, no listeners left. */
  stop(): void;
}

export function composePersistentAgents(deps: PersistentAgentsCompositionDeps): PersistentAgentsComposition {
  const { db, configManager, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const capture = deps.captureSeamError ?? defaultCaptureSeamError;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  }));
  const running = (): boolean => configManager.isAgentsEnabled() && !isPersistentAgentsKilled();

  const store = new PersistentAgentStore(db, { now, logger });
  const registry = new ConnectorRegistry();
  const budget = new TokenBuckets({ now: () => now().getTime() });
  let bootRecovered: Promise<void> = Promise.resolve();

  const handleFromRow = (conn: ConnectionRow): ConnectionHandle | null => {
    const agent = store.getAgentRow(conn.agent_id);
    if (!agent) return null;
    const version = conn.credential_id !== null ? store.getCredentialRow(conn.credential_id)?.version ?? null : null;
    return toConnectionHandle(conn, agent, version);
  };
  const buildHandle = (connectionId: string): ConnectionHandle | null => {
    const conn = store.getConnectionRow(connectionId);
    return conn ? handleFromRow(conn) : null;
  };

  // Late-bound: the pump and the outbox call into the connection service, which needs both.
  let connections: ConnectionService | null = null;
  const conn = (): ConnectionService => {
    if (connections === null) throw new Error('persistent agents: connection service not constructed');
    return connections;
  };
  let pump: InboundPump | null = null;

  const credentials = new CredentialService({
    store,
    encrypt: deps.encrypt ?? encryptSecret,
    decrypt: deps.decrypt ?? decryptSecret,
    onCredentialReopened: (ids) => { for (const id of ids) pump?.kick(id); },
    logger,
  });
  registry.configure({ fetch: globalThis.fetch, now, log: logger, secret: (id) => credentials.secret(id) });

  const outbox = new OutboxWorker({
    store, registry, buildHandle, budget, isRunning: running, now, logger, captureSeamError: capture,
    onAuthFailure: (id, e) => conn().onAuthFailure(id, e),
    onRateLimited: (id, until) => store.setConnectionState(id, { rateLimitedUntil: until }),
    onConnectionGone: (id, e) => conn().onConnectionGone(id, e),
    bootRecovered: () => bootRecovered,
  });
  pump = new InboundPump({
    store, registry, buildHandle, budget, outbox, isRunning: running, now, logger, captureSeamError: capture,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (t) => clearInterval(t),
    connections: {
      onConnectionVerified: (id) => conn().onConnectionVerified(id),
      runRevokeRetries: () => conn().runRevokeRetries(),
      onAuthFailure: (id, e) => conn().onAuthFailure(id, e),
      onConnectionGone: (id, e) => conn().onConnectionGone(id, e),
    },
    bootRecovered: () => bootRecovered,
  });
  const thePump = pump;
  connections = new ConnectionService({
    store, registry, credentials, buildHandle, budget, pump: thePump, outbox, now, sleep, logger, captureSeamError: capture,
  });

  const service = new PersistentAgentsService({
    store, registry, connections, credentials, pump: thePump, outbox, now, logger,
    isAvailable: () => configManager.isAgentsAvailable(),
    isConfigEnabled: () => configManager.getConfig().agents?.enabled === true,
    isEnabled: () => configManager.isAgentsEnabled(),
    isKilled: () => isPersistentAgentsKilled(),
    isBridgeKilled: () => isBridgeKilled(),
  });
  setPersistentAgentsFacade(service);

  const ctx: ConnectorWiringContext = {
    register: (reg, opts) => registry.register(reg, opts),
    cloud: deps.cloud,
    listHandles: (connectorId) => store.listHandleRows(connectorId)
      .map(handleFromRow)
      .filter((h): h is ConnectionHandle => h !== null),
    onConnectionsChanged: (listener) => {
      const h = (ev: PersistentAgentsChangedEvent): void => {
        if (ev.kind === 'agents' || ev.kind === 'connection') listener();
      };
      persistentAgentEvents.on(PERSISTENT_AGENTS_CHANNEL, h);
      return () => { persistentAgentEvents.off(PERSISTENT_AGENTS_CHANNEL, h); };
    },
    findConnectionIdByRemoteId: (connectorId, remoteId) => store.findConnectionIdByRemoteId(connectorId, remoteId),
    kick: (id) => thePump.kick(id),
    kickAll: (filter) => thePump.kickAll(filter),
    reportRemotePatch: (id, patch) => store.patchRemote(id, patch),
    reportConnectionGone: (id, reason) => conn().onConnectionGone(id, reason),
    notifyAvailabilityChanged: () => emitPersistentAgentsChanged({ kind: 'connection', agentId: null }),
    isRunning: running,
    logger,
    captureSeamError: capture,
  };
  const wiring: ConnectorWiring | null = deps.wireConnectors ? deps.wireConnectors(ctx) : null;

  let started = false;
  let booted = false;
  let paused = false;
  let retentionFirst: ReturnType<typeof setTimeout> | null = null;
  let retentionInterval: ReturnType<typeof setInterval> | null = null;

  const sweepRetention = (): void => {
    const cutoff = new Date(now().getTime() - EVENT_RETENTION_MS).toISOString();
    store.pruneEvents(cutoff).catch((err: unknown) => {
      logger.warn('[persistent-agents] retention sweep failed', { error: err instanceof Error ? err.name : 'unknown' });
    });
  };

  const refreshDescriptors = (): void => {
    for (const def of registry.list()) {
      for (const row of store.listConnectionsForConnector(def.id)) {
        if (row.connector_version < def.version) {
          void store.refreshDescriptor(row.id, def.capabilities, def.version).catch(() => undefined);
        }
      }
    }
  };

  const boot = (): void => {
    booted = true;
    paused = false;
    // FIRST entry on the store's global queue; claims and the pump's interval wait for it.
    bootRecovered = store.requeueInFlightAsAmbiguous().then(
      (n) => { if (n > 0) logger.info('[persistent-agents] in-flight sends marked ambiguous at boot', { count: n }); },
      (err: unknown) => { logger.warn('[persistent-agents] boot requeue failed', { error: err instanceof Error ? err.name : 'unknown' }); },
    );
    refreshDescriptors();
    // Snapshot synchronously: a connect or switch this process starts after boot is never "recovered".
    const leftover = conn().captureBootState();
    void bootRecovered.then(() => conn().recoverOnBoot(leftover)).catch((err: unknown) => {
      logger.warn('[persistent-agents] boot recovery failed', { error: err instanceof Error ? err.name : 'unknown' });
    });
    thePump.start();
    outbox.start();
    wiring?.start();
    retentionFirst = setTimeout(sweepRetention, RETENTION_FIRST_SWEEP_MS);
    (retentionFirst as { unref?: () => void }).unref?.();
    retentionInterval = setInterval(sweepRetention, RETENTION_SWEEP_INTERVAL_MS);
    (retentionInterval as { unref?: () => void }).unref?.();
  };

  const pauseAll = (): void => {
    if (!booted || paused) return;
    paused = true;
    thePump.stop();
    outbox.stop();
    wiring?.stop();
  };

  const resumeAll = (): void => {
    if (!booted || !paused) return;
    paused = false;
    thePump.start();
    outbox.start();
    wiring?.start();
  };

  const onConfig = (): void => {
    if (running()) {
      if (!booted) boot();
      else resumeAll();
    } else {
      pauseAll();
    }
    emitPersistentAgentsChanged({ kind: 'status', agentId: null });
  };

  return {
    service,
    registry,
    start(): void {
      if (started) return;
      started = true;
      configManager.on('config-updated', onConfig);
      if (running()) {
        if (!booted) boot();
        else resumeAll();
      }
      emitPersistentAgentsChanged({ kind: 'status', agentId: null });
    },
    stop(): void {
      configManager.off('config-updated', onConfig);
      started = false;
      if (booted) paused = true;
      thePump.stop();
      outbox.stop();
      try {
        wiring?.stop();
      } catch {
        // quit drain is best-effort
      }
      registry.disposeAll();
      if (retentionFirst !== null) clearTimeout(retentionFirst);
      if (retentionInterval !== null) clearInterval(retentionInterval);
      retentionFirst = null;
      retentionInterval = null;
    },
  };
}
