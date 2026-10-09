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
 *   listConflicts     : query { projectId?, view } -> RemoteSyncConflict[]
 *   resolveConflict   : mutation { conflictId, action } -> RemoteSyncResolveResult
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
  RemoteSyncConflict,
  RemoteSyncEnableResult,
  RemoteSyncResolveResult,
  RemoteSyncProjectChoices,
  RemoteSyncStatus,
} from '../../../../../shared/types/remoteSync';

function requireFacade(): RemoteSyncFacade {
  const facade = getRemoteSyncFacade();
  if (!facade) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Remote sync is not available in this build' });
  return facade;
}

const projectId = z.number().int().positive();

const conflictAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('keep') }),
  z.object({ kind: z.literal('use_other') }),
  z.object({ kind: z.literal('merge'), value: z.string().max(256 * 1024) }),
  z.object({ kind: z.literal('recreate') }),
  z.object({ kind: z.literal('move'), parentId: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('delete_children') }),
  z.object({ kind: z.literal('swap') }),
]);

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
  listConflicts: protectedProcedure
    .input(z.object({ projectId: projectId.optional(), view: z.enum(['open', 'resolved']).default('open') }))
    .query(({ input }): RemoteSyncConflict[] => getRemoteSyncFacade()?.listConflicts(input.projectId ?? null, input.view) ?? []),
  resolveConflict: protectedProcedure
    .input(z.object({ conflictId: z.string().min(1).max(200), action: conflictAction }))
    .mutation(({ input }): Promise<RemoteSyncResolveResult> => requireFacade().resolveConflict(input.conflictId, input.action)),
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
