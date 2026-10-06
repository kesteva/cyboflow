/**
 * Tombstone triggers for cross-machine backlog sync (desktop doc, M0 item 2).
 *
 * An AFTER DELETE on ideas/epics/tasks records a tombstone for the push step,
 * but only for a project that is opted in (a remote_sync_projects row) and
 * still exists, and never for an experiment-sandbox row. During a project's
 * own FK cascade the projects row is already gone, so removing a project
 * records nothing (verified on better-sqlite3's bundled SQLite, Phase 0 spike 2).
 *
 * Created here, after every migration run, rather than in migration 149: a
 * table-rebuild migration of ideas/epics/tasks (CREATE new / DROP / RENAME)
 * drops the table's triggers silently, and `CREATE TRIGGER IF NOT EXISTS` at
 * every boot restores them. To change a trigger body, rename it (the old name
 * then needs a DROP TRIGGER IF EXISTS here).
 */
import type Database from 'better-sqlite3';

export const REMOTE_SYNC_TOMBSTONE_TABLES = [
  { table: 'ideas', entityType: 'idea' },
  { table: 'epics', entityType: 'epic' },
  { table: 'tasks', entityType: 'task' },
] as const;

export function remoteSyncTriggerName(table: string): string {
  return `remote_sync_tombstone_${table}`;
}

export function remoteSyncTriggerSql(table: string, entityType: string): string {
  return `CREATE TRIGGER IF NOT EXISTS ${remoteSyncTriggerName(table)}
AFTER DELETE ON ${table}
WHEN OLD.experiment_id IS NULL
  AND EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
  AND EXISTS (SELECT 1 FROM remote_sync_projects WHERE project_id = OLD.project_id)
BEGIN
  INSERT OR REPLACE INTO remote_sync_tombstones (entity_type, entity_id, project_id, ref, deleted_at)
  VALUES ('${entityType}', OLD.id, OLD.project_id, OLD.ref, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END`;
}

/**
 * Create any missing tombstone trigger. A no-op when migration 149 hasn't run
 * (no remote_sync_tombstones table), so a partial test schema stays bootable.
 */
export function ensureRemoteSyncTriggers(db: Database.Database): void {
  const hasTable = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'remote_sync_tombstones'`)
    .get();
  if (!hasTable) return;
  for (const { table, entityType } of REMOTE_SYNC_TOMBSTONE_TABLES) {
    const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
    if (exists) db.exec(remoteSyncTriggerSql(table, entityType));
  }
}
