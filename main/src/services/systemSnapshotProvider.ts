/**
 * Concrete SystemSnapshotProvider for the `cyboflow.system` router: composes the
 * process snapshot service (ONE `ps` scan) + the four-bucket classifier, the
 * worktree monitor provider (registry + disk-usage tri-state) and the running
 * OrchSocketServer. Lives in services/ so the router stays free of service
 * imports; wired at boot in main/src/index.ts.
 *
 * Nothing here polls: every call originates from a `snapshot` query.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type {
  SystemOrchSocketSource,
  SystemSnapshotProvider,
} from '../orchestrator/trpc/routers/system';
import type {
  SystemForeignProcess,
  SystemManagedProcess,
  SystemOrphanProcess,
  SystemProcessEntry,
} from '../orchestrator/systemTypes';
import type { WorktreeMonitorProvider } from '../orchestrator/trpc/routers/worktreeMonitor';
import { getInstanceId, type InstanceRecord } from '../utils/spawnMarker';
import { getCyboflowSubdirectory } from '../utils/cyboflowDirectory';
import {
  buildLiveInstanceSet,
  classify,
  type ClassifiedProcess,
  type MarkedProcess,
  type SpawnMarkerObservation,
} from './processSnapshot/classify';
import type { SnapshottedProcess } from './processSnapshot/processSnapshotService';
import type { WorktreeTruth } from './processSnapshot/worktreeTruth';

export interface SystemSnapshotProviderDeps {
  processSnapshot: { snapshot(): Promise<SnapshottedProcess[]> };
  worktrees: Pick<WorktreeMonitorProvider, 'loadRegistry' | 'getDiskUsage'>;
  orchSocket: SystemOrchSocketSource;
  /** Port probe seam; defaults to the real `probePort`. */
  probePort?: SystemSnapshotProvider['probePort'];
  /** Liveness records under `<data dir>/instances/`. Defaults to reading that directory. */
  readInstanceRecords?: () => Promise<InstanceRecord[]>;
  /** Defaults to `process.kill(pid, 0)`. */
  isPidAlive?: (pid: number) => boolean;
  /** This process's instance id. Defaults to {@link getInstanceId}. */
  getSelfInstanceId?: () => string;
  /**
   * Reads the spawn marker off scanned rows' environments. No reader ships with
   * the scan yet, so by default rows carry no marker: nothing can reach
   * `orphan`, and unmanaged cyboflow-shaped rows stay `suspected`.
   */
  readMarkers?: (rows: readonly SnapshottedProcess[]) => Promise<Map<number, SpawnMarkerObservation>>;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isInstanceRecord(v: unknown): v is InstanceRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.instanceId === 'string' && typeof r.pid === 'number';
}

export async function readInstanceRecordsFromDisk(
  dir: string = getCyboflowSubdirectory('instances'),
): Promise<InstanceRecord[]> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const records: InstanceRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed: unknown = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
      if (isInstanceRecord(parsed)) records.push(parsed);
    } catch {
      // Torn or foreign file — ignorable, same as an absent record.
    }
  }
  return records;
}

/** Wire shape of one classified row. Foreign rows keep their no-number guarantee. */
export function toSystemProcessEntry(c: ClassifiedProcess): SystemProcessEntry {
  switch (c.bucket) {
    case 'foreign': {
      const entry: SystemForeignProcess = {
        bucket: 'foreign',
        readOnly: true,
        processType: c.processType,
        command: c.command,
        worktreePath: c.worktreePath,
        pidLabel: c.pidLabel,
        display: c.display,
        foreignInstanceId: c.foreignInstanceId,
      };
      return entry;
    }
    case 'orphan': {
      const entry: SystemOrphanProcess = {
        bucket: 'orphan',
        sweepEligible: true,
        instanceId: c.instanceId,
        processType: c.processType,
        command: c.command,
        worktreePath: c.worktreePath,
        pid: c.process.pid,
        ppid: c.process.ppid,
        pcpu: c.pcpu,
        pmem: c.pmem,
        etimeSeconds: c.etimeSeconds,
        owner: c.process.owner,
      };
      return entry;
    }
    case 'owned':
    case 'suspected': {
      const entry: SystemManagedProcess = {
        bucket: c.bucket,
        processType: c.processType,
        command: c.command,
        worktreePath: c.worktreePath,
        pid: c.process.pid,
        ppid: c.process.ppid,
        pcpu: c.pcpu,
        pmem: c.pmem,
        etimeSeconds: c.etimeSeconds,
        owner: c.process.owner,
      };
      return entry;
    }
  }
}

export function createSystemSnapshotProvider(deps: SystemSnapshotProviderDeps): SystemSnapshotProvider {
  const readRecords = deps.readInstanceRecords ?? (() => readInstanceRecordsFromDisk());
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  const selfId = deps.getSelfInstanceId ?? getInstanceId;

  return {
    loadWorktrees: (projectId) => deps.worktrees.loadRegistry(projectId),
    getDiskUsage: (p) => deps.worktrees.getDiskUsage(p),
    orchSocket: deps.orchSocket,
    probePort: deps.probePort,
    async loadProcesses(knownWorktreePaths) {
      const rows = await deps.processSnapshot.snapshot();
      const [records, markers] = await Promise.all([
        readRecords(),
        deps.readMarkers ? deps.readMarkers(rows) : Promise.resolve(new Map<number, SpawnMarkerObservation>()),
      ]);
      const marked: MarkedProcess[] = rows.map((r) => ({ ...r, marker: markers.get(r.pid) ?? null }));
      const liveInstances = buildLiveInstanceSet(selfId(), records, isPidAlive);
      // The registry's path set IS the worktree truth (sessions/runs ∪ git).
      const truth: WorktreeTruth = { knownWorktreePaths };
      return classify(marked, liveInstances, truth).map(toSystemProcessEntry);
    },
  };
}
