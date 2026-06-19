/**
 * ArtifactRouter — the single-writer chokepoint for the run-scoped `artifacts`
 * table (migration 029).
 *
 * Mirrors the TaskChangeRouter / ReviewItemRouter pattern: a per-project PQueue
 * (concurrency 1) serializes writes; every write atomically (a) mutates the
 * artifacts table, (b) appends an `entity_events` row under entity_type='artifact'
 * (the polymorphic audit log), and (c) emits an ArtifactChangedEvent AFTER the
 * transaction commits. Nothing else writes the artifacts table directly — the
 * tRPC sub-router, the MCP tools, and (later) the orchestrator auto-mint all
 * route through here.
 *
 * One artifact per (run_id, atype) in v1: `apply` with op='create' UPSERTS by
 * (runId, atype), so re-deriving a templated artifact (auto-mint) is idempotent.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/* — the DB is injected as the narrow DatabaseLike.
 */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import PQueue from 'p-queue';
import type { DatabaseLike } from './types';
import {
  ARTIFACT_RENDER_MODE,
  type Artifact,
  type ArtifactChangeAction,
  type ArtifactRenderMode,
  type ArtifactType,
} from '../../../shared/types/artifacts';

// ---------------------------------------------------------------------------
// Public emitter + channel
// ---------------------------------------------------------------------------

/** Emits ArtifactChangedEvent after each committed write. Consumed directly by
 *  the cyboflow.artifacts.onArtifactChanged subscription (no bridge needed). */
export const artifactChangeEvents = new EventEmitter();

/** Per-project emit channel. Exported so the tRPC subscription stays in sync. */
export function artifactProjectChannel(projectId: number): string {
  return `artifact-project-${projectId}`;
}

/** entity_events discriminator for artifact audit rows. */
const ENTITY_EVENT_TYPE = 'artifact';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ArtifactErrorCode =
  | 'not_found'
  | 'invalid_atype'
  | 'already_committed'
  | 'run_not_found'
  | 'wrong_project';

export class ArtifactError extends Error {
  constructor(
    public readonly code: ArtifactErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactError';
  }
}

// ---------------------------------------------------------------------------
// Change + row types
// ---------------------------------------------------------------------------

export type ArtifactActor = 'user' | 'orchestrator' | `agent:${string}`;

/** Create (or idempotently re-derive) an artifact for (runId, atype). */
export interface ArtifactCreate {
  op: 'create';
  runId: string;
  sessionId?: string | null;
  atype: ArtifactType;
  label: string;
  /** Render mode; defaults to ARTIFACT_RENDER_MODE[atype]. */
  mode?: ArtifactRenderMode;
  stepOrigin?: string | null;
  sourceRef?: string | null;
  payloadJson?: string | null;
  /** Defaults: committed=false, sessionOnly=true, isNew=true. */
  committed?: boolean;
  sessionOnly?: boolean;
  isNew?: boolean;
  actor: ArtifactActor;
}

/** Enrich an existing artifact (label / payload / new-dot). */
export interface ArtifactUpdate {
  op: 'update';
  artifactId: string;
  label?: string;
  payloadJson?: string | null;
  isNew?: boolean;
  actor: ArtifactActor;
}

/** Persist the artifact into the repo (flips committed; M5 adds the disk snapshot). */
export interface ArtifactCommit {
  op: 'commit';
  artifactId: string;
  payloadJson?: string | null;
  actor: ArtifactActor;
}

export type ArtifactChange = ArtifactCreate | ArtifactUpdate | ArtifactCommit;

/** DB row shape (snake_case, numeric flags). */
export interface ArtifactDbRow {
  id: string;
  run_id: string;
  session_id: string | null;
  atype: ArtifactType;
  label: string;
  step_origin: string | null;
  mode: ArtifactRenderMode;
  committed: number;
  session_only: number;
  is_new: number;
  payload_json: string | null;
  source_ref: string | null;
  created_at: string;
  committed_at: string | null;
}

interface FieldDelta {
  field: string;
  from: unknown;
  to: unknown;
}

const VALID_ATYPES: ReadonlySet<ArtifactType> = new Set<ArtifactType>([
  'idea-spec',
  'decomposed-stories',
  'screenshots',
  'ui-prototype',
  'generic',
]);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export class ArtifactRouter {
  private static instance: ArtifactRouter | null = null;

  /** Per-project serialization queues (artifacts are project-scoped). */
  private projectQueues = new Map<number, PQueue>();

  constructor(private readonly db: DatabaseLike) {}

  static initialize(db: DatabaseLike): ArtifactRouter {
    ArtifactRouter.instance = new ArtifactRouter(db);
    return ArtifactRouter.instance;
  }

  static getInstance(): ArtifactRouter {
    if (!ArtifactRouter.instance) {
      throw new Error(
        'ArtifactRouter has not been initialized. Call ArtifactRouter.initialize() from main/src/index.ts.',
      );
    }
    return ArtifactRouter.instance;
  }

  /** Reset singleton — intended for tests only. */
  static _resetForTesting(): void {
    ArtifactRouter.instance = null;
  }

  private getProjectQueue(projectId: number): PQueue {
    let q = this.projectQueues.get(projectId);
    if (!q) {
      q = new PQueue({ concurrency: 1 });
      this.projectQueues.set(projectId, q);
    }
    return q;
  }

  /**
   * Apply an artifact change (create / update / commit). Serialized per project.
   * Returns the artifact id + the appended audit event.
   */
  async apply(
    projectId: number,
    change: ArtifactChange,
  ): Promise<{ artifactId: string; event: { id: number; seq: number } }> {
    return this.getProjectQueue(projectId).add(() => {
      if (change.op === 'create') return this.runCreate(projectId, change);
      if (change.op === 'update') return this.runUpdate(projectId, change);
      return this.runCommit(projectId, change);
    }) as Promise<{ artifactId: string; event: { id: number; seq: number } }>;
  }

  /**
   * Drop session-only (uncommitted) artifacts for the given runs. Committed
   * artifacts persist. Emits a 'deleted' event per dropped artifact. Returns the
   * dropped artifact ids. (Disk-byte cleanup is layered on in the lifecycle
   * milestone.)
   */
  async pruneSessionOnly(projectId: number, runIds: string[]): Promise<{ deleted: string[] }> {
    if (runIds.length === 0) return { deleted: [] };
    return this.getProjectQueue(projectId).add(() => {
      const placeholders = runIds.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT * FROM artifacts WHERE committed = 0 AND run_id IN (${placeholders})`,
        )
        .all(...runIds) as ArtifactDbRow[];
      const txn = this.db.transaction(() => {
        this.db
          .prepare(`DELETE FROM artifacts WHERE committed = 0 AND run_id IN (${placeholders})`)
          .run(...runIds);
      });
      (txn as () => void)();
      for (const row of rows) {
        this.emitChange(projectId, row.run_id, row.id, row.atype, 'deleted', null);
      }
      return { deleted: rows.map((r) => r.id) };
    }) as Promise<{ deleted: string[] }>;
  }

  // ------------------------------------------------------------------------
  // Write paths
  // ------------------------------------------------------------------------

  private runCreate(
    projectId: number,
    change: ArtifactCreate,
  ): { artifactId: string; event: { id: number; seq: number } } {
    if (!VALID_ATYPES.has(change.atype)) {
      throw new ArtifactError('invalid_atype', `unknown artifact atype '${change.atype}'`);
    }
    this.assertRun(change.runId);

    const existing = this.db
      .prepare('SELECT * FROM artifacts WHERE run_id = ? AND atype = ?')
      .get(change.runId, change.atype) as ArtifactDbRow | undefined;

    const now = new Date().toISOString();
    const mode: ArtifactRenderMode = change.mode ?? ARTIFACT_RENDER_MODE[change.atype];
    let artifactId: string;
    let action: ArtifactChangeAction;
    let eventId = 0;
    let eventSeq = 0;
    let wrote = false;

    const txn = this.db.transaction(() => {
      if (existing) {
        // Idempotent re-derive: keep the row id, refresh the mutable fields. The
        // audit row records ONLY fields that actually changed (matching the
        // op='update' no-op semantics) — a re-derive with an unchanged label must
        // not spam the entity_events log with a no-op delta.
        artifactId = existing.id;
        action = 'updated';
        const nextStepOrigin = change.stepOrigin ?? existing.step_origin;
        const nextPayload = change.payloadJson ?? existing.payload_json;
        const nextSourceRef = change.sourceRef ?? existing.source_ref;
        const nextIsNew = change.isNew === false ? 0 : 1;
        this.db
          .prepare(
            `UPDATE artifacts
                SET label = ?, step_origin = ?, mode = ?, payload_json = ?, source_ref = ?,
                    session_id = COALESCE(?, session_id), is_new = ?
              WHERE id = ?`,
          )
          .run(change.label, nextStepOrigin, mode, nextPayload, nextSourceRef, change.sessionId ?? null, nextIsNew, existing.id);

        const deltas: FieldDelta[] = [];
        if (change.label !== existing.label) deltas.push({ field: 'label', from: existing.label, to: change.label });
        if (mode !== existing.mode) deltas.push({ field: 'mode', from: existing.mode, to: mode });
        if (nextIsNew !== existing.is_new) deltas.push({ field: 'is_new', from: existing.is_new === 1, to: nextIsNew === 1 });
        if (nextPayload !== existing.payload_json) {
          deltas.push({
            field: 'payload_json',
            from: existing.payload_json == null ? null : 'present',
            to: nextPayload == null ? 'cleared' : 'present',
          });
        }

        if (deltas.length === 0) {
          const last = this.db
            .prepare(
              'SELECT id, seq FROM entity_events WHERE entity_type = ? AND entity_id = ? ORDER BY seq DESC LIMIT 1',
            )
            .get(ENTITY_EVENT_TYPE, existing.id) as { id: number; seq: number } | undefined;
          eventId = last?.id ?? 0;
          eventSeq = last?.seq ?? 0;
        } else {
          const ev = this.insertEvent(existing.id, 'updated', change.actor, change.runId, deltas, now);
          eventId = ev.id;
          eventSeq = ev.seq;
          wrote = true;
        }
        return;
      }

      artifactId = `art_${randomBytes(12).toString('hex')}`;
      action = 'created';
      const committed = change.committed ? 1 : 0;
      const sessionOnly = change.sessionOnly === false ? 0 : 1;
      const isNew = change.isNew === false ? 0 : 1;
      this.db
        .prepare(
          `INSERT INTO artifacts
             (id, run_id, session_id, atype, label, step_origin, mode, committed, session_only,
              is_new, payload_json, source_ref, created_at, committed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          artifactId,
          change.runId,
          change.sessionId ?? null,
          change.atype,
          change.label,
          change.stepOrigin ?? null,
          mode,
          committed,
          sessionOnly,
          isNew,
          change.payloadJson ?? null,
          change.sourceRef ?? null,
          now,
        );
      const ev = this.insertEvent(artifactId, 'created', change.actor, change.runId, [
        { field: 'atype', from: null, to: change.atype },
        { field: 'label', from: null, to: change.label },
        { field: 'mode', from: null, to: mode },
      ], now);
      eventId = ev.id;
      eventSeq = ev.seq;
      wrote = true;
    });
    (txn as () => void)();

    // An idempotent re-derive with NO changed fields wrote no audit row — skip the
    // emit too, so a true no-op neither writes audit nor emits.
    if (wrote) {
      this.emitChange(projectId, change.runId, artifactId!, change.atype, action!, this.readById(artifactId!));
    }
    return { artifactId: artifactId!, event: { id: eventId, seq: eventSeq } };
  }

  private runUpdate(
    projectId: number,
    change: ArtifactUpdate,
  ): { artifactId: string; event: { id: number; seq: number } } {
    const now = new Date().toISOString();
    let eventId = 0;
    let eventSeq = 0;
    let runId = '';
    let atype: ArtifactType = 'generic';
    let trueProject = projectId;
    let wrote = false;

    const txn = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(change.artifactId) as
        | ArtifactDbRow
        | undefined;
      if (!row) throw new ArtifactError('not_found', `artifact ${change.artifactId} not found`);
      trueProject = this.assertArtifactProject(projectId, row);
      runId = row.run_id;
      atype = row.atype;

      const deltas: FieldDelta[] = [];
      const sets: string[] = [];
      const params: unknown[] = [];
      if (change.label !== undefined && change.label !== row.label) {
        sets.push('label = ?');
        params.push(change.label);
        deltas.push({ field: 'label', from: row.label, to: change.label });
      }
      if (change.payloadJson !== undefined) {
        sets.push('payload_json = ?');
        params.push(change.payloadJson);
        deltas.push({
          field: 'payload_json',
          from: row.payload_json == null ? null : 'present',
          to: change.payloadJson == null ? 'cleared' : 'present',
        });
      }
      if (change.isNew !== undefined) {
        const next = change.isNew ? 1 : 0;
        if (next !== row.is_new) {
          sets.push('is_new = ?');
          params.push(next);
          deltas.push({ field: 'is_new', from: row.is_new === 1, to: change.isNew });
        }
      }
      if (sets.length === 0) {
        const last = this.db
          .prepare(
            'SELECT id, seq FROM entity_events WHERE entity_type = ? AND entity_id = ? ORDER BY seq DESC LIMIT 1',
          )
          .get(ENTITY_EVENT_TYPE, change.artifactId) as { id: number; seq: number } | undefined;
        eventId = last?.id ?? 0;
        eventSeq = last?.seq ?? 0;
        return;
      }
      params.push(change.artifactId);
      this.db.prepare(`UPDATE artifacts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      const ev = this.insertEvent(change.artifactId, 'updated', change.actor, runId, deltas, now);
      eventId = ev.id;
      eventSeq = ev.seq;
      wrote = true;
    });
    (txn as () => void)();

    // A true no-op (nothing changed) wrote no audit row — so emit nothing either.
    if (wrote) {
      this.emitChange(trueProject, runId, change.artifactId, atype, 'updated', this.readById(change.artifactId));
    }
    return { artifactId: change.artifactId, event: { id: eventId, seq: eventSeq } };
  }

  private runCommit(
    projectId: number,
    change: ArtifactCommit,
  ): { artifactId: string; event: { id: number; seq: number } } {
    const now = new Date().toISOString();
    let eventId = 0;
    let eventSeq = 0;
    let runId = '';
    let atype: ArtifactType = 'generic';
    let trueProject = projectId;

    const txn = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(change.artifactId) as
        | ArtifactDbRow
        | undefined;
      if (!row) throw new ArtifactError('not_found', `artifact ${change.artifactId} not found`);
      trueProject = this.assertArtifactProject(projectId, row);
      if (row.committed === 1) {
        throw new ArtifactError('already_committed', `artifact ${change.artifactId} is already committed`);
      }
      runId = row.run_id;
      atype = row.atype;

      const sets = ['committed = 1', 'session_only = 0', 'committed_at = ?'];
      const params: unknown[] = [now];
      if (change.payloadJson !== undefined) {
        sets.push('payload_json = ?');
        params.push(change.payloadJson);
      }
      params.push(change.artifactId);
      this.db.prepare(`UPDATE artifacts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      const ev = this.insertEvent(
        change.artifactId,
        'committed',
        change.actor,
        runId,
        [{ field: 'committed', from: false, to: true }],
        now,
      );
      eventId = ev.id;
      eventSeq = ev.seq;
    });
    (txn as () => void)();

    this.emitChange(trueProject, runId, change.artifactId, atype, 'committed', this.readById(change.artifactId));
    return { artifactId: change.artifactId, event: { id: eventId, seq: eventSeq } };
  }

  // ------------------------------------------------------------------------
  // Read + shape
  // ------------------------------------------------------------------------

  private readById(artifactId: string): Artifact | null {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId) as
      | ArtifactDbRow
      | undefined;
    return row ? ArtifactRouter.shapeRow(row) : null;
  }

  /** Single source of truth for ArtifactDbRow -> Artifact. */
  static shapeRow(row: ArtifactDbRow): Artifact {
    return {
      id: row.id,
      runId: row.run_id,
      sessionId: row.session_id,
      atype: row.atype,
      label: row.label,
      stepOrigin: row.step_origin,
      mode: row.mode,
      committed: row.committed === 1,
      sessionOnly: row.session_only === 1,
      isNew: row.is_new === 1,
      payloadJson: row.payload_json,
      sourceRef: row.source_ref,
      createdAt: row.created_at,
      committedAt: row.committed_at,
    };
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  private assertRun(runId: string): void {
    const run = this.db.prepare('SELECT 1 AS ok FROM workflow_runs WHERE id = ?').get(runId) as
      | { ok: number }
      | undefined;
    if (!run) throw new ArtifactError('run_not_found', `run ${runId} not found`);
  }

  /**
   * Resolve the artifact's TRUE project via its owning run, and reject when it
   * differs from the queue/project the change was scheduled on. Without this an
   * agent in project P_A could mutate an artifact id owned by run B (project
   * P_B): the write would serialize on P_A's queue (not P_B's — defeating
   * per-project concurrency-1 for that row) and emit on the P_A channel that the
   * real subscriber (P_B) never listens to. Returns the true project for the
   * emit channel.
   */
  private assertArtifactProject(projectId: number, row: ArtifactDbRow): number {
    const run = this.db
      .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE id = ?')
      .get(row.run_id) as { projectId: number } | undefined;
    if (!run) throw new ArtifactError('run_not_found', `run ${row.run_id} not found`);
    if (run.projectId !== projectId) {
      throw new ArtifactError(
        'wrong_project',
        `artifact ${row.id} belongs to project ${run.projectId}, not ${projectId}`,
      );
    }
    return run.projectId;
  }

  private insertEvent(
    artifactId: string,
    kind: string,
    actor: ArtifactActor,
    runId: string | null,
    changes: FieldDelta[],
    now: string,
  ): { id: number; seq: number } {
    const maxRow = this.db
      .prepare('SELECT MAX(seq) AS maxSeq FROM entity_events WHERE entity_type = ? AND entity_id = ?')
      .get(ENTITY_EVENT_TYPE, artifactId) as { maxSeq: number | null };
    const seq = (maxRow.maxSeq ?? 0) + 1;
    const info = this.db
      .prepare(
        `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id, changes_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ENTITY_EVENT_TYPE, artifactId, seq, kind, actor, runId, JSON.stringify(changes), now) as {
      lastInsertRowid: number | bigint;
    };
    return { id: Number(info.lastInsertRowid), seq };
  }

  private emitChange(
    projectId: number,
    runId: string,
    artifactId: string,
    atype: ArtifactType,
    action: ArtifactChangeAction,
    artifact: Artifact | null,
  ): void {
    artifactChangeEvents.emit(artifactProjectChannel(projectId), {
      projectId,
      runId,
      artifactId,
      atype,
      action,
      artifact,
    });
  }
}
