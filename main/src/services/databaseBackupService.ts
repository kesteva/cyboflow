/**
 * DatabaseBackupService — daily on-disk snapshots of `sessions.db` with a
 * 7-day retention window.
 *
 * WHY THIS EXISTS. `sessions.db` (better-sqlite3, WAL mode) is the ONLY copy
 * of a user's runs, backlog, and review queue. It can get corrupted — a hard
 * crash mid-write, a disk fault, a future migration bug — and there is
 * currently no recovery path except "hope for a Time Machine snapshot". This
 * service takes an independent, consistent daily snapshot so a corrupted live
 * database is never total loss.
 *
 * WHY HOURLY TICK + FILE-EXISTENCE GUARD, NOT A 24H TIMER. Electron apps
 * sleep and wake with the machine and may not be running at any particular
 * fixed hour — a `setInterval(24h)` armed at 11pm might never fire before the
 * user quits for the night, and after a wake from sleep Node's timers do not
 * reliably "catch up" a missed 24h boundary. Ticking hourly and asking
 * "does today's file already exist?" sidesteps both problems: the daily
 * backup happens on whatever hour the app happens to be running, and the
 * check is cheap (a single `existsSync`) on every tick after the day's
 * backup is already done. The backup FILES are the watermark — there is no
 * separate "last backed up" record to fall out of sync with reality.
 *
 * WHY `db.backup()`, NOT A FILE COPY. A plain copy of `sessions.db` in WAL
 * mode can capture a torn, inconsistent snapshot (the WAL file has pending
 * frames not yet checkpointed into the main file). better-sqlite3's
 * `Database#backup()` uses SQLite's online backup API — it produces a
 * complete, consistent snapshot regardless of WAL state, without blocking
 * writers, and runs on a background thread.
 *
 * WHY raw_events IS ARCHIVED SEPARATELY. `raw_events` is roughly 80% of the
 * database, so copying it into all seven retained backups is where this
 * directory's bulk comes from. It is NOT disposable — `raw_events` is the
 * source of truth for reconstructed chat history (no separate messages table
 * exists), the context-usage view, the run inspector, and Insights — so
 * it cannot simply be dropped. Instead it is stored ONCE: the table is
 * append-only with an AUTOINCREMENT id, so each tick appends the rows above
 * the previous high-water mark to an immutable delta file and the daily backup
 * carries none of them. Fidelity is unchanged; only the seven-fold duplication
 * goes away. See databaseBackupSnapshot.ts for the archive and
 * databaseBackupRestore.ts for the replay.
 *
 * WHY THE PROCESSING RUNS IN A WORKER. Archiving and VACUUMing are synchronous
 * better-sqlite3 work over a multi-gigabyte file; on the main thread they would
 * freeze the app for seconds, and the first tick fires during initialisation.
 *
 * WHY THE .partial RENAME. A crash or force-quit mid-backup must never leave
 * a file that looks like a finished backup — if it did, the next day's tick
 * would treat that day as already covered and silently skip it, and a
 * consumer of the backup would open a truncated database. Writing to
 * `<target>.partial` and only `renameSync`-ing to the final name once
 * `db.backup()` resolves means the file at the final name is atomically
 * either absent or complete.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type Database from 'better-sqlite3';
import type { LoggerLike } from '../orchestrator/types';
import type { ProcessSnapshotOptions, ProcessSnapshotResult } from './databaseBackupSnapshot';
import type { SnapshotWorkerMessage } from './databaseBackupWorker';

/** How often the tick runs. Cheap once today's backup already exists (see file doc). */
export const DATABASE_BACKUP_TICK_INTERVAL_MS = 60 * 60 * 1000;

/** How many daily backup files to keep. */
export const DATABASE_BACKUP_RETAIN_COUNT = 7;

/** Matches a finished daily backup filename exactly — never a `.partial`. */
const BACKUP_FILENAME_RE = /^sessions-\d{4}-\d{2}-\d{2}\.db$/;

/** Matches an in-progress backup or a sidecar left beside one. */
const PARTIAL_FILENAME_RE = /\.partial(-wal|-shm)?$/;

/**
 * Run {@link processSnapshot} on a worker thread. The compiled worker sits
 * beside this file in `dist`, which is what `__dirname` resolves to at runtime.
 */
function runSnapshotWorker(options: ProcessSnapshotOptions): Promise<ProcessSnapshotResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'databaseBackupWorker.js'), { workerData: options });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      fn();
    };
    worker.on('message', (message: SnapshotWorkerMessage) => {
      finish(() => {
        if (message.ok) resolve(message.result);
        else reject(new Error(message.error));
      });
    });
    worker.on('error', (err) => finish(() => reject(err)));
    worker.on('exit', (code) => finish(() => reject(new Error(`snapshot worker exited with code ${code}`))));
  });
}

export interface DatabaseBackupServiceOptions {
  /** The live better-sqlite3 connection to snapshot. */
  db: Database.Database;
  /** Absolute directory backups are written to. Created recursively as needed. */
  backupsDir: string;
  /**
   * Where immutable `raw_events` delta files live. Defaults to a `raw-events`
   * subdirectory of {@link backupsDir}. NOT subject to the daily retention:
   * these files are the only copy of that history outside the live database.
   */
  deltaDir?: string;
  /**
   * Override for the snapshot processor, so tests can run it in-process
   * instead of spawning a worker thread. Production always uses the worker.
   */
  processSnapshot?: (options: ProcessSnapshotOptions) => Promise<ProcessSnapshotResult>;
  /** Structured logger. Required — this service's only output is log lines. */
  logger: LoggerLike;
  /** Current wall-clock time. Injectable for deterministic tests. */
  now?: () => Date;
  /** Tick interval override. Defaults to {@link DATABASE_BACKUP_TICK_INTERVAL_MS}. */
  intervalMs?: number;
}

/** Timer handle carrying Node's `unref`, so this service can never keep the process alive. */
interface UnreffableTimer {
  unref?: () => void;
}

/** Zero-padded local-time `YYYY-MM-DD` for `date` — LOCAL day, not UTC. */
function localDateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Shape an arbitrary caught value into a `LoggerLike`-compatible context. */
function errorContext(err: unknown): Record<string, unknown> {
  return { error: err instanceof Error ? err.message : String(err) };
}

export class DatabaseBackupService {
  private readonly db: Database.Database;
  private readonly backupsDir: string;
  private readonly deltaDir: string;
  private readonly processSnapshot: (options: ProcessSnapshotOptions) => Promise<ProcessSnapshotResult>;
  private readonly logger: LoggerLike;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(opts: DatabaseBackupServiceOptions) {
    this.db = opts.db;
    this.backupsDir = opts.backupsDir;
    this.deltaDir = opts.deltaDir ?? path.join(opts.backupsDir, 'raw-events');
    this.processSnapshot = opts.processSnapshot ?? runSnapshotWorker;
    this.logger = opts.logger;
    this.now = opts.now ?? (() => new Date());
    this.intervalMs = opts.intervalMs ?? DATABASE_BACKUP_TICK_INTERVAL_MS;
  }

  /**
   * Fire one tick immediately, then a recurring tick every {@link intervalMs}.
   * The interval is `unref`'d — this service must never be the reason the
   * app's event loop stays alive. Idempotent: a second call while already
   * running is a no-op.
   */
  start(): void {
    if (this.timer !== null) return;
    void this.tick();
    const timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    (timer as unknown as UnreffableTimer).unref?.();
    this.timer = timer;
  }

  /** Cancel the recurring tick. Idempotent. */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Run one backup pass. Public (not just interval-private) so tests can
   * drive it directly without waiting on the timer. Fail-soft throughout:
   * any error is logged and this returns, never throws — a backup failure
   * must never take down the app that is trying to protect itself.
   */
  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const today = localDateStamp(this.now());
      const targetPath = path.join(this.backupsDir, `sessions-${today}.db`);

      if (fs.existsSync(targetPath)) return;

      fs.mkdirSync(this.backupsDir, { recursive: true });

      // Sweep stale partials. Only one tick runs at a time in-process
      // (inFlight guard) and the app itself holds a single-instance lock, so
      // any `.partial` present at tick start is a dead leftover from a crash
      // mid-backup, never a concurrent in-progress write.
      this.sweepStalePartials();

      const partialPath = `${targetPath}.partial`;
      try {
        await this.db.backup(partialPath);
      } catch (err) {
        this.discardPartial(partialPath);
        this.logger.error('[DatabaseBackup] backup failed', errorContext(err));
        return;
      }

      try {
        const result = await this.processSnapshot({ snapshotPath: partialPath, deltaDir: this.deltaDir });
        fs.renameSync(partialPath, targetPath);
        this.logger.info(
          `[DatabaseBackup] wrote daily backup to ${targetPath}`,
          {
            lineage: result.lineage,
            lineageMinted: result.lineageMinted,
            archivedRows: result.archivedRows,
            shardFile: result.shardPath ?? 'none',
            watermark: result.watermark,
            bytesReclaimed: result.bytesReclaimed,
          },
        );
      } catch (err) {
        // The partial may be half-processed — rows archived but not yet
        // stripped, or stripped but not compacted — so it is NOT a full copy
        // and must never be published as one. Throw it away and take a clean
        // unprocessed snapshot instead: an oversized backup is still a
        // complete backup, and losing the day's snapshot over a disk-space
        // optimisation would be exactly backwards.
        this.logger.error('[DatabaseBackup] snapshot processing failed', errorContext(err));
        this.discardPartial(partialPath);
        try {
          await this.db.backup(partialPath);
          fs.renameSync(partialPath, targetPath);
          this.logger.info(`[DatabaseBackup] wrote UNPROCESSED full daily backup to ${targetPath}`);
        } catch (fallbackErr) {
          this.discardPartial(partialPath);
          this.logger.error('[DatabaseBackup] full-copy fallback failed', errorContext(fallbackErr));
          return;
        }
      }

      this.prune();
    } catch (err) {
      this.logger.error('[DatabaseBackup] tick failed', errorContext(err));
    } finally {
      this.inFlight = false;
    }
  }

  /** Best-effort removal of a partial that must not be published. */
  private discardPartial(partialPath: string): void {
    try {
      if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
    } catch {
      // best-effort cleanup only
    }
  }

  /** Delete any leftover `*.partial` files in {@link backupsDir}. */
  private sweepStalePartials(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.backupsDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      // `-wal`/`-shm` too: processing OPENS the partial, so a crash during
      // that step leaves sidecars beside it that `.partial` alone would not
      // match, and they would orphan forever.
      if (!PARTIAL_FILENAME_RE.test(entry)) continue;
      try {
        fs.unlinkSync(path.join(this.backupsDir, entry));
      } catch (err) {
        this.logger.error(`[DatabaseBackup] failed to sweep stale partial ${entry}`, errorContext(err));
      }
    }
  }

  /** Keep the {@link DATABASE_BACKUP_RETAIN_COUNT} newest daily backups; delete the rest. */
  private prune(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.backupsDir);
    } catch (err) {
      this.logger.error('[DatabaseBackup] failed to list backups dir for pruning', errorContext(err));
      return;
    }

    // ISO date filenames sort correctly lexicographically — descending here
    // puts the newest first.
    const backups = entries.filter((f) => BACKUP_FILENAME_RE.test(f)).sort().reverse();

    for (const stale of backups.slice(DATABASE_BACKUP_RETAIN_COUNT)) {
      // The backup inherits WAL journal mode, so an external tool that opened
      // it (e.g. sqlite3 for a restore dry-run) leaves `-wal`/`-shm` sidecars
      // beside it — prune those with their backup or they orphan forever.
      for (const suffix of ['', '-wal', '-shm']) {
        const target = path.join(this.backupsDir, `${stale}${suffix}`);
        try {
          if (suffix === '' || fs.existsSync(target)) fs.unlinkSync(target);
        } catch (err) {
          this.logger.error(`[DatabaseBackup] failed to prune stale backup ${stale}${suffix}`, errorContext(err));
        }
      }
    }
  }
}
