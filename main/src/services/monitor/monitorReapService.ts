/**
 * The concrete `MonitorReapProvider` behind the `monitorReap` router: resolves a
 * manifest and stashes it, then executes strictly against the stashed copy.
 *
 * execute() order is deliberate:
 *   1. an executor must be wired (else PRECONDITION — nothing is consumed);
 *   2. `take` the stash entry (unknown/expired/replayed ids die here, with zero
 *      side effects);
 *   3. re-derive the SAME selection against a fresh snapshot and compare its
 *      identity fingerprint with the one stashed at resolve (from the resolve-time
 *      snapshot) — if the target set or any target's identity drifted (a process
 *      died or its pid was reused, a worktree's branch/owner changed, a new orphan
 *      appeared, a bucket changed) the manifest is stale and nothing runs. The entry stays consumed: the user must re-confirm a new one;
 *   4. only then hand the manifest's exact target list to the executor, with the
 *      branch-delete choice the user confirmed at resolve time (`manifest
 *      .alsoDeleteBranch`) — execute cannot change it. Changing it means resolving,
 *      and confirming, a new manifest.
 *
 * Every resolve mints a fresh, unguessable single-use id (never the builder's content
 * hash), so re-resolving identical content can neither revive an expired/consumed id
 * nor extend its expiry.
 */
import { randomUUID } from 'node:crypto';
import {
  reapTargetKey,
  type ReapExecutionResult,
  ReapExecutor,
  ReapManifest,
  ReapSelection,
} from '../../orchestrator/reapTypes';
import {
  ReapManifestError,
  buildReapManifest,
  reapFingerprintsMatch,
  reapIdentityFingerprint,
  type ReapIdentityFingerprint,
  type ReapManifestDeps,
  type ReapSnapshot,
} from './reapManifest';
import { ReapManifestStash } from './reapManifestStash';

function buildForSelection(
  selection: ReapSelection,
  snapshot: ReapSnapshot,
  deps: ReapManifestDeps,
  options: { alsoDeleteBranch?: boolean },
): Promise<ReapManifest> {
  switch (selection.kind) {
    case 'row':
      return buildReapManifest('row', selection, snapshot, deps, options);
    case 'card':
      return buildReapManifest('card', selection, snapshot, deps, options);
    case 'kill-all-of-type':
      return buildReapManifest('kill-all-of-type', selection, snapshot, deps, options);
    case 'reap-all-stale':
      return buildReapManifest('reap-all-stale', {}, snapshot, deps, options);
  }
}

function fingerprintForSelection(selection: ReapSelection, snapshot: ReapSnapshot): ReapIdentityFingerprint {
  switch (selection.kind) {
    case 'row':
      return reapIdentityFingerprint('row', selection, snapshot);
    case 'card':
      return reapIdentityFingerprint('card', selection, snapshot);
    case 'kill-all-of-type':
      return reapIdentityFingerprint('kill-all-of-type', selection, snapshot);
    case 'reap-all-stale':
      return reapIdentityFingerprint('reap-all-stale', {}, snapshot);
  }
}

function mintManifestId(): string {
  return `reap_${randomUUID()}`;
}

export type MonitorReapExecuteOutcome =
  | { ok: true; manifest: ReapManifest; alsoDeleteBranch: boolean; results: ReapExecutionResult[] }
  | { ok: false; code: 'not_found' | 'expired' | 'stale' | 'unavailable'; message: string };

export type MonitorReapResolveOutcome =
  | { ok: true; manifest: ReapManifest }
  | { ok: false; code: 'not_found' | 'not_prunable'; message: string };

export interface MonitorReapServiceDeps {
  /** Aggregated snapshot for a project (one ps scan; ambient disk cache only). */
  loadSnapshot(projectId: number): Promise<ReapSnapshot>;
  manifestDeps: ReapManifestDeps;
  /** Execution primitives; absent until they are wired — execute then reports `unavailable`. */
  executor?: ReapExecutor;
  stash?: ReapManifestStash;
  /** Mints the per-resolve stash id; injectable for tests. */
  mintId?: () => string;
}

export class MonitorReapService {
  private readonly stash: ReapManifestStash;
  private executor: ReapExecutor | undefined;
  /** Target keys ({@link reapTargetKey}) of executions currently in flight. */
  private readonly inFlightTargets = new Set<string>();

  constructor(private readonly deps: MonitorReapServiceDeps) {
    this.stash = deps.stash ?? new ReapManifestStash();
    this.executor = deps.executor;
  }

  setExecutor(executor: ReapExecutor | undefined): void {
    this.executor = executor;
  }

  async resolve(
    projectId: number,
    selection: ReapSelection,
    options: { alsoDeleteBranch?: boolean } = {},
  ): Promise<MonitorReapResolveOutcome> {
    try {
      const snapshot = await this.deps.loadSnapshot(projectId);
      // Same snapshot for the manifest and its fingerprint: what execute later compares against.
      const fingerprint = fingerprintForSelection(selection, snapshot);
      const built = await buildForSelection(selection, snapshot, this.deps.manifestDeps, options);
      const manifest: ReapManifest = { ...built, id: (this.deps.mintId ?? mintManifestId)() };
      this.stash.put({ manifest, projectId, selection, fingerprint });
      return { ok: true, manifest };
    } catch (err) {
      if (err instanceof ReapManifestError) return { ok: false, code: err.code, message: err.message };
      throw err;
    }
  }

  async execute(manifestId: string): Promise<MonitorReapExecuteOutcome> {
    const executor = this.executor;
    if (!executor) {
      return { ok: false, code: 'unavailable', message: 'Reap execution is not available yet.' };
    }
    const taken = this.stash.take(manifestId);
    if (!taken.ok) {
      return {
        ok: false,
        code: taken.reason,
        message:
          taken.reason === 'expired'
            ? 'This manifest expired; resolve a new one and confirm again.'
            : 'Unknown manifest id; resolve a manifest first.',
      };
    }
    const { manifest, projectId, selection, fingerprint } = taken.entry;

    // Claim every target SYNCHRONOUSLY (before the first await): single-use ids stop
    // replay of one manifest, but two distinct manifests may overlap on a target and
    // would otherwise both pass the fresh-snapshot check below before either acts.
    const claimed = manifest.targets.map(reapTargetKey);
    if (claimed.some((key) => this.inFlightTargets.has(key))) {
      return {
        ok: false,
        code: 'stale',
        message: 'Another reap is already acting on one of these targets; wait for it to finish, then resolve a new manifest.',
      };
    }
    for (const key of claimed) this.inFlightTargets.add(key);
    try {
      return await this.executeClaimed(executor, manifest, projectId, selection, fingerprint);
    } finally {
      for (const key of claimed) this.inFlightTargets.delete(key);
    }
  }

  private async executeClaimed(
    executor: ReapExecutor,
    manifest: ReapManifest,
    projectId: number,
    selection: ReapSelection,
    fingerprint: ReapIdentityFingerprint,
  ): Promise<MonitorReapExecuteOutcome> {
    let current: ReapIdentityFingerprint;
    try {
      const snapshot = await this.deps.loadSnapshot(projectId);
      current = fingerprintForSelection(selection, snapshot);
    } catch (err) {
      // A selection that no longer resolves (target gone / now unprunable) is drift too.
      if (err instanceof ReapManifestError) {
        return { ok: false, code: 'stale', message: `Targets changed since the manifest was resolved: ${err.message}` };
      }
      throw err;
    }
    if (!reapFingerprintsMatch(fingerprint, current)) {
      return {
        ok: false,
        code: 'stale',
        message: 'The target set changed since the manifest was resolved; resolve a new one and confirm again.',
      };
    }

    // The branch-delete choice is the one captured (and confirmed) at resolve time.
    const alsoDeleteBranch = manifest.alsoDeleteBranch;
    const results = await executor.execute(manifest, { alsoDeleteBranch, projectId });
    return { ok: true, manifest, alsoDeleteBranch, results };
  }
}
