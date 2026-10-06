/**
 * Boot wiring for cross-machine backlog sync, kept out of index.ts (issue #19's
 * file-size ratchet). DEV BUILDS ONLY: a release build wires no facade, so
 * `cyboflow.remoteSync` answers `{ available: false }`, the Settings section
 * renders nothing, and no engine ever starts.
 */
import { setRemoteSyncFacade } from '../../orchestrator/remoteSyncBridge';
import type { ConfigManager } from '../configManager';
import { RemoteSyncService } from './remoteSyncService';

export function wireRemoteSync(configManager: ConfigManager): void {
  if (!configManager.isRemoteSyncAvailable()) return;
  setRemoteSyncFacade(new RemoteSyncService({ configManager }));
}
