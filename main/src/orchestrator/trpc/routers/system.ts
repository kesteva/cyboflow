/**
 * cyboflow.system sub-router — the single aggregated query behind the System
 * view: classified processes (EPIC-039), the worktree registry + disk-usage
 * tri-state (EPIC-040) and the ports/sockets section, in one `snapshot`.
 *
 * Deliberately NOT `monitor.ts` (the unrelated per-run supervisor-chat seam).
 *
 * Pattern: setter-injected provider, mirroring `health.ts`. The concrete provider
 * (services/systemSnapshotProvider.ts, wired at boot in main/src/index.ts) closes
 * over the process snapshot service, the worktree monitor provider and the running
 * OrchSocketServer; this module sees only the structural shapes below.
 *
 * No timer or polling lives here: `snapshot` does its work only when a subscriber
 * invokes it, so with the System view closed no `ps` or `du` runs at all.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/* — only structural types and portProbe.ts.
 */
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { probePort, type PortProbeResult } from '../../portProbe';
import {
  CDP_PROBE_PORT,
  DEV_RENDERER_PROBE_PORT,
  type OrchSocketSnapshot,
  type SystemProcessEntry,
  type SystemSnapshot,
  type SystemWorktreeEntry,
} from '../../systemTypes';
import type {
  WorktreeMonitorDiskUsage,
  WorktreeMonitorRegistryEntry,
} from './worktreeMonitor';

/** Structural view of `OrchSocketServer` — only its two public read-only getters. */
export interface SystemOrchSocketSource {
  getConnectionCount(): number;
  getRunBindingCounts(): Record<string, number>;
}

export interface SystemSnapshotProvider {
  /** The reconciled worktree registry for a project (git truth ∪ session/run rows). */
  loadWorktrees(projectId: number): Promise<WorktreeMonitorRegistryEntry[]>;
  /** Disk-usage tri-state for one path; may enqueue a lazy, staggered measurement. */
  getDiskUsage(path: string): WorktreeMonitorDiskUsage;
  /**
   * ONE process scan, classified into the four buckets. `knownWorktreePaths` is
   * the registry's path set — the classifier's worktree truth.
   */
  loadProcesses(knownWorktreePaths: ReadonlySet<string>): Promise<SystemProcessEntry[]>;
  /** The running orch.sock server. */
  orchSocket: SystemOrchSocketSource;
  /** Port probe seam; defaults to the real `probePort` (tests inject a fake `connect`). */
  probePort?: (port: number, label: string) => Promise<PortProbeResult>;
}

let _systemProvider: SystemSnapshotProvider | null = null;

/** Inject the provider at boot (main/src/index.ts), before tRPC handles requests. */
export function setSystemProvider(provider: SystemSnapshotProvider | null): void {
  _systemProvider = provider;
}

const DEV_RENDERER_LABEL = 'dev renderer';
const CDP_LABEL = 'CDP';

function emptyOrchSocket(): OrchSocketSnapshot {
  return { connectionCount: 0, runBindings: {} };
}

/** Served before the provider is wired: an explicit "starting" shape, never a throw. */
function startingSnapshot(): SystemSnapshot {
  return {
    status: 'starting',
    generatedAt: Date.now(),
    processes: [],
    worktrees: [],
    ports: {
      devRenderer: { port: DEV_RENDERER_PROBE_PORT, label: DEV_RENDERER_LABEL, inUse: false },
      cdp: { port: CDP_PROBE_PORT, label: CDP_LABEL, inUse: false },
      orchSocket: emptyOrchSocket(),
    },
  };
}

async function buildSnapshot(provider: SystemSnapshotProvider, projectId: number): Promise<SystemSnapshot> {
  const probe = provider.probePort ?? ((port: number, label: string) => probePort(port, label));
  const registry = await provider.loadWorktrees(projectId);
  const [processes, devRenderer, cdp] = await Promise.all([
    provider.loadProcesses(new Set(registry.map((w) => w.path))),
    probe(DEV_RENDERER_PROBE_PORT, DEV_RENDERER_LABEL),
    probe(CDP_PROBE_PORT, CDP_LABEL),
  ]);
  const worktrees: SystemWorktreeEntry[] = registry.map((entry) => ({
    ...entry,
    usage: provider.getDiskUsage(entry.path),
  }));
  return {
    status: 'ready',
    generatedAt: Date.now(),
    processes,
    worktrees,
    ports: {
      devRenderer,
      cdp,
      orchSocket: {
        connectionCount: provider.orchSocket.getConnectionCount(),
        runBindings: provider.orchSocket.getRunBindingCounts(),
      },
    },
  };
}

export const systemRouter = router({
  /**
   * cyboflow.system.snapshot — everything the System view renders, in one call.
   * Falls back to `status: 'starting'` when no provider has been injected yet.
   */
  snapshot: protectedProcedure
    .input(z.object({ projectId: z.number().int() }))
    .query(async ({ input }): Promise<SystemSnapshot> => {
      const provider = _systemProvider;
      if (provider === null) return startingSnapshot();
      return buildSnapshot(provider, input.projectId);
    }),
});
