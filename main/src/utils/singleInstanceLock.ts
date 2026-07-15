/**
 * singleInstanceLock — a data-dir-scoped "only one instance of this kind" guard.
 *
 * Electron's built-in `app.requestSingleInstanceLock()` keys on the app's
 * userData path (derived from the appId), which does NOT map to Cyboflow's data
 * directory: the stable release, the "Cyboflow Dev" DMG, and `pnpm dev` may have
 * overlapping or differing appIds, so that lock can neither (a) allow one of each
 * KIND to run in parallel nor (b) reliably block two of the SAME kind across
 * build variants. This lock instead lives INSIDE the resolved data directory
 * (`<dataDir>/instance.lock`), so "one holder per data dir" is exactly "one
 * instance per kind" once each kind owns its own dir (see cyboflowDirectory.ts).
 *
 * A stale lock (holder process gone — a crash left the file behind) is detected
 * via a liveness probe on the recorded pid and reclaimed. A genuinely live
 * holder is reported back so the caller can dialog-and-quit the new instance.
 *
 * Standalone invariant (mirrors the other utils here): only `fs`/`path` and a
 * type-only LoggerLike — no 'electron', no 'better-sqlite3', no service imports.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { LoggerLike } from '../orchestrator/types';

export interface InstanceLockDeps {
  /** This process's pid. Injectable for tests; defaults to `process.pid`. */
  pid?: number;
  /**
   * Liveness probe for a recorded holder pid. Injectable for tests; defaults to
   * a `process.kill(pid, 0)` check (EPERM ⇒ alive-but-not-ours, ESRCH ⇒ dead).
   */
  isProcessAlive?: (pid: number) => boolean;
  /** Optional structured logger (CLAUDE.md optional-logger rule: pass it). */
  logger?: LoggerLike;
}

export type InstanceLockResult =
  | { acquired: true; release: () => void }
  | { acquired: false; holderPid: number | null };

/** Default liveness probe: signal 0 tests existence without delivering a signal. */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH ⇒ no such process (dead). EPERM ⇒ exists but we can't signal it
    // (still alive — a different user/permission). Anything else: assume dead.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read the pid recorded in a lock file, or null if absent/unparseable. */
function readHolderPid(lockPath: string): number | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Try to acquire the single-instance lock for `dataDir`.
 *
 * - Success → `{ acquired: true, release }`. Call `release()` on quit; it only
 *   unlinks the file if it still records this process's pid (never clobbers a
 *   lock a successor already re-took).
 * - A live holder → `{ acquired: false, holderPid }`. The caller should inform
 *   the user and exit the new instance.
 *
 * A stale lock (dead holder, or an unparseable/empty file) is unlinked and the
 * acquire retried once. Unexpected filesystem errors FAIL OPEN — the lock is a
 * safety net, not a hard gate, and must never brick a launch — logging a warning
 * and returning a no-op-release success.
 */
export function acquireInstanceLock(dataDir: string, deps: InstanceLockDeps = {}): InstanceLockResult {
  const pid = deps.pid ?? process.pid;
  const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const lockPath = path.join(dataDir, 'instance.lock');

  const release = (): void => {
    // Only remove the file if it is still OURS — a successor that reclaimed a
    // stale lock must not have its file deleted by our late teardown.
    if (readHolderPid(lockPath) === pid) {
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        /* best-effort */
      }
    }
  };

  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    deps.logger?.warn('[Cyboflow InstanceLock] could not create data dir — failing open', {
      dataDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return { acquired: true, release: () => {} };
  }

  // At most two attempts: the second runs only after we reclaim a stale lock.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // O_EXCL create: succeeds iff the file did not exist.
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, String(pid));
      } finally {
        fs.closeSync(fd);
      }
      deps.logger?.debug('[Cyboflow InstanceLock] acquired', { dataDir, pid });
      return { acquired: true, release };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        deps.logger?.warn('[Cyboflow InstanceLock] unexpected lock error — failing open', {
          dataDir,
          error: err instanceof Error ? err.message : String(err),
        });
        return { acquired: true, release: () => {} };
      }

      // The file exists. Live holder ⇒ blocked; dead/unparseable ⇒ reclaim.
      const holderPid = readHolderPid(lockPath);
      if (holderPid !== null && holderPid !== pid && isAlive(holderPid)) {
        deps.logger?.warn('[Cyboflow InstanceLock] another instance holds the data dir', {
          dataDir,
          holderPid,
        });
        return { acquired: false, holderPid };
      }

      // Stale (or our own leftover): unlink and retry once.
      deps.logger?.info('[Cyboflow InstanceLock] reclaiming stale lock', { dataDir, holderPid });
      try {
        fs.rmSync(lockPath, { force: true });
      } catch (rmErr) {
        deps.logger?.warn('[Cyboflow InstanceLock] failed to unlink stale lock — failing open', {
          dataDir,
          error: rmErr instanceof Error ? rmErr.message : String(rmErr),
        });
        return { acquired: true, release: () => {} };
      }
    }
  }

  // Both attempts raced against another process re-creating the file. Treat the
  // current holder as live and back off rather than looping.
  const holderPid = readHolderPid(lockPath);
  return { acquired: false, holderPid };
}
