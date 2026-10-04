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
 * Windows (chosen approach: option 1 — the router stays registered on every
 * platform). The process listing already normalizes win32 through
 * winProcessTable.ts / platformProcess.ts, so processes, the worktree registry
 * and ports are served for real. Only worktree disk sizing (`du`, POSIX-only) is
 * unsupported there: `capabilities.diskSizing` is `{ supported: false, reason }`,
 * each worktree's `usage` is `{ status: 'unsupported', reason }`, and no `du` is
 * ever requested. The platform is injectable via `SystemSnapshotProvider.platform`
 * (PlatformProcessOptions convention) so tests can pin either platform.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/* — only structural types and portProbe.ts.
 */
import path from 'node:path';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { probePort, type PortProbeResult } from '../../portProbe';
import {
  CDP_PROBE_PORT,
  DEV_RENDERER_PROBE_PORT,
  DISK_SIZING_UNSUPPORTED_REASON,
  type SystemCapability,
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
  /** Platform seam (PlatformProcessOptions convention); defaults to the host platform. */
  platform?: NodeJS.Platform;
}

let _systemProvider: SystemSnapshotProvider | null = null;

/** Inject the provider at boot (main/src/index.ts), before tRPC handles requests. */
export function setSystemProvider(provider: SystemSnapshotProvider | null): void {
  _systemProvider = provider;
}

const DEV_RENDERER_LABEL = 'dev renderer';
const CDP_LABEL = 'CDP';

function diskSizingCapability(platform: NodeJS.Platform): SystemCapability {
  return platform === 'win32'
    ? { supported: false, reason: DISK_SIZING_UNSUPPORTED_REASON }
    : { supported: true };
}

function emptyOrchSocket(): OrchSocketSnapshot {
  return { connectionCount: 0, runBindings: {} };
}

/** Served before the provider is wired: an explicit "starting" shape, never a throw. */
function startingSnapshot(): SystemSnapshot {
  return {
    status: 'starting',
    generatedAt: Date.now(),
    capabilities: { diskSizing: diskSizingCapability(process.platform) },
    processes: [],
    worktrees: [],
    ports: {
      devRenderer: { port: DEV_RENDERER_PROBE_PORT, label: DEV_RENDERER_LABEL, inUse: false },
      cdp: { port: CDP_PROBE_PORT, label: CDP_LABEL, inUse: false },
      orchSocket: emptyOrchSocket(),
    },
  };
}

function isNestedPath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * `du` of a checkout counts every worktree nested under it — cyboflow's default
 * layout puts them in `<project>/worktrees/`, so the main repo would otherwise report
 * (and the Disk tile total double-count) all of them. Subtract the outermost nested
 * entries' measured sizes; while any of those is still unmeasured the parent stays
 * `measuring` rather than showing an inflated figure.
 */
function excludeNestedWorktreeUsage(worktrees: SystemWorktreeEntry[]): SystemWorktreeEntry[] {
  return worktrees.map((entry) => {
    if (entry.usage.status !== 'measured') return entry;
    const inside = worktrees.filter((o) => o !== entry && isNestedPath(entry.path, o.path));
    const outermost = inside.filter((o) => !inside.some((p) => p !== o && isNestedPath(p.path, o.path)));
    if (outermost.length === 0) return entry;
    let nestedBytes = 0;
    for (const o of outermost) {
      if (o.usage.status !== 'measured') return { ...entry, usage: { status: 'measuring' as const } };
      nestedBytes += o.usage.bytes;
    }
    return { ...entry, usage: { ...entry.usage, bytes: Math.max(0, entry.usage.bytes - nestedBytes) } };
  });
}

/** Assemble the aggregated snapshot from a provider (also what `monitorReap` resolves manifests against). */
export async function buildSystemSnapshot(provider: SystemSnapshotProvider, projectId: number): Promise<SystemSnapshot> {
  const probe = provider.probePort ?? ((port: number, label: string) => probePort(port, label));
  const diskSizing = diskSizingCapability(provider.platform ?? process.platform);
  const registry = await provider.loadWorktrees(projectId);
  const [processes, devRenderer, cdp] = await Promise.all([
    provider.loadProcesses(new Set(registry.map((w) => w.path))),
    probe(DEV_RENDERER_PROBE_PORT, DEV_RENDERER_LABEL),
    probe(CDP_PROBE_PORT, CDP_LABEL),
  ]);
  const worktrees: SystemWorktreeEntry[] = excludeNestedWorktreeUsage(
    registry.map((entry) => ({
      ...entry,
      // Unsupported: never touch the disk service, so no `du` is queued.
      usage: diskSizing.supported
        ? provider.getDiskUsage(entry.path)
        : { status: 'unsupported' as const, reason: diskSizing.reason },
    })),
  );
  return {
    status: 'ready',
    generatedAt: Date.now(),
    capabilities: { diskSizing },
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
      return buildSystemSnapshot(provider, input.projectId);
    }),
});
