/**
 * The remote sync ENGINE: one pass per opted-in project (desktop doc, "Engine").
 *
 *   1. Boot: a leftover frozen batch is re-sent IDENTICALLY, whatever happened
 *      since (the server dedupes it by batchId).
 *   2. Head: the workspace epoch and the project's maxSeq. A new epoch, or a
 *      maxSeq below our cursor, means the server was restored.
 *   3. Pull into the inbox (and advance the cursor) in one transaction per page.
 *   4. Apply the inbox (remoteApply.ts).
 *   5. Diff the synced projection against the base, freeze the batch, push it,
 *      apply the results, delete the frozen batch.
 *   6. Upload client-filed conflicts and queued resolutions.
 *
 * Pure orchestration over injected seams (DB, router, HTTP client, clock), so
 * the staging harness drives two of these against the real service.
 */
import { randomUUID } from 'node:crypto';
import type { TaskChangeRouter } from '../../orchestrator/taskChangeRouter';
import type { DatabaseLike } from '../../orchestrator/types';
import {
  SYNC_LIMITS,
  type FeedPage,
  type PushOp,
  type PushRequest,
  type PushResponse,
} from '../../../../shared/types/remoteSyncWire';
import { canonicalJson, jsonByteLength, projectionHash } from './canonical';
import { HlcClock, compareHlc, hlcFromIso } from './hlc';
import {
  APPLY_ORDER,
  SYNCED_FIELDS,
  isSyncedEntityType,
  readEntityProjection,
  readProjection,
  type ProjectedEntity,
  type SyncedEntityType,
} from './projection';
import { RemoteApplier, type ApplyReport } from './remoteApply';
import { SyncHttpError, type SyncHttpClient } from './syncHttpClient';
import type { SyncEntityState, SyncStore } from './syncStore';

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

export interface EngineDeps {
  db: DatabaseLike;
  router: TaskChangeRouter;
  store: SyncStore;
  client: SyncHttpClient;
  deviceId: string;
  now?: () => number;
  logger?: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

export type PassOutcome =
  | { status: 'ok'; pulled: number; pushed: number; apply: ApplyReport }
  | { status: 'skipped'; reason: string }
  | { status: 'paused'; reason: 'rewound' | 'epoch_changed' | 'upgrade_required' | 'revoked' | 'not_entitled' | 'storage_full' }
  | { status: 'failed'; error: SyncHttpError | Error };

interface FrozenBatch {
  request: PushRequest;
}

export class RemoteSyncEngine {
  private readonly now: () => number;
  private readonly clock: HlcClock;
  private readonly applier: RemoteApplier;

  constructor(private readonly deps: EngineDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.clock = new HlcClock(deps.deviceId, { now: this.now, last: deps.store.getAccount()?.lastHlc ?? null });
    this.applier = new RemoteApplier({
      db: deps.db,
      router: deps.router,
      store: deps.store,
      deviceId: deps.deviceId,
      now: this.now,
      stampNow: () => this.clock.next(),
    });
  }

  /**
   * A LOCAL write just landed on this entity (the TASK_ALL_CHANNEL listener
   * calls this for every non-remote actor). Stamps the edit time of each field
   * that now differs from its base, so a change that bumps no updated_at (a
   * dependency edge) still carries its real time. Never pushes by itself.
   */
  noteLocalChange(projectId: number, entityType: SyncedEntityType, entityId: string): void {
    const { store, db } = this.deps;
    if (!store.getProject(projectId)?.remoteProjectId) return;
    const st = store.getEntity(entityType, entityId);
    if (!st) return; // not synced yet: the create is stamped when it is pushed
    const local = readEntityProjection(db, projectId, entityType, entityId);
    if (!local) return;
    let changed = false;
    for (const f of SYNCED_FIELDS[entityType]) {
      const L = local.fields[f];
      const B = st.base[f];
      if (B !== undefined && same(L, B.value)) continue;
      const d = st.dirty[f];
      if (d && same(d.value, L)) continue;
      st.dirty[f] = { value: L, hlc: this.clock.next() };
      changed = true;
    }
    if (changed) {
      store.putEntity(st);
      this.persistClock();
    }
  }

  /** One full pass for a project. Never throws; the outcome says what happened. */
  async syncProject(projectId: number): Promise<PassOutcome> {
    const { store } = this.deps;
    const project = store.getProject(projectId);
    if (!project?.remoteProjectId) return { status: 'skipped', reason: 'project is not linked to a remote project' };
    if (project.status === 'rewound' || project.status === 'upgrade_required') {
      return { status: 'skipped', reason: `paused: ${project.status}` };
    }
    const remoteId = project.remoteProjectId;
    try {
      // 1. Boot recovery.
      await this.resendFrozenBatch(projectId, remoteId);

      // 2. Head.
      const head = await this.deps.client.head();
      const maxSeq = head.body.projects[remoteId] ?? 0;
      if (head.epoch !== null && project.epoch !== null && head.epoch !== project.epoch) {
        store.updateProject(projectId, { status: 'paused', statusDetail: 'epoch_changed' });
        store.appendLog(projectId, `epoch changed ${project.epoch} → ${head.epoch}: paused for re-bootstrap`);
        return { status: 'paused', reason: 'epoch_changed' };
      }
      if (head.epoch !== null && project.epoch === null) store.updateProject(projectId, { epoch: head.epoch });
      if (maxSeq < project.cursor) {
        store.updateProject(projectId, { status: 'paused', statusDetail: 'server_behind_cursor' });
        store.appendLog(projectId, `server maxSeq ${maxSeq} < cursor ${project.cursor}: paused for re-bootstrap`);
        return { status: 'paused', reason: 'epoch_changed' };
      }

      // 3. Pull.
      let pulled = 0;
      if (maxSeq > project.cursor) pulled = await this.pullAll(projectId, remoteId, project.cursor);

      // 4. Apply.
      const apply = await this.applier.applyInbox(projectId);

      // 5. Diff + push (several batches when one would exceed the limits).
      let pushed = 0;
      for (let guard = 0; guard < 50; guard += 1) {
        const batch = this.buildBatch(projectId);
        if (!batch) break;
        await this.pushFrozen(projectId, remoteId, batch);
        pushed += batch.request.ops.length;
        // A result can deliver new inbox entries (lost fields, deletes).
        await this.applier.applyInbox(projectId);
      }

      // 6. Conflicts.
      await this.uploadConflicts(projectId, remoteId);

      store.updateProject(projectId, { status: 'active', statusDetail: null, lastSyncAt: new Date(this.now()).toISOString() });
      this.persistClock();
      return { status: 'ok', pulled, pushed, apply };
    } catch (err) {
      this.persistClock();
      return this.handleFailure(projectId, err);
    }
  }

  /** Probe convergence: our projection hash against the server's at the same seq. */
  async checksum(projectId: number): Promise<'match' | 'mismatch' | 'stale' | 'skipped'> {
    const project = this.deps.store.getProject(projectId);
    if (!project?.remoteProjectId) return 'skipped';
    const hash = projectionHash(this.syncedState(projectId));
    const r = await this.deps.client.checksum(project.remoteProjectId, { atSeq: project.cursor, hash });
    return r.body.status;
  }

  /**
   * The projection the server should hold: known fields from the local tables
   * plus any unknown fields kept in the base, for every entity that has synced.
   */
  syncedState(projectId: number): Array<{ entityId: string; entityType: string; ref: string | null; fields: Record<string, unknown> }> {
    const projection = readProjection(this.deps.db, projectId);
    const out: Array<{ entityId: string; entityType: string; ref: string | null; fields: Record<string, unknown> }> = [];
    for (const st of this.deps.store.listEntities(projectId)) {
      const local = projection.get(st.entityId);
      if (!local) continue;
      const fields: Record<string, unknown> = {};
      for (const [f, b] of Object.entries(st.base)) fields[f] = b.value;
      for (const f of SYNCED_FIELDS[st.entityType]) fields[f] = local.fields[f];
      out.push({ entityId: st.entityId, entityType: st.entityType, ref: st.ref, fields });
    }
    return out;
  }

  // ---- pull ----------------------------------------------------------------

  private async pullAll(projectId: number, remoteId: string, cursor: number): Promise<number> {
    let since = cursor;
    let count = 0;
    for (let guard = 0; guard < 10_000; guard += 1) {
      const { body: page } = await this.deps.client.pull(remoteId, { since, limit: SYNC_LIMITS.maxPullLimit });
      this.ingestPage(projectId, page);
      count += page.items.length;
      since = page.nextSince;
      if (!page.hasMore) break;
    }
    return count;
  }

  /** Write one feed page into the inbox and advance the cursor, in one transaction. */
  private ingestPage(projectId: number, page: FeedPage): void {
    const { store } = this.deps;
    store.tx(() => {
      for (const item of page.items) {
        if (!isSyncedEntityType(item.entityType)) continue; // a later protocol's type
        const st = store.getEntity(item.entityType, item.entityId) ?? this.blankState(projectId, item.entityType, item.entityId);
        st.ref = item.ref ?? st.ref;
        st.version = Math.max(st.version, item.version);
        if (item.deleted) {
          st.inbox = {};
          st.pendingDelete = { reason: 'pending' };
          store.putEntity(st);
          continue;
        }
        for (const [field, value] of Object.entries(item.fields)) {
          const clock = item.clocks[field];
          if (!clock) continue;
          this.clock.observe(clock.hlc);
          if (clock.v <= (st.base[field]?.v ?? 0) || clock.v <= (st.inbox[field]?.v ?? 0)) continue;
          st.inbox[field] = { value, v: clock.v, hlc: clock.hlc, reason: 'pending' };
        }
        store.putEntity(st);
      }
      for (const record of page.conflicts) store.upsertServerConflict(projectId, record);
      store.updateProject(projectId, { cursor: page.nextSince });
    });
  }

  private blankState(projectId: number, entityType: SyncedEntityType, entityId: string): SyncEntityState {
    return { entityType, entityId, projectId, ref: null, version: 0, base: {}, dirty: {}, inbox: {}, pendingDelete: null };
  }

  // ---- diff + push ---------------------------------------------------------

  /**
   * Freeze the next batch: every dirty field (L ≠ B) and every local delete,
   * creates parents-first, tombstones children-first, within the op and byte
   * limits. Stamps the dirty edit times it needs. Null when nothing to push.
   */
  private buildBatch(projectId: number): FrozenBatch | null {
    const { store, db } = this.deps;
    const projection = readProjection(db, projectId);
    const states = new Map(store.listEntities(projectId).map((s) => [s.entityId, s]));
    const creates: PushOp[] = [];
    const updates: PushOp[] = [];
    const tombstones: Array<{ type: SyncedEntityType; op: PushOp }> = [];
    const touched: SyncEntityState[] = [];

    for (const type of APPLY_ORDER) {
      for (const local of projection.values()) {
        if (local.entityType !== type) continue;
        const st = states.get(local.entityId);
        // Never acknowledged by the server (no base, no server version): a create.
        if (!st || (Object.keys(st.base).length === 0 && st.version === 0)) {
          const fresh = st ?? this.blankState(projectId, type, local.entityId);
          fresh.ref = local.ref;
          creates.push(this.opFor(local, fresh, true));
          touched.push(fresh);
          continue;
        }
        if (st.pendingDelete) continue; // the remote delete applies first
        const op = this.opFor(local, st, false);
        if (op.fields && Object.keys(op.fields).length > 0) {
          updates.push(op);
          touched.push(st);
        }
      }
    }
    // Local deletes: a synced row whose entity is gone here.
    const tombstoneRows = new Set(store.listTombstones(projectId).map((t) => t.entityId));
    for (const st of states.values()) {
      if (projection.has(st.entityId) || st.pendingDelete) continue;
      // A pulled entity that has not applied here yet (its create is parked).
      if (Object.keys(st.base).length === 0 && Object.keys(st.inbox).length > 0) continue;
      if (Object.keys(st.base).length === 0) {
        // Never acknowledged by the server: nothing to delete there.
        store.tx(() => {
          store.deleteEntity(st.entityType, st.entityId);
          store.deleteTombstone(st.entityType, st.entityId);
        });
        continue;
      }
      tombstones.push({
        type: st.entityType,
        op: { entityType: st.entityType, entityId: st.entityId, kind: 'tombstone', baseVersion: st.version },
      });
      tombstoneRows.delete(st.entityId);
    }
    // Tombstones with no synced row (never pushed, or a remote-applied delete).
    for (const id of tombstoneRows) {
      const row = store.listTombstones(projectId).find((t) => t.entityId === id);
      if (row) store.deleteTombstone(row.entityType, row.entityId);
    }
    tombstones.sort((a, b) => APPLY_ORDER.indexOf(b.type) - APPLY_ORDER.indexOf(a.type));

    const all = [...creates, ...updates, ...tombstones.map((t) => t.op)];
    if (all.length === 0) {
      for (const st of touched) if (states.has(st.entityId)) store.putEntity(st);
      return null;
    }
    const ops: PushOp[] = [];
    let bytes = 64;
    for (const op of all) {
      const size = jsonByteLength(op) + 1;
      if (ops.length > 0 && (ops.length >= SYNC_LIMITS.maxOpsPerPush || bytes + size > SYNC_LIMITS.maxPushBytes - 4096)) break;
      ops.push(op);
      bytes += size;
    }
    const request: PushRequest = { batchId: randomUUID(), ops };
    const included = new Set(ops.map((o) => o.entityId));
    store.tx(() => {
      for (const st of touched) if (included.has(st.entityId) || states.has(st.entityId)) store.putEntity(st);
      store.putBatch(projectId, request.batchId, JSON.stringify(request));
    });
    return { request };
  }

  /** The push op for one entity: all fields on a create, the dirty ones otherwise. Stamps D. */
  private opFor(local: ProjectedEntity, st: SyncEntityState, isCreate: boolean): PushOp {
    const fields: NonNullable<PushOp['fields']> = {};
    for (const f of SYNCED_FIELDS[local.entityType]) {
      const L = local.fields[f];
      const B = st.base[f];
      if (!isCreate && B !== undefined && same(L, B.value)) {
        if (st.dirty[f]) delete st.dirty[f];
        continue;
      }
      let d = st.dirty[f];
      if (!d || !same(d.value, L)) {
        d = { value: L, hlc: this.editTime(local, B?.hlc ?? null) };
        st.dirty[f] = d;
      }
      fields[f] = { value: L, baseV: B?.v ?? 0, hlc: d.hlc };
    }
    const op: PushOp = { entityType: local.entityType, entityId: local.entityId, kind: 'upsert', fields };
    if (isCreate) op.ref = local.ref;
    return op;
  }

  /**
   * The edit time of a change the engine first notices now: the row's
   * updated_at (when the edit happened), kept above both the field's base HLC
   * and every HLC this clock has issued or seen.
   */
  private editTime(local: ProjectedEntity, baseHlc: string | null): string {
    const fromRow = local.updatedAt ? hlcFromIso(local.updatedAt, this.deps.deviceId) : null;
    const next = this.clock.next();
    if (fromRow && compareHlc(fromRow, next) < 0 && (baseHlc === null || compareHlc(fromRow, baseHlc) > 0)) {
      // An older offline edit keeps its real time, as long as it still sorts
      // after the value it replaced.
      return fromRow;
    }
    return next;
  }

  private async resendFrozenBatch(projectId: number, remoteId: string): Promise<void> {
    const stored = this.deps.store.getBatch(projectId);
    if (!stored) return;
    const request = JSON.parse(stored.payloadJson) as PushRequest;
    await this.pushFrozen(projectId, remoteId, { request });
  }

  private async pushFrozen(projectId: number, remoteId: string, batch: FrozenBatch): Promise<void> {
    const { body } = await this.deps.client.push(remoteId, batch.request);
    this.applyPushResults(projectId, batch.request, body);
  }

  /** Apply a push response (desktop doc, apply rule 6) and drop the frozen batch, atomically. */
  private applyPushResults(projectId: number, request: PushRequest, response: PushResponse): void {
    const { store } = this.deps;
    const opsById = new Map(request.ops.map((o) => [o.entityId, o]));
    store.tx(() => {
      for (const result of response.results) {
        const op = opsById.get(result.entityId);
        if (!op || !isSyncedEntityType(op.entityType)) continue;
        const type = op.entityType;
        if (op.kind === 'tombstone') {
          if (result.error) {
            store.appendLog(projectId, `tombstone ${op.entityId}: ${result.error}`);
          } else {
            // applied, or noop (already deleted there): either way it is gone.
            store.deleteEntity(type, op.entityId);
            store.deleteTombstone(type, op.entityId);
          }
          continue;
        }
        const st = store.getEntity(type, op.entityId) ?? this.blankState(projectId, type, op.entityId);
        if (op.ref) st.ref = op.ref;
        if (result.error) {
          store.appendLog(projectId, `push ${op.entityId}: ${result.error}`);
          store.putEntity(st);
          continue;
        }
        const entity = result.entity;
        if (entity) {
          st.version = Math.max(st.version, entity.version);
          st.ref = entity.ref ?? st.ref;
        }
        if (result.status === 'deleted') {
          st.pendingDelete = { reason: 'pending' };
          store.putEntity(st);
          continue;
        }
        for (const [field, outcome] of Object.entries(result.fields)) {
          const sent = op.fields?.[field];
          const clock = entity?.clocks[field];
          if (!sent) continue;
          if (!clock || !entity) continue; // state omitted: the next pull settles it
          this.clock.observe(clock.hlc);
          const serverValue = entity.fields[field];
          if (outcome === 'accepted' || outcome === 'noop') {
            st.base[field] = { value: serverValue, v: clock.v, hlc: clock.hlc };
            if (st.dirty[field] && same(st.dirty[field].value, sent.value)) delete st.dirty[field];
          } else {
            // lost / cleared: our sent value stays the base at its OLD version,
            // and the winner waits in the inbox. If nothing changed locally since,
            // apply takes it; a newer local edit shadows it and pushes again.
            st.base[field] = { value: sent.value, v: sent.baseV, hlc: st.base[field]?.hlc ?? null };
            st.inbox[field] = { value: serverValue, v: clock.v, hlc: clock.hlc, reason: 'pending' };
            if (st.dirty[field] && same(st.dirty[field].value, sent.value)) delete st.dirty[field];
          }
        }
        // Fields another machine changed that rode along with the result.
        if (entity) {
          for (const [field, clock] of Object.entries(entity.clocks)) {
            if (op.fields?.[field]) continue;
            if (clock.v > (st.base[field]?.v ?? 0) && clock.v > (st.inbox[field]?.v ?? 0) && field in entity.fields) {
              st.inbox[field] = { value: entity.fields[field], v: clock.v, hlc: clock.hlc, reason: 'pending' };
            }
          }
        }
        store.putEntity(st);
      }
      for (const record of response.conflicts) store.upsertServerConflict(projectId, record);
      store.deleteBatch(projectId);
    });
  }

  // ---- conflicts -----------------------------------------------------------

  private async uploadConflicts(projectId: number, remoteId: string): Promise<void> {
    const { store, client } = this.deps;
    for (const record of store.listPendingUploads(projectId)) {
      const { body } = await client.fileConflict(remoteId, {
        id: record.id,
        kind: record.kind,
        entityId: record.entityId,
        payload: {
          entityRef: record.entityRef,
          entityTitle: record.entityTitle,
          field: record.field,
          current: record.current,
          other: record.other,
          extra: record.extra,
        },
      });
      store.upsertServerConflict(projectId, body.conflict);
    }
    for (const { id, resolution } of store.listPendingResolutions(projectId)) {
      try {
        const { body } = await client.resolveConflict(remoteId, id, resolution);
        store.tx(() => {
          store.upsertServerConflict(projectId, body.conflict);
          store.clearPendingResolution(id);
        });
      } catch (err) {
        // 404: the server pruned the record (it was resolved long ago); close it here.
        if (err instanceof SyncHttpError && err.status === 404) store.closeConflictLocally(id, resolution);
        else throw err;
      }
    }
  }

  // ---- failures ------------------------------------------------------------

  private handleFailure(projectId: number, err: unknown): PassOutcome {
    const { store } = this.deps;
    if (err instanceof SyncHttpError) {
      store.appendLog(projectId, `sync failed: ${err.status} ${err.code}`);
      switch (err.kind) {
        case 'rewound':
          store.updateProject(projectId, { status: 'rewound', statusDetail: err.code });
          return { status: 'paused', reason: 'rewound' };
        case 'upgrade_required':
          store.updateProject(projectId, { status: 'upgrade_required', statusDetail: err.code });
          return { status: 'paused', reason: 'upgrade_required' };
        case 'revoked':
          return { status: 'paused', reason: 'revoked' };
        case 'not_entitled':
          return { status: 'paused', reason: 'not_entitled' };
        default:
          if (err.status === 507) {
            store.updateProject(projectId, { status: 'storage_full', statusDetail: err.code });
            return { status: 'paused', reason: 'storage_full' };
          }
          store.updateProject(projectId, { status: 'error', statusDetail: `${err.status} ${err.code}` });
          return { status: 'failed', error: err };
      }
    }
    const error = err instanceof Error ? err : new Error(String(err));
    store.appendLog(projectId, `sync failed: ${error.message}`);
    store.updateProject(projectId, { status: 'error', statusDetail: error.message });
    return { status: 'failed', error };
  }

  private persistClock(): void {
    const last = this.clock.last;
    if (last && this.deps.store.getAccount()) this.deps.store.setLastHlc(last);
  }
}
