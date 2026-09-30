import { describe, it, expect } from 'vitest';
import type { ReapManifest } from '../../orchestrator/reapTypes';
import { ReapManifestStash, REAP_MANIFEST_TTL_MS } from './reapManifestStash';

const manifest = (id: string): ReapManifest => ({
  id,
  kind: 'reap-all-stale',
  snapshotGeneratedAt: 1,
  builtAt: 1,
  targets: [],
  reclaimableBytes: 0,
  unmeasuredTargetCount: 0,
  dirtyFileCount: 0,
  dirtyCountUnknownTargetCount: 0,
  aheadOfMainCount: 0,
  descendantPidCount: 0,
  alsoDeleteBranch: false,
});

describe('ReapManifestStash', () => {
  it('take is single-use', () => {
    const stash = new ReapManifestStash(() => 0);
    stash.put({ manifest: manifest('a'), projectId: 1, selection: { kind: 'reap-all-stale' }, fingerprint: [] });
    expect(stash.take('a').ok).toBe(true);
    expect(stash.take('a')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('an unknown id is not_found', () => {
    expect(new ReapManifestStash().take('nope')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('expires after the TTL and reports expired, consuming the entry', () => {
    let t = 1000;
    const stash = new ReapManifestStash(() => t);
    stash.put({ manifest: manifest('a'), projectId: 1, selection: { kind: 'reap-all-stale' }, fingerprint: [] });
    t += REAP_MANIFEST_TTL_MS - 1;
    expect(stash.has('a')).toBe(true);
    t += 1;
    expect(stash.take('a')).toEqual({ ok: false, reason: 'expired' });
    expect(stash.size).toBe(0);
  });

  it('put sweeps other expired entries lazily (no timer)', () => {
    let t = 0;
    const stash = new ReapManifestStash(() => t);
    stash.put({ manifest: manifest('old'), projectId: 1, selection: { kind: 'reap-all-stale' }, fingerprint: [] });
    t = REAP_MANIFEST_TTL_MS + 1;
    stash.put({ manifest: manifest('new'), projectId: 1, selection: { kind: 'reap-all-stale' }, fingerprint: [] });
    expect(stash.has('old')).toBe(false);
    expect(stash.has('new')).toBe(true);
  });

  it('refuses to replace an already-stashed id (no revival / expiry extension)', () => {
    const stash = new ReapManifestStash(() => 0);
    stash.put({ manifest: manifest('a'), projectId: 1, selection: { kind: 'reap-all-stale' }, fingerprint: [] });
    expect(() =>
      stash.put({ manifest: manifest('a'), projectId: 1, selection: { kind: 'reap-all-stale' }, fingerprint: [] }),
    ).toThrow(/already stashed/);
  });
});
