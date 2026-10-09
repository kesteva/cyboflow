/**
 * Sync conflicts, the user's side (proposal, "Conflicts"; desktop doc,
 * "Conflicts (desktop)").
 *
 * Conflicts already applied automatically; a record is what the user reviews.
 * A resolution is an ORDINARY EDIT made as the user, never a special merge
 * path: "Use the other value" and "Merge…" write through the router and push
 * like any edit; "Recreate" creates a new item from the lost values; "Keep"
 * writes nothing. Then the record is marked resolved here and the next pass
 * sends the resolution, which closes it on every machine.
 *
 * Agents never resolve conflicts; an agent's read of a conflicted item carries
 * a note (orchestrator/syncConflictNotes.ts) so it does not treat a
 * just-overwritten value as settled.
 */
import type { TaskChange, TaskChangeRouter } from '../../orchestrator/taskChangeRouter';
import type { DatabaseLike } from '../../orchestrator/types';
import type { ConflictRecord, ConflictSide } from '../../../../shared/types/remoteSyncWire';
import type {
  RemoteSyncConflict,
  RemoteSyncConflictAction,
  RemoteSyncConflictSide,
} from '../../../../shared/types/remoteSync';
import type { EntityCategory, IdeaScope, Priority, TaskExecutor } from '../../../../shared/types/tasks';
import { canonicalJson } from './canonical';
import { parseHlc } from './hlc';
import { APPLY_ORDER, ENTITY_TABLE, readEntityProjection, stageIdForKey, type SyncedEntityType } from './projection';
import type { SyncStore } from './syncStore';

/** Resolved conflicts stay listed this long (the server strips their values after 30 days). */
export const RESOLVED_CONFLICT_DAYS = 30;

/** Fields a "Use the other value" can write as the user. */
const WRITABLE_FIELDS = new Set([
  'title', 'summary', 'body', 'priority', 'category', 'repo', 'scope', 'executor', 'sort_order',
  'stage', 'archived_at', 'parent_epic_id', 'originating_idea_id',
]);
/** Text fields a merge can write. */
const MERGEABLE_FIELDS = new Set(['title', 'summary', 'body']);

const RESOLUTION: Record<string, Partial<Record<RemoteSyncConflictAction['kind'], string>>> = {
  field: { keep: 'keep_current', use_other: 'use_other', merge: 'merged' },
  delete_vs_edit: { keep: 'keep_deleted', recreate: 'recreated' },
  dependency_edge: { keep: 'keep_removed', swap: 'swapped' },
  orphaned: { keep: 'keep', move: 'moved', delete_children: 'deleted_children' },
};

export interface ConflictDeps {
  db: DatabaseLike;
  router: TaskChangeRouter;
  store: SyncStore;
  /** This computer's device id, while signed in. */
  deviceId: string | null;
  now: () => number;
}

/** The project's conflicts as the Conflicts view shows them. */
export function listConflictViews(deps: ConflictDeps, projectId: number, view: 'open' | 'resolved'): RemoteSyncConflict[] {
  const rows =
    view === 'open'
      ? deps.store.listConflictRows(projectId, { open: true })
      : deps.store.listConflictRows(projectId, { open: false, resolvedSince: deps.now() - RESOLVED_CONFLICT_DAYS * 86_400_000 });
  return rows.map((r) => toView(deps, projectId, r.record, r.resolvedAt, r.pendingResolution, r.entityType));
}

/** Settle a conflict as the user. The resolution reaches the server on the next pass. */
export async function resolveConflict(
  deps: ConflictDeps,
  conflictId: string,
  action: RemoteSyncConflictAction,
): Promise<{ ok: true; projectId: number } | { ok: false; message: string }> {
  const projectId = deps.store.conflictProject(conflictId);
  const row = projectId === null ? undefined : deps.store.listConflictRows(projectId, { open: true }).find((r) => r.record.id === conflictId);
  if (projectId === null || !row) return { ok: false, message: 'That conflict is already resolved' };
  if (row.pendingResolution) return { ok: true, projectId };
  const view = toView(deps, projectId, row.record, null, null, row.entityType);
  if (!view.actions.includes(action.kind)) return { ok: false, message: `“${action.kind}” does not apply to this conflict` };
  const resolution = RESOLUTION[view.kind]?.[action.kind];
  if (!resolution) return { ok: false, message: 'Unknown conflict kind' };
  try {
    await applyAction(deps, projectId, view, action);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  deps.store.setPendingResolution(conflictId, resolution);
  deps.store.appendLog(projectId, `conflict ${view.entityRef ?? view.entityId} resolved: ${resolution}`);
  return { ok: true, projectId };
}

// ---- internals ---------------------------------------------------------------

function toView(
  deps: ConflictDeps,
  projectId: number,
  r: ConflictRecord,
  resolvedAt: number | null,
  pendingResolution: string | null,
  storedType: SyncedEntityType | null,
): RemoteSyncConflict {
  const entityType = localTypeOf(deps.db, r.entityId) ?? storedType ?? entityTypeOf(deps.db, r);
  let changedSince = false;
  let currentNow: unknown = null;
  if (r.kind === 'field' && r.field && entityType) {
    const local = readEntityProjection(deps.db, projectId, entityType, r.entityId);
    if (local && r.field in local.fields) {
      currentNow = local.fields[r.field];
      changedSince = canonicalJson(currentNow) !== canonicalJson(r.current.value);
    }
  }
  return {
    id: r.id,
    projectId,
    entityId: r.entityId,
    entityType,
    entityRef: r.entityRef,
    entityTitle: typeof r.entityTitle === 'string' ? r.entityTitle : null,
    kind: r.kind,
    field: r.field ?? null,
    current: side(deps, r.current),
    other: side(deps, r.other),
    extra: r.extra ?? null,
    createdAt: r.createdAt,
    resolvedAt: resolvedAt ?? r.resolvedAt ?? null,
    resolution: r.resolution ?? null,
    pendingResolution,
    changedSince,
    currentNow,
    actions: actionsFor(deps.db, projectId, r, entityType),
  };
}

function side(deps: ConflictDeps, s: ConflictSide): RemoteSyncConflictSide {
  const hlc = s.hlc ? parseHlc(s.hlc) : null;
  return { value: s.value, device: s.device, thisDevice: s.device !== null && s.device === deps.deviceId, at: hlc?.ms ?? null };
}

function actionsFor(db: DatabaseLike, projectId: number, r: ConflictRecord, type: SyncedEntityType | null): RemoteSyncConflictAction['kind'][] {
  switch (r.kind) {
    case 'field': {
      const exists = type !== null && readEntityProjection(db, projectId, type, r.entityId) !== null;
      if (!exists || !r.field || !WRITABLE_FIELDS.has(r.field)) return ['keep'];
      return MERGEABLE_FIELDS.has(r.field) ? ['keep', 'use_other', 'merge'] : ['keep', 'use_other'];
    }
    case 'delete_vs_edit':
      return ['keep', 'recreate'];
    case 'orphaned':
      return childrenOf(r).length > 0 ? ['keep', 'move', 'delete_children'] : ['keep'];
    case 'dependency_edge': {
      const edges = edgesOf(r);
      const here = (e: Edge) => localTypeOf(db, e.taskId) === 'task' && localTypeOf(db, e.dependsOnId) === 'task';
      return edges && here(edges.removed) && here(edges.kept) ? ['keep', 'swap'] : ['keep'];
    }
    default:
      return ['keep'];
  }
}

async function applyAction(deps: ConflictDeps, projectId: number, c: RemoteSyncConflict, action: RemoteSyncConflictAction): Promise<void> {
  const { router, db } = deps;
  switch (action.kind) {
    case 'keep':
      return;
    case 'use_other':
    case 'merge': {
      if (!c.entityType || !c.field) throw new Error('This item is no longer here');
      const value = action.kind === 'merge' ? action.value : c.other.value;
      const change: TaskChange & { fields: NonNullable<TaskChange['fields']> } = {
        actor: 'user',
        entityType: c.entityType,
        taskId: c.entityId,
        fields: {},
      };
      fieldIntoChange(db, projectId, change, c.field, value);
      await router.applyChange(projectId, change);
      return;
    }
    case 'recreate': {
      const lost = (c.other.value && typeof c.other.value === 'object' ? c.other.value : {}) as Record<string, unknown>;
      const type = c.entityType ?? 'task';
      const title = typeof lost.title === 'string' ? lost.title : c.entityTitle ?? `Recreated ${c.entityRef ?? 'item'}`;
      const note = `Recreated from ${c.entityRef ?? c.entityId}, which was deleted on another machine while it was edited here.`;
      const body = typeof lost.body === 'string' && lost.body ? `${lost.body}\n\n${note}` : note;
      const change: TaskChange & { fields: NonNullable<TaskChange['fields']> } = {
        actor: 'user',
        entityType: type,
        fields: { title, body },
      };
      for (const f of ['summary', 'priority', 'category', 'repo', 'scope', 'executor']) {
        if (f in lost && lost[f] !== undefined) fieldIntoChange(db, projectId, change, f, lost[f]);
      }
      if (type !== 'idea') {
        for (const f of ['parent_epic_id', 'originating_idea_id']) {
          const target = lost[f];
          if (typeof target === 'string' && localTypeOf(db, target)) fieldIntoChange(db, projectId, change, f, target);
        }
      }
      await router.applyChange(projectId, change);
      return;
    }
    case 'move': {
      const parentType = localTypeOf(db, action.parentId);
      if (!parentType || parentType === 'task') throw new Error('Pick an idea or an epic as the new parent');
      for (const child of childrenOf(c)) {
        if (!localTypeOf(db, child.id)) continue;
        const change: TaskChange = { actor: 'user', entityType: child.type, taskId: child.id };
        if (parentType === 'epic' && child.type === 'task') change.parentEpicId = action.parentId;
        else if (parentType === 'idea' && child.type !== 'idea') change.originatingIdeaId = action.parentId;
        else throw new Error(`A ${child.type} cannot move under a ${parentType}`);
        await router.applyChange(projectId, change);
      }
      return;
    }
    case 'swap': {
      const edges = edgesOf(c);
      if (!edges) throw new Error('This conflict does not say which edge was kept');
      const edit = (e: Edge, removeDependency: boolean): TaskChange => ({
        actor: 'user',
        entityType: 'task',
        taskId: e.taskId,
        dependsOnTaskId: e.dependsOnId,
        removeDependency,
      });
      await router.applyChange(projectId, edit(edges.kept, true));
      try {
        await router.applyChange(projectId, edit(edges.removed, false));
      } catch (err) {
        // Restoring would close another cycle: put the kept edge back.
        await router.applyChange(projectId, edit(edges.kept, false));
        throw err;
      }
      return;
    }
    case 'delete_children': {
      for (const child of childrenOf(c)) {
        if (localTypeOf(db, child.id)) await router.applyDelete(projectId, { actor: 'user', taskId: child.id, entityType: child.type });
      }
      return;
    }
  }
}

/** Translate one synced field into the user edit that sets it. */
function fieldIntoChange(
  db: DatabaseLike,
  projectId: number,
  change: TaskChange & { fields: NonNullable<TaskChange['fields']> },
  field: string,
  value: unknown,
): void {
  switch (field) {
    case 'title':
      if (typeof value !== 'string' || !value.trim()) throw new Error('A title cannot be empty');
      change.fields.title = value;
      return;
    case 'summary':
    case 'body':
    case 'repo':
      change.fields[field] = typeof value === 'string' ? value : null;
      return;
    case 'priority':
      change.fields.priority = value as Priority;
      return;
    case 'category':
      change.fields.category = value as EntityCategory;
      return;
    case 'scope':
      change.fields.scope = value as IdeaScope | null;
      return;
    case 'executor':
      change.fields.executor = value as TaskExecutor;
      return;
    case 'sort_order':
      change.fields.sortOrder = typeof value === 'number' ? value : null;
      return;
    case 'stage': {
      const stageId = typeof value === 'string' ? stageIdForKey(db, projectId, value) : null;
      if (!stageId) throw new Error('That stage does not exist on this board');
      change.stageId = stageId;
      return;
    }
    case 'archived_at':
      change.archived = value !== null && value !== undefined;
      return;
    case 'parent_epic_id':
      change.parentEpicId = typeof value === 'string' ? value : null;
      return;
    case 'originating_idea_id':
      change.originatingIdeaId = typeof value === 'string' ? value : null;
      return;
    default:
      throw new Error(`“${field}” cannot be set from a conflict`);
  }
}

interface Edge {
  taskId: string;
  dependsOnId: string;
}

/** A dependency_edge record's removed and kept edges; null when either is missing. */
function edgesOf(c: Pick<ConflictRecord, 'extra'>): { removed: Edge; kept: Edge } | null {
  const extra = c.extra as { removedEdge?: Partial<Edge>; keptEdge?: Partial<Edge> } | null | undefined;
  const edge = (e: Partial<Edge> | undefined): Edge | null =>
    typeof e?.taskId === 'string' && typeof e.dependsOnId === 'string' ? { taskId: e.taskId, dependsOnId: e.dependsOnId } : null;
  const removed = edge(extra?.removedEdge);
  const kept = edge(extra?.keptEdge);
  return removed && kept ? { removed, kept } : null;
}

function childrenOf(c: Pick<ConflictRecord, 'extra'>): Array<{ id: string; type: SyncedEntityType }> {
  const extra = c.extra as { children?: Array<{ id?: unknown; type?: unknown }> } | null | undefined;
  return (extra?.children ?? []).flatMap((ch) =>
    typeof ch.id === 'string' && (ch.type === 'idea' || ch.type === 'epic' || ch.type === 'task') ? [{ id: ch.id, type: ch.type }] : [],
  );
}

function localTypeOf(db: DatabaseLike, id: string): SyncedEntityType | null {
  for (const type of APPLY_ORDER) {
    if (db.prepare(`SELECT 1 FROM ${ENTITY_TABLE[type]} WHERE id = ?`).get(id)) return type;
  }
  return null;
}

/**
 * The entity's type: from the row while it exists, else from its event history
 * (which outlives a delete), else from the lost fields only a task or idea has.
 */
function entityTypeOf(db: DatabaseLike, r: ConflictRecord): SyncedEntityType | null {
  const live = localTypeOf(db, r.entityId);
  if (live) return live;
  const ev = db.prepare(`SELECT entity_type FROM entity_events WHERE entity_id = ? AND entity_type IN ('idea','epic','task') LIMIT 1`).get(r.entityId) as
    | { entity_type: SyncedEntityType }
    | undefined;
  if (ev) return ev.entity_type;
  const lost = r.kind === 'delete_vs_edit' && r.other.value && typeof r.other.value === 'object' ? (r.other.value as Record<string, unknown>) : {};
  if ('executor' in lost || 'parent_epic_id' in lost || 'depends_on' in lost) return 'task';
  if ('scope' in lost || 'decomposed_at' in lost) return 'idea';
  return null;
}
