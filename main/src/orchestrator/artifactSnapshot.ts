/**
 * artifactSnapshot — on-disk durability snapshot for COMMITTED artifacts.
 *
 * When an artifact is committed (ArtifactRouter.runCommit flips committed=1) we
 * write a small JSON manifest of the committed row to disk under the run's
 * worktree, so the deliverable survives a later DELETE of the originating entity
 * (idea / epic / task). The DB row remains the source of truth; this manifest is
 * a best-effort, fail-soft mirror — a disk error must NEVER fail the commit.
 *
 * Standalone-typecheck invariant (mirrors artifactRouter.ts): NO import from
 * 'electron', 'better-sqlite3', or main/src/services/* — disk work uses
 * fs/promises + node:path only, and the function is pure/injectable so it can be
 * unit-tested against an os.tmpdir() worktree.
 *
 * IMPORTANT LIMITATION — templated artifacts (idea-spec / decomposed-stories):
 * for these atypes payload_json is typically empty because the rendered content
 * is re-derived on the FRONTEND from the entity model (the row only carries a
 * sourceRef pointer to the originating entity). So for templated artifacts this
 * manifest captures the ROW + sourceRef pointer, NOT the rendered markdown.
 * Capturing the rendered content would require the frontend to send its rendered
 * output back at commit time — a separate design. The snapshot IS fully complete
 * for canvas artifacts (ui-prototype/generic `url` payload) and screenshots
 * (`fileNames` payload), whose content lives entirely in payload_json.
 */
import * as fs from 'fs/promises';
import * as path from 'node:path';
import type { LoggerLike } from './types';
import type { ArtifactDbRow } from './artifactRouter';

/** Bump when the manifest shape changes (consumers can branch on it). */
export const ARTIFACT_SNAPSHOT_SCHEMA_VERSION = 1;

/** On-disk manifest shape for one committed artifact. */
export interface ArtifactSnapshotManifest {
  schemaVersion: number;
  id: string;
  runId: string;
  atype: string;
  label: string;
  mode: string;
  sourceRef: string | null;
  /** Parsed payload when payload_json is valid JSON; the raw string otherwise;
   *  null when the row had no payload (typical for templated artifacts). */
  payloadJson: unknown;
  committedAt: string | null;
}

/** Relative directory (under the worktree) that holds artifact manifests. */
export const ARTIFACT_SNAPSHOT_DIR = path.join('.cyboflow', 'artifacts');

/**
 * Compute the absolute manifest path for a committed row under a worktree.
 * Filename = `<atype>__<artifactId>.json`.
 */
export function snapshotPathFor(worktreePath: string, row: Pick<ArtifactDbRow, 'id' | 'atype'>): string {
  return path.join(worktreePath, ARTIFACT_SNAPSHOT_DIR, `${row.atype}__${row.id}.json`);
}

/** Build the manifest object for a committed row. Pure (no I/O). */
export function buildSnapshotManifest(row: ArtifactDbRow): ArtifactSnapshotManifest {
  return {
    schemaVersion: ARTIFACT_SNAPSHOT_SCHEMA_VERSION,
    id: row.id,
    runId: row.run_id,
    atype: row.atype,
    label: row.label,
    mode: row.mode,
    sourceRef: row.source_ref,
    payloadJson: parsePayload(row.payload_json),
    committedAt: row.committed_at,
  };
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

/**
 * Write the committed-artifact manifest to disk under the run's worktree.
 *
 * FAIL-SOFT: this never throws. Any disk error (missing/unwritable worktree,
 * permission denied) is caught and logged, then swallowed — the DB row already
 * carries committed=1 and is the source of truth. Callers MUST invoke this
 * OUTSIDE the chokepoint DB transaction so a slow/failed disk write cannot roll
 * back or block the commit.
 *
 * @returns the absolute manifest path on success, or null when the write failed.
 */
export async function snapshotCommittedArtifact(
  worktreePath: string,
  row: ArtifactDbRow,
  logger?: LoggerLike,
): Promise<string | null> {
  const target = snapshotPathFor(worktreePath, row);
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const manifest = buildSnapshotManifest(row);
    await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    return target;
  } catch (err) {
    const msg = `[artifactSnapshot] failed to write committed-artifact manifest for ${row.id} at ${target} (fail-soft): ${
      err instanceof Error ? err.message : String(err)
    }`;
    if (logger) logger.warn(msg, { artifactId: row.id, runId: row.run_id });
    else console.warn(msg);
    return null;
  }
}
