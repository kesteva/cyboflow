/**
 * remoteSyncBridge — the seam between the remote-sync service
 * (main/src/services/remoteSync/*) and its tRPC surface
 * (trpc/routers/remoteSync.ts). Same shape as trackerSyncBridge.ts: the router
 * must standalone-typecheck, so it talks to this facade and the composition
 * root injects the live service.
 *
 * UNSET MEANS UNAVAILABLE. Unlike the tracker bridge, an unwired facade is not
 * a boot-order bug: a release build never wires one (remote sync is dev-only),
 * so the router answers `{ available: false }` and the renderer renders nothing.
 */
import { EventEmitter } from 'node:events';
import type {
  RemoteSyncEnableRequest,
  RemoteSyncEnableResult,
  RemoteSyncProjectChoices,
  RemoteSyncStatus,
} from '../../../shared/types/remoteSync';

/** Everything the remoteSync tRPC surface can ask of the service. */
export interface RemoteSyncFacade {
  /** What the Settings → Integrations → Sync section renders from. */
  getStatus(): RemoteSyncStatus;
  /** "Sync now" for one project, or every linked project. Ignores backoff. */
  syncNow(projectId?: number): Promise<void>;
  /** Resume a project paused because this machine's sync state went backwards. */
  resumeAfterRewind(projectId: number): Promise<void>;
  /** Turning sync on for a project: its fingerprint and the remote projects it could join. */
  getProjectChoices(projectId: number): Promise<RemoteSyncProjectChoices>;
  /** Create the project's remote project, or join an existing one. */
  enableProject(req: RemoteSyncEnableRequest): Promise<RemoteSyncEnableResult>;
  /** Stop syncing a project on this machine; local data stays. */
  disableProject(projectId: number): Promise<void>;
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

/** Module-level emitter: the composition emits, the router subscription listens. */
export const remoteSyncEvents = new EventEmitter();
remoteSyncEvents.setMaxListeners(50);

export const REMOTE_SYNC_CHANGED_CHANNEL = 'remote-sync-changed';

/** Status changed: the payload is the new status, so the renderer never re-queries. */
export function emitRemoteSyncChanged(status: RemoteSyncStatus): void {
  remoteSyncEvents.emit(REMOTE_SYNC_CHANGED_CHANNEL, status);
}
