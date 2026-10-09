/**
 * cyboflow.remoteSync sub-router — cross-machine backlog sync (dev builds only).
 *
 *   getStatus         : query -> RemoteSyncStatus
 *   syncNow           : mutation { projectId? } -> void
 *   resumeAfterRewind : mutation { projectId } -> void
 *   getProjectChoices : query { projectId } -> RemoteSyncProjectChoices
 *   enableProject     : mutation RemoteSyncEnableRequest -> RemoteSyncEnableResult
 *   disableProject    : mutation { projectId } -> void
 *   getLog            : query { projectId } -> string[]
 *   confirmHeldDeletes: mutation { projectId } -> void
 *   restoreHeldDeletes: mutation { projectId } -> number
 *   onChanged         : subscription -> RemoteSyncStatus
 *
 * A thin wrapper over the RemoteSyncFacade wired at boot. In a release build no
 * facade is wired, so every procedure answers as unavailable.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { eventToAsyncIterable } from './events';
import { REMOTE_SYNC_CHANGED_CHANNEL, getRemoteSyncFacade, remoteSyncEvents } from '../../remoteSyncBridge';
import type { RemoteSyncFacade } from '../../remoteSyncBridge';
import type {
  RemoteSyncEnableResult,
  RemoteSyncProjectChoices,
  RemoteSyncStatus,
} from '../../../../../shared/types/remoteSync';

function requireFacade(): RemoteSyncFacade {
  const facade = getRemoteSyncFacade();
  if (!facade) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Remote sync is not available in this build' });
  return facade;
}

const projectId = z.number().int().positive();

const enableRequest = z.discriminatedUnion('mode', [
  z.object({ projectId, mode: z.literal('create') }),
  z.object({ projectId, mode: z.literal('join'), remoteProjectId: z.string().min(1).max(200) }),
]);

export const remoteSyncRouter = router({
  getStatus: protectedProcedure.query((): RemoteSyncStatus => {
    return getRemoteSyncFacade()?.getStatus() ?? { available: false };
  }),
  syncNow: protectedProcedure.input(z.object({ projectId: projectId.optional() })).mutation(async ({ input }) => {
    await requireFacade().syncNow(input.projectId);
  }),
  resumeAfterRewind: protectedProcedure.input(z.object({ projectId })).mutation(async ({ input }) => {
    await requireFacade().resumeAfterRewind(input.projectId);
  }),
  getProjectChoices: protectedProcedure
    .input(z.object({ projectId }))
    .query(({ input }): Promise<RemoteSyncProjectChoices> => requireFacade().getProjectChoices(input.projectId)),
  enableProject: protectedProcedure
    .input(enableRequest)
    .mutation(({ input }): Promise<RemoteSyncEnableResult> => requireFacade().enableProject(input)),
  disableProject: protectedProcedure.input(z.object({ projectId })).mutation(async ({ input }) => {
    await requireFacade().disableProject(input.projectId);
  }),
  getLog: protectedProcedure.input(z.object({ projectId })).query(({ input }): string[] => requireFacade().getLog(input.projectId)),
  confirmHeldDeletes: protectedProcedure.input(z.object({ projectId })).mutation(async ({ input }) => {
    await requireFacade().confirmHeldDeletes(input.projectId);
  }),
  restoreHeldDeletes: protectedProcedure
    .input(z.object({ projectId }))
    .mutation(({ input }): Promise<number> => requireFacade().restoreHeldDeletes(input.projectId)),
  onChanged: protectedProcedure.subscription(async function* ({ signal }): AsyncGenerator<RemoteSyncStatus> {
    const abortSignal = signal ?? new AbortController().signal;
    const source = eventToAsyncIterable<RemoteSyncStatus>(remoteSyncEvents, REMOTE_SYNC_CHANGED_CHANNEL, abortSignal);
    for await (const status of source) yield status;
  }),
});
