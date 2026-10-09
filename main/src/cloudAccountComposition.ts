/**
 * cloudAccountComposition — the cyboflow cloud sign-in's composition root.
 *
 * A SIBLING of index.ts on purpose (like webViewerComposition.ts): it imports `electron` and concrete
 * services freely, so it must stay OUT of `main/src/orchestrator/**`. Composing never decrypts, fetches or
 * binds a socket: the stored row is only read, and the token is decrypted later by a user action or by
 * one boot unlock when a consumer (agents) is enabled.
 *
 * Release builds get null: no service, no facade, nothing reachable.
 */
import { app, session, shell } from 'electron';
import type { ConfigManager } from './services/configManager';
import type { DatabaseLike, LoggerLike } from './orchestrator/types';
import { setCloudAccountFacade, emitCloudChanged } from './orchestrator/cloudAccountBridge';
import type { CloudAccountFacade } from './orchestrator/cloudAccountBridge';
import { createElectronFetch } from './services/cloud/electronFetch';
import type { FetchLike } from './services/cloud/fetchLike';
import { AccountsHttpClient } from './services/cloud/accountsHttpClient';
import { CloudAccountStore } from './services/cloud/cloudAccountStore';
import { CloudAccountService } from './services/cloud/cloudAccountService';
import type { CloudAccountHandle } from './services/cloud/cloudAccountHandle';
import { defaultDeviceName } from './services/cloud/deviceName';
import { decryptSecret, encryptSecret, isSecretStorageAvailable } from './services/secrets/safeStorageSecret';
import { isPersistentAgentsKilled } from './services/persistentAgents/flags';
import { captureSeamError } from './services/telemetry';

export interface CloudAccountCompositionDeps {
  db: DatabaseLike;
  configManager: ConfigManager;
  logger: LoggerLike;
}

export interface CloudAccountComposition {
  service: CloudAccountService;
  /** What the persistent-agents composition takes. */
  handle: CloudAccountHandle;
}

/** One unlock of the saved sign-in, this long after compose, so a keychain prompt lands after first paint. */
export const CLOUD_BOOT_UNLOCK_DELAY_MS = 10_000;

function toFacade(service: CloudAccountService): CloudAccountFacade {
  return {
    getStatus: () => service.getStatus(),
    startSignIn: (opts) => service.startSignIn(opts),
    cancelSignIn: () => service.cancelSignIn(),
    signOut: () => service.signOut(),
    refreshAccount: (opts) => service.refreshAccount(opts),
    listDevices: () => service.listDevices(),
    openDevicesPage: () => service.openDevicesPage(),
    unlock: (opts) => service.unlockStatus(opts),
    reopenSignInPage: () => service.reopenSignInPage(),
  };
}

/** Release build returns null. */
export function composeCloudAccount(deps: CloudAccountCompositionDeps): CloudAccountComposition | null {
  const { db, configManager, logger } = deps;
  if (!configManager.isAgentsAvailable()) return null;

  // In-memory partition: no cookie bleed from the default session; still honours system proxy and certs.
  // Created lazily, after app ready.
  let cloudSession: ReturnType<typeof session.fromPartition> | null = null;
  const getSession = (): ReturnType<typeof session.fromPartition> => {
    if (!cloudSession) cloudSession = session.fromPartition('cyboflow-cloud');
    return cloudSession;
  };
  const fetchImpl = createElectronFetch({
    getNet: () => {
      const s = getSession();
      return { fetch: s.fetch.bind(s) as unknown as FetchLike };
    },
    createFreshSessionFetch: () => {
      const s = session.fromPartition(`cyboflow-cloud-${Date.now()}`);
      return s.fetch.bind(s) as unknown as FetchLike;
    },
    logger,
  });

  const store = new CloudAccountStore(db, logger);
  const appVersion = app.getVersion();
  const service = new CloudAccountService({
    store,
    createHttpClient: (origin) => new AccountsHttpClient({ origin, fetch: fetchImpl, appVersion }),
    fetch: fetchImpl,
    secrets: { encrypt: encryptSecret, decrypt: decryptSecret, isAvailable: isSecretStorageAvailable },
    openExternal: (url) => shell.openExternal(url),
    // Consumers: Agents & Environments and cross-machine backlog sync.
    isEnabled: () => configManager.isAgentsEnabled() || configManager.isRemoteSyncEnabled(),
    isDevBuild: () => configManager.isAgentsAvailable(),
    getConfiguredOrigin: () => configManager.getCloudOrigin(),
    appVersion,
    platform: process.platform,
    defaultDeviceName: () => defaultDeviceName(),
    logger,
    captureError: captureSeamError,
  });

  service.on('stateChanged', () => emitCloudChanged({ kind: 'stateChanged', status: service.getStatus() }));
  service.on('signedIn', () => emitCloudChanged({ kind: 'signedIn', status: service.getStatus() }));
  service.on('signedOut', () => emitCloudChanged({ kind: 'signedOut', status: service.getStatus() }));
  service.on('revoked', () => emitCloudChanged({ kind: 'revoked', status: service.getStatus() }));

  // One unlock at boot, only when a consumer will run: with the agents kill switch set, agents do not
  // consume the token (sync still may).
  const consumerEnabled = (): boolean =>
    (configManager.isAgentsEnabled() && !isPersistentAgentsKilled()) || configManager.isRemoteSyncEnabled();
  if (consumerEnabled() && service.getState() === 'locked') {
    service.scheduleBootUnlock(CLOUD_BOOT_UNLOCK_DELAY_MS);
  }

  const gateOpen = (): boolean => configManager.isAgentsEnabled() || configManager.isRemoteSyncEnabled();
  let lastEnabled = gateOpen();
  let lastConsumer = consumerEnabled();
  configManager.on('config-updated', () => {
    const enabled = gateOpen();
    const consumer = consumerEnabled();
    const consumerTurnedOn = consumer && !lastConsumer;
    const gateChanged = enabled !== lastEnabled;
    lastEnabled = enabled;
    lastConsumer = consumer;
    // Turning a consumer on is a user action: an implicit unlock (never re-prompts after a failure).
    if (consumerTurnedOn) service.unlock('user');
    if (gateChanged) service.notifyGateChanged();
  });

  setCloudAccountFacade(toFacade(service));

  // before-quit fires on both passes of the two-pass quit; stop() is synchronous and idempotent. It closes
  // the loopback listener and destroys its sockets so nothing holds the event loop past will-quit.
  app.on('before-quit', () => {
    service.stop();
  });

  return { service, handle: service };
}
