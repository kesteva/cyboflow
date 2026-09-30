/**
 * Four-bucket process classifier: owned / foreign / orphan / suspected.
 *
 * Pure — no I/O and no clock/`process.*` reads. Everything it needs (the scan,
 * which app instances are alive, which worktrees cyboflow knows) is an argument.
 *
 * The buckets are genuinely different TYPES, not one shape with a string tag, so
 * the destructive path can be gated by the compiler:
 *   - only {@link OrphanProcess} carries `sweepEligible: true`; a sweep-set builder
 *     takes `OrphanProcess[]`, so a `suspected` row cannot be handed to it.
 *   - {@link ForeignProcess} carries NO number-typed field at all (pid label and
 *     cpu/mem/elapsed figures are pre-formatted strings), so nothing on it can
 *     reach `killTree`/`forceKillPids` (which take a `number`) without a cast.
 *   - {@link SuspectedProcess} is NEVER promoted to orphan: without a spawn marker
 *     we have no proof it is cyboflow's, so it is shown, not swept.
 *
 * The spawn marker (CYBOFLOW_INSTANCE / CYBOFLOW_WORKTREE, see utils/spawnMarker.ts)
 * is read off a process's environment by the snapshot's marker reader and arrives
 * here as {@link MarkedProcess.marker}; `null`/absent means "no marker found".
 */
import type { InstanceRecord } from '../../utils/spawnMarker';
import type { ProcessSnapshotRow } from '../processTable';
import type { ProcessOwner, SnapshottedProcess } from './processSnapshotService';
import type { ProcessType } from './processTypes';
import type { WorktreeTruth } from './worktreeTruth';

/** What a process's environment said about who spawned it. */
export interface SpawnMarkerObservation {
  /** `CYBOFLOW_INSTANCE`. */
  instanceId: string;
  /** `CYBOFLOW_WORKTREE`, when readable. */
  worktree: string | null;
}

/** A snapshot row plus its (optional) observed spawn marker. `SnapshottedProcess` is assignable. */
export interface MarkedProcess extends SnapshottedProcess {
  marker?: SpawnMarkerObservation | null;
}

/** Which cyboflow app instances exist right now (from the `instances/<id>.json` liveness records). */
export interface LiveInstanceSet {
  /** The instance running this classifier (`getInstanceId()`), supplied by the caller. */
  readonly selfInstanceId: string;
  /** Every instance id whose liveness record names a still-running pid (self included). */
  readonly liveInstanceIds: ReadonlySet<string>;
  /**
   * Instance ids CONFIRMED dead: a liveness record exists and its pid is gone.
   * Absence from both sets means "unknown" (record missing/unreadable) — that is
   * NOT proof of death, so an unknown id is never sweep-eligible.
   */
  readonly deadInstanceIds: ReadonlySet<string>;
}

/**
 * Build a {@link LiveInstanceSet} from the liveness records under
 * `<data dir>/instances/`. `isPidAlive` is injected so this stays pure.
 */
export function buildLiveInstanceSet(
  selfInstanceId: string,
  records: readonly Pick<InstanceRecord, 'instanceId' | 'pid'>[],
  isPidAlive: (pid: number) => boolean,
): LiveInstanceSet {
  const live = new Set<string>([selfInstanceId]);
  const dead = new Set<string>();
  for (const r of records) {
    if (r.instanceId === selfInstanceId) continue;
    if (isPidAlive(r.pid)) live.add(r.instanceId);
    else dead.add(r.instanceId);
  }
  return { selfInstanceId, liveInstanceIds: live, deadInstanceIds: dead };
}

/** Non-numeric fields every bucket shares. */
interface ClassifiedCommon {
  processType: ProcessType;
  command: string;
  worktreePath: string | null;
}

/** Raw resource figures — every bucket EXCEPT foreign (see {@link ForeignProcess}). */
interface NumericMetrics {
  pcpu: number | null;
  pmem: number | null;
  etimeSeconds: number | null;
}

type ClassifiedBase = ClassifiedCommon & NumericMetrics;

/** Belongs to a live cyboflow instance — this one. Killable through the normal per-owner paths. */
export interface OwnedProcess extends ClassifiedBase {
  bucket: 'owned';
  process: SnapshottedProcess;
  owner: ProcessOwner | null;
  instanceId: string;
}

/** Cyboflow's own (marker proves it) and its owning instance is confirmed gone: the ONLY sweep-eligible bucket. */
export interface OrphanProcess extends ClassifiedBase {
  bucket: 'orphan';
  sweepEligible: true;
  process: SnapshottedProcess;
  /** The dead instance that spawned it. */
  instanceId: string;
}

/**
 * Looks cyboflow-shaped but carries no spawn marker. Never swept; a human may
 * still kill it individually behind the "not tagged as cyboflow's" confirm.
 */
export interface SuspectedProcess extends ClassifiedBase {
  bucket: 'suspected';
  process: SnapshottedProcess;
}

/**
 * Someone else's: an unrelated process, or another live instance's child.
 * Read-only by construction — deliberately NO `pid`/`ppid` and NO number-typed
 * field anywhere (a nullable `number` narrows to `number` after a null check and
 * would satisfy a `killTree(pid: number)` signature). `pidLabel` and `display`
 * are formatted strings for rendering only.
 */
export interface ForeignProcess extends ClassifiedCommon {
  bucket: 'foreign';
  readOnly: true;
  pidLabel: string;
  display: { cpu: string | null; mem: string | null; elapsed: string | null };
  /** The other live instance it belongs to, when the marker says so. */
  foreignInstanceId: string | null;
}

export type ClassifiedProcess = OwnedProcess | OrphanProcess | SuspectedProcess | ForeignProcess;

export function isOrphanProcess(c: ClassifiedProcess): c is OrphanProcess {
  return c.bucket === 'orphan';
}

/** The only sanctioned way to build a reap/sweep target list. */
export function selectSweepSet(classified: readonly ClassifiedProcess[]): OrphanProcess[] {
  return classified.filter(isOrphanProcess);
}

const MAX_ANCESTRY_DEPTH = 32;

function common(p: SnapshottedProcess): ClassifiedCommon {
  return { processType: p.processType, command: p.command, worktreePath: p.worktreePath };
}

function base(p: SnapshottedProcess): ClassifiedBase {
  return {
    ...common(p),
    pcpu: p.pcpu,
    pmem: p.pmem,
    etimeSeconds: p.etimeSeconds,
    worktreePath: p.worktreePath,
  };
}

/** True when `command` mentions `dir` as a whole path (not a prefix of a sibling like `/wt/a-b`). */
function mentionsPath(command: string, dir: string): boolean {
  if (dir.length === 0) return false;
  let from = 0;
  for (;;) {
    const at = command.indexOf(dir, from);
    if (at === -1) return false;
    const next = command.charAt(at + dir.length);
    if (next === '' || next === '/' || next === '\\' || /\s|["'=:]/.test(next)) return true;
    from = at + 1;
  }
}

/**
 * Marker-absent heuristic — used ONLY to reach `suspected`, never `orphan`.
 * Cyboflow-shaped = a known process type (broker/owned handle), a command line
 * naming a worktree cyboflow knows, or an ancestor that is itself cyboflow's.
 */
function selfLooksCyboflow(p: MarkedProcess, truth: WorktreeTruth): boolean {
  if (p.processType !== 'unknown' || p.owner !== null) return true;
  for (const wt of truth.knownWorktreePaths) {
    if (mentionsPath(p.command, wt)) return true;
  }
  return false;
}

/**
 * Classify every row. Order of evidence, strongest first:
 *  1. A spawn marker: another live instance → foreign; an instance CONFIRMED dead
 *     (liveness record present, pid gone) → orphan; this instance AND a matching
 *     manager handle → owned. A marker alone never yields owned/orphan: a
 *     self-stamped row with no handle, or an id that is neither live nor
 *     confirmed dead (record missing/unreadable), is only suspected.
 *  2. No marker, but this app's own manager holds the handle → owned.
 *  3. No marker, cyboflow-shaped (see {@link selfLooksCyboflow}, or an ancestor is
 *     cyboflow's) → suspected.
 *  4. Anything else → foreign.
 */
export function classify(
  rows: readonly MarkedProcess[],
  liveInstances: LiveInstanceSet,
  worktreeTruth: WorktreeTruth,
): ClassifiedProcess[] {
  const byPid = new Map<number, MarkedProcess>();
  for (const r of rows) byPid.set(r.pid, r);

  const isLiveOther = (id: string): boolean =>
    id !== liveInstances.selfInstanceId && liveInstances.liveInstanceIds.has(id);

  /** An ancestor is cyboflow's when it is tagged (and not another live instance's) or looks cyboflow-shaped. */
  const ancestorIsCyboflow = (p: ProcessSnapshotRow): boolean => {
    const seen = new Set<number>([p.pid]);
    let cur = byPid.get(p.ppid);
    for (let depth = 0; cur && depth < MAX_ANCESTRY_DEPTH && !seen.has(cur.pid); depth++) {
      if (cur.marker) {
        if (!isLiveOther(cur.marker.instanceId)) return true;
      } else if (selfLooksCyboflow(cur, worktreeTruth)) {
        return true;
      }
      seen.add(cur.pid);
      cur = byPid.get(cur.ppid);
    }
    return false;
  };

  const foreign = (p: MarkedProcess, foreignInstanceId: string | null): ForeignProcess => ({
    ...common(p),
    bucket: 'foreign',
    readOnly: true,
    pidLabel: String(p.pid),
    display: {
      cpu: p.pcpu === null ? null : String(p.pcpu),
      mem: p.pmem === null ? null : String(p.pmem),
      elapsed: p.etimeSeconds === null ? null : String(p.etimeSeconds),
    },
    foreignInstanceId,
  });

  return rows.map((p): ClassifiedProcess => {
    const marker = p.marker ?? null;
    if (marker) {
      const id = marker.instanceId;
      if (id === liveInstances.selfInstanceId) {
        // The marker names this live instance; ownership also needs the manager's handle.
        if (p.owner !== null) {
          return { ...base(p), bucket: 'owned', process: p, owner: p.owner, instanceId: id };
        }
        return { ...base(p), bucket: 'suspected', process: p };
      }
      if (liveInstances.liveInstanceIds.has(id)) return foreign(p, id);
      if (liveInstances.deadInstanceIds.has(id)) {
        return { ...base(p), bucket: 'orphan', sweepEligible: true, process: p, instanceId: id };
      }
      // Unknown instance: absence of a record is not proof the owner is dead.
      return { ...base(p), bucket: 'suspected', process: p };
    }
    if (p.owner !== null) {
      return {
        ...base(p),
        bucket: 'owned',
        process: p,
        owner: p.owner,
        instanceId: liveInstances.selfInstanceId,
      };
    }
    if (selfLooksCyboflow(p, worktreeTruth) || ancestorIsCyboflow(p)) {
      return { ...base(p), bucket: 'suspected', process: p };
    }
    return foreign(p, null);
  });
}
