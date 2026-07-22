/**
 * Reverse backlog-entity -> workflow-run associations used by destructive
 * lifecycle follow-ons. Every query arm is independently fail-soft so an older
 * schema can still return associations available through its remaining arms.
 *
 * Standalone-typecheck invariant: this module depends only on DatabaseLike.
 */
import type { TaskType } from '../../../shared/types/tasks';
import type { DatabaseLike } from './types';

function addRunRows(runIds: Set<string>, rows: Array<{ runId: unknown }>): void {
  for (const row of rows) {
    if (typeof row.runId === 'string' && row.runId.length > 0) runIds.add(row.runId);
  }
}

function collectRunRows(
  db: DatabaseLike,
  runIds: Set<string>,
  sql: string,
  ...params: unknown[]
): void {
  try {
    addRunRows(runIds, db.prepare(sql).all(...params) as Array<{ runId: unknown }>);
  } catch {
    // Missing table/column or a failed read contributes no associations.
  }
}

function listTaskRunIds(db: DatabaseLike, taskId: string): string[] {
  const runIds = new Set<string>();

  collectRunRows(
    db,
    runIds,
    'SELECT DISTINCT id AS runId FROM workflow_runs WHERE task_id = ?',
    taskId,
  );
  collectRunRows(
    db,
    runIds,
    `SELECT DISTINCT wr.id AS runId
       FROM workflow_runs wr
       JOIN sprint_batch_tasks sbt ON sbt.batch_id = wr.batch_id
      WHERE sbt.task_id = ?`,
    taskId,
  );

  return [...runIds];
}

function listIdeaRunIds(db: DatabaseLike, ideaId: string): string[] {
  const runIds = new Set<string>();

  collectRunRows(
    db,
    runIds,
    'SELECT DISTINCT id AS runId FROM workflow_runs WHERE seed_idea_id = ?',
    ideaId,
  );

  // Parse the migration-061 JSON array in TypeScript so one corrupt legacy row
  // cannot make SQLite's json_each abort the entire association read.
  try {
    const rows = db
      .prepare(
        'SELECT id AS runId, seed_idea_ids AS seedIdeaIds FROM workflow_runs WHERE seed_idea_ids IS NOT NULL',
      )
      .all() as Array<{ runId: unknown; seedIdeaIds: unknown }>;
    for (const row of rows) {
      if (typeof row.runId !== 'string' || typeof row.seedIdeaIds !== 'string') continue;
      try {
        const parsed: unknown = JSON.parse(row.seedIdeaIds);
        if (Array.isArray(parsed) && parsed.includes(ideaId)) runIds.add(row.runId);
      } catch {
        // Corrupt seed JSON contributes nothing; other rows still resolve.
      }
    }
  } catch {
    // Pre-061 schema — seed_idea_id and event-lineage arms still apply.
  }

  // A run can own or operate on an idea through events on the idea itself or
  // through run-created descendants that point back to it.
  collectRunRows(
    db,
    runIds,
    `SELECT DISTINCT run_id AS runId
       FROM entity_events
      WHERE entity_type = 'idea' AND entity_id = ? AND run_id IS NOT NULL`,
    ideaId,
  );
  collectRunRows(
    db,
    runIds,
    `SELECT DISTINCT ev.run_id AS runId
       FROM entity_events ev
       JOIN epics e ON e.id = ev.entity_id
      WHERE ev.entity_type = 'epic' AND e.originating_idea_id = ?
        AND ev.run_id IS NOT NULL`,
    ideaId,
  );
  collectRunRows(
    db,
    runIds,
    `SELECT DISTINCT ev.run_id AS runId
       FROM entity_events ev
       JOIN tasks t ON t.id = ev.entity_id
       LEFT JOIN epics e ON e.id = t.parent_epic_id
      WHERE ev.entity_type = 'task'
        AND COALESCE(t.originating_idea_id, e.originating_idea_id) = ?
        AND ev.run_id IS NOT NULL`,
    ideaId,
  );

  return [...runIds];
}

function listEpicRunIds(db: DatabaseLike, epicId: string): string[] {
  const runIds = new Set<string>();
  try {
    const children = db
      .prepare('SELECT id FROM tasks WHERE parent_epic_id = ?')
      .all(epicId) as Array<{ id: unknown }>;
    for (const child of children) {
      if (typeof child.id !== 'string') continue;
      for (const runId of listTaskRunIds(db, child.id)) runIds.add(runId);
    }
  } catch {
    // Missing tasks table/column or a failed read means no child associations.
  }
  return [...runIds];
}

/** Resolve every distinct workflow run associated with an entity. Never throws. */
export function listRunIdsForEntity(
  db: DatabaseLike,
  entityType: TaskType,
  entityId: string,
): string[] {
  try {
    if (entityType === 'task') return listTaskRunIds(db, entityId);
    if (entityType === 'idea') return listIdeaRunIds(db, entityId);
    return listEpicRunIds(db, entityId);
  } catch {
    return [];
  }
}
