/**
 * Windows-safe cleanup for test dirs holding better-sqlite3 files.
 *
 * On POSIX, rmSync happily deletes files a Database still holds open. On
 * Windows an open Database keeps its files undeletable until V8 finalizes the
 * object — an afterEach that races the finalizer gets EPERM. rmDbTestDir: try
 * a plain delete first; on a Windows sharing violation, RENAME the dir out of
 * the way (renaming needs no access to the open files) and delete the renamed
 * copy best-effort. If the finalizer has not run yet, the renamed dir carries
 * a `.dbtest-leak-` marker and the next sweep call removes it — the test
 * result stays green and nothing accumulates beyond a finalizer-lag window.
 */
import { readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const LEASE_MARKER = '.dbtest-leak-';

export function rmDbTestDir(dir: string | undefined | null): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch (err) {
    // POSIX failures are real failures (the rename fallback below would only
    // hide them); Windows EPERM from an un-finalized handle is the race this
    // helper exists for.
    if (process.platform !== 'win32') throw err;
  }
  const renamed = `${dir}${LEASE_MARKER}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    renameSync(dir, renamed);
  } catch {
    return; // could not even rename — leave it for the sweep
  }
  try {
    rmSync(renamed, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // Finalizer lag — the next sweep collects it.
  }
}

/** Best-effort removal of earlier `.dbtest-leak-` dirs under `parent`. */
export function sweepLeakedDbTestDirs(parent: string): void {
  // The `.dbtest-leak-` marker this sweeps for is only ever written by the
  // win32 rename fallback above — on POSIX, rmDbTestDir's plain rmSync either
  // succeeds or throws, so no marker can exist to find. Without this gate,
  // every afterEach in ~20 suites pays a readdirSync of the whole $TMPDIR on
  // macOS/Linux for a marker that never appears.
  if (process.platform !== 'win32') return;
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.includes(LEASE_MARKER)) continue;
    try {
      rmSync(join(parent, name), { recursive: true, force: true });
    } catch {
      // Finalizer still pending — a later sweep tries again.
    }
  }
}
