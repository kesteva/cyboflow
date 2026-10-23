/**
 * Remote artifact pull-back (spec M2 §5 D4). An agent on a remote environment writes its file-based artifacts
 * (`prototype/index.html`, screenshot PNGs) into ITS run artifacts dir, `<remoteRoot>/artifacts/runs/<runKey>`
 * (CYBOFLOW_RUN_ARTIFACTS_DIR, remapped by the remote spawn). Everything that renders, validates or snapshots an
 * artifact reads the LOCAL run artifacts dir, so when such a run reports a file-based artifact the named files are
 * copied here first, before the report handler validates and the router reads them.
 *
 * Standalone (orchestrator/**): no services import, no fs. The bytes are moved by a fetcher the hosts composition
 * publishes with setRemoteArtifactFetcher (services/hosts/remoteArtifactFetcher.ts implements it); this module only
 * decides WHETHER a pull is needed and WHICH files, and turns a failure into the readable error the agent sees.
 *
 * LOCAL behaviour: a run on This Mac (host NULL / 'local') and every non-file atype return before anything else.
 */
import { isRemoteHostId } from '../../../../shared/types/hosts';
import { PROTOTYPE_HTML_RELPATH } from '../../../../shared/types/artifacts';
import { ArtifactError } from '../artifactRouter';
import type { DatabaseLike } from '../types';

/** Per-file ceiling for a pulled artifact. */
export const REMOTE_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
/** At most this many files per report (a screenshots payload names one per capture). */
export const REMOTE_ARTIFACT_MAX_FILES = 64;

/** One pull: copy `relPaths` (relative to the remote run artifacts dir of `runKey`) into `localDir`. */
export interface RemoteArtifactFetchRequest {
  hostId: string;
  /** CYBOFLOW_RUN_ID of the reporting process — names the remote dir (`<remoteRoot>/artifacts/runs/<runKey>`). */
  runKey: string;
  relPaths: readonly string[];
  /** The LOCAL run artifacts dir; each file lands at `<localDir>/<relPath>`. */
  localDir: string;
  /** Per-file byte ceiling. */
  maxBytes: number;
}

/** Thrown by a fetcher; `message` is user-presentable (no ssh target, secrets redacted). */
export class RemoteArtifactFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RemoteArtifactFetchError';
  }
}

/** Implemented by services/hosts/remoteArtifactFetcher.ts. Rejects with RemoteArtifactFetchError. */
export interface RemoteArtifactFetcherLike {
  fetch(request: RemoteArtifactFetchRequest): Promise<void>;
}

let fetcher: RemoteArtifactFetcherLike | null = null;

/** Composition root only (hosts start/stop). null clears it. */
export function setRemoteArtifactFetcher(next: RemoteArtifactFetcherLike | null): void {
  fetcher = next;
}

export function getRemoteArtifactFetcher(): RemoteArtifactFetcherLike | null {
  return fetcher;
}

/**
 * A relative artifact path that is safe to name on both machines: no absolute path, no backslash, no control
 * character, no empty / `.` / `..` segment. Anything else is not pulled (the local loaders skip such names too).
 */
export function isSafeArtifactRelPath(p: string): boolean {
  if (p.length === 0 || p.length > 512 || p.startsWith('/') || p.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) return false;
  return p.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

/**
 * The files a report of `atype` carries in the run artifacts dir, or null when the atype is not file-based. The
 * prototype atypes always carry the canonical document (the handler validates exactly that path, whatever the
 * payload says); screenshots carry `payload.fileNames`.
 */
export function remoteArtifactRelPaths(atype: string, payloadJson: string | null | undefined): string[] | null {
  if (atype === 'ui-prototype' || atype === 'interactive-prototype') return [PROTOTYPE_HTML_RELPATH];
  if (atype !== 'screenshots') return null;
  let parsed: unknown;
  try {
    parsed = payloadJson ? JSON.parse(payloadJson) : null;
  } catch {
    return [];
  }
  const names = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as { fileNames?: unknown }).fileNames
    : undefined;
  if (!Array.isArray(names)) return [];
  const safe = names.filter((n): n is string => typeof n === 'string' && isSafeArtifactRelPath(n));
  return [...new Set(safe)];
}

/**
 * The environment a run lives on (null = This Mac): `workflow_runs.host_id`, else its session's `sessions.host_id`
 * (a quick-session sentinel run may carry NULL while its session is remote). `SELECT *` so a test schema that
 * predates migration 152 reads as This Mac instead of failing.
 */
export function resolveRunHostId(db: DatabaseLike, runId: string): string | null {
  const run = db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as
    | { host_id?: string | null; session_id?: string | null }
    | undefined;
  if (isRemoteHostId(run?.host_id)) return run.host_id;
  if (!run?.session_id) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(run.session_id) as
    | { host_id?: string | null }
    | undefined;
  return isRemoteHostId(session?.host_id) ? session.host_id : null;
}

export interface PullRemoteArtifactsInput {
  runId: string;
  atype: string;
  payloadJson?: string | null;
  /** The LOCAL run artifacts dir (`CYBOFLOW_DIR/artifacts/runs/<runId>`). */
  localDir: string;
}

/**
 * Copy a remote run's reported artifact files into the local run artifacts dir. No-op for a local run and for a
 * non-file atype. Throws ArtifactError('invalid_payload', 'remote_artifact_unavailable: …') when the files cannot
 * be brought over (missing on the environment, too large, environment unreachable, remote runs not wired) — the
 * report tool shows that to the producing agent.
 */
export async function pullRemoteRunArtifacts(db: DatabaseLike, input: PullRemoteArtifactsInput): Promise<void> {
  const relPaths = remoteArtifactRelPaths(input.atype, input.payloadJson);
  if (relPaths === null) return;
  const hostId = resolveRunHostId(db, input.runId);
  if (hostId === null || relPaths.length === 0) return;
  if (relPaths.length > REMOTE_ARTIFACT_MAX_FILES) {
    throw new ArtifactError(
      'invalid_payload',
      `remote_artifact_unavailable: ${relPaths.length} files is more than the ${REMOTE_ARTIFACT_MAX_FILES} a report can bring back from a remote environment`,
    );
  }
  const active = fetcher;
  if (active === null) {
    throw new ArtifactError(
      'invalid_payload',
      'remote_artifact_unavailable: remote environments are not available right now, so the files cannot be brought back',
    );
  }
  try {
    await active.fetch({
      hostId,
      runKey: input.runId,
      relPaths,
      localDir: input.localDir,
      maxBytes: REMOTE_ARTIFACT_MAX_BYTES,
    });
  } catch (err) {
    const reason = err instanceof RemoteArtifactFetchError ? err.message : 'the environment could not be read';
    throw new ArtifactError('invalid_payload', `remote_artifact_unavailable: ${reason}`);
  }
}
