/**
 * cyboflow.remoteSync sub-router — cross-machine backlog sync (dev builds only).
 *
 *   getStatus : query -> RemoteSyncStatus
 *
 * A thin wrapper over the RemoteSyncFacade wired at boot. In a release build no
 * facade is wired, so every procedure answers as unavailable.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*.
 */
import { router, protectedProcedure } from '../trpc';
import { getRemoteSyncFacade } from '../../remoteSyncBridge';
import type { RemoteSyncStatus } from '../../../../../shared/types/remoteSync';

export const remoteSyncRouter = router({
  getStatus: protectedProcedure.query((): RemoteSyncStatus => {
    return getRemoteSyncFacade()?.getStatus() ?? { available: false };
  }),
});
