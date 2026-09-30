/**
 * Server-side stash of resolved reap manifests, keyed by `ReapManifest.id`.
 *
 * `monitorReap.resolve` puts a manifest here; `monitorReap.execute` takes it back
 * by id. The client only ever holds an id the server minted, so execution can run
 * nothing the server did not itself resolve. Entries are:
 *   - short-lived: gone after {@link REAP_MANIFEST_TTL_MS} (an expired id is
 *     rejected, never silently re-resolved);
 *   - single-use: `take` removes the entry, so a replay finds nothing.
 *
 * No timer: expired entries are dropped lazily on `put`/`take`, so an idle stash
 * costs nothing.
 */
import type { ReapManifest, ReapSelection } from '../../orchestrator/reapTypes';
import type { ReapIdentityFingerprint } from './reapManifest';

/** How long a resolved manifest stays executable. */
export const REAP_MANIFEST_TTL_MS = 60_000;

export interface StashedManifest {
  manifest: ReapManifest;
  projectId: number;
  /** The selection the manifest was resolved from — re-derived at execute to detect drift. */
  selection: ReapSelection;
  /** Identity fingerprint computed at resolve from the SAME snapshot the manifest was built from. */
  fingerprint: ReapIdentityFingerprint;
  expiresAt: number;
}

export type StashTakeResult =
  | { ok: true; entry: StashedManifest }
  | { ok: false; reason: 'not_found' | 'expired' };

export class ReapManifestStash {
  private readonly entries = new Map<string, StashedManifest>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = REAP_MANIFEST_TTL_MS,
  ) {}

  put(entry: Omit<StashedManifest, 'expiresAt'>): void {
    this.sweep();
    // Ids are minted unique per resolve; a collision would let a fresh put revive or
    // extend an older confirmation, so it is a bug, never a silent replace.
    if (this.entries.has(entry.manifest.id)) {
      throw new Error(`Reap manifest id already stashed: ${entry.manifest.id}`);
    }
    this.entries.set(entry.manifest.id, { ...entry, expiresAt: this.now() + this.ttlMs });
  }

  /** Remove-and-return: a second `take` of the same id always misses. */
  take(id: string): StashTakeResult {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, reason: 'not_found' };
    this.entries.delete(id);
    if (entry.expiresAt <= this.now()) return { ok: false, reason: 'expired' };
    return { ok: true, entry };
  }

  /** Non-consuming peek (tests / diagnostics). */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(id);
  }
}
