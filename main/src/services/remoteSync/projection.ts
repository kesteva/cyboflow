/**
 * The SYNCED PROJECTION of a project's backlog: exactly what this machine
 * would hold on the server for each idea/epic/task, field by field.
 *
 * The engine diffs this against the per-field base every pass (desktop doc,
 * "Engine"), so it must be a pure function of the entity tables: no event log,
 * no updated_at heuristics. Values are wire values (snake_case field names,
 * the server's reference fields `parent_epic_id` / `originating_idea_id` /
 * `depends_on` included).
 *
 * What syncs (overview, "What syncs"): the content fields, the stage as a
 * board-position KEY, the archive/approval/retire stamps, lineage, executor,
 * created_at and, on tasks, `depends_on`. Experiment-sandbox rows never sync.
 *
 * Derived stages never sync:
 *   - a task in the orchestrator-derived "In development" (7) projects its
 *     entry stage (falling back to "Ready for development"), because a machine
 *     with no run for the task would revert it there anyway;
 *   - an epic in 6 or 9 projects `rollup`: the rollup owns those two stages,
 *     so every machine derives the same result from the synced children.
 */
import type { DatabaseLike } from '../../orchestrator/types';
import type { TaskType } from '../../../../shared/types/tasks';

export type SyncedEntityType = TaskType;

/** One entity's synced projection. */
export interface ProjectedEntity {
  entityType: SyncedEntityType;
  entityId: string;
  ref: string;
  fields: Record<string, unknown>;
  /** Local updated_at, the edit-time fallback for a field whose change no listener saw. */
  updatedAt: string | null;
}

/** The stage value an epic projects while the rollup owns its stage. */
export const ROLLUP_STAGE_KEY = 'rollup';

const IN_DEVELOPMENT_POSITION = 7;
const READY_FOR_DEV_POSITION = 6;
const DONE_POSITION = 9;

/** Synced fields per entity type, in a stable order. */
export const SYNCED_FIELDS: Record<SyncedEntityType, readonly string[]> = {
  idea: [
    'title', 'summary', 'body', 'scope', 'priority', 'category', 'repo', 'stage',
    'archived_at', 'sort_order', 'decomposed_at', 'created_at',
  ],
  epic: [
    'title', 'summary', 'body', 'priority', 'category', 'repo', 'stage',
    'archived_at', 'sort_order', 'approved_at', 'originating_idea_id', 'created_at',
  ],
  task: [
    'title', 'summary', 'body', 'priority', 'category', 'repo', 'stage',
    'archived_at', 'sort_order', 'approved_at', 'parent_epic_id', 'originating_idea_id',
    'executor', 'created_at', 'depends_on',
  ],
};

/** Fields whose value names another entity (they apply only once it exists). */
export const REFERENCE_FIELDS = ['parent_epic_id', 'originating_idea_id', 'depends_on'] as const;

/** Fields the router guards with the active-run check (applied in their own call). */
export const GUARDED_FIELDS = ['stage', 'archived_at'] as const;

export const ENTITY_TABLE: Record<SyncedEntityType, 'ideas' | 'epics' | 'tasks'> = {
  idea: 'ideas',
  epic: 'epics',
  task: 'tasks',
};

/** Apply order: parents before children. */
export const APPLY_ORDER: readonly SyncedEntityType[] = ['idea', 'epic', 'task'];

export function isSyncedEntityType(value: string): value is SyncedEntityType {
  return value === 'idea' || value === 'epic' || value === 'task';
}

export type DependsOnValue = Array<{ id: string; kind: 'blocking' | 'related' }>;

interface EntityRow {
  id: string;
  ref: string;
  title: string;
  summary: string | null;
  body: string | null;
  scope?: string | null;
  priority: string;
  category: string;
  repo: string | null;
  stage_position: number | null;
  entry_position?: number | null;
  archived_at: string | null;
  sort_order: number | null;
  decomposed_at?: string | null;
  approved_at?: string | null;
  parent_epic_id?: string | null;
  originating_idea_id?: string | null;
  executor?: string | null;
  created_at: string | null;
  updated_at: string | null;
}

const SELECTS: Record<SyncedEntityType, string> = {
  idea: `SELECT e.id, e.ref, e.title, e.summary, e.body, e.scope, e.priority, e.category, e.repo,
                s.position AS stage_position, e.archived_at, e.sort_order, e.decomposed_at,
                e.created_at, e.updated_at
           FROM ideas e LEFT JOIN board_stages s ON s.id = e.stage_id
          WHERE e.project_id = ? AND e.experiment_id IS NULL`,
  epic: `SELECT e.id, e.ref, e.title, e.summary, e.body, e.priority, e.category, e.repo,
                s.position AS stage_position, e.archived_at, e.sort_order, e.approved_at,
                e.originating_idea_id, e.created_at, e.updated_at
           FROM epics e LEFT JOIN board_stages s ON s.id = e.stage_id
          WHERE e.project_id = ? AND e.experiment_id IS NULL`,
  task: `SELECT e.id, e.ref, e.title, e.summary, e.body, e.priority, e.category, e.repo,
                s.position AS stage_position, es.position AS entry_position, e.archived_at,
                e.sort_order, e.approved_at, e.parent_epic_id, e.originating_idea_id, e.executor,
                e.created_at, e.updated_at
           FROM tasks e
           LEFT JOIN board_stages s ON s.id = e.stage_id
           LEFT JOIN board_stages es ON es.id = e.entry_stage_id
          WHERE e.project_id = ? AND e.experiment_id IS NULL`,
};

/** The stage key an entity projects (see the module header). */
export function projectStageKey(
  type: SyncedEntityType,
  position: number | null,
  entryPosition: number | null,
): string | null {
  if (position === null) return null;
  if (type === 'epic' && (position === READY_FOR_DEV_POSITION || position === DONE_POSITION)) {
    return ROLLUP_STAGE_KEY;
  }
  if (type === 'task' && position === IN_DEVELOPMENT_POSITION) {
    return String(entryPosition ?? READY_FOR_DEV_POSITION);
  }
  return String(position);
}

function toFields(type: SyncedEntityType, row: EntityRow, dependsOn: DependsOnValue | undefined): Record<string, unknown> {
  const all: Record<string, unknown> = {
    title: row.title,
    summary: row.summary,
    body: row.body,
    scope: row.scope ?? null,
    priority: row.priority,
    category: row.category,
    repo: row.repo,
    stage: projectStageKey(type, row.stage_position, row.entry_position ?? null),
    archived_at: row.archived_at,
    sort_order: row.sort_order,
    decomposed_at: row.decomposed_at ?? null,
    approved_at: row.approved_at ?? null,
    parent_epic_id: row.parent_epic_id ?? null,
    originating_idea_id: row.originating_idea_id ?? null,
    executor: row.executor ?? null,
    created_at: row.created_at,
    depends_on: dependsOn ?? [],
  };
  const fields: Record<string, unknown> = {};
  for (const f of SYNCED_FIELDS[type]) fields[f] = all[f];
  return fields;
}

/** depends_on per blocked task, sorted by prerequisite id so equal sets compare equal. */
function readDependsOn(db: DatabaseLike, projectId: number): Map<string, DependsOnValue> {
  const rows = db
    .prepare(
      `SELECT d.task_id AS taskId, d.depends_on_task_id AS id, d.kind
         FROM task_dependencies d
         JOIN tasks t ON t.id = d.task_id
        WHERE t.project_id = ? AND t.experiment_id IS NULL
        ORDER BY d.task_id, d.depends_on_task_id`,
    )
    .all(projectId) as Array<{ taskId: string; id: string; kind: 'blocking' | 'related' }>;
  const out = new Map<string, DependsOnValue>();
  for (const r of rows) {
    const list = out.get(r.taskId) ?? [];
    list.push({ id: r.id, kind: r.kind });
    out.set(r.taskId, list);
  }
  return out;
}

/** Normalize a depends_on value from the wire: sorted, deduped, well-formed entries only. */
export function normalizeDependsOn(value: unknown): DependsOnValue | null {
  if (!Array.isArray(value)) return null;
  const byId = new Map<string, 'blocking' | 'related'>();
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { id, kind } = entry as { id?: unknown; kind?: unknown };
    if (typeof id !== 'string' || (kind !== 'blocking' && kind !== 'related')) return null;
    byId.set(id, kind);
  }
  return [...byId.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, kind]) => ({ id, kind }));
}

/** Read the synced projection of every live (non-experiment) entity in a project. */
export function readProjection(db: DatabaseLike, projectId: number): Map<string, ProjectedEntity> {
  const out = new Map<string, ProjectedEntity>();
  const dependsOn = readDependsOn(db, projectId);
  for (const type of APPLY_ORDER) {
    const rows = db.prepare(SELECTS[type]).all(projectId) as EntityRow[];
    for (const row of rows) {
      out.set(row.id, {
        entityType: type,
        entityId: row.id,
        ref: row.ref,
        fields: toFields(type, row, type === 'task' ? dependsOn.get(row.id) : undefined),
        updatedAt: row.updated_at,
      });
    }
  }
  return out;
}

/** The projection of one entity, or null when it is gone or sandboxed. */
export function readEntityProjection(
  db: DatabaseLike,
  projectId: number,
  type: SyncedEntityType,
  entityId: string,
): ProjectedEntity | null {
  const row = db.prepare(`${SELECTS[type]} AND e.id = ?`).get(projectId, entityId) as EntityRow | undefined;
  if (!row) return null;
  let deps: DependsOnValue | undefined;
  if (type === 'task') {
    deps = (
      db
        .prepare(
          `SELECT depends_on_task_id AS id, kind FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id`,
        )
        .all(entityId) as DependsOnValue
    );
  }
  return {
    entityType: type,
    entityId,
    ref: row.ref,
    fields: toFields(type, row, deps),
    updatedAt: row.updated_at,
  };
}

/** Map a stage key back to this project's stage id (null = unknown key). */
export function stageIdForKey(db: DatabaseLike, projectId: number, key: string): string | null {
  if (!/^\d{1,3}$/.test(key)) return null;
  const row = db
    .prepare(
      `SELECT s.id FROM board_stages s
         JOIN boards b ON b.id = s.board_id
        WHERE b.project_id = ? AND b.is_default = 1 AND s.position = ?`,
    )
    .get(projectId, Number(key)) as { id: string } | undefined;
  return row?.id ?? null;
}
