/**
 * Reap manifest — the server-side statement of exactly what a destructive System
 * view action will destroy, resolved BEFORE the user is asked to confirm.
 *
 * `buildReapManifest` turns a selection (a row, a card, "kill all of a type", or
 * "reap all stale") plus the aggregated `cyboflow.system` snapshot into a
 * {@link ReapManifest}: the itemized targets with facts (reclaimable bytes,
 * dirty/ahead-of-main annotations, descendant pid counts). The same manifest is
 * later stashed server-side and executed by id, so what the user confirmed is
 * exactly what runs. This module resolves only — it never kills or prunes.
 *
 * Safety is structural, not cosmetic:
 *   - `foreign` processes carry no pid on the snapshot (see systemTypes.ts), so
 *     no selector can name one; they are never a target.
 *   - `reap-all-stale` only ever considers `orphan` worktrees and `orphan`
 *     processes; `suspected`/`owned`/`foreign` are filtered out before any
 *     target is created.
 *   - `in_place` / `is_main_repo` worktrees (`prunable: false`) can never become a
 *     worktree target; an explicit selection of one throws.
 *   - dirty / ahead-of-main state ANNOTATES a target, it never excludes it.
 *
 * Cost rules (docs/design/process-worktree-monitor.md): reclaim bytes come from a
 * FRESH `du` of exactly the target paths (the disk service's serial queue, jumping
 * the TTL backlog), never the ambient cache; git state comes from the
 * `GitStatusManager` cache only (no new git spawns); descendant counts reuse the
 * platform process helpers. Every dependency is injected, so this is unit-testable
 * without Electron or IPC.
 *
 * The manifest is plain JSON (no undefined, Map, Set or class instances) so it can
 * cross the tRPC boundary and sit in a transient in-memory map keyed by `id`.
 */
import { createHash } from 'node:crypto';
import type { GitStatus } from '../../types/session';
import type {
  SystemProcessEntry,
  SystemProcessType,
  SystemSnapshot,
  SystemWorktreeEntry,
} from '../../orchestrator/systemTypes';
import { collectDescendantPidsAsync } from '../../utils/platformProcess';
import { worktreePathKey } from '../worktreeRegistry';
import type {
  ReapManifest,
  ReapManifestKind,
  ReapProcessTarget,
  ReapTarget,
  ReapWorktreeTarget,
} from '../../orchestrator/reapTypes';

export type {
  ReapManifest,
  ReapManifestKind,
  ReapProcessTarget,
  ReapTarget,
  ReapWorktreeTarget,
} from '../../orchestrator/reapTypes';

/** What each manifest kind selects. */
export interface ReapSelectors {
  /** Explicit rows: worktrees by path and/or processes by pid. */
  row: { worktreePaths?: readonly string[]; pids?: readonly number[] };
  /** A worktree card: the worktree itself plus every process running in it. */
  card: { worktreePath: string };
  /** Every killable (non-foreign) process of one type. */
  'kill-all-of-type': { processType: SystemProcessType };
  /** No selection: derived entirely from the snapshot's orphan buckets. */
  'reap-all-stale': Record<string, never>;
}

/** The slice of the aggregated snapshot a manifest is built from. */
export type ReapSnapshot = Pick<SystemSnapshot, 'generatedAt' | 'processes' | 'worktrees'>;

export type ReapManifestErrorCode = 'not_found' | 'not_prunable';

export class ReapManifestError extends Error {
  constructor(
    readonly code: ReapManifestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReapManifestError';
  }
}

/** Everything the builder reaches outside itself for. */
export interface ReapManifestDeps {
  /** A `du` of exactly this path that started after the call (DiskUsageService.measureFresh). */
  measureFresh(path: string): Promise<number | null>;
  /** GitStatusManager cache read (`peekCachedStatus`) — never spawns git. */
  peekGitStatus(sessionId: string): { status: GitStatus } | null;
  /** How many descendants a pid has. */
  countDescendants(pid: number): Promise<number>;
  now?: () => number;
}

export interface BuildReapManifestOptions {
  /** Only `true` opts in; anything else leaves the branch alone. */
  alsoDeleteBranch?: boolean;
}

/** Default descendant counter: the shared platform-aware walker, not a reimplementation. */
export async function countDescendantPids(pid: number): Promise<number> {
  return (await collectDescendantPidsAsync(pid)).length;
}

type KillableProcess = Exclude<SystemProcessEntry, { bucket: 'foreign' }>;

/** A foreign row carries no pid, so excluding it here is what makes it un-targetable. */
function isKillable(p: SystemProcessEntry): p is KillableProcess {
  return p.bucket !== 'foreign';
}

type PrunableWorktree = Extract<SystemWorktreeEntry, { prunable: true }>;

function isPrunable(w: SystemWorktreeEntry): w is PrunableWorktree {
  return w.prunable;
}

function ownerIds(p: KillableProcess): { sessionId: string | null; runId: string | null } {
  if (p.owner?.kind === 'cli') return { sessionId: p.owner.sessionId, runId: null };
  if (p.owner?.kind === 'run-shell') return { sessionId: null, runId: p.owner.runId };
  return { sessionId: null, runId: null };
}

function gitAnnotation(
  sessionId: string | null,
  deps: ReapManifestDeps,
): Pick<ReapWorktreeTarget, 'dirty' | 'dirtyFileCount' | 'aheadOfMain'> {
  const cached = sessionId === null ? null : deps.peekGitStatus(sessionId);
  if (!cached) return { dirty: null, dirtyFileCount: null, aheadOfMain: null };
  const s = cached.status;
  const tracked = s.filesChanged ?? 0;
  const dirty = s.hasUncommittedChanges === true || s.hasUntrackedFiles === true || tracked > 0;
  // `filesChanged` never counts untracked files, so with any present the true total is unknown.
  const dirtyFileCount = s.hasUntrackedFiles === true ? null : tracked;
  return { dirty, dirtyFileCount, aheadOfMain: s.ahead ?? 0 };
}

async function toProcessTarget(p: KillableProcess, deps: ReapManifestDeps): Promise<ReapProcessTarget> {
  const ids = ownerIds(p);
  return {
    kind: 'process',
    pid: p.pid,
    processType: p.processType,
    bucket: p.bucket,
    command: p.command,
    worktreePath: p.worktreePath,
    sessionId: ids.sessionId,
    runId: ids.runId,
    taggedAsCyboflow: p.bucket !== 'suspected',
    descendantPidCount: await deps.countDescendants(p.pid),
  };
}

/** Targets before enrichment: which worktrees and which processes are selected. */
function selectTargets<K extends ReapManifestKind>(
  kind: K,
  selector: ReapSelectors[K],
  snapshot: ReapSnapshot,
): { worktrees: PrunableWorktree[]; processes: KillableProcess[] } {
  const wtKey = worktreePathKey;
  const findWorktree = (path: string): PrunableWorktree => {
    const hit = snapshot.worktrees.find((w) => wtKey(w.path) === wtKey(path));
    if (!hit) throw new ReapManifestError('not_found', `No worktree at ${path} in the snapshot`);
    if (!isPrunable(hit)) {
      throw new ReapManifestError(
        'not_prunable',
        `${hit.path} is ${hit.tag === 'in_place' ? 'an in-place checkout' : 'the main repo'} and can never be pruned`,
      );
    }
    return hit;
  };

  switch (kind) {
    case 'row': {
      const sel = selector as ReapSelectors['row'];
      const worktrees = (sel.worktreePaths ?? []).map(findWorktree);
      const processes = (sel.pids ?? []).map((pid) => {
        const hit = snapshot.processes.filter(isKillable).find((p) => p.pid === pid);
        if (!hit) throw new ReapManifestError('not_found', `No killable process ${pid} in the snapshot`);
        return hit;
      });
      return { worktrees, processes };
    }
    case 'card': {
      const sel = selector as ReapSelectors['card'];
      const wt = findWorktree(sel.worktreePath);
      const processes = snapshot.processes
        .filter(isKillable)
        .filter((p) => p.worktreePath !== null && wtKey(p.worktreePath) === wtKey(wt.path));
      return { worktrees: [wt], processes };
    }
    case 'kill-all-of-type': {
      const sel = selector as ReapSelectors['kill-all-of-type'];
      const processes = snapshot.processes
        .filter(isKillable)
        .filter((p) => p.processType === sel.processType);
      return { worktrees: [], processes };
    }
    case 'reap-all-stale': {
      // Filtered BEFORE any target exists: only orphans are ever considered.
      const worktrees = snapshot.worktrees.filter(isPrunable).filter((w) => w.tag === 'orphan');
      const processes = snapshot.processes.filter(isKillable).filter((p) => p.bucket === 'orphan');
      return { worktrees, processes };
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown reap manifest kind: ${String(exhaustive)}`);
    }
  }
}

function manifestId(
  kind: ReapManifestKind,
  targets: readonly ReapTarget[],
  snapshotGeneratedAt: number,
  alsoDeleteBranch: boolean,
): string {
  // Hash the fully resolved targets (sizes, git annotations, pid counts included),
  // not just their identities: a stash keyed by id must never map one id to two
  // different confirmation payloads. Sorted for order-independence.
  const canonical = targets
    .map((t) => JSON.stringify(t, Object.keys(t).sort()))
    .sort();
  const hash = createHash('sha256')
    .update(JSON.stringify({ kind, canonical, snapshotGeneratedAt, alsoDeleteBranch }))
    .digest('hex');
  return `reap_${hash.slice(0, 24)}`;
}

/**
 * Resolve a manifest for one selection against an aggregated snapshot. Never
 * executes anything. Throws {@link ReapManifestError} for an explicit selection
 * that names a missing target (`not_found`) or a never-prunable worktree
 * (`not_prunable`); an empty derived selection (nothing stale) is a valid, empty
 * manifest.
 */
export async function buildReapManifest<K extends ReapManifestKind>(
  kind: K,
  selector: ReapSelectors[K],
  snapshot: ReapSnapshot,
  deps: ReapManifestDeps,
  options: BuildReapManifestOptions = {},
): Promise<ReapManifest> {
  const now = deps.now ?? Date.now;
  const { worktrees, processes } = selectTargets(kind, selector, snapshot);

  // One fresh du per DISTINCT target path; the disk service serializes them.
  const uniqueWorktrees = worktrees.filter(
    (w, i) => worktrees.findIndex((o) => worktreePathKey(o.path) === worktreePathKey(w.path)) === i,
  );
  const uniqueProcesses = processes.filter((p, i) => processes.findIndex((o) => o.pid === p.pid) === i);

  const [worktreeTargets, processTargets] = await Promise.all([
    Promise.all(
      uniqueWorktrees.map(async (w): Promise<ReapWorktreeTarget> => {
        const sessionId = w.sessionId ?? null;
        return {
          kind: 'worktree',
          path: w.path,
          branch: w.branch,
          tag: w.tag,
          sessionId,
          runId: w.runId ?? null,
          reclaimableBytes: await deps.measureFresh(w.path),
          ...gitAnnotation(sessionId, deps),
        };
      }),
    ),
    Promise.all(uniqueProcesses.map((p) => toProcessTarget(p, deps))),
  ]);

  const targets: ReapTarget[] = [...worktreeTargets, ...processTargets];
  const alsoDeleteBranch = options.alsoDeleteBranch === true;

  return {
    id: manifestId(kind, targets, snapshot.generatedAt, alsoDeleteBranch),
    kind,
    snapshotGeneratedAt: snapshot.generatedAt,
    builtAt: now(),
    targets,
    reclaimableBytes: worktreeTargets.reduce((sum, t) => sum + (t.reclaimableBytes ?? 0), 0),
    unmeasuredTargetCount: worktreeTargets.filter((t) => t.reclaimableBytes === null).length,
    dirtyFileCount: worktreeTargets.reduce((sum, t) => sum + (t.dirtyFileCount ?? 0), 0),
    dirtyCountUnknownTargetCount: worktreeTargets.filter((t) => t.dirtyFileCount === null).length,
    aheadOfMainCount: worktreeTargets.reduce((sum, t) => sum + (t.aheadOfMain ?? 0), 0),
    descendantPidCount: processTargets.reduce((sum, t) => sum + t.descendantPidCount, 0),
    alsoDeleteBranch,
  };
}

/** Two derived process start times within this many seconds are the same process (ps etime is whole seconds). */
export const REAP_START_TIME_TOLERANCE_SECONDS = 2;

/** One selected target's identity evidence. `key` must match exactly; `startTime` only within tolerance. */
export interface ReapIdentityEntry {
  /** Which target this is (`worktree:<normalized path>` / `process:<pid>`); the set of ids must match. */
  id: string;
  /** Exact-match identity evidence (branch, owner, ppid, command, bucket, ...). */
  key: string;
  /** Derived process start (epoch seconds); `null` for worktrees. A null start on a process never matches. */
  startTime: number | null;
  isProcess: boolean;
}

/** What a selection would target, as identity evidence. Compare with {@link reapFingerprintsMatch}. */
export type ReapIdentityFingerprint = ReapIdentityEntry[];

/** Structured (never delimiter-joined) so owner ids containing `:` cannot collide once JSON-encoded. */
function ownerKey(p: KillableProcess): string[] | null {
  const o = p.owner;
  if (!o) return null;
  return o.kind === 'cli' ? ['cli', o.panelId, o.sessionId] : ['run-shell', o.runId, o.terminalId];
}

/**
 * The ONE stale-target fingerprint. Built from the selected snapshot entries
 * (`selectTargets`), never from manifest targets, so resolve and execute derive it
 * the same way from a snapshot. `monitorReap.resolve` stashes it next to the
 * manifest; `execute` recomputes it against a fresh snapshot and refuses on any
 * difference. No `du`, git or descendant work.
 *
 * Worktree identity: normalized path, tag, branch, session and run owner. Process
 * identity: pid, ppid, bucket, type, command, worktree, owner, dead-instance id
 * (orphans) and a derived start time — the pid-reuse discriminator.
 */
export function reapIdentityFingerprint<K extends ReapManifestKind>(
  kind: K,
  selector: ReapSelectors[K],
  snapshot: ReapSnapshot,
): ReapIdentityFingerprint {
  const { worktrees, processes } = selectTargets(kind, selector, snapshot);
  const entries: ReapIdentityEntry[] = [
    ...worktrees.map((w): ReapIdentityEntry => ({
      id: `worktree:${worktreePathKey(w.path)}`,
      key: JSON.stringify([worktreePathKey(w.path), w.tag, w.branch, w.sessionId ?? null, w.runId ?? null]),
      startTime: null,
      isProcess: false,
    })),
    ...processes.map((p): ReapIdentityEntry => ({
      id: `process:${p.pid}`,
      key: JSON.stringify([
        p.pid,
        p.ppid,
        p.bucket,
        p.processType,
        p.command,
        p.worktreePath === null ? null : worktreePathKey(p.worktreePath),
        ownerKey(p),
        p.bucket === 'orphan' ? p.instanceId : null,
      ]),
      startTime: p.etimeSeconds === null ? null : Math.round(snapshot.generatedAt / 1000 - p.etimeSeconds),
      isProcess: true,
    })),
  ];
  return entries
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .filter((e, i, all) => i === 0 || all[i - 1].id !== e.id);
}

/** True only when both fingerprints select the same targets with the same identity evidence. */
export function reapFingerprintsMatch(a: ReapIdentityFingerprint, b: ReapIdentityFingerprint): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    if (x.id !== y.id || x.key !== y.key) return false;
    if (!x.isProcess) return true;
    if (x.startTime === null || y.startTime === null) return false;
    return Math.abs(x.startTime - y.startTime) <= REAP_START_TIME_TOLERANCE_SECONDS;
  });
}
