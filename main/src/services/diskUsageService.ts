/**
 * DiskUsageService — per-worktree `du -sk` sizing for the System view, governed by
 * the measured cost budget in docs/design/process-worktree-monitor.md.
 *
 * WHY THIS IS NOT ON THE POLL LOOP. One `du -sk` of a worktree costs ~0.46 s CPU
 * and 16 worktrees ~7.4 s; `du` does not warm-cache at this scale, so the only lever
 * is cadence. The rules baked in here:
 *   - concurrency 1, service-wide: a serial drain loop, never two `du` in flight;
 *   - lazy: a path is only measured once somebody asks about it (`getUsage`);
 *   - staggered: a short pause between consecutive measurements so a burst of
 *     requests for many worktrees doesn't run back-to-back;
 *   - long TTL ({@link DISK_USAGE_TTL_MS}): worktree size moves on installs/builds,
 *     not seconds; an expired entry is dropped and re-queued on the next request;
 *   - `invalidate(path)` expires an entry now (prune / removal);
 *   - `requestFresh(path)` jumps the queue (the reap manifest's reclaim figure).
 *
 * `node_modules` is deliberately NOT excluded: each worktree holds a genuine full
 * copy (no hardlinks), which is the largest reclaim lever the disk column exists for.
 *
 * The query surface is a discriminated union — `bytes` exists ONLY on `measured`
 * — so a UI can never render an unmeasured path as "0 MB". There is no stale
 * fallback either: an expired or invalidated path reads `queued`/`measuring`, not
 * its old number.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LoggerLike } from '../orchestrator/types';

const execFileAsync = promisify(execFile);

/** How long a measured size stays authoritative before the next request re-queues it. */
export const DISK_USAGE_TTL_MS = 5 * 60 * 1000;

/** Pause between consecutive measurements so many worktrees don't queue-flood. */
export const DISK_USAGE_STAGGER_MS = 250;

/** After a failed `du` (e.g. the path is already gone) wait this long before retrying it. */
export const DISK_USAGE_FAILURE_BACKOFF_MS = 30 * 1000;

/** Kill a `du` that runs longer than this — a stuck measurement must not wedge the serial queue. */
const DU_TIMEOUT_MS = 2 * 60 * 1000;

export type DiskUsageEntry =
  | { status: 'measured'; bytes: number; measuredAt: number }
  | { status: 'measuring' }
  | { status: 'queued' };

/** Measure one path, resolving its size in bytes. The real impl shells out to `du -sk`. */
export type DuRunner = (path: string) => Promise<number>;

export interface DiskUsageServiceOptions {
  /** Defaults to {@link defaultDuRunner} (`du -sk` via execFile). */
  runDu?: DuRunner;
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to a `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
  ttlMs?: number;
  staggerMs?: number;
  failureBackoffMs?: number;
  logger?: LoggerLike;
}

/** Parse `du -sk` output (`<kilobytes>\t<path>`) into bytes; throws on anything else. */
export function parseDuSkOutput(stdout: string): number {
  const match = /^\s*(\d+)\s/.exec(stdout);
  if (!match) throw new Error(`Unparseable du output: ${JSON.stringify(stdout.slice(0, 120))}`);
  return Number(match[1]) * 1024;
}

/**
 * Real runner: `du -sk -- <path>` via execFile, so the path is a positional argv
 * element and never parsed by a shell (same convention as utils/runGit.ts).
 */
export const defaultDuRunner: DuRunner = async (path) => {
  const { stdout } = await execFileAsync('du', ['-sk', '--', path], { timeout: DU_TIMEOUT_MS });
  return parseDuSkOutput(stdout);
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface InflightMeasurement {
  path: string;
  /** Invalidated mid-flight: the result predates the invalidation, so it is discarded. */
  stale: boolean;
  /** `requestFresh` arrived mid-flight: re-measure at the front of the queue afterwards. */
  requeueFront: boolean;
}

export class DiskUsageService {
  private readonly runDu: DuRunner;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ttlMs: number;
  private readonly staggerMs: number;
  private readonly failureBackoffMs: number;
  private readonly logger?: LoggerLike;

  private readonly cache = new Map<string, { bytes: number; measuredAt: number }>();
  private readonly failedAt = new Map<string, number>();
  private readonly queue: string[] = [];
  private inflight: InflightMeasurement | null = null;
  private draining = false;
  /** Callers of {@link measureFresh} parked until their path's fresh `du` settles. */
  private readonly freshWaiters = new Map<string, Array<(bytes: number | null) => void>>();

  constructor(opts: DiskUsageServiceOptions = {}) {
    this.runDu = opts.runDu ?? defaultDuRunner;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.ttlMs = opts.ttlMs ?? DISK_USAGE_TTL_MS;
    this.staggerMs = opts.staggerMs ?? DISK_USAGE_STAGGER_MS;
    this.failureBackoffMs = opts.failureBackoffMs ?? DISK_USAGE_FAILURE_BACKOFF_MS;
    this.logger = opts.logger;
  }

  /**
   * Current state of one path. A never-seen or expired path is queued for
   * measurement as a side effect and reads `queued` — never a value.
   */
  getUsage(path: string): DiskUsageEntry {
    const cached = this.cache.get(path);
    if (cached) {
      if (this.now() - cached.measuredAt < this.ttlMs) {
        return { status: 'measured', bytes: cached.bytes, measuredAt: cached.measuredAt };
      }
      this.cache.delete(path);
    }
    if (this.inflight?.path === path) return { status: 'measuring' };
    if (!this.queue.includes(path) && !this.inBackoff(path)) {
      this.queue.push(path);
      this.kick();
    }
    return { status: 'queued' };
  }

  /** Expire a path's cached entry immediately (e.g. after the worktree was removed). Does not queue a re-measure. */
  invalidate(path: string): void {
    this.cache.delete(path);
    this.failedAt.delete(path);
    if (this.inflight?.path === path) this.inflight.stale = true;
  }

  /** Measure a path ahead of every TTL-driven backlog entry, discarding any cached value. */
  requestFresh(path: string): DiskUsageEntry {
    this.cache.delete(path);
    this.failedAt.delete(path);
    if (this.inflight?.path === path) {
      this.inflight.stale = true;
      this.inflight.requeueFront = true;
      return { status: 'measuring' };
    }
    const at = this.queue.indexOf(path);
    if (at !== -1) this.queue.splice(at, 1);
    this.queue.unshift(path);
    this.kick();
    return { status: 'queued' };
  }

  /**
   * Awaitable {@link requestFresh}: jumps the queue, discards any cached value, and
   * resolves with the bytes of a `du` that STARTED after this call (`null` when it
   * failed, e.g. the path is gone). Still runs through the serial drain loop, so
   * the concurrency-1 rule holds. Used by the reap manifest, whose reclaim figure
   * must never come from the stale-tolerant cache.
   */
  measureFresh(path: string): Promise<number | null> {
    return new Promise<number | null>((resolve) => {
      const waiters = this.freshWaiters.get(path);
      if (waiters) waiters.push(resolve);
      else this.freshWaiters.set(path, [resolve]);
      this.requestFresh(path);
    });
  }

  private settleFreshWaiters(path: string, bytes: number | null): void {
    const waiters = this.freshWaiters.get(path);
    if (!waiters) return;
    this.freshWaiters.delete(path);
    for (const resolve of waiters) resolve(bytes);
  }

  private inBackoff(path: string): boolean {
    const failed = this.failedAt.get(path);
    if (failed === undefined) return false;
    if (this.now() - failed < this.failureBackoffMs) return true;
    this.failedAt.delete(path);
    return false;
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = true;
    void this.drain();
  }

  /** The serial drain loop — the single place a `du` is ever started. */
  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const path = this.queue.shift() as string;
        const job: InflightMeasurement = { path, stale: false, requeueFront: false };
        this.inflight = job;
        try {
          const bytes = await this.runDu(path);
          if (!job.stale) this.cache.set(path, { bytes, measuredAt: this.now() });
          // A requeued path is re-measured next; its waiters take that newer number.
          if (!job.requeueFront) this.settleFreshWaiters(path, bytes);
        } catch (err) {
          if (!job.stale) this.failedAt.set(path, this.now());
          if (!job.requeueFront) this.settleFreshWaiters(path, null);
          this.logger?.warn('diskUsageService: du failed', {
            path,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          this.inflight = null;
        }
        if (job.requeueFront) this.queue.unshift(path);
        if (this.queue.length > 0 && this.staggerMs > 0) await this.sleep(this.staggerMs);
      }
    } finally {
      this.draining = false;
    }
  }
}

/** The process-wide instance the worktree-removal hook and the System router share. */
export const diskUsageService = new DiskUsageService();
