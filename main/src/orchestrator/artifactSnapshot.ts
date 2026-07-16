/**
 * artifactSnapshot — on-disk durability snapshot for COMMITTED artifacts
 * (schema v2, IDEA-039 artifact lifecycle).
 *
 * When an artifact is committed the router snapshots its durable content —
 * a JSON manifest PLUS the on-disk bytes it points at — into the configured
 * commit store (global `artifactCommitDir`, resolved against the owning
 * project's ROOT, NOT the run's worktree, which is torn down on dismiss), and
 * THEN deletes the DB row. So the committed snapshot, not the DB row, is the
 * durable source of truth: the read model (ArtifactRouter.listForRun /
 * listForSession) UNIONs live DB rows with these snapshots read back from disk.
 *
 * v2 directory layout (replaces the flat `<atype>__<id>.json` v1 file):
 *   S/<safeRunId>/<atype>/manifest.json
 *   S/<safeRunId>/<atype>/files/<relpath>        (e.g. files/prototype/index.html, files/home.png)
 * A re-commit `rm -rf`s the `(runId, atype)` dir and rewrites it via a
 * temp-dir + rename for atomicity. Byte copy is atype-driven:
 *   - ui-prototype / generic → the static mockup pointer (payload.fileName,
 *     default `prototype/index.html`) copied to files/<relpath>;
 *   - screenshots → each payload.fileNames basename copied to files/<basename>;
 *   - templated atypes (idea-spec / decomposed-stories / …) → no bytes (content
 *     re-derives from the still-present backlog entity on the frontend).
 *
 * Standalone-typecheck invariant (mirrors artifactRouter.ts): NO import from
 * 'electron', 'better-sqlite3', or main/src/services/* — disk work uses
 * fs/promises + node:path + node:crypto only, and every function is
 * pure/injectable so it can be unit-tested against an os.tmpdir() store.
 */
import * as fs from 'fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_ARTIFACT_COMMIT_DIR,
  ARTIFACT_SNAPSHOT_SCHEMA_VERSION,
  MAX_PROTOTYPE_HTML_BYTES,
  PROTOTYPE_HTML_RELPATH,
  type Artifact,
  type ArtifactType,
  type ArtifactRenderMode,
} from '../../../shared/types/artifacts';
import type { LoggerLike } from './types';
import type { ArtifactDbRow } from './artifactRouter';

/** Re-export the shared schema-version const so consumers importing it from this
 *  module (its historical home) keep compiling; the value now lives in
 *  shared/types/artifacts.ts (single source of truth). */
export { ARTIFACT_SNAPSHOT_SCHEMA_VERSION } from '../../../shared/types/artifacts';

/**
 * On-disk manifest shape for one committed artifact (schema v2). Captures the
 * full durable row plus the list of byte files actually copied into the
 * sibling `files/` dir.
 */
export interface ArtifactSnapshotManifest {
  schemaVersion: number;
  id: string;
  runId: string;
  sessionId: string | null;
  atype: string;
  label: string;
  mode: string;
  stepOrigin: string | null;
  sourceRef: string | null;
  /** Parsed payload when payload_json is valid JSON; the raw string otherwise;
   *  null when the row had no payload (typical for templated artifacts). */
  payloadJson: unknown;
  /** Relpaths (POSIX-style, relative to `files/`) of the bytes actually copied. */
  files: string[];
  /** Committed snapshots are never "new" (the pulsing-dot flag is a live-row concept). */
  isNew: false;
  createdAt: string;
  committedAt: string | null;
}

/**
 * Sanitize a runId for use as a single on-disk path segment in the commit
 * store. Drops path separators / dots so a crafted runId can never traverse
 * out of the store (`..`, `/`, `\` all collapse to `_`). Read-back paths filter
 * on the manifest's real `runId` field, so a (rare) sanitization collision is
 * still disambiguated on read.
 */
export function safeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Resolve the FINAL commit store directory (`S`) for artifact snapshots.
 *
 * A RELATIVE `configured` value resolves against the owning project's ROOT — so
 * the store survives a later teardown of the run's worktree. An ABSOLUTE value
 * is used verbatim. Blank input floors to DEFAULT_ARTIFACT_COMMIT_DIR. Pure (no I/O).
 */
export function resolveArtifactCommitDir(projectRoot: string, configured: string): string {
  const dir = configured.trim() || DEFAULT_ARTIFACT_COMMIT_DIR;
  return path.isAbsolute(dir) ? dir : path.join(projectRoot, dir);
}

/** The `(runId, atype)` snapshot directory inside an already-resolved store `S`. */
export function snapshotDirFor(storeDir: string, runId: string, atype: string): string {
  return path.join(storeDir, safeRunId(runId), atype);
}

/** The manifest path inside a `(runId, atype)` snapshot directory. */
export function manifestPathFor(storeDir: string, runId: string, atype: string): string {
  return path.join(snapshotDirFor(storeDir, runId, atype), 'manifest.json');
}

/** Parse payload_json when it is valid JSON; fall back to the raw string; null when absent. */
function parsePayload(payloadJson: string | null): unknown {
  if (payloadJson == null) return null;
  try {
    return JSON.parse(payloadJson);
  } catch {
    return payloadJson;
  }
}

/** Build the manifest object for a committed row + the relpaths actually copied. Pure. */
export function buildSnapshotManifest(row: ArtifactDbRow, files: string[] = []): ArtifactSnapshotManifest {
  return {
    schemaVersion: ARTIFACT_SNAPSHOT_SCHEMA_VERSION,
    id: row.id,
    runId: row.run_id,
    sessionId: row.session_id,
    atype: row.atype,
    label: row.label,
    mode: row.mode,
    stepOrigin: row.step_origin,
    sourceRef: row.source_ref,
    payloadJson: parsePayload(row.payload_json),
    files,
    isNew: false,
    createdAt: row.created_at,
    committedAt: row.committed_at,
  };
}

/** Re-stringify a parsed manifest payload back to the `Artifact.payloadJson` string. */
function manifestPayloadToJsonString(payload: unknown): string | null {
  if (payload == null) return null;
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

/**
 * Shape a committed snapshot manifest into the camelCase API `Artifact` the
 * read model returns. Committed snapshots are, by construction, committed=true,
 * sessionOnly=false, isNew=false.
 */
export function snapshotManifestToArtifact(m: ArtifactSnapshotManifest): Artifact {
  return {
    id: m.id,
    runId: m.runId,
    sessionId: m.sessionId,
    atype: m.atype as ArtifactType,
    label: m.label,
    stepOrigin: m.stepOrigin,
    mode: m.mode as ArtifactRenderMode,
    committed: true,
    sessionOnly: false,
    isNew: false,
    payloadJson: manifestPayloadToJsonString(m.payloadJson),
    sourceRef: m.sourceRef,
    createdAt: m.createdAt,
    committedAt: m.committedAt,
  };
}

/** The relpaths (relative to the run artifacts dir / the snapshot `files/` dir)
 *  whose bytes a given atype's snapshot carries. */
function bytePathsForRow(row: ArtifactDbRow): string[] {
  const payload = parsePayload(row.payload_json);
  const asObj = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : undefined;
  if (row.atype === 'ui-prototype' || row.atype === 'generic') {
    const fileName = asObj && typeof asObj.fileName === 'string' ? asObj.fileName : PROTOTYPE_HTML_RELPATH;
    return [fileName];
  }
  if (row.atype === 'screenshots') {
    const names = asObj && Array.isArray(asObj.fileNames) ? asObj.fileNames : [];
    return names.filter((n): n is string => typeof n === 'string').map((n) => path.basename(n));
  }
  return [];
}

/**
 * Copy one byte file from the run artifacts dir into the snapshot `files/` dir,
 * with full containment hardening. Returns the stored relpath on success, or
 * null (fail-soft) on any guard failure — traversal escape, symlink, not a
 * regular file, over the per-file ceiling, or a plain read/copy error.
 */
async function copyGuardedByte(
  runArtifactsRoot: string,
  rel: string,
  destFilesDir: string,
  logger?: LoggerLike,
): Promise<string | null> {
  try {
    const srcAbs = path.resolve(runArtifactsRoot, rel);
    // Containment: the resolved source must stay inside the run artifacts root.
    if (srcAbs !== runArtifactsRoot && !srcAbs.startsWith(runArtifactsRoot + path.sep)) {
      return null;
    }
    // Reject a symlinked final component outright (no following out of the tree).
    const lst = await fs.lstat(srcAbs);
    if (lst.isSymbolicLink() || !lst.isFile()) return null;
    if (lst.size > MAX_PROTOTYPE_HTML_BYTES) return null;
    // Re-verify via realpath so an intermediate symlinked dir can't escape either.
    const realSrc = await fs.realpath(srcAbs);
    if (realSrc !== runArtifactsRoot && !realSrc.startsWith(runArtifactsRoot + path.sep)) {
      return null;
    }
    const dest = path.join(destFilesDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(realSrc, dest);
    return rel;
  } catch (err) {
    const msg = `[artifactSnapshot] byte copy skipped for '${rel}' (fail-soft): ${
      err instanceof Error ? err.message : String(err)
    }`;
    if (logger) logger.debug(msg);
    else console.debug(msg);
    return null;
  }
}

/**
 * Snapshot a just-committed artifact (manifest + on-disk bytes) into the commit
 * store, replacing any prior snapshot for the same `(runId, atype)`.
 *
 * Atomic-ish: the new manifest + copied bytes are staged into a sibling temp
 * dir, the old `(runId, atype)` dir is removed, then the temp dir is renamed
 * into place (same parent → an atomic rename on POSIX). Byte copy is best-effort
 * per file (a missing/oversized/symlinked source is simply omitted from
 * `manifest.files`); the manifest is always written.
 *
 * `runArtifactsRoot` is the run's artifacts subtree (bytes source), or null when
 * unavailable (unit tests / url-only generic) — then no bytes are copied.
 *
 * FAIL-SOFT overall: any disk error is caught, logged, and swallowed — the DB
 * row already carries committed=1, so a snapshot problem must never surface to
 * the commit caller. Returns the manifest path on success, or null on failure
 * (the router keeps committed=1 and skips the delete when this returns null).
 */
export async function snapshotCommittedArtifact(
  storeDir: string,
  runArtifactsRoot: string | null,
  row: ArtifactDbRow,
  logger?: LoggerLike,
): Promise<string | null> {
  const destDir = snapshotDirFor(storeDir, row.run_id, row.atype);
  const parent = path.dirname(destDir);
  const tmpDir = path.join(parent, `.tmp-${row.atype}-${randomBytes(8).toString('hex')}`);
  try {
    const filesDir = path.join(tmpDir, 'files');
    await fs.mkdir(filesDir, { recursive: true });

    // Atype-driven byte copy (best-effort per file). Only when a run artifacts
    // root is available AND its realpath resolves — url-only/templated atypes
    // copy nothing and the manifest carries files: [].
    const copied: string[] = [];
    const wanted = runArtifactsRoot ? bytePathsForRow(row) : [];
    if (wanted.length > 0 && runArtifactsRoot) {
      let realRoot: string | null = null;
      try {
        realRoot = await fs.realpath(runArtifactsRoot);
      } catch {
        realRoot = null;
      }
      if (realRoot) {
        for (const rel of wanted) {
          const stored = await copyGuardedByte(realRoot, rel, filesDir, logger);
          if (stored) copied.push(stored);
        }
      }
    }

    const manifest = buildSnapshotManifest(row, copied);
    await fs.writeFile(path.join(tmpDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    // Swap the new snapshot into place (rm the old dir, rename temp → dest).
    await fs.mkdir(parent, { recursive: true });
    await fs.rm(destDir, { recursive: true, force: true });
    await fs.rename(tmpDir, destDir);
    return manifestPathFor(storeDir, row.run_id, row.atype);
  } catch (err) {
    // Best-effort cleanup of the abandoned temp dir; never mask the real error.
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    const msg = `[artifactSnapshot] failed to snapshot committed artifact ${row.id} at ${destDir} (fail-soft): ${
      err instanceof Error ? err.message : String(err)
    }`;
    if (logger) logger.warn(msg, { artifactId: row.id, runId: row.run_id });
    else console.warn(msg);
    return null;
  }
}

/** Read + parse one manifest file; null (fail-soft) when absent or malformed. */
async function readManifest(manifestPath: string): Promise<ArtifactSnapshotManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as ArtifactSnapshotManifest;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Read back all committed snapshot manifests under the store, optionally scoped
 * to one run. Fail-soft: an absent store / unreadable manifest yields fewer (or
 * zero) results, never a throw. When `runId` is given, only that run's
 * `(safeRunId, *)` subtree is scanned and results are filtered on the manifest's
 * real `runId` (guards against a sanitization collision).
 */
export async function listCommittedSnapshots(
  storeDir: string,
  runId?: string,
): Promise<ArtifactSnapshotManifest[]> {
  const out: ArtifactSnapshotManifest[] = [];
  const runDirs: string[] = [];
  try {
    if (runId !== undefined) {
      runDirs.push(path.join(storeDir, safeRunId(runId)));
    } else {
      const entries = await fs.readdir(storeDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) runDirs.push(path.join(storeDir, e.name));
      }
    }
  } catch {
    return out;
  }

  for (const runDir of runDirs) {
    let atypeEntries: Dirent[] = [];
    try {
      atypeEntries = await fs.readdir(runDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of atypeEntries) {
      if (!e.isDirectory()) continue;
      const m = await readManifest(path.join(runDir, e.name, 'manifest.json'));
      if (!m) continue;
      if (runId !== undefined && m.runId !== runId) continue;
      out.push(m);
    }
  }
  return out;
}

/** Load one committed snapshot manifest for `(runId, atype)`; null when absent. */
export async function loadCommittedSnapshot(
  storeDir: string,
  runId: string,
  atype: string,
): Promise<ArtifactSnapshotManifest | null> {
  const m = await readManifest(manifestPathFor(storeDir, runId, atype));
  if (!m) return null;
  if (m.runId !== runId || m.atype !== atype) return null;
  return m;
}

/**
 * Read the committed static mockup HTML (`files/prototype/index.html`) for a
 * `(runId, atype)` snapshot, with the same hardening as the live-file handler:
 * containment inside the snapshot files dir, symlink reject, regular-file +
 * size ceiling. Returns the document string, or null (fail-soft) when absent /
 * invalid / oversized.
 */
export async function loadCommittedHtml(
  storeDir: string,
  runId: string,
  atype: string,
): Promise<string | null> {
  try {
    const filesRoot = path.join(snapshotDirFor(storeDir, runId, atype), 'files');
    const realRoot = await fs.realpath(filesRoot);
    const target = path.resolve(realRoot, PROTOTYPE_HTML_RELPATH);
    if (target !== realRoot && !target.startsWith(realRoot + path.sep)) return null;
    const lst = await fs.lstat(target);
    if (lst.isSymbolicLink() || !lst.isFile()) return null;
    if (lst.size > MAX_PROTOTYPE_HTML_BYTES) return null;
    const realTarget = await fs.realpath(target);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null;
    return await fs.readFile(realTarget, 'utf-8');
  } catch {
    return null;
  }
}
