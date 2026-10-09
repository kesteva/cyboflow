/**
 * Boot wiring for cross-machine backlog sync, kept out of index.ts (issue #19's
 * file-size ratchet). DEV BUILDS ONLY: a release build wires no facade, so
 * `cyboflow.remoteSync` answers `{ available: false }`, the Settings section
 * renders nothing, and no engine ever starts.
 */
import { app, powerMonitor } from 'electron';
import { join } from 'node:path';
import { emitRemoteSyncChanged, setRemoteSyncFacade } from '../../orchestrator/remoteSyncBridge';
import type { ReviewItemRouter } from '../../orchestrator/reviewItemRouter';
import type { TaskChangeRouter } from '../../orchestrator/taskChangeRouter';
import type { DatabaseLike, LoggerLike } from '../../orchestrator/types';
import { getCyboflowDirectory } from '../../utils/cyboflowDirectory';
import type { CloudAccountHandle } from '../cloud/cloudAccountHandle';
import type { TrackerClaimConnections, TrackerClaimGate } from '../trackerSync/claimGate';
import type { ConfigManager } from '../configManager';
import { captureSeamError } from '../telemetry';
import { RemoteSyncService } from './remoteSyncService';

export interface RemoteSyncWiringDeps {
  db: DatabaseLike;
  router: TaskChangeRouter;
  reviewRouter: ReviewItemRouter;
  configManager: ConfigManager;
  cloud: CloudAccountHandle | null;
  /** Tracker sync: its connections run only on the device holding their claim. */
  trackers: (TrackerClaimConnections & { setClaimGate(gate: TrackerClaimGate | null): void }) | null;
  logger: LoggerLike;
}

export function wireRemoteSync(deps: RemoteSyncWiringDeps): RemoteSyncService | null {
  const { configManager, reviewRouter } = deps;
  if (!configManager.isRemoteSyncAvailable()) return null;
  const service = new RemoteSyncService({
    db: deps.db,
    router: deps.router,
    configManager,
    cloud: deps.cloud,
    restoreExportDir: join(getCyboflowDirectory(), 'sync-restore-exports'),
    fileFinding: (projectId, title, body) => {
      void reviewRouter
        .applyReviewItem(projectId, {
          op: 'create',
          actor: 'cyboflow-remote',
          kind: 'finding',
          title,
          body,
          blocking: false,
          severity: 'warning',
          source: 'remote-sync',
          payload: { kind: 'finding', category: 'remote-sync' },
        })
        .catch((err: unknown) => deps.logger.error('[remoteSync] filing a finding failed', { error: String(err) }));
    },
    // Codes only: no titles, bodies or ids of backlog content.
    reportError: (code, tags) => captureSeamError('remote-sync', new Error(`remote sync: ${code}`), { errorClass: code, ...tags }),
    subscribeWake: (cb) => {
      powerMonitor.on('resume', cb);
      app.on('browser-window-focus', cb);
      return () => {
        powerMonitor.off('resume', cb);
        app.off('browser-window-focus', cb);
      };
    },
    logger: deps.logger,
  });
  service.on('changed', () => emitRemoteSyncChanged(service.getStatus()));
  setRemoteSyncFacade({
    getStatus: () => service.getStatus(),
    syncNow: (projectId) => service.syncNow(projectId),
    resumeAfterRewind: (projectId) => service.resumeAfterRewind(projectId),
    getProjectChoices: (projectId) => service.getProjectChoices(projectId),
    enableProject: (req) => service.enableProject(req),
    disableProject: (projectId) => service.disableProject(projectId),
    getLog: (projectId) => service.getLog(projectId),
    confirmHeldDeletes: (projectId) => service.confirmHeldDeletes(projectId),
    restoreHeldDeletes: (projectId) => service.restoreHeldDeletes(projectId),
  });
  if (deps.trackers) {
    service.trackerClaims.setConnections(deps.trackers);
    deps.trackers.setClaimGate(service.trackerClaims);
  }
  service.start();
  app.on('before-quit', () => service.stop());
  return service;
}
