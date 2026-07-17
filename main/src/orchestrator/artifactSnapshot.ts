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
import { constants as fsConstants, type Dirent } from 'node:fs';
import * as path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import {
  DEFAULT_ARTIFACT_COMMIT_DIR,
  ARTIFACT_SNAPSHOT_SCHEMA_VERSION,
  MAX_PROTOTYPE_HTML_BYTES,
  MAX_SCREENSHOT_BYTES,
  PROTOTYPE_HTML_RELPATH,
  isPerEntityArtifact,
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

/** Short, path-safe, collision-free digest of an arbitrary string. */
function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/**
 * Sanitize an identifier for use as a single on-disk path segment in the commit
 * store. Drops path separators / dots so a crafted value can never traverse out
 * of the store (`..`, `/`, `\` all collapse to `_`).
 *
 * Collision-safe: sanitization is LOSSY (`run.a` and `run/a` both → `run_a`), so
 * when the raw value contains any char outside `[A-Za-z0-9_-]` we suffix a hash
 * of the RAW value — distinct inputs then always map to distinct segments, and a
 * value that is already path-safe (the common case: a UUID-hex runId) is returned
 * verbatim for back-compat.
 */
function safeSegment(raw: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(raw)) return raw;
  return `${raw.replace(/[^A-Za-z0-9_-]/g, '_')}-${shortHash(raw)}`;
}

/** Sanitize a runId into a single collision-free on-disk path segment. */
export function safeRunId(runId: string): string {
  return safeSegment(runId);
}

/**
 * The per-atype directory segment under a run's snapshot dir. Non-per-entity
 * atypes are one-per-(run, atype) → the segment is just `<atype>`. PER-ENTITY
 * atypes (idea-spec) are one-per-(run, atype, sourceRef) — matching the DB read
 * union's identity — so they get a `sourceRef` sub-segment; without it a second
 * committed idea-spec in the same run would `rm -rf` the first's snapshot.
 */
function atypeSegment(atype: string, sourceRef: string | null | undefined): string {
  if (isPerEntityArtifact(atype as ArtifactType) && sourceRef) {
    return path.join(atype, safeSegment(sourceRef));
  }
  return atype;
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

/** The snapshot directory for an artifact identity inside an already-resolved
 *  store `S`. Keyed by `(runId, atype)`, plus `sourceRef` for per-entity atypes. */
export function snapshotDirFor(
  storeDir: string,
  runId: string,
  atype: string,
  sourceRef?: string | null,
): string {
  return path.join(storeDir, safeRunId(runId), atypeSegment(atype, sourceRef));
}

/** The manifest path inside an artifact-identity snapshot directory. */
export function manifestPathFor(
  storeDir: string,
  runId: string,
  atype: string,
  sourceRef?: string | null,
): string {
  return path.join(snapshotDirFor(storeDir, runId, atype, sourceRef), 'manifest.json');
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
 *  a given row's snapshot MUST carry to be durable. Empty for templated /
 *  url-only artifacts. The router uses this to decide whether a committed row's
 *  bytes are safely captured before reaping the run subtree. */
export function requiredBytePaths(row: ArtifactDbRow): string[] {
  const payload = parsePayload(row.payload_json);
  const asObj = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : undefined;
  if (row.atype === 'ui-prototype') {
    // A static ui-prototype ALWAYS carries its canonical HTML document — required
    // regardless of payload. Keying the requirement off the payload would let a
    // payload edit strip `fileName` and drop the requirement, so the row could be
    // committed + deleted with nothing captured. The report handler mints the
    // canonical fileName anyway, so this only hardens against later edits.
    const fileName = asObj && typeof asObj.fileName === 'string' ? asObj.fileName : PROTOTYPE_HTML_RELPATH;
    return [fileName];
  }
  if (row.atype === 'generic') {
    // A generic canvas is dual: a declared `fileName` carries HTML bytes; a
    // url-only generic (legacy dev-server pointer) declares none and wants none.
    const fileName = asObj && typeof asObj.fileName === 'string' ? asObj.fileName : null;
    return fileName ? [fileName] : [];
  }
  if (row.atype === 'screenshots') {
    const names = asObj && Array.isArray(asObj.fileNames) ? asObj.fileNames : [];
    return names.filter((n): n is string => typeof n === 'string').map((n) => path.basename(n));
  }
  return [];
}

/** Per-atype byte ceiling for a snapshot copy (screenshots dwarf HTML docs). */
function capForAtype(atype: string): number {
  return atype === 'screenshots' ? MAX_SCREENSHOT_BYTES : MAX_PROTOTYPE_HTML_BYTES;
}

/**
 * Copy one byte file from the run artifacts dir into the snapshot `files/` dir,
 * with full containment hardening. Returns the stored relpath on success, or
 * null (fail-soft) on any guard failure — traversal escape, symlink, not a
 * regular file, over the per-file ceiling, or a plain read/copy error.
 *
 * TOCTOU-hardened: the final component is opened with `O_NOFOLLOW` (a symlinked
 * file is rejected ATOMICALLY at open, no lstat→realpath→read window), and the
 * `fstat` size check + the bytes copied both come off that SAME descriptor — so
 * a producer swapping the file between validation and read cannot smuggle other
 * bytes in. An intermediate symlinked directory is still caught by the
 * realpath containment check on the parent dir.
 */
async function copyGuardedByte(
  runArtifactsRoot: string,
  rel: string,
  destFilesDir: string,
  maxBytes: number,
  logger?: LoggerLike,
): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const srcAbs = path.resolve(runArtifactsRoot, rel);
    // Containment: the resolved source must stay inside the run artifacts root.
    if (srcAbs !== runArtifactsRoot && !srcAbs.startsWith(runArtifactsRoot + path.sep)) {
      return null;
    }
    // Re-verify the CONTAINING dir via realpath so an intermediate symlinked dir
    // can't escape the run root (the final component is guarded by O_NOFOLLOW).
    const realRoot = await fs.realpath(runArtifactsRoot);
    const realDir = await fs.realpath(path.dirname(srcAbs));
    if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) return null;
    // Open with O_NOFOLLOW: a symlinked final component throws ELOOP (fail-soft).
    fh = await fs.open(srcAbs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const st = await fh.stat();
    if (!st.isFile()) return null;
    if (st.size > maxBytes) return null;
    const buf = await fh.readFile();
    const dest = path.join(destFilesDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buf);
    return rel;
  } catch (err) {
    const msg = `[artifactSnapshot] byte copy skipped for '${rel}' (fail-soft): ${
      err instanceof Error ? err.message : String(err)
    }`;
    if (logger) logger.debug(msg);
    else console.debug(msg);
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * Snapshot a just-committed artifact (manifest + on-disk bytes) into the commit
 * store, replacing any prior snapshot for the same `(runId, atype)`.
 *
 * Atomic-ish: the new manifest + copied bytes are staged into a sibling temp
 * dir, the old identity dir is removed, then the temp dir is renamed into place
 * (same parent → an atomic rename on POSIX).
 *
 * `runArtifactsRoot` is the run's artifacts subtree (bytes source), or null when
 * unavailable (unit tests). The set of REQUIRED files is derived from the row's
 * payload INDEPENDENTLY of the root, so a byte-bearing artifact whose root is
 * missing fails the durability gate rather than silently snapshotting empty.
 *
 * DURABILITY GATE: when the atype declares required byte files (a static
 * ui-prototype / generic pointer, or screenshots), EVERY required file must copy
 * or the snapshot is abandoned (null returned) so the caller never deletes the
 * still-live DB row — byte-copy is a prerequisite of the commit's row delete.
 * Atypes with no required bytes (templated, url-only generic) finalize with
 * `files: []`.
 *
 * FAIL-SOFT overall: any disk error is caught, logged, and swallowed — the DB
 * row already carries committed=1, so a snapshot problem must never surface to
 * the commit caller. Returns the manifest path on success, or null on failure /
 * incomplete copy (the router keeps committed=1 and skips the delete then).
 */
export async function snapshotCommittedArtifact(
  storeDir: string,
  runArtifactsRoot: string | null,
  row: ArtifactDbRow,
  logger?: LoggerLike,
): Promise<string | null> {
  const destDir = snapshotDirFor(storeDir, row.run_id, row.atype, row.source_ref);
  const parent = path.dirname(destDir);
  const tmpDir = path.join(parent, `.tmp-${row.atype}-${randomBytes(8).toString('hex')}`);
  try {
    const filesDir = path.join(tmpDir, 'files');
    await fs.mkdir(filesDir, { recursive: true });

    // REQUIRED files come from the payload, NOT from root availability — a
    // fileName-bearing artifact requires its byte regardless of whether the run
    // root resolves, so it can never be deleted with an empty snapshot.
    const required = requiredBytePaths(row);
    const cap = capForAtype(row.atype);
    const copied: string[] = [];
    if (required.length > 0 && runArtifactsRoot) {
      let realRoot: string | null = null;
      try {
        realRoot = await fs.realpath(runArtifactsRoot);
      } catch {
        realRoot = null;
      }
      if (realRoot) {
        for (const rel of required) {
          const stored = await copyGuardedByte(realRoot, rel, filesDir, cap, logger);
          if (stored) copied.push(stored);
        }
      }
    }

    // DATA-LOSS GUARD: a byte-bearing atype's snapshot is only durable when EVERY
    // required file copied. If any is missing (root absent/unresolvable, source
    // reaped/gone, oversized, or symlinked), do NOT finalize — return null so
    // runCommit keeps committed=1 and never deletes the still-live DB row.
    const copiedSet = new Set(copied);
    const missing = required.filter((rel) => !copiedSet.has(rel));
    if (missing.length > 0) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      const msg = `[artifactSnapshot] snapshot for ${row.id} incomplete — ${copied.length}/${required.length} bytes copied (missing: ${missing.join(', ')}); keeping committed=1`;
      if (logger) logger.warn(msg, { artifactId: row.id, runId: row.run_id });
      else console.warn(msg);
      return null;
    }

    const manifest = buildSnapshotManifest(row, copied);
    await fs.writeFile(path.join(tmpDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    // Swap the new snapshot into place (rm the old dir, rename temp → dest).
    await fs.mkdir(parent, { recursive: true });
    await fs.rm(destDir, { recursive: true, force: true });
    await fs.rename(tmpDir, destDir);
    return manifestPathFor(storeDir, row.run_id, row.atype, row.source_ref);
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
      if (!e.isDirectory() || e.name.startsWith('.tmp-')) continue;
      // A non-per-entity atype dir holds manifest.json directly; a per-entity
      // atype dir (idea-spec) instead holds one <sourceRef>/manifest.json subdir
      // per entity. Read the direct manifest, else descend one level.
      const direct = await readManifest(path.join(runDir, e.name, 'manifest.json'));
      if (direct) {
        if (runId === undefined || direct.runId === runId) out.push(direct);
        continue;
      }
      let refEntries: Dirent[] = [];
      try {
        refEntries = await fs.readdir(path.join(runDir, e.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ref of refEntries) {
        if (!ref.isDirectory() || ref.name.startsWith('.tmp-')) continue;
        const m = await readManifest(path.join(runDir, e.name, ref.name, 'manifest.json'));
        if (!m) continue;
        if (runId !== undefined && m.runId !== runId) continue;
        out.push(m);
      }
    }
  }
  return out;
}

/** Load one committed snapshot manifest for an artifact identity; null when absent. */
export async function loadCommittedSnapshot(
  storeDir: string,
  runId: string,
  atype: string,
  sourceRef?: string | null,
): Promise<ArtifactSnapshotManifest | null> {
  const m = await readManifest(manifestPathFor(storeDir, runId, atype, sourceRef));
  if (!m) return null;
  if (m.runId !== runId || m.atype !== atype) return null;
  return m;
}

/**
 * Read the committed static mockup HTML (`files/prototype/index.html`) for a
 * `(runId, atype)` snapshot, with the same TOCTOU-hardening as the live-file
 * handler: realpath containment of the files dir, then O_NOFOLLOW open of the
 * final component (symlink rejected atomically) with the size check + read off
 * the same descriptor. Returns the document string, or null (fail-soft) when
 * absent / invalid / oversized.
 */
export async function loadCommittedHtml(
  storeDir: string,
  runId: string,
  atype: string,
): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const filesRoot = path.join(snapshotDirFor(storeDir, runId, atype), 'files');
    const realRoot = await fs.realpath(filesRoot);
    const target = path.resolve(realRoot, PROTOTYPE_HTML_RELPATH);
    if (target !== realRoot && !target.startsWith(realRoot + path.sep)) return null;
    const realDir = await fs.realpath(path.dirname(target));
    if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) return null;
    fh = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const st = await fh.stat();
    if (!st.isFile()) return null;
    if (st.size > MAX_PROTOTYPE_HTML_BYTES) return null;
    return await fh.readFile('utf-8');
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}
