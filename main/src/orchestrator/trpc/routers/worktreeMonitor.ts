/**
 * cyboflow.worktreeMonitor sub-router — the query surface behind the System view's
 * worktree cards: the reconciled worktree registry (session-owned / run-owned /
 * orphan / in_place / is_main_repo, each carrying its `prunable` guard) and the
 * per-path disk-usage tri-state (`measured | measuring | queued`) plus an on-demand
 * `requestFresh`.
 *
 * Deliberately NOT `monitor.ts` (the unrelated per-run supervisor-chat seam) and
 * NOT `system.ts` (reserved for the aggregated process/ports snapshot).
 *
 * Pattern: setter-injected provider, mirroring `health.ts`. The concrete provider
 * (services/worktreeMonitorProvider.ts, wired at boot in main/src/index.ts) closes
 * over the database, WorktreeManager and DiskUsageService; this module sees only
 * the structural shapes below.
 *
 * No timer or polling lives here: a disk measurement (`du`) is only ever started
 * because a subscriber asked about a path, so a closed System view costs nothing.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc';

/** Structural mirror of services/worktreeRegistry.ts `WorktreeRegistryEntry`. */
interface WorktreeRegistryEntryBase {
  path: string;
  branch: string;
  sessionId?: string;
  runId?: string;
}

export type WorktreeMonitorRegistryEntry =
  | (WorktreeRegistryEntryBase & { tag: 'in_place' | 'is_main_repo'; prunable: false })
  | (WorktreeRegistryEntryBase & { tag: 'session-owned' | 'run-owned' | 'orphan'; prunable: true });

/** Structural mirror of services/diskUsageService.ts `DiskUsageEntry` — `bytes` exists only when measured. */
export type WorktreeMonitorDiskUsage =
  | { status: 'measured'; bytes: number; measuredAt: number }
  | { status: 'measuring' }
  | { status: 'queued' };

export interface WorktreeMonitorProvider {
  loadRegistry(projectId: number): Promise<WorktreeMonitorRegistryEntry[]>;
  getDiskUsage(path: string): WorktreeMonitorDiskUsage;
  requestFresh(path: string): WorktreeMonitorDiskUsage;
}

let _provider: WorktreeMonitorProvider | null = null;

/** Inject the provider at boot (main/src/index.ts), before tRPC handles requests. */
export function setWorktreeMonitorProvider(provider: WorktreeMonitorProvider | null): void {
  _provider = provider;
}

function requireProvider(): WorktreeMonitorProvider {
  if (!_provider) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'worktreeMonitor provider not wired into tRPC',
    });
  }
  return _provider;
}

/** Cap on paths per disk-usage query — a project has tens of worktrees, not thousands. */
const MAX_DISK_PATHS = 500;

export const worktreeMonitorRouter = router({
  /** cyboflow.worktreeMonitor.registry — the reconciled worktree registry for one project. */
  registry: protectedProcedure
    .input(z.object({ projectId: z.number().int() }))
    .query(async ({ input }): Promise<{ worktrees: WorktreeMonitorRegistryEntry[] }> => {
      const worktrees = await requireProvider().loadRegistry(input.projectId);
      return { worktrees };
    }),

  /**
   * cyboflow.worktreeMonitor.diskUsage — tri-state per path. Never a bare number:
   * `bytes` is present only on `status: 'measured'`.
   */
  diskUsage: protectedProcedure
    .input(z.object({ paths: z.array(z.string().min(1)).max(MAX_DISK_PATHS) }))
    .query(({ input }): { entries: Array<{ path: string; usage: WorktreeMonitorDiskUsage }> } => {
      const provider = requireProvider();
      return {
        entries: input.paths.map((path) => ({ path, usage: provider.getDiskUsage(path) })),
      };
    }),

  /** cyboflow.worktreeMonitor.requestFresh — re-measure one path ahead of the TTL queue. */
  requestFresh: protectedProcedure
    .input(z.object({ path: z.string().min(1) }))
    .mutation(({ input }): { path: string; usage: WorktreeMonitorDiskUsage } => {
      return { path: input.path, usage: requireProvider().requestFresh(input.path) };
    }),
});
