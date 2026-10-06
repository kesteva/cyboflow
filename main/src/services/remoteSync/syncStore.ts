/**
 * Typed access to the remote_sync_* tables (migration 149). No sync logic
 * lives here: the engine decides, this module reads and writes rows.
 *
 * Per-entity state follows the desktop doc's apply rules: for every synced
 * field `f` the row keeps the base B[f] (the last value agreed with the
 * server), the dirty stamp D[f] (when the current local change was made) and
 * the inbox I[f] (a remote value not yet applied, with the reason it waits).
 */
import type { DatabaseLike } from '../../orchestrator/types';
import type { ConflictRecord } from '../../../../shared/types/remoteSyncWire';
import type { SyncedEntityType } from './projection';

export interface BaseField {
  value: unknown;
  /** Server field version (0 = never agreed). */
  v: number;
  hlc: string | null;
}

export interface DirtyField {
  /** The local value this stamp was taken for; a different value is a newer edit. */
  value: unknown;
  hlc: string;
}

export type InboxReason = 'pending' | 'shadow' | 'deferred' | 'missing_ref' | 'unsupported' | 'error';

export interface InboxField {
  value: unknown;
  v: number;
  hlc: string;
  reason: InboxReason;
  detail?: string;
  /** ISO time the entry first parked (missing_ref older than a day files a finding). */
  parkedAt?: string;
}

/** A remote tombstone waiting to be applied locally. */
export interface InboxDelete {
  reason: InboxReason;
  detail?: string;
  parkedAt?: string;
}

export interface SyncEntityState {
  entityType: SyncedEntityType;
  entityId: string;
  projectId: number;
  ref: string | null;
  /** Server entity version last seen (a tombstone's baseVersion). */
  version: number;
  base: Record<string, BaseField>;
  dirty: Record<string, DirtyField>;
  inbox: Record<string, InboxField>;
  /** Set when the server tombstoned the entity and the local delete is pending. */
  pendingDelete: InboxDelete | null;
}

export type SyncProjectStatus =
  | 'pending'
  | 'active'
  | 'paused'
  | 'error'
  | 'rewound'
  | 'upgrade_required'
  | 'storage_full';

export interface SyncProjectRow {
  projectId: number;
  remoteProjectId: string | null;
  fingerprint: string | null;
  status: SyncProjectStatus;
  statusDetail: string | null;
  cursor: number;
  /** Send `reset` on the next pull (the user resumed after a rewind). */
  resetNextPull: boolean;
  epoch: number | null;
  lastSyncAt: string | null;
}

export interface SyncAccountRow {
  origin: string;
  accountId: string;
  workspaceId: string | null;
  deviceId: string;
  deviceName: string;
  deviceCode: string;
  tokenCiphertext: string;
  lastHlc: string | null;
}

export interface StoredBatch {
  batchId: string;
  payloadJson: string;
  createdAt: string;
}

interface EntityDbRow {
  entity_type: SyncedEntityType;
  entity_id: string;
  project_id: number;
  ref: string | null;
  version: number;
  base_json: string;
  dirty_json: string;
  inbox_json: string;
  deleted: number;
}

const DELETE_KEY = '__delete';

function parseObject<T>(json: string): Record<string, T> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}

export class SyncStore {
  constructor(private readonly db: DatabaseLike) {}

  /** Run `fn` in one SQLite transaction. */
  tx<T>(fn: () => T): T {
    return (this.db.transaction(fn) as () => T)();
  }

  // ---- account -------------------------------------------------------------

  getAccount(): SyncAccountRow | null {
    const r = this.db.prepare('SELECT * FROM remote_sync_account WHERE singleton = 1').get() as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      origin: r.origin as string,
      accountId: r.account_id as string,
      workspaceId: (r.workspace_id as string | null) ?? null,
      deviceId: r.device_id as string,
      deviceName: r.device_name as string,
      deviceCode: r.device_code as string,
      tokenCiphertext: r.token_ciphertext as string,
      lastHlc: (r.last_hlc as string | null) ?? null,
    };
  }

  putAccount(a: SyncAccountRow): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO remote_sync_account
           (singleton, origin, account_id, workspace_id, device_id, device_name, device_code, token_ciphertext, last_hlc, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           origin = excluded.origin, account_id = excluded.account_id, workspace_id = excluded.workspace_id,
           device_id = excluded.device_id, device_name = excluded.device_name, device_code = excluded.device_code,
           token_ciphertext = excluded.token_ciphertext, last_hlc = excluded.last_hlc, updated_at = excluded.updated_at`,
      )
      .run(a.origin, a.accountId, a.workspaceId, a.deviceId, a.deviceName, a.deviceCode, a.tokenCiphertext, a.lastHlc, now, now);
  }

  deleteAccount(): void {
    this.db.prepare('DELETE FROM remote_sync_account').run();
  }

  setLastHlc(hlc: string): void {
    this.db.prepare('UPDATE remote_sync_account SET last_hlc = ? WHERE singleton = 1').run(hlc);
  }

  // ---- projects ------------------------------------------------------------

  private toProject(r: Record<string, unknown>): SyncProjectRow {
    return {
      projectId: r.project_id as number,
      remoteProjectId: (r.remote_project_id as string | null) ?? null,
      fingerprint: (r.fingerprint as string | null) ?? null,
      status: r.status as SyncProjectStatus,
      statusDetail: (r.status_detail as string | null) ?? null,
      cursor: r.cursor as number,
      resetNextPull: r.reset_next_pull === 1,
      epoch: (r.epoch as number | null) ?? null,
      lastSyncAt: (r.last_sync_at as string | null) ?? null,
    };
  }

  getProject(projectId: number): SyncProjectRow | null {
    const r = this.db.prepare('SELECT * FROM remote_sync_projects WHERE project_id = ?').get(projectId) as
      | Record<string, unknown>
      | undefined;
    return r ? this.toProject(r) : null;
  }

  listProjects(): SyncProjectRow[] {
    return (this.db.prepare('SELECT * FROM remote_sync_projects ORDER BY project_id').all() as Array<
      Record<string, unknown>
    >).map((r) => this.toProject(r));
  }

  /** Opt a local project in (idempotent). */
  optIn(projectId: number, remoteProjectId: string | null, fingerprint: string | null): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO remote_sync_projects (project_id, remote_project_id, fingerprint, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           remote_project_id = COALESCE(excluded.remote_project_id, remote_sync_projects.remote_project_id),
           fingerprint = COALESCE(excluded.fingerprint, remote_sync_projects.fingerprint),
           updated_at = excluded.updated_at`,
      )
      .run(projectId, remoteProjectId, fingerprint, now, now);
  }

  /** Opt out: cascades every remote_sync_* row for the project away. */
  optOut(projectId: number): void {
    this.db.prepare('DELETE FROM remote_sync_projects WHERE project_id = ?').run(projectId);
  }

  updateProject(
    projectId: number,
    patch: Partial<
      Pick<SyncProjectRow, 'remoteProjectId' | 'status' | 'statusDetail' | 'cursor' | 'resetNextPull' | 'epoch' | 'lastSyncAt'>
    >,
  ): void {
    const cols: Record<string, string> = {
      remoteProjectId: 'remote_project_id',
      status: 'status',
      statusDetail: 'status_detail',
      cursor: 'cursor',
      resetNextPull: 'reset_next_pull',
      epoch: 'epoch',
      lastSyncAt: 'last_sync_at',
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, col] of Object.entries(cols)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      sets.push(`${col} = ?`);
      params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(new Date().toISOString(), projectId);
    this.db.prepare(`UPDATE remote_sync_projects SET ${sets.join(', ')} WHERE project_id = ?`).run(...params);
  }

  /** Append one line to the project's bounded sync log (newest last, 200 kept). */
  appendLog(projectId: number, line: string): void {
    const row = this.db.prepare('SELECT log_json FROM remote_sync_projects WHERE project_id = ?').get(projectId) as
      | { log_json: string }
      | undefined;
    if (!row) return;
    let log: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.log_json);
      if (Array.isArray(parsed)) log = parsed.filter((l): l is string => typeof l === 'string');
    } catch {
      // A corrupt log starts over.
    }
    log.push(`${new Date().toISOString()} ${line}`);
    this.db
      .prepare('UPDATE remote_sync_projects SET log_json = ? WHERE project_id = ?')
      .run(JSON.stringify(log.slice(-200)), projectId);
  }

  // ---- entities ------------------------------------------------------------

  private toEntity(r: EntityDbRow): SyncEntityState {
    const inbox = parseObject<InboxField>(r.inbox_json);
    const pendingDelete = (inbox[DELETE_KEY] as InboxDelete | undefined) ?? null;
    delete inbox[DELETE_KEY];
    return {
      entityType: r.entity_type,
      entityId: r.entity_id,
      projectId: r.project_id,
      ref: r.ref,
      version: r.version,
      base: parseObject<BaseField>(r.base_json),
      dirty: parseObject<DirtyField>(r.dirty_json),
      inbox,
      pendingDelete: r.deleted === 1 ? (pendingDelete ?? { reason: 'pending' }) : null,
    };
  }

  getEntity(entityType: SyncedEntityType, entityId: string): SyncEntityState | null {
    const r = this.db
      .prepare('SELECT * FROM remote_sync_entities WHERE entity_type = ? AND entity_id = ?')
      .get(entityType, entityId) as EntityDbRow | undefined;
    return r ? this.toEntity(r) : null;
  }

  /** Find a row by id alone (ids are unique across the three types). */
  findEntity(entityId: string): SyncEntityState | null {
    const r = this.db.prepare('SELECT * FROM remote_sync_entities WHERE entity_id = ?').get(entityId) as
      | EntityDbRow
      | undefined;
    return r ? this.toEntity(r) : null;
  }

  listEntities(projectId: number): SyncEntityState[] {
    return (this.db.prepare('SELECT * FROM remote_sync_entities WHERE project_id = ?').all(projectId) as EntityDbRow[]).map(
      (r) => this.toEntity(r),
    );
  }

  /** Entities with something waiting in the inbox (fields or a delete). */
  listInbox(projectId: number): SyncEntityState[] {
    return (
      this.db
        .prepare(`SELECT * FROM remote_sync_entities WHERE project_id = ? AND (inbox_json != '{}' OR deleted = 1)`)
        .all(projectId) as EntityDbRow[]
    ).map((r) => this.toEntity(r));
  }

  putEntity(e: SyncEntityState): void {
    const inbox: Record<string, unknown> = { ...e.inbox };
    if (e.pendingDelete) inbox[DELETE_KEY] = e.pendingDelete;
    this.db
      .prepare(
        `INSERT INTO remote_sync_entities
           (entity_type, entity_id, project_id, ref, version, base_json, dirty_json, inbox_json, deleted, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET
           project_id = excluded.project_id, ref = excluded.ref, version = excluded.version,
           base_json = excluded.base_json, dirty_json = excluded.dirty_json, inbox_json = excluded.inbox_json,
           deleted = excluded.deleted, updated_at = excluded.updated_at`,
      )
      .run(
        e.entityType,
        e.entityId,
        e.projectId,
        e.ref,
        e.version,
        JSON.stringify(e.base),
        JSON.stringify(e.dirty),
        JSON.stringify(inbox),
        e.pendingDelete ? 1 : 0,
        new Date().toISOString(),
      );
  }

  deleteEntity(entityType: SyncedEntityType, entityId: string): void {
    this.db.prepare('DELETE FROM remote_sync_entities WHERE entity_type = ? AND entity_id = ?').run(entityType, entityId);
  }

  // ---- tombstones ----------------------------------------------------------

  listTombstones(projectId: number): Array<{ entityType: SyncedEntityType; entityId: string; ref: string | null }> {
    return (
      this.db
        .prepare('SELECT entity_type, entity_id, ref FROM remote_sync_tombstones WHERE project_id = ?')
        .all(projectId) as Array<{ entity_type: SyncedEntityType; entity_id: string; ref: string | null }>
    ).map((r) => ({ entityType: r.entity_type, entityId: r.entity_id, ref: r.ref }));
  }

  deleteTombstone(entityType: SyncedEntityType, entityId: string): void {
    this.db.prepare('DELETE FROM remote_sync_tombstones WHERE entity_type = ? AND entity_id = ?').run(entityType, entityId);
  }

  // ---- frozen batch --------------------------------------------------------

  getBatch(projectId: number): StoredBatch | null {
    const r = this.db
      .prepare('SELECT batch_id, payload_json, created_at FROM remote_sync_batches WHERE project_id = ?')
      .get(projectId) as { batch_id: string; payload_json: string; created_at: string } | undefined;
    return r ? { batchId: r.batch_id, payloadJson: r.payload_json, createdAt: r.created_at } : null;
  }

  putBatch(projectId: number, batchId: string, payloadJson: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO remote_sync_batches (project_id, batch_id, payload_json, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(projectId, batchId, payloadJson, new Date().toISOString());
  }

  deleteBatch(projectId: number): void {
    this.db.prepare('DELETE FROM remote_sync_batches WHERE project_id = ?').run(projectId);
  }

  // ---- conflicts -----------------------------------------------------------

  /**
   * Store a server record (from the feed or a push response). A newer seq
   * replaces an older one; a record already held at the same or a later seq
   * is left alone. A server record clears `pending_upload` (the server has it).
   */
  upsertServerConflict(projectId: number, record: ConflictRecord): void {
    const existing = this.db.prepare('SELECT seq FROM remote_sync_conflicts WHERE id = ?').get(record.id) as
      | { seq: number | null }
      | undefined;
    if (existing && existing.seq !== null && existing.seq >= record.seq) return;
    this.db
      .prepare(
        `INSERT INTO remote_sync_conflicts (id, project_id, entity_id, kind, record_json, seq, resolved_at, pending_upload)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(id) DO UPDATE SET
           record_json = excluded.record_json, seq = excluded.seq, resolved_at = excluded.resolved_at,
           pending_upload = 0`,
      )
      .run(record.id, projectId, record.entityId, record.kind, JSON.stringify(record), record.seq, record.resolvedAt ?? null);
  }

  /** Store a conflict this client filed; it uploads on the next pass. */
  putClientConflict(projectId: number, record: Omit<ConflictRecord, 'seq'>): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO remote_sync_conflicts (id, project_id, entity_id, kind, record_json, seq, resolved_at, pending_upload)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, 1)`,
      )
      .run(record.id, projectId, record.entityId, record.kind, JSON.stringify(record));
  }

  listPendingUploads(projectId: number): Array<Omit<ConflictRecord, 'seq'>> {
    return (
      this.db
        .prepare('SELECT record_json FROM remote_sync_conflicts WHERE project_id = ? AND pending_upload = 1')
        .all(projectId) as Array<{ record_json: string }>
    ).map((r) => JSON.parse(r.record_json) as Omit<ConflictRecord, 'seq'>);
  }

  /** Queue a resolution to send; the record stays open locally until the server confirms. */
  setPendingResolution(conflictId: string, resolution: string): void {
    this.db.prepare('UPDATE remote_sync_conflicts SET pending_resolution = ? WHERE id = ?').run(resolution, conflictId);
  }

  clearPendingResolution(conflictId: string): void {
    this.db.prepare('UPDATE remote_sync_conflicts SET pending_resolution = NULL WHERE id = ?').run(conflictId);
  }

  listPendingResolutions(projectId: number): Array<{ id: string; resolution: string }> {
    return this.db
      .prepare(
        `SELECT id, pending_resolution AS resolution FROM remote_sync_conflicts
          WHERE project_id = ? AND pending_resolution IS NOT NULL AND pending_upload = 0`,
      )
      .all(projectId) as Array<{ id: string; resolution: string }>;
  }

  /** Close a record locally (the server no longer has it, e.g. 404 on resolve after retention). */
  closeConflictLocally(conflictId: string, resolution: string): void {
    this.db
      .prepare(
        `UPDATE remote_sync_conflicts SET resolved_at = ?, pending_resolution = NULL,
            record_json = json_set(record_json, '$.resolution', ?)
          WHERE id = ?`,
      )
      .run(Date.now(), resolution, conflictId);
  }

  listOpenConflicts(projectId: number): ConflictRecord[] {
    return (
      this.db
        .prepare(
          `SELECT record_json FROM remote_sync_conflicts WHERE project_id = ? AND resolved_at IS NULL ORDER BY seq DESC`,
        )
        .all(projectId) as Array<{ record_json: string }>
    ).map((r) => JSON.parse(r.record_json) as ConflictRecord);
  }
}
