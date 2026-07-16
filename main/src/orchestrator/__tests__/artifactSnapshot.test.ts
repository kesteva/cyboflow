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
import { mkdtemp, rm, readFile, mkdir, writeFile, symlink, stat } from 'fs/promises';
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
import { DEFAULT_ARTIFACT_COMMIT_DIR, PROTOTYPE_HTML_RELPATH } from '../../../../shared/types/artifacts';
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
  it('collapses path separators and dots so a runId cannot traverse', () => {
    expect(safeRunId('../../etc')).toBe('______etc');
    expect(safeRunId('run/../x')).toBe('run____x');
    expect(safeRunId('run_ok-1')).toBe('run_ok-1');
    expect(safeRunId('run/../x')).not.toContain('..');
  });
  it('snapshotDirFor / manifestPathFor compose S/<safeRunId>/<atype>/{…}', () => {
    expect(snapshotDirFor('/S', 'run-1', 'ui-prototype')).toBe(path.join('/S', 'run-1', 'ui-prototype'));
    expect(manifestPathFor('/S', 'run-1', 'ui-prototype')).toBe(
      path.join('/S', 'run-1', 'ui-prototype', 'manifest.json'),
    );
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

  it('writes the manifest (files empty) when runArtifactsRoot is null', async () => {
    const manifestPath = await snapshotCommittedArtifact(store, null, makeRow());
    expect(manifestPath).not.toBeNull();
    const m = JSON.parse(await readFile(manifestPath as string, 'utf-8')) as ArtifactSnapshotManifest;
    expect(m.files).toEqual([]);
  });

  it('omits a symlinked pointer source (fail-soft, no copy)', async () => {
    // Point prototype/index.html at a file OUTSIDE the run root via a symlink.
    const outside = path.join(runRoot, '..', 'secret.html');
    await writeFile(outside, 'SECRET', 'utf-8');
    await mkdir(path.join(runRoot, 'prototype'), { recursive: true });
    await symlink(outside, path.join(runRoot, 'prototype', 'index.html'));
    try {
      const manifestPath = await snapshotCommittedArtifact(store, runRoot, makeRow());
      const m = JSON.parse(await readFile(manifestPath as string, 'utf-8')) as ArtifactSnapshotManifest;
      expect(m.files).toEqual([]); // symlink rejected
    } finally {
      await rm(outside, { force: true });
    }
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
});
