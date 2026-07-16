/**
 * Unit tests for artifactSnapshot — the on-disk durability snapshot for
 * COMMITTED artifacts (schema v2, IDEA-039 artifact lifecycle).
 *
 * Covered:
 *  - resolveArtifactCommitDir join/absolute/floor behaviour (unchanged).
 *  - safeRunId collapses path separators / dots so a runId can't traverse.
 *  - snapshotDirFor / manifestPathFor compose S/<safeRunId>/<atype>/{…}.
 *  - buildSnapshotManifest captures the v2 shape (schemaVersion:2, sessionId,
 *    stepOrigin, files, isNew:false, createdAt) and parses the payload.
 *  - snapshotCommittedArtifact copies atype-driven bytes (ui-prototype pointer,
 *    screenshots fileNames), writes manifest.files = actually-copied, and skips
 *    a url-only generic (no bytes).
 *  - a traversal/symlink/oversized source is omitted from files (fail-soft).
 *  - a re-commit rm -rf's the (runId,atype) dir and rewrites it (bytes replaced).
 *  - listCommittedSnapshots / loadCommittedSnapshot round-trip the manifest.
 *  - snapshotManifestToArtifact shapes committed:true / sessionOnly:false / isNew:false.
 *  - loadCommittedHtml reads files/prototype/index.html back (size-capped).
 *  - FAIL-SOFT: an unwritable store resolves to null, never throws.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile, symlink } from 'fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  snapshotCommittedArtifact,
  snapshotDirFor,
  manifestPathFor,
  resolveArtifactCommitDir,
  buildSnapshotManifest,
  listCommittedSnapshots,
  loadCommittedSnapshot,
  snapshotManifestToArtifact,
  loadCommittedHtml,
  safeRunId,
  ARTIFACT_SNAPSHOT_SCHEMA_VERSION,
  type ArtifactSnapshotManifest,
} from '../artifactSnapshot';
import { DEFAULT_ARTIFACT_COMMIT_DIR, PROTOTYPE_HTML_RELPATH, MAX_PROTOTYPE_HTML_BYTES } from '../../../../shared/types/artifacts';
import type { ArtifactDbRow } from '../artifactRouter';

function makeRow(over: Partial<ArtifactDbRow> = {}): ArtifactDbRow {
  return {
    id: 'art_abc123',
    run_id: 'run-1',
    session_id: 'sess-1',
    atype: 'ui-prototype',
    label: 'proto',
    step_origin: 'Plan · prototype',
    mode: 'canvas',
    committed: 1,
    session_only: 0,
    is_new: 0,
    payload_json: JSON.stringify({ fileName: PROTOTYPE_HTML_RELPATH }),
    source_ref: null,
    created_at: '2026-06-19T00:00:00.000Z',
    committed_at: '2026-06-19T00:00:01.000Z',
    ...over,
  };
}

/** Build a run artifacts dir with a static prototype document. */
async function seedPrototype(runRoot: string, html = '<!doctype html><html><head></head><body>hi</body></html>'): Promise<void> {
  const dir = path.join(runRoot, 'prototype');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.html'), html, 'utf-8');
}

let store = '';
let runRoot = '';

beforeEach(async () => {
  store = await mkdtemp(path.join(tmpdir(), 'artifact-store-'));
  runRoot = await mkdtemp(path.join(tmpdir(), 'artifact-run-'));
});

afterEach(async () => {
  await rm(store, { recursive: true, force: true });
  await rm(runRoot, { recursive: true, force: true });
});

describe('resolveArtifactCommitDir', () => {
  it('joins a RELATIVE configured dir under the project root', () => {
    expect(resolveArtifactCommitDir('/proj', '.cyboflow/artifacts')).toBe(
      path.join('/proj', '.cyboflow/artifacts'),
    );
  });
  it('uses an ABSOLUTE configured dir verbatim', () => {
    expect(resolveArtifactCommitDir('/proj', '/var/artifacts')).toBe('/var/artifacts');
  });
  it('floors a blank configured dir to DEFAULT_ARTIFACT_COMMIT_DIR under the root', () => {
    expect(resolveArtifactCommitDir('/proj', '   ')).toBe(path.join('/proj', DEFAULT_ARTIFACT_COMMIT_DIR));
  });
});

describe('safeRunId + dir helpers', () => {
  it('neutralizes traversal and is COLLISION-SAFE (distinct raw ids → distinct segments)', () => {
    // A path-safe id (the common case: UUID hex) is returned verbatim.
    expect(safeRunId('run_ok-1')).toBe('run_ok-1');
    expect(safeRunId('abc123def456')).toBe('abc123def456');
    // A non-conforming id is sanitized AND suffixed with a hash of the raw value,
    // so it can neither traverse nor collide with another lossy input.
    for (const bad of ['../../etc', 'run/../x', 'run.a', 'run/a']) {
      const s = safeRunId(bad);
      expect(s).not.toContain('..');
      expect(s).not.toContain('/');
      expect(s).not.toContain('\\');
    }
    // The lossy pair `run.a` / `run/a` (both sanitize to `run_a`) map to DISTINCT
    // segments — the collision the flat sanitizer would have caused.
    expect(safeRunId('run.a')).not.toBe(safeRunId('run/a'));
  });
  it('snapshotDirFor / manifestPathFor compose S/<safeRunId>/<atype>/{…}', () => {
    expect(snapshotDirFor('/S', 'run-1', 'ui-prototype')).toBe(path.join('/S', 'run-1', 'ui-prototype'));
    expect(manifestPathFor('/S', 'run-1', 'ui-prototype')).toBe(
      path.join('/S', 'run-1', 'ui-prototype', 'manifest.json'),
    );
  });
  it('snapshotDirFor keys a PER-ENTITY atype by sourceRef (no cross-idea-spec collision)', () => {
    const a = snapshotDirFor('/S', 'run-1', 'idea-spec', 'idea:7');
    const b = snapshotDirFor('/S', 'run-1', 'idea-spec', 'idea:8');
    // Distinct sourceRefs → distinct dirs, both nested under the atype segment.
    expect(a).not.toBe(b);
    expect(a.startsWith(path.join('/S', 'run-1', 'idea-spec') + path.sep)).toBe(true);
    expect(b.startsWith(path.join('/S', 'run-1', 'idea-spec') + path.sep)).toBe(true);
    // A conforming sourceRef is used verbatim as the sub-segment.
    expect(snapshotDirFor('/S', 'run-1', 'idea-spec', 'IDEA-7')).toBe(
      path.join('/S', 'run-1', 'idea-spec', 'IDEA-7'),
    );
    // A non-per-entity atype ignores sourceRef (one-per-(run, atype)).
    expect(snapshotDirFor('/S', 'run-1', 'ui-prototype', 'x')).toBe(path.join('/S', 'run-1', 'ui-prototype'));
  });
});

describe('buildSnapshotManifest (v2)', () => {
  it('captures the v2 shape and parses the payload', () => {
    const m = buildSnapshotManifest(makeRow({ source_ref: 'idea:7' }), ['prototype/index.html']);
    expect(m).toMatchObject<Partial<ArtifactSnapshotManifest>>({
      schemaVersion: ARTIFACT_SNAPSHOT_SCHEMA_VERSION,
      id: 'art_abc123',
      runId: 'run-1',
      sessionId: 'sess-1',
      atype: 'ui-prototype',
      label: 'proto',
      mode: 'canvas',
      stepOrigin: 'Plan · prototype',
      sourceRef: 'idea:7',
      files: ['prototype/index.html'],
      isNew: false,
      createdAt: '2026-06-19T00:00:00.000Z',
      committedAt: '2026-06-19T00:00:01.000Z',
    });
    expect(m.schemaVersion).toBe(2);
    expect(m.payloadJson).toEqual({ fileName: PROTOTYPE_HTML_RELPATH });
  });

  it('defaults files to [] and maps a NULL payload (templated) to null', () => {
    const m = buildSnapshotManifest(makeRow({ atype: 'idea-spec', mode: 'template', payload_json: null }));
    expect(m.files).toEqual([]);
    expect(m.payloadJson).toBeNull();
  });
});

describe('snapshotCommittedArtifact — byte copy + layout', () => {
  it('copies the ui-prototype pointer into files/ and records it in manifest.files', async () => {
    await seedPrototype(runRoot);
    const manifestPath = await snapshotCommittedArtifact(store, runRoot, makeRow());
    expect(manifestPath).toBe(manifestPathFor(store, 'run-1', 'ui-prototype'));

    const m = JSON.parse(await readFile(manifestPath as string, 'utf-8')) as ArtifactSnapshotManifest;
    expect(m.schemaVersion).toBe(2);
    expect(m.files).toEqual(['prototype/index.html']);
    const copied = path.join(snapshotDirFor(store, 'run-1', 'ui-prototype'), 'files', 'prototype', 'index.html');
    expect(existsSync(copied)).toBe(true);
    expect(await readFile(copied, 'utf-8')).toContain('<body>hi</body>');
  });

  it('copies screenshots fileNames (basename) into files/', async () => {
    await writeFile(path.join(runRoot, 'home.png'), 'PNGDATA', 'utf-8');
    await writeFile(path.join(runRoot, 'detail.png'), 'PNGDATA2', 'utf-8');
    const row = makeRow({
      atype: 'screenshots',
      mode: 'template',
      payload_json: JSON.stringify({ fileNames: ['home.png', 'nested/detail.png'] }),
    });
    const manifestPath = await snapshotCommittedArtifact(store, runRoot, row);
    const m = JSON.parse(await readFile(manifestPath as string, 'utf-8')) as ArtifactSnapshotManifest;
    // 'nested/detail.png' basename resolves to detail.png at the run root.
    expect(m.files.sort()).toEqual(['detail.png', 'home.png']);
    const filesDir = path.join(snapshotDirFor(store, 'run-1', 'screenshots'), 'files');
    expect(existsSync(path.join(filesDir, 'home.png'))).toBe(true);
    expect(existsSync(path.join(filesDir, 'detail.png'))).toBe(true);
  });

  it('copies NO bytes for a url-only generic artifact (manifest.files empty)', async () => {
    const row = makeRow({ atype: 'generic', payload_json: JSON.stringify({ url: 'http://localhost:8081' }) });
    const manifestPath = await snapshotCommittedArtifact(store, runRoot, row);
    const m = JSON.parse(await readFile(manifestPath as string, 'utf-8')) as ArtifactSnapshotManifest;
    expect(m.files).toEqual([]);
  });

  it('writes the manifest (files empty) for a BYTE-FREE atype when runArtifactsRoot is null', async () => {
    // A templated idea-spec requires no bytes, so a null root still snapshots.
    const row = makeRow({ atype: 'idea-spec', mode: 'template', payload_json: null, source_ref: 'idea:9' });
    const manifestPath = await snapshotCommittedArtifact(store, null, row);
    expect(manifestPath).not.toBeNull();
    const m = JSON.parse(await readFile(manifestPath as string, 'utf-8')) as ArtifactSnapshotManifest;
    expect(m.files).toEqual([]);
  });

  it('ABANDONS the snapshot (null) for a BYTE-BEARING atype when runArtifactsRoot is null', async () => {
    // A ui-prototype requires its canonical HTML doc regardless of root; a null
    // root means it cannot be copied → the gate must NOT finalize an empty
    // snapshot the caller would treat as durable (data-loss guard, root-independent).
    const manifestPath = await snapshotCommittedArtifact(store, null, makeRow());
    expect(manifestPath).toBeNull();
  });

  it('ABANDONS the snapshot (null) when the wanted pointer is a rejected symlink', async () => {
    // Point prototype/index.html at a file OUTSIDE the run root via a symlink.
    // copyGuardedByte refuses to follow it, so the required byte never copies —
    // the durability gate must return null (no safe content) so the caller keeps
    // committed=1 rather than deleting a row whose bytes were never captured.
    const outside = path.join(runRoot, '..', 'secret.html');
    await writeFile(outside, 'SECRET', 'utf-8');
    await mkdir(path.join(runRoot, 'prototype'), { recursive: true });
    await symlink(outside, path.join(runRoot, 'prototype', 'index.html'));
    try {
      const manifestPath = await snapshotCommittedArtifact(store, runRoot, makeRow());
      expect(manifestPath).toBeNull();
    } finally {
      await rm(outside, { force: true });
    }
  });

  it('ABANDONS the snapshot (null) when a wanted pointer source is absent (data-loss guard)', async () => {
    // ui-prototype declares prototype/index.html but nothing was seeded on disk.
    // The gate must NOT finalize a bytes-less snapshot + let the caller delete the
    // still-live DB row (regression: manifest was written with files:[] regardless).
    const manifestPath = await snapshotCommittedArtifact(store, runRoot, makeRow());
    expect(manifestPath).toBeNull();
    // Nothing was swapped into place.
    expect(existsSync(manifestPathFor(store, 'run-1', 'ui-prototype'))).toBe(false);
  });

  it('re-commit rm -rf\'s the (runId,atype) dir and rewrites the bytes', async () => {
    await seedPrototype(runRoot, '<html><head></head><body>v1</body></html>');
    await snapshotCommittedArtifact(store, runRoot, makeRow());
    // Second commit with fresh bytes + a stray file that must NOT survive the replace.
    const stray = path.join(snapshotDirFor(store, 'run-1', 'ui-prototype'), 'files', 'stale.txt');
    await writeFile(stray, 'stale', 'utf-8');
    await seedPrototype(runRoot, '<html><head></head><body>v2</body></html>');
    await snapshotCommittedArtifact(store, runRoot, makeRow({ label: 'proto v2' }));

    const m = JSON.parse(
      await readFile(manifestPathFor(store, 'run-1', 'ui-prototype'), 'utf-8'),
    ) as ArtifactSnapshotManifest;
    expect(m.label).toBe('proto v2');
    const copied = path.join(snapshotDirFor(store, 'run-1', 'ui-prototype'), 'files', 'prototype', 'index.html');
    expect(await readFile(copied, 'utf-8')).toContain('v2');
    expect(existsSync(stray)).toBe(false); // the whole dir was replaced
  });

  it('is FAIL-SOFT: an unwritable store (path under a FILE) resolves to null, never throws', async () => {
    const notADir = path.join(store, 'a-file');
    await writeFile(notADir, 'x', 'utf-8');
    let result: string | null = 'sentinel';
    await expect(
      (async () => {
        result = await snapshotCommittedArtifact(notADir, runRoot, makeRow(), {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        });
      })(),
    ).resolves.toBeUndefined();
    expect(result).toBeNull();
  });
});

describe('read-back — listCommittedSnapshots / loadCommittedSnapshot / loadCommittedHtml', () => {
  it('round-trips a snapshot by runId and across the whole store', async () => {
    await seedPrototype(runRoot);
    await snapshotCommittedArtifact(store, runRoot, makeRow());
    await snapshotCommittedArtifact(store, runRoot, makeRow({ id: 'art_shots', run_id: 'run-2', atype: 'screenshots', payload_json: '{}' }));

    const forRun1 = await listCommittedSnapshots(store, 'run-1');
    expect(forRun1.map((m) => m.atype)).toEqual(['ui-prototype']);

    const all = await listCommittedSnapshots(store);
    expect(all.map((m) => m.runId).sort()).toEqual(['run-1', 'run-2']);

    const one = await loadCommittedSnapshot(store, 'run-1', 'ui-prototype');
    expect(one?.id).toBe('art_abc123');
    expect(await loadCommittedSnapshot(store, 'run-1', 'screenshots')).toBeNull();
  });

  it('returns [] for a missing store (fail-soft)', async () => {
    expect(await listCommittedSnapshots(path.join(store, 'nope'))).toEqual([]);
  });

  it('snapshotManifestToArtifact shapes committed:true / sessionOnly:false / isNew:false', async () => {
    await seedPrototype(runRoot);
    await snapshotCommittedArtifact(store, runRoot, makeRow());
    const m = await loadCommittedSnapshot(store, 'run-1', 'ui-prototype');
    const a = snapshotManifestToArtifact(m as ArtifactSnapshotManifest);
    expect(a).toMatchObject({
      id: 'art_abc123',
      runId: 'run-1',
      sessionId: 'sess-1',
      atype: 'ui-prototype',
      committed: true,
      sessionOnly: false,
      isNew: false,
    });
    // payloadJson is re-stringified back to a JSON string.
    expect(JSON.parse(a.payloadJson as string)).toEqual({ fileName: PROTOTYPE_HTML_RELPATH });
  });

  it('loadCommittedHtml reads files/prototype/index.html back', async () => {
    await seedPrototype(runRoot, '<html><head></head><body>loaded</body></html>');
    await snapshotCommittedArtifact(store, runRoot, makeRow());
    const html = await loadCommittedHtml(store, 'run-1', 'ui-prototype');
    expect(html).toContain('<body>loaded</body>');
    // Absent snapshot → null.
    expect(await loadCommittedHtml(store, 'run-999', 'ui-prototype')).toBeNull();
  });

  it('PER-ENTITY: two committed idea-specs in one run COEXIST (no cross-overwrite)', async () => {
    const a = makeRow({ id: 'art_a', atype: 'idea-spec', mode: 'template', payload_json: null, source_ref: 'idea:7', label: 'spec A' });
    const b = makeRow({ id: 'art_b', atype: 'idea-spec', mode: 'template', payload_json: null, source_ref: 'idea:8', label: 'spec B' });
    expect(await snapshotCommittedArtifact(store, runRoot, a)).not.toBeNull();
    expect(await snapshotCommittedArtifact(store, runRoot, b)).not.toBeNull();
    // Both survive — B's snapshot did NOT rm A's (the old (runId,atype)-only key
    // collided; the new key includes sourceRef).
    const list = await listCommittedSnapshots(store, 'run-1');
    const specs = list.filter((m) => m.atype === 'idea-spec').map((m) => m.label).sort();
    expect(specs).toEqual(['spec A', 'spec B']);
    // Point-lookup resolves each by its sourceRef.
    expect((await loadCommittedSnapshot(store, 'run-1', 'idea-spec', 'idea:7'))?.id).toBe('art_a');
    expect((await loadCommittedSnapshot(store, 'run-1', 'idea-spec', 'idea:8'))?.id).toBe('art_b');
  });

  it('SCREENSHOTS use the larger cap: a >HTML-cap PNG still copies', async () => {
    // A capture larger than MAX_PROTOTYPE_HTML_BYTES but under MAX_SCREENSHOT_BYTES
    // must be snapshotted — using the HTML cap silently dropped valid screenshots.
    const big = Buffer.alloc(MAX_PROTOTYPE_HTML_BYTES + 1024, 0x41);
    await writeFile(path.join(runRoot, 'wide.png'), big);
    const row = makeRow({ atype: 'screenshots', mode: 'template', payload_json: JSON.stringify({ fileNames: ['wide.png'] }) });
    const manifestPath = await snapshotCommittedArtifact(store, runRoot, row);
    expect(manifestPath).not.toBeNull();
    const m = JSON.parse(await readFile(manifestPath as string, 'utf-8')) as ArtifactSnapshotManifest;
    expect(m.files).toEqual(['wide.png']);
  });
});
