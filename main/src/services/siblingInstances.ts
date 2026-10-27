/**
 * Sibling cyboflow instances — the OTHER data dirs on this machine (stable
 * `~/.cyboflow`, the Dev DMG's `~/.cyboflow_dev_dmg`, `pnpm dev`'s `~/.cyboflow_dev`,
 * and any `CYBOFLOW_DIR` smoke dir that is running right now). Each keeps its own
 * `sessions.db` and `instances/` liveness records, so without this module an
 * instance is blind to them:
 *   - a worktree a sibling still owns has no session/run row HERE, so the
 *     registry would tag it `orphan` and the System view would offer to reap it;
 *   - a helper a sibling runs unmarked (its disk-usage `du`) looks like a stray.
 *
 * Read-only by construction: sibling DBs are opened `readonly` and never
 * migrated, and sibling liveness records only ever feed the main-pid ancestry
 * check — they are NOT merged into this instance's live/dead instance sets, so
 * nothing a sibling spawned can become sweep-eligible here.
 *
 * Liveness is pid AND start time: crashed / killed instances leave their records
 * behind (hundreds of them under a busy `~/.cyboflow_dev`), and macOS recycles
 * pids, so `kill(pid, 0)` alone happily calls `cfprefsd` a live cyboflow. A record
 * is live only when its pid is alive AND that process started no later than the
 * record's `startedAt` (the record is written after boot; a recycled pid's
 * process started after it). Where the age cannot be read (win32, `ps` failure)
 * it falls back to pid liveness.
 *
 * Fail-closed where it guards a destructive action: a sibling `sessions.db` that
 * exists but cannot be read is reported, and the registry then refuses to call
 * any worktree an orphan (see worktreeRegistry.ts). A non-canonical dir whose
 * liveness records cannot be read is treated as possibly running, not dead.
 *
 * Paths are matched by identity, not spelling: each claimed path is also entered
 * under its real path (symlinks, `/var` → `/private/var`, on-disk case), and the
 * registry resolves git's paths the same way.
 *
 * Reads are cached briefly for the System view's polling; a destructive action
 * calls {@link SiblingInstances.invalidate} first so its re-check never reuses an
 * ownership read taken before the user confirmed.
 */
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import type { InstanceRecord } from '../utils/spawnMarker';
import type { InstanceRecordScan } from './systemSnapshotProvider';
import { parseEtime } from './processTable';

const execFileAsync = promisify(execFile);

/** Data dirs a packaged/dev build resolves to by default — checked whether or not they are running. */
const CANONICAL_DATA_DIR_NAMES = ['.cyboflow', '.cyboflow_dev_dmg', '.cyboflow_dev'] as const;
const DATA_DIR_PREFIX = '.cyboflow';
const DB_FILE = 'sessions.db';
const CACHE_TTL_MS = 2_000;
/** etime has 1s resolution and the record lands just after boot: allow a little skew. */
const START_SKEW_MS = 5_000;

/** What the sibling DBs say about worktree ownership. */
export interface SiblingWorktreeClaims {
  /** Worktree path → the sibling data dir whose DB references it; keyed by both the stored and the real path. */
  claimedPaths: ReadonlyMap<string, string>;
  /** Sibling data dirs whose `sessions.db` exists but could not be read. Non-empty ⇒ fail closed. */
  unreadableDataDirs: readonly string[];
}

export const NO_SIBLING_CLAIMS: SiblingWorktreeClaims = { claimedPaths: new Map(), unreadableDataDirs: [] };

export interface SiblingInstanceDeps {
  /** This instance's own data dir (excluded from the scan). */
  selfDataDir: string;
  /** Defaults to `os.homedir()`. */
  homeDir?: string;
  readInstanceRecords: (instancesDir: string) => Promise<InstanceRecordScan>;
  isPidAlive: (pid: number) => boolean;
  /** Elapsed seconds per pid (missing pid = unknown). Defaults to one `ps -o pid=,etime= -p …` (none on win32). */
  readProcessAges?: (pids: readonly number[]) => Promise<Map<number, number>>;
  /** Worktree paths a sibling DB references; throws when the DB cannot be read. Defaults to a readonly better-sqlite3 open. */
  readWorktreeRefs?: (dbPath: string) => string[];
  /** Real path of an existing path, null when it cannot be resolved. Defaults to `fs.realpath`. */
  realPath?: (p: string) => Promise<string | null>;
  now?: () => number;
}

export interface SiblingInstances {
  /** Live main-process pid → instance id, across every sibling data dir. */
  liveMainPids(): Promise<Map<number, string>>;
  /** Worktree ownership claims from the sibling DBs (cached for {@link CACHE_TTL_MS}). */
  worktreeClaims(): Promise<SiblingWorktreeClaims>;
  /** Drop every cached read: the next call re-scans and re-reads (never an in-flight older read). */
  invalidate(): void;
}

interface SiblingDir {
  dir: string;
  canonical: boolean;
  /** Liveness records whose pid is alive and not recycled. */
  live: InstanceRecord[];
  /** Some liveness record could not be read: whether an instance runs here is unknown. */
  livenessUnknown: boolean;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** True for "this sibling's schema predates the table": an empty claim, not an unreadable DB. */
function isMissingTable(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message);
}

/** Readonly open — never migrates, never writes; WAL readers do not block the owning app. */
export function readWorktreeRefsFromDb(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 250 });
  try {
    const refs: string[] = [];
    for (const table of ['sessions', 'workflow_runs']) {
      try {
        const rows = db
          .prepare(`SELECT worktree_path FROM ${table} WHERE worktree_path IS NOT NULL AND worktree_path != ''`)
          .all() as Array<{ worktree_path: string }>;
        for (const r of rows) refs.push(r.worktree_path);
      } catch (err) {
        if (!isMissingTable(err)) throw err;
      }
    }
    return refs;
  } finally {
    db.close();
  }
}

export async function defaultRealPath(p: string): Promise<string | null> {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

/** One `ps` call for every candidate pid; empty on win32 or failure (callers fall back to pid liveness). */
export async function readProcessAgesFromPs(pids: readonly number[]): Promise<Map<number, number>> {
  const ages = new Map<number, number>();
  if (pids.length === 0 || process.platform === 'win32') return ages;
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'pid=,etime=', '-p', pids.join(',')], { timeout: 5_000 });
    for (const line of stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
      if (!m) continue;
      const secs = parseEtime(m[2]);
      if (secs !== null) ages.set(Number(m[1]), secs);
    }
  } catch {
    // ps exits 1 when none of the pids exist; any failure just means "age unknown".
  }
  return ages;
}

export function createSiblingInstances(deps: SiblingInstanceDeps): SiblingInstances {
  const home = deps.homeDir ?? os.homedir();
  const selfDir = path.resolve(deps.selfDataDir);
  const readRefs = deps.readWorktreeRefs ?? readWorktreeRefsFromDb;
  const now = deps.now ?? Date.now;
  const readAges = deps.readProcessAges ?? readProcessAgesFromPs;
  const realPath = deps.realPath ?? defaultRealPath;
  /** Bumped by invalidate(); a cache entry is served only to callers of the generation that started its read. */
  let generation = 0;

  /** Every `~/.cyboflow*` dir but this one, with its records that are verifiably live. */
  const scanUncached = async (): Promise<SiblingDir[]> => {
    let names: string[];
    try {
      names = await fsp.readdir(home);
    } catch {
      return [];
    }
    const dirs: Array<{ dir: string; canonical: boolean; alive: InstanceRecord[]; livenessUnknown: boolean }> = [];
    for (const name of names) {
      if (!name.startsWith(DATA_DIR_PREFIX)) continue;
      const dir = path.join(home, name);
      if (path.resolve(dir) === selfDir || !(await isDirectory(dir))) continue;
      const { records, incomplete } = await deps.readInstanceRecords(path.join(dir, 'instances'));
      dirs.push({
        dir,
        canonical: (CANONICAL_DATA_DIR_NAMES as readonly string[]).includes(name),
        alive: records.filter((r) => deps.isPidAlive(r.pid)),
        livenessUnknown: incomplete,
      });
    }
    const ages = await readAges([...new Set(dirs.flatMap((d) => d.alive.map((r) => r.pid)))]);
    const at = now();
    const notRecycled = (r: InstanceRecord): boolean => {
      const age = ages.get(r.pid);
      const startedAt = Date.parse(r.startedAt);
      if (age === undefined || Number.isNaN(startedAt)) return true;
      return at - age * 1000 <= startedAt + START_SKEW_MS;
    };
    return dirs.map(({ dir, canonical, alive, livenessUnknown }) => ({
      dir,
      canonical,
      live: alive.filter(notRecycled),
      livenessUnknown,
    }));
  };

  const fresh = (entry: { at: number; gen: number } | null): boolean =>
    entry !== null && entry.gen === generation && now() - entry.at < CACHE_TTL_MS;

  let scanCache: { at: number; gen: number; dirs: SiblingDir[] } | null = null;
  const scan = async (): Promise<SiblingDir[]> => {
    if (scanCache && fresh(scanCache)) return scanCache.dirs;
    const gen = generation;
    const dirs = await scanUncached();
    if (gen === generation) scanCache = { at: now(), gen, dirs };
    return dirs;
  };

  let cached: { at: number; gen: number; claims: SiblingWorktreeClaims } | null = null;

  return {
    async liveMainPids() {
      const pids = new Map<number, string>();
      for (const { live } of await scan()) {
        for (const r of live) if (!pids.has(r.pid)) pids.set(r.pid, r.instanceId);
      }
      return pids;
    },

    async worktreeClaims() {
      if (cached && fresh(cached)) return cached.claims;
      const gen = generation;
      const claimedPaths = new Map<string, string>();
      const unreadableDataDirs: string[] = [];
      for (const { dir, canonical, live, livenessUnknown } of await scan()) {
        // A dead smoke dir's rows are abandoned: only canonical variants (running or
        // not — the user reopens them), currently-running dirs, and dirs whose liveness
        // cannot be read (maybe running) can still own a worktree.
        if (!canonical && live.length === 0 && !livenessUnknown) continue;
        const dbPath = path.join(dir, DB_FILE);
        if (!(await fileExists(dbPath))) continue;
        try {
          for (const p of readRefs(dbPath)) if (!claimedPaths.has(p)) claimedPaths.set(p, dir);
        } catch {
          unreadableDataDirs.push(dir);
        }
      }
      // Also key every claim by its real path, so an alias of git's spelling still matches.
      const stored = [...claimedPaths];
      const reals = await Promise.all(stored.map(([p]) => realPath(p)));
      stored.forEach(([, dir], i) => {
        const real = reals[i];
        if (real !== null && !claimedPaths.has(real)) claimedPaths.set(real, dir);
      });
      const claims: SiblingWorktreeClaims = { claimedPaths, unreadableDataDirs };
      if (gen === generation) cached = { at: now(), gen, claims };
      return claims;
    },

    invalidate() {
      generation += 1;
      scanCache = null;
      cached = null;
    },
  };
}
