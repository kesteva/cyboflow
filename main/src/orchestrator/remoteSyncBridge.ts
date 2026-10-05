/**
 * remoteSyncBridge — the seam between the remote-sync engine
 * (main/src/services/remoteSync/*) and its tRPC surface
 * (trpc/routers/remoteSync.ts). Same shape as trackerSyncBridge.ts: the router
 * must standalone-typecheck, so it talks to this facade and the composition
 * root (main/src/index.ts) injects the live service.
 *
 * UNSET MEANS UNAVAILABLE. Unlike the tracker bridge, an unwired facade is not
 * a boot-order bug: a release build never wires one (remote sync is dev-only),
 * so the router answers `{ available: false }` and the renderer renders nothing.
 */
import type { RemoteSyncStatus } from '../../../shared/types/remoteSync';

/** Everything the remoteSync tRPC surface can ask of the engine. */
export interface RemoteSyncFacade {
  /** What the Settings → Integrations → Sync section renders from. */
  getStatus(): RemoteSyncStatus;
}

let facade: RemoteSyncFacade | null = null;

/** Inject the live service at boot. Only a dev build calls this. */
export function setRemoteSyncFacade(next: RemoteSyncFacade): void {
  facade = next;
}

/** The wired facade, or null in a release build. */
export function getRemoteSyncFacade(): RemoteSyncFacade | null {
  return facade;
}

/** Test-only: clear the wired facade so a case starts from the unset state. */
export function _resetRemoteSyncFacadeForTesting(): void {
  facade = null;
}
