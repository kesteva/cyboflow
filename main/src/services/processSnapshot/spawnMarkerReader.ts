/**
 * Reads the spawn marker (CYBOFLOW_INSTANCE / CYBOFLOW_WORKTREE, stamped by
 * utils/spawnMarker.ts at every spawn site) back off scanned processes'
 * environments — the production source for the classifier's `marker` input.
 *
 * - linux: `/proc/<pid>/environ`. Entries are split on NUL, so an environment
 *   entry is told apart from anything in argv exactly, and no process is spawned.
 * - darwin/win32: no environment reader. `ps -E` cannot tell arguments from
 *   environment entries, and it would need a second scan. Rows there carry no
 *   marker, so they classify no higher than `suspected` and are never
 *   sweep-eligible.
 *
 * Fail-soft: any read failure yields "no marker" for the affected rows, never a
 * throw — an absent marker can only demote a row, never promote it.
 */
import { promises as fsp } from 'node:fs';
import {
  SPAWN_MARKER_INSTANCE_ENV,
  SPAWN_MARKER_WORKTREE_ENV,
} from '../../utils/spawnMarker';
import type { SpawnMarkerObservation } from './classify';

export interface SpawnMarkerReaderOptions {
  platform?: NodeJS.Platform;
  /** Returns the raw NUL-separated environ blob for a pid, or null when unreadable. */
  readEnviron?: (pid: number) => Promise<string | null>;
}

/** Parse a NUL-separated environ blob (`/proc/<pid>/environ`). */
export function parseMarkerFromEnviron(environ: string): SpawnMarkerObservation | null {
  let instanceId: string | null = null;
  let worktree: string | null = null;
  for (const entry of environ.split('\0')) {
    if (entry.startsWith(`${SPAWN_MARKER_INSTANCE_ENV}=`)) {
      instanceId = entry.slice(SPAWN_MARKER_INSTANCE_ENV.length + 1);
    } else if (entry.startsWith(`${SPAWN_MARKER_WORKTREE_ENV}=`)) {
      const v = entry.slice(SPAWN_MARKER_WORKTREE_ENV.length + 1);
      worktree = v.length > 0 ? v : null;
    }
  }
  return instanceId ? { instanceId, worktree } : null;
}

async function defaultReadEnviron(pid: number): Promise<string | null> {
  try {
    return await fsp.readFile(`/proc/${pid}/environ`, 'latin1');
  } catch {
    return null;
  }
}

/** Build the `readMarkers` function the system snapshot provider consumes. */
export function createSpawnMarkerReader(
  opts: SpawnMarkerReaderOptions = {},
): (rows: readonly { pid: number }[]) => Promise<Map<number, SpawnMarkerObservation>> {
  const platform = opts.platform ?? process.platform;
  const readEnviron = opts.readEnviron ?? defaultReadEnviron;

  return async (rows) => {
    const result = new Map<number, SpawnMarkerObservation>();
    if (rows.length === 0 || platform !== 'linux') return result;
    const pids = [...new Set(rows.map((r) => r.pid))];
    try {
      await Promise.all(
        pids.map(async (pid) => {
          const blob = await readEnviron(pid);
          const marker = blob ? parseMarkerFromEnviron(blob) : null;
          if (marker) result.set(pid, marker);
        }),
      );
    } catch {
      // Fail soft: unreadable environments just mean no marker.
    }
    return result;
  };
}
