/**
 * Reads the spawn marker (CYBOFLOW_INSTANCE / CYBOFLOW_WORKTREE, stamped by
 * utils/spawnMarker.ts at every spawn site) back off scanned processes'
 * environments — the production source for the classifier's `marker` input.
 *
 * - darwin: ONE `ps -Eww -o pid=,command= -p <pids>` spawn (BSD `ps` appends the
 *   environment to the command). Not per-pid. macOS withholds the environment of
 *   SIP-protected platform binaries (`/bin/sleep` …); those rows simply carry no
 *   marker and classify no higher than `suspected`.
 * - linux: `/proc/<pid>/environ` (NUL-separated, exact), no subprocess.
 * - win32: no reader — environments are not readable from a process table, so no
 *   row is ever marked and nothing on Windows can reach `orphan`.
 *
 * Fail-soft: any read/spawn failure yields "no marker" for the affected rows,
 * never a throw — an absent marker can only demote a row, never promote it.
 */
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import {
  SPAWN_MARKER_INSTANCE_ENV,
  SPAWN_MARKER_WORKTREE_ENV,
} from '../../utils/spawnMarker';
import type { SpawnMarkerObservation } from './classify';

export interface SpawnMarkerReaderOptions {
  platform?: NodeJS.Platform;
  /** Runs the env-printing `ps` for these pids and returns stdout. */
  runPs?: (pids: readonly number[]) => Promise<string>;
  /** Returns the raw NUL-separated environ blob for a pid, or null when unreadable. */
  readEnviron?: (pid: number) => Promise<string | null>;
}

// `ps -p` takes a comma list on argv; chunk to stay far below ARG_MAX.
const PS_PID_CHUNK = 400;

const ENV_KEY_BOUNDARY = /\s[A-Za-z_][A-Za-z0-9_]*=/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pull the marker out of one `ps -E` "command env…" tail. Env values are
 * space-joined, so the worktree value runs until the next ` KEY=` token.
 */
export function parseMarkerFromCommandLine(tail: string): SpawnMarkerObservation | null {
  const inst = new RegExp(`(?:^|\\s)${escapeRegExp(SPAWN_MARKER_INSTANCE_ENV)}=(\\S+)`).exec(tail);
  if (!inst) return null;
  let worktree: string | null = null;
  const wtKey = `${SPAWN_MARKER_WORKTREE_ENV}=`;
  const at = tail.search(new RegExp(`(?:^|\\s)${escapeRegExp(wtKey)}`));
  if (at >= 0) {
    const rest = tail.slice(tail.indexOf(wtKey, at) + wtKey.length);
    const boundary = ENV_KEY_BOUNDARY.exec(rest);
    const value = (boundary ? rest.slice(0, boundary.index) : rest).trim();
    worktree = value.length > 0 ? value : null;
  }
  return { instanceId: inst[1], worktree };
}

/** Parse `ps -Eww -o pid=,command=` output into pid → marker (unmarked pids omitted). */
export function parseMarkersFromPsEnv(stdout: string): Map<number, SpawnMarkerObservation> {
  const out = new Map<number, SpawnMarkerObservation>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number.parseInt(m[1], 10);
    const marker = parseMarkerFromCommandLine(m[2]);
    if (marker) out.set(pid, marker);
  }
  return out;
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

function defaultRunPs(pids: readonly number[]): Promise<string> {
  return new Promise<string>((resolve) => {
    execFile(
      'ps',
      ['-Eww', '-o', 'pid=,command=', '-p', pids.join(',')],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      // `ps -p` exits 1 when any listed pid already vanished; stdout is still valid.
      (_err, stdout) => resolve(typeof stdout === 'string' ? stdout : ''),
    );
  });
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
  const runPs = opts.runPs ?? defaultRunPs;
  const readEnviron = opts.readEnviron ?? defaultReadEnviron;

  return async (rows) => {
    const result = new Map<number, SpawnMarkerObservation>();
    if (rows.length === 0 || platform === 'win32') return result;
    const pids = [...new Set(rows.map((r) => r.pid))];
    try {
      if (platform === 'linux') {
        await Promise.all(
          pids.map(async (pid) => {
            const blob = await readEnviron(pid);
            const marker = blob ? parseMarkerFromEnviron(blob) : null;
            if (marker) result.set(pid, marker);
          }),
        );
      } else {
        for (let i = 0; i < pids.length; i += PS_PID_CHUNK) {
          const stdout = await runPs(pids.slice(i, i + PS_PID_CHUNK));
          for (const [pid, marker] of parseMarkersFromPsEnv(stdout)) result.set(pid, marker);
        }
      }
    } catch {
      // Fail soft: unreadable environments just mean no marker.
    }
    return result;
  };
}
