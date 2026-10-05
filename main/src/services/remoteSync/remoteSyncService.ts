/**
 * RemoteSyncService — the desktop client of the cyboflow-sync service
 * (cross-machine backlog sync, protocol 1). The desktop relies on the service's
 * HTTP contract only, never on the server's code.
 *
 * Constructed and wired ONLY in a dev build (see ConfigManager.isRemoteSyncAvailable).
 * For now it only reports status; sign-in and the engine land in M0.
 */
import type { RemoteSyncFacade } from '../../orchestrator/remoteSyncBridge';
import { REMOTE_SYNC_STAGING_ORIGIN, type RemoteSyncStatus } from '../../../../shared/types/remoteSync';
import type { ConfigManager } from '../configManager';

export interface RemoteSyncServiceDeps {
  configManager: Pick<ConfigManager, 'isRemoteSyncAvailable' | 'isRemoteSyncEnabled' | 'getRemoteSyncServerOrigin'>;
}

export class RemoteSyncService implements RemoteSyncFacade {
  constructor(private readonly deps: RemoteSyncServiceDeps) {}

  getStatus(): RemoteSyncStatus {
    const { configManager } = this.deps;
    // Re-checked here, not only at wiring time: the gate is the single source
    // of truth, so a facade that somehow got wired still reports unavailable.
    if (!configManager.isRemoteSyncAvailable()) return { available: false };
    const serverOrigin = configManager.getRemoteSyncServerOrigin();
    return {
      available: true,
      enabled: configManager.isRemoteSyncEnabled(),
      serverOrigin,
      staging: serverOrigin === REMOTE_SYNC_STAGING_ORIGIN,
      signedIn: false,
    };
  }
}
