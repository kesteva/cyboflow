/**
 * APPLY: turn inbox entries (remote values pulled but not yet applied) into
 * router writes, per the desktop doc's apply rules.
 *
 *   - A field applies only when it is NOT dirty locally (L[f] equals B[f]);
 *     otherwise it waits as `shadow` and the next push settles it at the server.
 *   - A field naming an entity that is not here yet waits as `missing_ref`.
 *   - A value the local schema cannot hold waits as `unsupported`.
 *   - Stage and archive go in their own router call, so a live run holds only
 *     those (`deferred`) while the content still applies.
 *   - On success B[f] := I[f] and the entry is dropped. B never moves before
 *     the local value actually reflects the server's.
 *   - Order: ideas, epics, tasks; then depends_on; then deletes, children first.
 *
 * Every write carries actor 'cyboflow-remote' and no runId; see the router's
 * remote-apply mode. The listener and the projection diff never echo these.
 */
import type { TaskChangeRouter, TaskChange, RemoteApplyFields } from '../../orchestrator/taskChangeRouter';
import { TaskChangeError } from '../../orchestrator/taskChangeRouter';
import type { DatabaseLike } from '../../orchestrator/types';
import type { EntityCategory, IdeaScope, Priority, TaskExecutor } from '../../../../shared/types/tasks';
import { canonicalJson } from './canonical';
import { compareHlc } from './hlc';
import {
  APPLY_ORDER,
  ENTITY_TABLE,
  GUARDED_FIELDS,
  ROLLUP_STAGE_KEY,
  SYNCED_FIELDS,
  normalizeDependsOn,
  readEntityProjection,
  readProjection,
  stageIdForKey,
  type DependsOnValue,
  type ProjectedEntity,
  type SyncedEntityType,
} from './projection';
import type { InboxField, InboxReason, SyncEntityState, SyncStore } from './syncStore';
import { clientConflictId } from './conflictIds';

const PRIORITIES: readonly Priority[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
const CATEGORIES: readonly EntityCategory[] = ['feature', 'bug', 'chore'];
const SCOPES: readonly IdeaScope[] = ['small', 'large'];
const EXECUTORS: readonly TaskExecutor[] = ['agent', 'human'];

const isNullableString = (v: unknown): boolean => v === null || typeof v === 'string';

/** Whether a remote value fits the local schema (else it parks `unsupported`). */
function validValue(field: string, value: unknown): boolean {
  switch (field) {
    case 'title':
      return typeof value === 'string';
    case 'summary':
    case 'body':
    case 'repo':
    case 'archived_at':
    case 'approved_at':
    case 'decomposed_at':
    case 'parent_epic_id':
    case 'originating_idea_id':
    case 'created_at':
      return isNullableString(value);
    case 'priority':
      return PRIORITIES.includes(value as Priority);
    case 'category':
      return CATEGORIES.includes(value as EntityCategory);
    case 'scope':
      return value === null || SCOPES.includes(value as IdeaScope);
    case 'executor':
      return EXECUTORS.includes(value as TaskExecutor);
    case 'sort_order':
      return value === null || (typeof value === 'number' && Number.isFinite(value));
    case 'stage':
      return typeof value === 'string';
    case 'depends_on':
      return normalizeDependsOn(value) !== null;
    default:
      return false;
  }
}

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

export interface ApplyDeps {
  db: DatabaseLike;
  router: TaskChangeRouter;
  store: SyncStore;
  deviceId: string;
  now?: () => number;
  /** A fresh local HLC, for a dirty field nobody stamped yet (it is at least this recent). */
  stampNow: () => string;
}

export interface ApplyReport {
  applied: number;
  parked: Record<InboxReason, number>;
  deleted: number;
  /** Conflicts this client filed during the pass (they upload on the push step). */
  filedConflicts: string[];
}

function emptyReport(): ApplyReport {
  return {
    applied: 0,
    parked: { pending: 0, shadow: 0, deferred: 0, missing_ref: 0, unsupported: 0, error: 0 },
    deleted: 0,
    filedConflicts: [],
  };
}

/** Which table holds this id, if any. */
function localTypeOf(db: DatabaseLike, id: string): SyncedEntityType | null {
  for (const type of APPLY_ORDER) {
    if (db.prepare(`SELECT 1 FROM ${ENTITY_TABLE[type]} WHERE id = ?`).get(id)) return type;
  }
  return null;
}

function localVersion(db: DatabaseLike, type: SyncedEntityType, id: string): number | null {
  const r = db.prepare(`SELECT version FROM ${ENTITY_TABLE[type]} WHERE id = ?`).get(id) as { version: number } | undefined;
  return r?.version ?? null;
}

function park(entry: InboxField, reason: InboxReason, detail?: string): InboxField {
  return {
    ...entry,
    reason,
    detail,
    parkedAt: entry.reason === reason && entry.parkedAt ? entry.parkedAt : new Date().toISOString(),
  };
}

/** Translate one synced field into the router change it needs. Returns false when it needs no write. */
function addToChange(
  change: TaskChange & { remote: RemoteApplyFields; fields: NonNullable<TaskChange['fields']> },
  field: string,
  value: unknown,
): void {
  switch (field) {
    case 'title':
      change.fields.title = value as string;
      break;
    case 'summary':
      change.fields.summary = value as string | null;
      break;
    case 'body':
      change.fields.body = value as string | null;
      break;
    case 'priority':
      change.fields.priority = value as Priority;
      break;
    case 'category':
      change.fields.category = value as EntityCategory;
      break;
    case 'repo':
      change.fields.repo = value as string | null;
      break;
    case 'scope':
      change.fields.scope = value as IdeaScope | null;
      break;
    case 'executor':
      change.fields.executor = value as TaskExecutor;
      break;
    case 'sort_order':
      change.fields.sortOrder = value as number | null;
      break;
    case 'parent_epic_id':
      change.parentEpicId = value as string | null;
      break;
    case 'originating_idea_id':
      change.originatingIdeaId = value as string | null;
      break;
    case 'approved_at':
      change.remote.approvedAt = value as string | null;
      break;
    case 'decomposed_at':
      change.remote.decomposedAt = value as string | null;
      break;
    case 'archived_at':
      change.remote.archivedAt = value as string | null;
      break;
    default:
      break;
  }
}

/** Map a router failure onto an inbox reason. */
function reasonFor(err: unknown): { reason: InboxReason; detail: string } | 'retry' {
  if (err instanceof TaskChangeError) {
    if (err.code === 'active_runs') return { reason: 'deferred', detail: err.message };
    if (err.code === 'concurrency') return 'retry';
    if (err.code === 'forbidden_stage' || err.code === 'not_found') return { reason: 'unsupported', detail: err.message };
    return { reason: 'error', detail: `${err.code}: ${err.message}` };
  }
  return { reason: 'error', detail: err instanceof Error ? err.message : String(err) };
}

export class RemoteApplier {
  private readonly now: () => number;

  constructor(private readonly deps: ApplyDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Apply everything applicable in the project's inbox. Never throws for a per-entity problem. */
  async applyInbox(projectId: number): Promise<ApplyReport> {
    const report = emptyReport();
    const { store } = this.deps;
    const pending = store.listInbox(projectId);
    if (pending.length === 0) return report;

    for (const type of APPLY_ORDER) {
      for (const st of pending.filter((e) => e.entityType === type && !e.pendingDelete)) {
        await this.applyEntity(projectId, st, report);
      }
    }
    await this.applyDependsOn(projectId, report);
    const deletes = pending.filter((e) => e.pendingDelete);
    for (const type of [...APPLY_ORDER].reverse()) {
      for (const st of deletes.filter((e) => e.entityType === type)) {
        await this.applyDelete(projectId, st, report);
      }
    }
    return report;
  }

  // ---- entity fields -------------------------------------------------------

  private async applyEntity(projectId: number, st0: SyncEntityState, report: ApplyReport): Promise<void> {
    const { db, store } = this.deps;
    const st = store.getEntity(st0.entityType, st0.entityId);
    if (!st) return;
    const local = readEntityProjection(db, projectId, st.entityType, st.entityId);
    if (!local) {
      if (Object.keys(st.base).length === 0) await this.applyCreate(projectId, st, report);
      // Otherwise the entity was deleted here: the pending tombstone push
      // settles it at the server (which records the lost values).
      return;
    }

    const content: Array<[string, InboxField]> = [];
    const guarded: Array<[string, InboxField]> = [];
    for (const [field, entry] of Object.entries(st.inbox)) {
      if (field === 'depends_on') continue;
      const base = st.base[field];
      if (entry.v <= (base?.v ?? 0)) {
        delete st.inbox[field];
        continue;
      }
      const L = local.fields[field];
      // Already equal (crash after a write, or an echo): just agree on it.
      if (L !== undefined && same(L, entry.value)) {
        st.base[field] = { value: entry.value, v: entry.v, hlc: entry.hlc };
        delete st.inbox[field];
        if (st.dirty[field] && same(st.dirty[field].value, L)) delete st.dirty[field];
        continue;
      }
      if (!(field in local.fields)) {
        // A field this client does not model: keep it in the base, verbatim.
        st.base[field] = { value: entry.value, v: entry.v, hlc: entry.hlc };
        delete st.inbox[field];
        continue;
      }
      const dirty = base === undefined ? true : !same(L, base.value);
      if (dirty) {
        st.inbox[field] = park(entry, 'shadow');
        continue;
      }
      if (!validValue(field, entry.value)) {
        st.inbox[field] = park(entry, 'unsupported', 'value does not fit the local schema');
        continue;
      }
      if ((field === 'parent_epic_id' || field === 'originating_idea_id') && typeof entry.value === 'string') {
        if (!localTypeOf(db, entry.value)) {
          st.inbox[field] = park(entry, 'missing_ref', entry.value);
          continue;
        }
      }
      if (field === 'created_at') {
        // created_at never changes after create; agree without a write.
        st.base[field] = { value: entry.value, v: entry.v, hlc: entry.hlc };
        delete st.inbox[field];
        continue;
      }
      ((GUARDED_FIELDS as readonly string[]).includes(field) ? guarded : content).push([field, entry]);
    }

    for (const group of [content, guarded]) {
      if (group.length === 0) continue;
      await this.writeGroup(projectId, st, group, report);
    }
    store.putEntity(st);
    for (const entry of Object.values(st.inbox)) report.parked[entry.reason] += 1;
  }

  private async writeGroup(
    projectId: number,
    st: SyncEntityState,
    group: Array<[string, InboxField]>,
    report: ApplyReport,
  ): Promise<void> {
    const { db, router } = this.deps;
    const version = localVersion(db, st.entityType, st.entityId);
    if (version === null) return;
    const change: TaskChange & { remote: RemoteApplyFields; fields: NonNullable<TaskChange['fields']> } = {
      actor: 'cyboflow-remote',
      entityType: st.entityType,
      taskId: st.entityId,
      expectedVersion: version,
      fields: {},
      remote: {},
    };
    let recomputeEpic = false;
    const written: Array<[string, InboxField]> = [];
    for (const [field, entry] of group) {
      if (field === 'stage') {
        const key = entry.value as string;
        if (key === ROLLUP_STAGE_KEY) {
          if (st.entityType !== 'epic') {
            st.inbox[field] = park(entry, 'unsupported', 'rollup on a non-epic');
            continue;
          }
          // The epic is parked elsewhere (1 or 10): reopen it at 6, then let the
          // rollup derive the real stage from the synced children.
          const ready = stageIdForKey(db, projectId, '6');
          if (!ready) {
            st.inbox[field] = park(entry, 'unsupported', 'no stage 6 on the default board');
            continue;
          }
          change.stageId = ready;
          recomputeEpic = true;
        } else {
          const stageId = stageIdForKey(db, projectId, key);
          if (!stageId) {
            st.inbox[field] = park(entry, 'unsupported', `unknown stage key ${key}`);
            continue;
          }
          change.stageId = stageId;
        }
      } else {
        addToChange(change, field, entry.value);
      }
      written.push([field, entry]);
    }
    if (written.length === 0) return;
    try {
      await router.applyChange(projectId, change);
      if (recomputeEpic) await router.recomputeEpicStage(st.entityId).catch(() => {});
      for (const [field, entry] of written) {
        st.base[field] = { value: entry.value, v: entry.v, hlc: entry.hlc };
        delete st.inbox[field];
        if (st.dirty[field]) delete st.dirty[field];
        report.applied += 1;
      }
    } catch (err) {
      const r = reasonFor(err);
      if (r === 'retry') return;
      for (const [field, entry] of written) st.inbox[field] = park(entry, r.reason, r.detail);
    }
  }

  // ---- creates -------------------------------------------------------------

  private async applyCreate(projectId: number, st: SyncEntityState, report: ApplyReport): Promise<void> {
    const { db, router, store } = this.deps;
    const type = st.entityType;
    if (!st.ref) {
      for (const [f, e] of Object.entries(st.inbox)) st.inbox[f] = park(e, 'error', 'remote create without a ref');
      store.putEntity(st);
      return;
    }
    const value = (f: string): unknown => st.inbox[f]?.value;
    const change: TaskChange & { remote: RemoteApplyFields; fields: NonNullable<TaskChange['fields']> } = {
      actor: 'cyboflow-remote',
      entityType: type,
      fields: {},
      remote: {
        id: st.entityId,
        ref: st.ref,
        createdAt: typeof value('created_at') === 'string' ? (value('created_at') as string) : new Date(this.now()).toISOString(),
      },
    };
    const applied: string[] = [];
    // Fields that cannot apply yet start with a v:0 base at their local
    // default, so they are not dirty, and keep waiting in the inbox.
    const parkedAtDefault: string[] = [];
    for (const field of SYNCED_FIELDS[type]) {
      const entry = st.inbox[field];
      if (!entry || field === 'depends_on') continue;
      if (!validValue(field, entry.value)) {
        st.inbox[field] = park(entry, 'unsupported', 'value does not fit the local schema');
        parkedAtDefault.push(field);
        continue;
      }
      if ((field === 'parent_epic_id' || field === 'originating_idea_id') && typeof entry.value === 'string') {
        if (!localTypeOf(db, entry.value)) {
          st.inbox[field] = park(entry, 'missing_ref', entry.value);
          parkedAtDefault.push(field);
          continue;
        }
      }
      if (field === 'stage') {
        const key = entry.value as string;
        const stageId =
          key === ROLLUP_STAGE_KEY && type === 'epic' ? stageIdForKey(db, projectId, '6') : stageIdForKey(db, projectId, key);
        if (!stageId) {
          st.inbox[field] = park(entry, 'unsupported', `unknown stage key ${key}`);
          parkedAtDefault.push(field);
          continue;
        }
        change.initialStageId = stageId;
      } else if (field === 'title') {
        change.title = entry.value as string;
      } else if (field !== 'created_at') {
        addToChange(change, field, entry.value);
      }
      applied.push(field);
    }
    // A create always writes an approval stamp: absent means pending.
    if (type !== 'idea' && change.remote.approvedAt === undefined) change.remote.approvedAt = null;

    try {
      await router.applyChange(projectId, change);
    } catch (err) {
      const r = reasonFor(err);
      if (r !== 'retry') {
        for (const f of applied) st.inbox[f] = park(st.inbox[f], r.reason, r.detail);
      }
      store.putEntity(st);
      return;
    }
    if (type === 'epic' && st.inbox.stage?.value === ROLLUP_STAGE_KEY) {
      await router.recomputeEpicStage(st.entityId).catch(() => {});
    }
    const local = readEntityProjection(db, projectId, type, st.entityId);
    for (const f of applied) {
      const entry = st.inbox[f];
      st.base[f] = { value: entry.value, v: entry.v, hlc: entry.hlc };
      delete st.inbox[f];
      report.applied += 1;
    }
    for (const f of parkedAtDefault) {
      st.base[f] = { value: local?.fields[f] ?? null, v: 0, hlc: null };
      report.parked[st.inbox[f].reason] += 1;
    }
    // A field the server never sent (an older client created the entity):
    // agree on the local default at v:0 so it is not pushed as an edit.
    if (local) {
      for (const f of SYNCED_FIELDS[type]) {
        if (st.base[f] === undefined && st.inbox[f] === undefined && f !== 'depends_on') {
          st.base[f] = { value: local.fields[f], v: 0, hlc: null };
        }
      }
    }
    store.putEntity(st);
  }

  // ---- depends_on ----------------------------------------------------------

  private async applyDependsOn(projectId: number, report: ApplyReport): Promise<void> {
    const { db, router, store } = this.deps;
    const projection = readProjection(db, projectId);
    const candidates: Array<{ st: SyncEntityState; entry: InboxField; value: DependsOnValue }> = [];
    for (const st of store.listInbox(projectId)) {
      if (st.entityType !== 'task' || st.pendingDelete) continue;
      const entry = st.inbox.depends_on;
      if (!entry) continue;
      const local = projection.get(st.entityId);
      if (!local) continue;
      const base = st.base.depends_on;
      if (entry.v <= (base?.v ?? 0)) {
        delete st.inbox.depends_on;
        store.putEntity(st);
        continue;
      }
      const value = normalizeDependsOn(entry.value);
      if (!value) {
        st.inbox.depends_on = park(entry, 'unsupported', 'malformed depends_on');
        store.putEntity(st);
        continue;
      }
      const L = local.fields.depends_on;
      if (same(L, value)) {
        st.base.depends_on = { value, v: entry.v, hlc: entry.hlc };
        delete st.inbox.depends_on;
        store.putEntity(st);
        continue;
      }
      if (base === undefined ? true : !same(L, base.value)) {
        st.inbox.depends_on = park(entry, 'shadow');
        store.putEntity(st);
        continue;
      }
      const missing = value.filter((d) => localTypeOf(db, d.id) !== 'task');
      if (missing.length > 0) {
        st.inbox.depends_on = park(entry, 'missing_ref', missing.map((d) => d.id).join(','));
        store.putEntity(st);
        continue;
      }
      candidates.push({ st, entry, value });
    }
    if (candidates.length === 0) return;

    // Earlier edits first, so on a cross-machine cycle the LATER edge is the
    // one the router refuses (both machines compute the same loser).
    candidates.sort((a, b) => compareHlc(a.entry.hlc, b.entry.hlc));
    const result = await router.applyRemoteEdges(
      projectId,
      candidates.map((c) => ({ taskId: c.st.entityId, dependsOn: c.value })),
    );

    for (const c of candidates) {
      const st = store.getEntity('task', c.st.entityId);
      if (!st) continue;
      // B := the server's value even when an edge was refused: the local value
      // then differs from B, so the removal pushes as this machine's repair.
      st.base.depends_on = { value: c.value, v: c.entry.v, hlc: c.entry.hlc };
      delete st.inbox.depends_on;
      store.putEntity(st);
      report.applied += 1;
    }

    // Accept-then-repair for cycles: of the two edges, the LATER edit loses,
    // whichever machine owns it, so both machines keep the same edge.
    for (const refusedEdge of result.cycles) {
      const incoming = candidates.find((c) => c.st.entityId === refusedEdge.taskId);
      if (!incoming) continue;
      const competing = this.latestEdgeOnPath(projectId, refusedEdge.dependsOnId, refusedEdge.taskId);
      if (competing && compareHlc(competing.hlc, incoming.entry.hlc) > 0) {
        // The local edge is newer: remove it here, then retry the incoming set.
        const owner = readEntityProjection(db, projectId, 'task', competing.taskId);
        const ownerSet = ((owner?.fields.depends_on as DependsOnValue | undefined) ?? []).filter(
          (d) => d.id !== competing.dependsOnId,
        );
        await router.applyRemoteEdges(projectId, [{ taskId: competing.taskId, dependsOn: ownerSet }]);
        await router.applyRemoteEdges(projectId, [{ taskId: incoming.st.entityId, dependsOn: incoming.value }]);
        const ownerState = store.getEntity('task', competing.taskId);
        if (ownerState) {
          report.filedConflicts.push(
            this.fileDependencyEdgeConflict(projectId, ownerState, competing.dependsOnId, incoming.entry.hlc),
          );
        }
      } else {
        const st = store.getEntity('task', incoming.st.entityId);
        if (st) {
          report.filedConflicts.push(
            this.fileDependencyEdgeConflict(projectId, st, refusedEdge.dependsOnId, competing?.hlc ?? ''),
          );
        }
      }
    }
  }

  /**
   * The blocking edge on the path `from` →…→ `to` whose owning task's
   * depends_on was edited most recently (its dirty stamp, else its base HLC).
   * That is the edge competing with an incoming edge `to` → `from`.
   */
  private latestEdgeOnPath(
    projectId: number,
    from: string,
    to: string,
  ): { taskId: string; dependsOnId: string; hlc: string } | null {
    const { db, store } = this.deps;
    const prev = new Map<string, string>();
    const queue = [from];
    const seen = new Set([from]);
    while (queue.length > 0) {
      const node = queue.shift() as string;
      if (node === to) break;
      const next = db
        .prepare(`SELECT depends_on_task_id AS id FROM task_dependencies WHERE task_id = ? AND kind = 'blocking'`)
        .all(node) as Array<{ id: string }>;
      for (const { id } of next) {
        if (seen.has(id)) continue;
        seen.add(id);
        prev.set(id, node);
        queue.push(id);
      }
    }
    if (!prev.has(to)) return null;
    let best: { taskId: string; dependsOnId: string; hlc: string } | null = null;
    for (let node = to; prev.has(node); node = prev.get(node) as string) {
      const owner = prev.get(node) as string;
      const st = store.getEntity('task', owner);
      const local = readEntityProjection(db, projectId, 'task', owner);
      const base = st?.base.depends_on;
      const dirty = base === undefined || !same(local?.fields.depends_on, base.value);
      const hlc = dirty ? (st?.dirty.depends_on?.hlc ?? this.deps.stampNow()) : (base?.hlc ?? '');
      if (!best || compareHlc(hlc, best.hlc) > 0) best = { taskId: owner, dependsOnId: node, hlc };
    }
    return best;
  }

  /** File the record for a dropped edge `st` → `depId`; `winningHlc` is the kept edge's edit time. */
  private fileDependencyEdgeConflict(projectId: number, st: SyncEntityState, depId: string, winningHlc: string): string {
    const id = clientConflictId('dependency_edge', st.entityId, [st.entityId, depId], winningHlc);
    this.deps.store.putClientConflict(projectId, {
      id,
      projectId: '',
      entityId: st.entityId,
      entityRef: st.ref,
      entityTitle: null,
      kind: 'dependency_edge',
      field: 'depends_on',
      current: { value: null, device: this.deps.deviceId, hlc: null },
      other: { value: { id: depId }, device: null, hlc: winningHlc },
      extra: { removedEdge: { taskId: st.entityId, dependsOnId: depId } },
      createdAt: this.now(),
    });
    return id;
  }

  // ---- deletes -------------------------------------------------------------

  private async applyDelete(projectId: number, st: SyncEntityState, report: ApplyReport): Promise<void> {
    const { db, router, store } = this.deps;
    const projection = readProjection(db, projectId);
    const local = projection.get(st.entityId) ?? null;

    // Children that will survive with their lineage nulled: one `orphaned`
    // conflict names them, so the user can move or delete them.
    const orphans: ProjectedEntity[] = [];
    if (local && st.entityType !== 'task') {
      for (const e of projection.values()) {
        const pointsAtIt =
          e.fields.parent_epic_id === st.entityId || e.fields.originating_idea_id === st.entityId;
        if (pointsAtIt && !store.getEntity(e.entityType, e.entityId)?.pendingDelete) orphans.push(e);
      }
    }
    // Local edits the server never acknowledged are lost by the delete.
    const lostEdits: Record<string, unknown> = {};
    let lostHlc: string | null = null;
    if (local) {
      for (const f of SYNCED_FIELDS[st.entityType]) {
        const base = st.base[f];
        if (base === undefined || same(local.fields[f], base.value)) continue;
        lostEdits[f] = local.fields[f];
        const hlc = st.dirty[f]?.hlc ?? null;
        if (hlc && (lostHlc === null || compareHlc(hlc, lostHlc) > 0)) lostHlc = hlc;
      }
    }

    const result = await router.applyRemoteDelete(projectId, { entityType: st.entityType, entityId: st.entityId });
    if (result.status === 'deferred') {
      st.pendingDelete = { reason: 'deferred', detail: result.reason, parkedAt: st.pendingDelete?.parkedAt ?? new Date().toISOString() };
      store.putEntity(st);
      report.parked.deferred += 1;
      return;
    }
    store.tx(() => {
      store.deleteEntity(st.entityType, st.entityId);
      // The AFTER DELETE trigger recorded a tombstone for this remote-applied
      // delete; it must not be pushed back.
      store.deleteTombstone(st.entityType, st.entityId);
    });
    report.deleted += 1;

    if (Object.keys(lostEdits).length > 0) {
      const id = clientConflictId('delete_vs_edit', st.entityId, [st.entityId], lostHlc ?? '');
      store.putClientConflict(projectId, {
        id,
        projectId: '',
        entityId: st.entityId,
        entityRef: st.ref,
        entityTitle: typeof local?.fields.title === 'string' ? local.fields.title : null,
        kind: 'delete_vs_edit',
        current: { value: null, device: null, hlc: null },
        other: { value: lostEdits, device: this.deps.deviceId, hlc: lostHlc },
        createdAt: this.now(),
      });
      report.filedConflicts.push(id);
    }
    if (orphans.length > 0) {
      const childIds = orphans.map((o) => o.entityId).sort();
      const id = clientConflictId('orphaned', st.entityId, childIds, '');
      store.putClientConflict(projectId, {
        id,
        projectId: '',
        entityId: st.entityId,
        entityRef: st.ref,
        entityTitle: typeof local?.fields.title === 'string' ? local.fields.title : null,
        kind: 'orphaned',
        current: { value: null, device: null, hlc: null },
        other: { value: null, device: this.deps.deviceId, hlc: null },
        extra: { children: orphans.map((o) => ({ id: o.entityId, ref: o.ref, type: o.entityType })) },
        createdAt: this.now(),
      });
      report.filedConflicts.push(id);
    }
  }
}
