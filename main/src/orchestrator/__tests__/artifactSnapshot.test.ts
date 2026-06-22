/**
 * Unit tests for artifactSnapshot — the on-disk durability manifest for COMMITTED
 * artifacts (FEATURE #3).
 *
 * Covered:
 *  - resolveArtifactCommitDir joins a RELATIVE dir under the project root, uses an
 *    ABSOLUTE dir verbatim, and floors a blank dir to DEFAULT_ARTIFACT_COMMIT_DIR.
 *  - snapshotPathFor composes <commitDir>/<atype>__<id>.json (the passed dir is
 *    the FINAL destination — no .cyboflow/artifacts suffix is appended).
 *  - buildSnapshotManifest captures the row + schemaVersion:1 and PARSES a JSON
 *    payload (canvas url / screenshots fileNames) into an object/array.
 *  - a non-JSON payload falls back to the raw string; a NULL payload -> null
 *    (the templated-artifact case: row + sourceRef pointer, no rendered markdown).
 *  - snapshotCommittedArtifact writes the manifest (mkdir -p) into the commit dir;
 *    returns the absolute path.
 *  - FAIL-SOFT: an unwritable target (commit dir under a FILE, not a dir) does
 *    NOT throw — it resolves to null.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  snapshotCommittedArtifact,
  snapshotPathFor,
  resolveArtifactCommitDir,
  buildSnapshotManifest,
  ARTIFACT_SNAPSHOT_SCHEMA_VERSION,
  type ArtifactSnapshotManifest,
} from '../artifactSnapshot';
import { DEFAULT_ARTIFACT_COMMIT_DIR } from '../../../../shared/types/artifacts';
import type { ArtifactDbRow } from '../artifactRouter';

function makeRow(over: Partial<ArtifactDbRow> = {}): ArtifactDbRow {
  return {
    id: 'art_abc123',
    run_id: 'run-1',
    session_id: null,
    atype: 'ui-prototype',
    label: 'proto',
    step_origin: null,
    mode: 'canvas',
    committed: 1,
    session_only: 0,
    is_new: 0,
    payload_json: '{"url":"http://localhost:8081"}',
    source_ref: null,
    created_at: '2026-06-19T00:00:00.000Z',
    committed_at: '2026-06-19T00:00:01.000Z',
    ...over,
  };
}

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'artifact-snapshot-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('resolveArtifactCommitDir', () => {
  it('joins a RELATIVE configured dir under the project root', () => {
    expect(resolveArtifactCommitDir('/proj', '.cyboflow/artifacts')).toBe(
      path.join('/proj', '.cyboflow/artifacts'),
    );
    expect(resolveArtifactCommitDir('/proj', 'docs/deliverables')).toBe(
      path.join('/proj', 'docs/deliverables'),
    );
  });

  it('uses an ABSOLUTE configured dir verbatim (ignores the project root)', () => {
    expect(resolveArtifactCommitDir('/proj', '/var/artifacts')).toBe('/var/artifacts');
  });

  it('floors a blank/whitespace configured dir to DEFAULT_ARTIFACT_COMMIT_DIR under the root', () => {
    expect(resolveArtifactCommitDir('/proj', '')).toBe(path.join('/proj', DEFAULT_ARTIFACT_COMMIT_DIR));
    expect(resolveArtifactCommitDir('/proj', '   ')).toBe(path.join('/proj', DEFAULT_ARTIFACT_COMMIT_DIR));
  });
});

describe('snapshotPathFor', () => {
  it('composes <commitDir>/<atype>__<id>.json (the dir is the final destination)', () => {
    const p = snapshotPathFor('/wt/.cyboflow/artifacts', makeRow({ id: 'art_x', atype: 'screenshots' }));
    expect(p).toBe(path.join('/wt/.cyboflow/artifacts', 'screenshots__art_x.json'));
  });
});

describe('buildSnapshotManifest', () => {
  it('captures the row + schemaVersion and parses a JSON payload into an object', () => {
    const m = buildSnapshotManifest(makeRow({ source_ref: 'idea:7' }));
    expect(m).toMatchObject<Partial<ArtifactSnapshotManifest>>({
      schemaVersion: ARTIFACT_SNAPSHOT_SCHEMA_VERSION,
      id: 'art_abc123',
      runId: 'run-1',
      atype: 'ui-prototype',
      label: 'proto',
      mode: 'canvas',
      sourceRef: 'idea:7',
      committedAt: '2026-06-19T00:00:01.000Z',
    });
    expect(m.payloadJson).toEqual({ url: 'http://localhost:8081' });
  });

  it('parses a screenshots fileNames array payload', () => {
    const m = buildSnapshotManifest(
      makeRow({ atype: 'screenshots', payload_json: '{"fileNames":["a.png","b.png"]}' }),
    );
    expect(m.payloadJson).toEqual({ fileNames: ['a.png', 'b.png'] });
  });

  it('falls back to the raw string for a non-JSON payload', () => {
    const m = buildSnapshotManifest(makeRow({ payload_json: 'not json' }));
    expect(m.payloadJson).toBe('not json');
  });

  it('maps a NULL payload (templated artifact) to null — captures row + sourceRef only', () => {
    const m = buildSnapshotManifest(
      makeRow({ atype: 'idea-spec', mode: 'template', payload_json: null, source_ref: 'idea:42' }),
    );
    expect(m.payloadJson).toBeNull();
    expect(m.sourceRef).toBe('idea:42');
  });
});

describe('snapshotCommittedArtifact', () => {
  it('writes the manifest into the commit dir (mkdir -p) and returns the path', async () => {
    const row = makeRow();
    const target = await snapshotCommittedArtifact(dir, row);
    expect(target).toBe(snapshotPathFor(dir, row));

    const raw = await readFile(target as string, 'utf-8');
    const parsed = JSON.parse(raw) as ArtifactSnapshotManifest;
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      id: 'art_abc123',
      atype: 'ui-prototype',
    });
    expect(parsed.payloadJson).toEqual({ url: 'http://localhost:8081' });
  });

  it('is FAIL-SOFT: an unwritable worktree (path is a file) resolves to null, never throws', async () => {
    // Make the worktree path point at a regular FILE so mkdir -p underneath fails.
    const notADir = path.join(dir, 'a-file');
    await writeFile(notADir, 'x', 'utf-8');

    let result: string | null = 'sentinel';
    await expect(
      (async () => {
        result = await snapshotCommittedArtifact(notADir, makeRow(), {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        });
      })(),
    ).resolves.toBeUndefined();
    expect(result).toBeNull();
  });

  it('overwrites in place when the commit dir already exists (idempotent re-commit)', async () => {
    await mkdir(dir, { recursive: true });
    const row = makeRow({ label: 'first' });
    await snapshotCommittedArtifact(dir, row);
    const updated = await snapshotCommittedArtifact(dir, makeRow({ label: 'second' }));
    const parsed = JSON.parse(await readFile(updated as string, 'utf-8')) as ArtifactSnapshotManifest;
    expect(parsed.label).toBe('second');
  });
});
