/**
 * cyboflow cloud sign-in — the orchestrator-side seam between the `cyboflow.cloud.*` tRPC router and the
 * CloudAccountService under main/src/services/cloud/.
 *
 * Same shape as trackerSyncBridge.ts (facade, set/get/reset, module emitter), with one difference: an
 * UNSET facade means UNAVAILABLE (release builds never wire one), so `getCloudAccountFacade()` returns null
 * instead of throwing.
 *
 * Imports only node:events and shared/types/*.
 */
import { EventEmitter } from 'node:events';
import type {
  CloudChangedEvent, CloudListDevicesResult, CloudSignInStart, CloudSignOutResult, CloudStatus,
} from '../../../shared/types/cloudAccountWire';

export interface CloudAccountFacade {
  getStatus(): CloudStatus;
  startSignIn(opts: { deviceName?: string }): Promise<CloudSignInStart>;
  cancelSignIn(): { cancelled: boolean };
  signOut(): Promise<CloudSignOutResult>;
  refreshAccount(opts: { force: boolean }): Promise<CloudStatus>;
  listDevices(): Promise<CloudListDevicesResult>;
  openDevicesPage(): Promise<void>;
  /** User-action unlock. Synchronous decrypt; idempotent when already unlocked or signed out.
   *  explicitRetry=false never re-attempts after a terminal decrypt failure (overlay or undecryptable). */
  unlock(opts: { explicitRetry: boolean }): CloudStatus;
  /** Re-open the in-memory login URL in the OS browser while phase is waiting_for_browser.
   *  {opened:false} in any other phase or when openExternal rejects (never throws for those). */
  reopenSignInPage(): Promise<{ opened: boolean }>;
}

let facade: CloudAccountFacade | null = null;

/** Inject the live service (composition root). UNSET MEANS UNAVAILABLE: release builds never call this. */
export function setCloudAccountFacade(next: CloudAccountFacade): void {
  facade = next;
}

/** The wired facade, or null when cyboflow cloud is unavailable in this build. */
export function getCloudAccountFacade(): CloudAccountFacade | null {
  return facade;
}

/** Test-only: clear the wired facade so a case starts from the unset state. */
export function _resetCloudAccountFacadeForTesting(): void {
  facade = null;
}

/** Module-level emitter shared by the composition (emit) and the router subscription (listen). */
export const cloudAccountEvents = new EventEmitter();
cloudAccountEvents.setMaxListeners(50);

export const CLOUD_CHANGED_CHANNEL = 'cloud-changed';

export function emitCloudChanged(ev: CloudChangedEvent): void {
  cloudAccountEvents.emit(CLOUD_CHANGED_CHANNEL, ev);
}
