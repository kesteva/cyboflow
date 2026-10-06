/**
 * Reads the spawn marker (CYBOFLOW_INSTANCE / CYBOFLOW_WORKTREE, stamped by
 * utils/spawnMarker.ts at every spawn site) back off scanned processes'
 * environments — the production source for the classifier's `marker` input.
 *
 * - linux: `/proc/<pid>/environ`. Entries are split on NUL, so an environment
 *   entry is told apart from anything in argv exactly, and no process is spawned.
 * - darwin: `ps -E` appends the environment to argv with spaces, so it is read
 *   alongside a plain `ps` of the same pids and the plain argv is stripped off
 *   the front — a marker spelled inside argv is never read. Only rows parented
 *   to launchd (ppid 1) are read: that is where a detached cyboflow child lands
 *   once its spawner is gone, and this instance's live processes are attributed
 *   through its manager handles and ancestry. Trade-off: a LIVE other instance's
 *   still-parented children carry no marker here, so they are not shown (linux
 *   shows them read-only); they become visible the moment they are orphaned. A process's starting environment never changes, so each
 *   result is cached per (pid, command, start time); a steady-state refresh
 *   spawns nothing. Residual ambiguity: an environment VALUE that itself
 *   contains ` CYBOFLOW_INSTANCE=…` would read as a marker — only a process the
 *   user's own session configured that way could do it.
 * - win32: no environment reader. Rows there carry no marker, so they classify
 *   no higher than `suspected` and are never sweep-eligible.
 *
 * Fail-soft: any read failure yields "no marker" for the affected rows, never a
 * throw — an absent marker can only demote a row, never promote it.
 */
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import {
  SPAWN_MARKER_INSTANCE_ENV,
  SPAWN_MARKER_WORKTREE_ENV,
} from '../../utils/spawnMarker';
import type { SpawnMarkerObservation } from './classify';
import type { ProcessSnapshotRow } from '../processTable';

/** The slice of a scanned row the reader needs. */
export type MarkerReaderRow = Pick<ProcessSnapshotRow, 'pid' | 'ppid' | 'command' | 'etimeSeconds'>;

export interface SpawnMarkerReaderOptions {
  platform?: NodeJS.Platform;
  /** linux: the raw NUL-separated environ blob for a pid, or null when unreadable. */
  readEnviron?: (pid: number) => Promise<string | null>;
  /**
   * darwin: `ps -ww [-E] -o pid=,command= -p <pids>` stdout. `withEnv` selects `-E`.
   * Rejects (or resolves '') on failure.
   */
  runPs?: (pids: readonly number[], withEnv: boolean) => Promise<string>;
  /** darwin: clock for the start-time cache key. Defaults to `Date.now`. */
  now?: () => number;
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

/** One environment entry starts at the text start or after a space, with a NAME= prefix. */
const PS_ENV_ENTRY = /(?:^| )([A-Za-z_][A-Za-z0-9_]*)=/g;

/**
 * Parse the environment tail of a `ps -E` line (argv already stripped). Entries
 * are space-separated, but a value may itself contain spaces (a worktree path),
 * so a value runs up to the next ` NAME=` boundary rather than the next space.
 */
export function parseMarkerFromPsEnv(envText: string): SpawnMarkerObservation | null {
  const starts: Array<{ name: string; valueStart: number; entryStart: number }> = [];
  for (const m of envText.matchAll(PS_ENV_ENTRY)) {
    starts.push({ name: m[1], valueStart: m.index + m[0].length, entryStart: m.index });
  }
  const entries = starts.map((s, i) => `${s.name}=${envText.slice(s.valueStart, starts[i + 1]?.entryStart ?? envText.length)}`);
  return parseMarkerFromEnviron(entries.join('\0'));
}

/** Split `ps -o pid=,command=` stdout into pid → text. A line not starting with a pid continues the previous one. */
export function parsePsPidCommand(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  let last: number | null = null;
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+) (.*)$/.exec(line);
    if (m) {
      last = Number(m[1]);
      out.set(last, m[2]);
    } else if (last !== null && line.length > 0) {
      out.set(last, `${out.get(last) ?? ''}\n${line}`);
    }
  }
  return out;
}

function defaultRunPs(pids: readonly number[], withEnv: boolean): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      [withEnv ? '-wwE' : '-ww', '-o', 'pid=,command=', '-p', pids.join(',')],
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      // ps exits 1 when some pid vanished between the scan and this read; the
      // remaining rows on stdout are still valid.
      (_err, stdout) => resolve(typeof stdout === 'string' ? stdout : ''),
    );
  });
}

interface CachedMarker {
  command: string;
  startedAtMs: number;
  marker: SpawnMarkerObservation | null;
}

/** `etime` has one-second resolution and the clock moves between scans. */
const START_TIME_TOLERANCE_MS = 2_000;

function createDarwinReader(
  runPs: NonNullable<SpawnMarkerReaderOptions['runPs']>,
  now: () => number,
): (rows: readonly MarkerReaderRow[]) => Promise<Map<number, SpawnMarkerObservation>> {
  const cache = new Map<number, CachedMarker>();

  return async (rows) => {
    const result = new Map<number, SpawnMarkerObservation>();
    const at = now();
    const candidates = rows.filter((r) => r.ppid === 1);
    const live = new Set<number>();
    const toRead: MarkerReaderRow[] = [];
    for (const r of candidates) {
      live.add(r.pid);
      const hit = cache.get(r.pid);
      // No start time (unparseable etime) ⇒ no safe cache key: always read.
      const startedAtMs = r.etimeSeconds === null ? null : at - r.etimeSeconds * 1000;
      if (
        hit &&
        startedAtMs !== null &&
        hit.command === r.command &&
        Math.abs(hit.startedAtMs - startedAtMs) <= START_TIME_TOLERANCE_MS
      ) {
        if (hit.marker) result.set(r.pid, hit.marker);
      } else {
        toRead.push(r);
      }
    }
    // Drop entries for pids that are gone, so a reused pid can never hit a stale result.
    for (const pid of cache.keys()) if (!live.has(pid)) cache.delete(pid);
    if (toRead.length === 0) return result;

    try {
      const pids = toRead.map((r) => r.pid);
      const [plainOut, envOut] = await Promise.all([runPs(pids, false), runPs(pids, true)]);
      const plain = parsePsPidCommand(plainOut);
      const withEnv = parsePsPidCommand(envOut);
      for (const r of toRead) {
        const argv = plain.get(r.pid);
        const full = withEnv.get(r.pid);
        // A pid missing from either read (exited, or another user's process with
        // no visible environment) yields no marker; it is retried next snapshot.
        if (argv === undefined || full === undefined) continue;
        const marker = full.startsWith(argv) ? parseMarkerFromPsEnv(full.slice(argv.length)) : null;
        if (r.etimeSeconds !== null) {
          cache.set(r.pid, { command: r.command, startedAtMs: at - r.etimeSeconds * 1000, marker });
        }
        if (marker) result.set(r.pid, marker);
      }
    } catch {
      // Fail soft: an unreadable environment just means no marker.
    }
    return result;
  };
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
): (rows: readonly MarkerReaderRow[]) => Promise<Map<number, SpawnMarkerObservation>> {
  const platform = opts.platform ?? process.platform;
  if (platform === 'darwin') return createDarwinReader(opts.runPs ?? defaultRunPs, opts.now ?? Date.now);
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
