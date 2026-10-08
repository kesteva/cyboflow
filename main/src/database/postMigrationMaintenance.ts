import type Database from 'better-sqlite3';
import { ensureRemoteSyncTriggers } from './remoteSyncTriggers';

/**
 * Boot work that must run AFTER every migration and reconciler
 * (DatabaseService.initialize's last step).
 */
export function runPostMigrationMaintenance(db: Database.Database): void {
  // Sync tombstone triggers live outside the migration files: any later table
  // rebuild of ideas/epics/tasks drops them, so they are re-created every boot.
  ensureRemoteSyncTriggers(db);
  maybeVacuumAfterBulkDelete(db);
}

/**
 * One-shot space reclaim after a bulk-delete migration (e.g. 072's
 * raw_events noise cleanup). SQLite returns deleted pages to its internal
 * freelist — future inserts reuse them, but the file never shrinks without
 * an explicit VACUUM (no auto_vacuum pragma is set). VACUUM cannot run
 * inside a transaction, so it cannot live in a migration file; it runs here,
 * gated on the freelist being both large in absolute terms AND a meaningful
 * share of the file. Normal boots evaluate three pragmas and return; the one
 * boot after a bulk delete pays the rewrite once, which drops the freelist
 * to ~0 and disarms the gate. Fail-soft: a VACUUM error (e.g. low disk for
 * the rewrite copy) must never block boot.
 */
export function maybeVacuumAfterBulkDelete(db: Database.Database): void {
  const MIN_FREE_BYTES = 50 * 1024 * 1024;
  const MIN_FREE_RATIO = 0.2;
  try {
    const pageCount = db.pragma('page_count', { simple: true }) as number;
    const freelistCount = db.pragma('freelist_count', { simple: true }) as number;
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    const freeBytes = freelistCount * pageSize;
    if (pageCount === 0 || freeBytes < MIN_FREE_BYTES || freelistCount / pageCount < MIN_FREE_RATIO) {
      return;
    }
    const startedAt = Date.now();
    db.exec('VACUUM');
    console.log(`[Database] VACUUM reclaimed ~${Math.round(freeBytes / 1048576)}MB in ${Date.now() - startedAt}ms`);
  } catch (err) {
    console.warn('[Database] Post-migration VACUUM skipped:', err);
  }
}
