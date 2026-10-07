/**
 * Bridge wiring: builds the runtime, relay client, connector and doorbell once, registers the connector
 * with the persistent-agents core, and exposes a restartable start()/stop() (feature toggle) plus a
 * terminal dispose() (quit, via the connector's dispose()).
 *
 * Boot rule: nothing here calls getToken() or makes a request during createBridge/start() or for
 * BRIDGE_START_DELAY_MS afterwards; the doorbell and the periodic refresh wait for that delay.
 */
import type { CloudAccountHandle } from '../../../cloud/cloudAccountHandle';
import type { FetchLike } from '../../../cloud/fetchLike';
import type { ConnectorAvailability } from '../../../../../../shared/types/persistentAgents';
import type { ConnectorWiring, ConnectorWiringContext } from '../../connectorContract';
import { BridgeConnector } from './bridgeConnector';
import { BridgeRuntime } from './bridgeRuntime';
import { BRIDGE_START_DELAY_MS, CONNECTIONS_FIRST_REFRESH_MS, CONNECTIONS_REFRESH_MS } from './constants';
import { BRIDGE_CONNECTOR_ID, BRIDGE_DEFINITION } from './descriptor';
import { Doorbell } from './doorbell';
import { createNodeWebSocketFactory, type DoorbellSocketFactory } from './doorbellSocket';
import { RelayClient } from './relayClient';
import type { BridgeStatus } from './types';

export { BRIDGE_DEFINITION, BRIDGE_CONNECTOR_ID } from './descriptor';
export { BRIDGE_COPY } from './copy';
export type { BridgeStatus, DoorbellState } from './types';

export interface CreateBridgeDeps {
  ctx: ConnectorWiringContext;
  cloud: CloudAccountHandle;
  fetch: FetchLike;
  appVersion: string;
  createWebSocket: DoorbellSocketFactory | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  random?: () => number;
}

export interface BridgeInstance {
  connector: BridgeConnector;
  runtime: BridgeRuntime;
  doorbell: Doorbell;
  relay: RelayClient;
  /** Idempotent while running; restarts after stop(). */
  start(): void;
  /** Sync, reversible. */
  stop(): void;
  /** stop() + terminal doorbell teardown (quit only). */
  dispose(): void;
}

type Timer = ReturnType<typeof setTimeout>;

function unrefTimer<T extends Timer>(t: T): T {
  (t as { unref?: () => void }).unref?.();
  return t;
}

/**
 * The status fields that matter to availability and the doorbell (the doorbell's own state excluded),
 * plus the availability itself: a relay block (and its end) changes availability while status stays 'ready'.
 */
function statusKey(s: BridgeStatus, availability: ConnectorAvailability): string {
  const status = s.state === 'ready' ? 'ready' : s.state === 'degraded' ? { ...s, doorbell: null } : s;
  return JSON.stringify([status, availability]);
}

export function createBridge(deps: CreateBridgeDeps): BridgeInstance {
  const { ctx, cloud } = deps;
  const logger = ctx.logger;
  let running = false;
  let disposed = false;
  let delayElapsed = false;
  let startTimer: Timer | null = null;
  let firstRefreshTimer: Timer | null = null;
  let refreshInterval: ReturnType<typeof setInterval> | null = null;
  let unsubscribeConnections: (() => void) | null = null;
  let lastStatusKey: string | null = null;

  // The runtime's callbacks reach `relay`/`doorbell` (declared below) only after construction.
  const runtime = new BridgeRuntime({
    cloud,
    logger,
    env: deps.env,
    now: deps.now,
    onStatus: (s) => {
      const key = statusKey(s, runtime.availability());
      if (key === lastStatusKey) return;
      lastStatusKey = key;
      ctx.notifyAvailabilityChanged(BRIDGE_CONNECTOR_ID);
      doorbell.reconcile();
    },
    onSweepRequested: () => {
      ctx.kickAll((t) => t.connectorId === BRIDGE_CONNECTOR_ID);
      doorbell.reconcile();
    },
    probe: async () => {
      await relay.listConnections({ probe: true });
    },
  });

  const relay = new RelayClient({
    cloud,
    fetch: deps.fetch,
    appVersion: deps.appVersion,
    hooks: runtime,
    logger,
    budget: () => runtime.budget,
    abortSignal: () => runtime.signal,
    captureSeamError: (seam, err, tags) => ctx.captureSeamError(seam, err, tags),
    now: deps.now,
    random: deps.random,
  });

  const connector = new BridgeConnector({
    relay,
    runtime,
    cloud,
    reportRemotePatch: (id, patch) => ctx.reportRemotePatch(id, patch),
    reportConnectionGone: (id, reason) => ctx.reportConnectionGone(id, reason),
    captureSeamError: (seam, err, tags) => ctx.captureSeamError(seam, err, tags),
    logger,
    now: deps.now,
    onDispose: () => dispose(),
  });

  const doorbell = new Doorbell({
    createSocket: deps.createWebSocket,
    cloud,
    runtime,
    relay,
    listHandles: () => ctx.listHandles(BRIDGE_CONNECTOR_ID),
    findLocalId: (relayId) => ctx.findConnectionIdByRemoteId(BRIDGE_CONNECTOR_ID, relayId),
    kick: (id) => ctx.kick(id),
    reportConnectionGone: (id, reason) => {
      ctx.reportConnectionGone(id, reason).catch(() => {
        logger.warn('[bridge] reportConnectionGone failed', { connectionId: id, reason });
      });
    },
    canRun: () => running && delayElapsed,
    appVersion: deps.appVersion,
    logger,
    now: deps.now,
    random: deps.random,
  });

  const refreshNow = (): void => {
    if (!running) return;
    void connector.refreshConnections(ctx.listHandles(BRIDGE_CONNECTOR_ID), runtime.signal);
  };

  function start(): void {
    if (running || disposed) return;
    running = true;
    delayElapsed = false;
    lastStatusKey = null;
    runtime.start();
    doorbell.resume();
    unsubscribeConnections = ctx.onConnectionsChanged(() => doorbell.reconcile());
    startTimer = unrefTimer(setTimeout(() => {
      startTimer = null;
      delayElapsed = true;
      doorbell.reconcile();
      firstRefreshTimer = unrefTimer(setTimeout(() => {
        firstRefreshTimer = null;
        refreshNow();
      }, CONNECTIONS_FIRST_REFRESH_MS));
      refreshInterval = unrefTimer(setInterval(refreshNow, CONNECTIONS_REFRESH_MS));
    }, BRIDGE_START_DELAY_MS));
  }

  function stop(): void {
    if (!running) return;
    running = false;
    delayElapsed = false;
    if (startTimer) clearTimeout(startTimer);
    if (firstRefreshTimer) clearTimeout(firstRefreshTimer);
    if (refreshInterval) clearInterval(refreshInterval);
    startTimer = null;
    firstRefreshTimer = null;
    refreshInterval = null;
    unsubscribeConnections?.();
    unsubscribeConnections = null;
    doorbell.pause();
    connector.clearMemory();
    runtime.stop();
    // The stopped runtime reports 'disabled' and emits nothing, so announce the change here.
    lastStatusKey = null;
    ctx.notifyAvailabilityChanged(BRIDGE_CONNECTOR_ID);
  }

  function dispose(): void {
    if (disposed) return;
    stop();
    disposed = true;
    doorbell.stop();
  }

  return { connector, runtime, doorbell, relay, start, stop, dispose };
}

export interface WireBridgeOptions {
  /** Defaults to the main-process global WebSocket (null → pull-only). */
  createWebSocket?: DoorbellSocketFactory | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  random?: () => number;
}

/** Registers the Bridge with the persistent-agents core. Registers nothing in release builds (cloud null). */
export function wireBridgeConnector(ctx: ConnectorWiringContext, opts: WireBridgeOptions = {}): ConnectorWiring {
  if (ctx.cloud === null) return { start() {}, stop() {} };
  const cloud = ctx.cloud;
  const bridge = createBridge({
    ctx,
    cloud,
    fetch: cloud.fetch,
    appVersion: cloud.appVersion,
    createWebSocket: opts.createWebSocket !== undefined ? opts.createWebSocket : createNodeWebSocketFactory(),
    env: opts.env,
    now: opts.now,
    random: opts.random,
  });
  ctx.register({ definition: BRIDGE_DEFINITION, factory: () => bridge.connector });
  return { start: () => bridge.start(), stop: () => bridge.stop() };
}
