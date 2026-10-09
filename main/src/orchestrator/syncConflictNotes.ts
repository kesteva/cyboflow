/**
 * Open cross-machine sync conflicts, as an agent's read of an entity reports
 * them (desktop doc, "Conflicts (desktop)"): agents never resolve conflicts,
 * but they must not build on a value another machine's edit just overwrote.
 *
 * A plain read of remote_sync_conflicts, kept in the orchestrator layer so the
 * MCP handlers need nothing from services/remoteSync.
 */
import type { DatabaseLike } from './types';
import type { ConflictRecord } from '../../../shared/types/remoteSyncWire';

/**
 * What an agent's read of an entity says about its open sync conflicts: one
 * line each, so it does not build on a value that was just overwritten.
 * Empty when there are none (or before the sync tables exist).
 */
export function openConflictNotes(db: DatabaseLike, entityId: string): string[] {
  let rows: Array<{ record_json: string }>;
  try {
    rows = db
      .prepare(
        `SELECT record_json FROM remote_sync_conflicts
          WHERE entity_id = ? AND resolved_at IS NULL AND pending_resolution IS NULL ORDER BY COALESCE(seq, 0)`,
      )
      .all(entityId) as Array<{ record_json: string }>;
  } catch {
    return [];
  }
  return rows.map(({ record_json }) => {
    const r = JSON.parse(record_json) as ConflictRecord;
    const what =
      r.kind === 'field'
        ? `“${r.field ?? 'a field'}” was changed on two machines; one edit was applied and the other was set aside`
        : r.kind === 'delete_vs_edit'
          ? 'it was edited here while another machine deleted it'
          : r.kind === 'orphaned'
            ? 'its parent was deleted on another machine, so its children were detached'
            : r.kind === 'dependency_edge'
              ? 'a dependency was removed to break a cycle between machines'
              : `a sync conflict (${r.kind}) is open`;
    return `Open sync conflict: ${what}. A person reviews it; do not treat the current value as settled.`;
  });
}
