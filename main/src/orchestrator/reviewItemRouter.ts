/**
 * ReviewItemRouter — the SINGLE write chokepoint for the unified review inbox.
 *
 * INVARIANT: every review_items write (Sprint-agent findings via MCP, the folded
 * PreToolUse/approval path, approve-idea/approve-plan decision gates, manual
 * human tasks, and triage resolve/dismiss) routes through applyReviewItem.
 * Nothing INSERTs/UPDATEs `review_items` directly. Each applyReviewItem
 * atomically (1) mutates the row and (2) appends a delta row to the polymorphic
 * `entity_events(entity_type='review_item', entity_id=<reviewItemId>)`, then
 * emits a ReviewItemChangedEvent after commit.
 *
 * Mirrors the per-project PQueue serialization pattern in taskChangeRouter.ts
 * (review items are project-scoped). 'promote-to-task' is NOT handled here — it
 * is a triage operation that resolves the item AND mints a task via the OTHER
 * chokepoint (TaskChangeRouter); that two-chokepoint orchestration lives in the
 * reviewItems tRPC router so this router stays single-table.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*. The DB is
 * injected as the narrow DatabaseLike interface.
 */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import PQueue from 'p-queue';
import type { DatabaseLike } from './types';
import type {
  ReviewItem,
  ReviewItemChangeAction,
  ReviewItemChangedEvent,
  ReviewItemEntityType,
  ReviewItemKind,
  ReviewItemPayload,
  ReviewItemSeverity,
  ReviewItemStatus,
} from '../../../shared/types/reviews';

// ---------------------------------------------------------------------------
// Public event emitter — exported HERE (NOT trpc/routers/events.ts), mirroring
// taskChangeEvents, to avoid file contention with the events router. The tRPC
// subscription bridges this emitter via eventToAsyncIterable.
//
// Emit key format: 'review-project-' + projectId.
// ---------------------------------------------------------------------------

export const reviewItemChangeEvents = new EventEmitter();

/** Build the emit channel name for a project. Exported so the tRPC subscription stays in sync. */
export function reviewItemProjectChannel(projectId: number): string {
  return `review-project-${projectId}`;
}

/**
 * Broadcast a review-item delta for a row written OUTSIDE the chokepoint.
 *
 * QuestionRouter and HumanStepManager co-write review_items rows inside their
 * own transactions (deliberately bypassing applyReviewItem so the gate write
 * commits atomically with the run-status flip) — which also bypasses the
 * chokepoint's emit. They call this AFTER their commit so the renderer's
 * queue/landing subscriptions still hear about the change. Fail-soft: a row
 * deleted between commit and emit broadcasts nothing.
 */
export function emitReviewItemChangedById(
  db: DatabaseLike,
  reviewItemId: string,
  action: ReviewItemChangeAction,
): void {
  const row = db
    .prepare('SELECT * FROM review_items WHERE id = ?')
    .get(reviewItemId) as ReviewItemDbRow | undefined;
  if (!row) return;
  const event: ReviewItemChangedEvent = {
    projectId: row.project_id,
    reviewItemId,
    action,
    item: ReviewItemRouter.shapeRow(row),
  };
  reviewItemChangeEvents.emit(reviewItemProjectChannel(row.project_id), event);
}

/** The (entity_type, entity_id) entity_events key reused for review items. */
const ENTITY_EVENT_TYPE = 'review_item';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ReviewItemErrorCode = 'not_found' | 'invalid_entity' | 'invalid_payload' | 'invalid_status';

/** Discriminated error for all chokepoint rejections. */
export class ReviewItemError extends Error {
  constructor(
    public readonly code: ReviewItemErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewItemError';
  }
}

// ---------------------------------------------------------------------------
// Change request shapes
// ---------------------------------------------------------------------------

/** Actors that may write review items. Mirrors TaskActor. */
export type ReviewActor = 'user' | 'orchestrator' | `agent:${string}` | 'linear';

/** Create a new review item. Omit `reviewItemId` (it is minted). */
export interface ReviewItemCreate {
  op: 'create';
  actor: ReviewActor;
  kind: ReviewItemKind;
  title: string;
  body?: string | null;
  /** Defaults to false. Permissions/decisions are typically blocking=true. */
  blocking?: boolean;
  /** Only meaningful for findings; ignored otherwise (stored as given). */
  severity?: ReviewItemSeverity | null;
  source?: string | null;
  /** Soft polymorphic link — both must be set together or both omitted. */
  entityType?: ReviewItemEntityType | null;
  entityId?: string | null;
  /** The run that produced this item (recorded on the row + the entity_events row). */
  runId?: string | null;
  /** Per-kind payload; its discriminant MUST equal `kind`. */
  payload?: ReviewItemPayload | null;
}

/** Resolve or dismiss an existing review item (the two triage transitions). */
export interface ReviewItemTriage {
  op: 'resolve' | 'dismiss';
  actor: ReviewActor;
  reviewItemId: string;
  /** Actor recorded on resolved_by; defaults to `actor`. */
  resolvedBy?: string;
  /** Free-form resolution note (e.g. 'promoted:tsk_...'). */
  resolution?: string | null;
  /** The run that triggered this triage, recorded on the entity_events row. */
  runId?: string | null;
}

export type ReviewItemChange = ReviewItemCreate | ReviewItemTriage;

// ---------------------------------------------------------------------------
// Internal row shape
// ---------------------------------------------------------------------------

interface ReviewItemDbRow {
  id: string;
  project_id: number;
  run_id: string | null;
  entity_type: ReviewItemEntityType | null;
  entity_id: string | null;
  kind: ReviewItemKind;
  status: ReviewItemStatus;
  blocking: number; // 0 | 1
  title: string;
  body: string | null;
  severity: ReviewItemSeverity | null;
  source: string | null;
  payload_json: string | null;
  created_at: string;
  updated_at: string;
  resolved_by: string | null;
  resolution: string | null;
}

interface FieldDelta {
  field: string;
  from: unknown;
  to: unknown;
}

// ---------------------------------------------------------------------------
// ReviewItemRouter
// ---------------------------------------------------------------------------

export class ReviewItemRouter {
  private static instance: ReviewItemRouter | null = null;

  /** Per-project serialization queues (review items are project-scoped). */
  private projectQueues = new Map<number, PQueue>();

  constructor(private readonly db: DatabaseLike) {}

  // --------------------------------------------------------------------------
  // Lifecycle (singleton, mirroring TaskChangeRouter)
  // --------------------------------------------------------------------------

  static initialize(db: DatabaseLike): ReviewItemRouter {
    ReviewItemRouter.instance = new ReviewItemRouter(db);
    return ReviewItemRouter.instance;
  }

  static getInstance(): ReviewItemRouter {
    if (!ReviewItemRouter.instance) {
      throw new Error(
        'ReviewItemRouter has not been initialized. Call ReviewItemRouter.initialize() from main/src/index.ts.',
      );
    }
    return ReviewItemRouter.instance;
  }

  /** Reset singleton — intended for tests only. */
  static _resetForTesting(): void {
    ReviewItemRouter.instance = null;
  }

  private getProjectQueue(projectId: number): PQueue {
    let q = this.projectQueues.get(projectId);
    if (!q) {
      q = new PQueue({ concurrency: 1 });
      this.projectQueues.set(projectId, q);
    }
    return q;
  }

  /** Test/seam helper — exposes the per-project queue for `.onIdle()` waits. */
  _queueForProject(projectId: number): PQueue {
    return this.getProjectQueue(projectId);
  }

  // --------------------------------------------------------------------------
  // Core API
  // --------------------------------------------------------------------------

  /**
   * Apply a single review-item change atomically and emit the resulting event.
   *
   * Create path: validates the soft entity link + per-kind payload discriminant,
   * mints an id, inserts the row, and logs a 'created' entity_events row.
   *
   * Triage path (resolve/dismiss): resolves the row, sets status + resolved_by +
   * resolution + updated_at, and appends a delta to entity_events — all in ONE
   * transaction. Re-resolving / re-dismissing an already-terminal item is
   * rejected with code='invalid_status'.
   *
   * @returns the affected review-item id + the inserted entity_events row id/seq.
   */
  async applyReviewItem(
    projectId: number,
    change: ReviewItemChange,
  ): Promise<{ reviewItemId: string; event: { id: number; seq: number } }> {
    return this.getProjectQueue(projectId).add(() => {
      return change.op === 'create'
        ? this.runCreate(projectId, change)
        : this.runTriage(projectId, change);
    }) as Promise<{ reviewItemId: string; event: { id: number; seq: number } }>;
  }

  // --------------------------------------------------------------------------
  // Create path
  // --------------------------------------------------------------------------

  private runCreate(
    projectId: number,
    change: ReviewItemCreate,
  ): { reviewItemId: string; event: { id: number; seq: number } } {
    const now = new Date().toISOString();
    const reviewItemId = `rvw_${randomBytes(10).toString('hex')}`;

    // ----- validate the soft entity link (both set together, or neither) -----
    const entityType = change.entityType ?? null;
    const entityId = change.entityId ?? null;
    if ((entityType === null) !== (entityId === null)) {
      throw new ReviewItemError(
        'invalid_entity',
        'entityType and entityId must be set together or both omitted',
      );
    }

    // ----- validate the per-kind payload discriminant -----
    const payload = change.payload ?? null;
    if (payload !== null && payload.kind !== change.kind) {
      throw new ReviewItemError(
        'invalid_payload',
        `payload.kind '${payload.kind}' does not match item kind '${change.kind}'`,
      );
    }

    const blocking = change.blocking ? 1 : 0;
    const severity = change.severity ?? null;
    const source = change.source ?? null;
    const body = change.body ?? null;
    const runId = change.runId ?? null;
    const payloadJson = payload === null ? null : JSON.stringify(payload);

    let eventId = 0;
    let eventSeq = 0;

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO review_items
             (id, project_id, run_id, entity_type, entity_id, kind, status, blocking,
              title, body, severity, source, payload_json, created_at, updated_at, resolved_by, resolution)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          reviewItemId,
          projectId,
          runId,
          entityType,
          entityId,
          change.kind,
          blocking,
          change.title,
          body,
          severity,
          source,
          payloadJson,
          now,
          now,
        );

      const deltas: FieldDelta[] = [
        { field: 'kind', from: null, to: change.kind },
        { field: 'status', from: null, to: 'pending' },
        { field: 'title', from: null, to: change.title },
        { field: 'blocking', from: null, to: change.blocking ?? false },
      ];
      if (entityType !== null) deltas.push({ field: 'entity_type', from: null, to: entityType });
      if (entityId !== null) deltas.push({ field: 'entity_id', from: null, to: entityId });

      const ev = this.insertEvent(reviewItemId, 'created', change.actor, runId, deltas, now);
      eventId = ev.id;
      eventSeq = ev.seq;
    });
    (txn as () => void)();

    this.emitChange(projectId, reviewItemId, 'created');
    return { reviewItemId, event: { id: eventId, seq: eventSeq } };
  }

  // --------------------------------------------------------------------------
  // Triage path (resolve / dismiss)
  // --------------------------------------------------------------------------

  private runTriage(
    projectId: number,
    change: ReviewItemTriage,
  ): { reviewItemId: string; event: { id: number; seq: number } } {
    const reviewItemId = change.reviewItemId;
    const now = new Date().toISOString();
    const targetStatus: ReviewItemStatus = change.op === 'resolve' ? 'resolved' : 'dismissed';
    const action: ReviewItemChangeAction = change.op === 'resolve' ? 'resolved' : 'dismissed';

    let eventId = 0;
    let eventSeq = 0;

    const txn = this.db.transaction(() => {
      const current = this.readRow(projectId, reviewItemId);
      if (!current) {
        throw new ReviewItemError(
          'not_found',
          `review item ${reviewItemId} not found for project ${projectId}`,
        );
      }
      // Only a pending item may be triaged — re-resolving/dismissing is rejected.
      if (current.status !== 'pending') {
        throw new ReviewItemError(
          'invalid_status',
          `review item ${reviewItemId} is already '${current.status}'`,
        );
      }

      const resolvedBy = change.resolvedBy ?? change.actor;
      const resolution = change.resolution ?? null;

      this.db
        .prepare(
          `UPDATE review_items
              SET status = ?, resolved_by = ?, resolution = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(targetStatus, resolvedBy, resolution, now, reviewItemId);

      const deltas: FieldDelta[] = [{ field: 'status', from: current.status, to: targetStatus }];
      if (resolution !== null) deltas.push({ field: 'resolution', from: current.resolution, to: resolution });

      const ev = this.insertEvent(reviewItemId, action, change.actor, change.runId ?? null, deltas, now);
      eventId = ev.id;
      eventSeq = ev.seq;
    });
    (txn as () => void)();

    this.emitChange(projectId, reviewItemId, action);
    return { reviewItemId, event: { id: eventId, seq: eventSeq } };
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  private readRow(projectId: number, reviewItemId: string): ReviewItemDbRow | undefined {
    return this.db
      .prepare('SELECT * FROM review_items WHERE id = ? AND project_id = ?')
      .get(reviewItemId, projectId) as ReviewItemDbRow | undefined;
  }

  /** Cheap project_id lookup for the post-commit emit read (the row exists). */
  private projectIdOf(reviewItemId: string): number | undefined {
    const row = this.db
      .prepare('SELECT project_id FROM review_items WHERE id = ?')
      .get(reviewItemId) as { project_id: number } | undefined;
    return row?.project_id;
  }

  // --------------------------------------------------------------------------
  // Event write + emit
  // --------------------------------------------------------------------------

  private insertEvent(
    reviewItemId: string,
    kind: string,
    actor: ReviewActor,
    runId: string | null,
    changes: FieldDelta[],
    now: string,
  ): { id: number; seq: number } {
    const maxRow = this.db
      .prepare('SELECT MAX(seq) AS maxSeq FROM entity_events WHERE entity_type = ? AND entity_id = ?')
      .get(ENTITY_EVENT_TYPE, reviewItemId) as { maxSeq: number | null };
    const seq = (maxRow.maxSeq ?? 0) + 1;
    const info = this.db
      .prepare(
        `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id, changes_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ENTITY_EVENT_TYPE, reviewItemId, seq, kind, actor, runId, JSON.stringify(changes), now) as {
      lastInsertRowid: number | bigint;
    };
    return { id: Number(info.lastInsertRowid), seq };
  }

  private emitChange(projectId: number, reviewItemId: string, action: ReviewItemChangeAction): void {
    const item = this.buildReviewItem(reviewItemId);
    if (!item) return; // deleted between commit and emit — nothing to broadcast
    const event: ReviewItemChangedEvent = { projectId, reviewItemId, action, item };
    reviewItemChangeEvents.emit(reviewItemProjectChannel(projectId), event);
  }

  /**
   * Build the read-model item carried by the emitted event from the committed
   * row, normalizing SQLite BOOLEAN (0/1) -> boolean and parsing payload_json.
   * Exported as a static so the tRPC router's read paths reuse the SAME shaping
   * (single source of truth for ReviewItemDbRow -> ReviewItem).
   */
  private buildReviewItem(reviewItemId: string): ReviewItem | null {
    const row = this.readRow(this.projectIdOf(reviewItemId) ?? -1, reviewItemId);
    if (!row) return null;
    return ReviewItemRouter.shapeRow(row);
  }

  /** Map a raw review_items DB row to the renderer-facing ReviewItem read-model. */
  static shapeRow(row: ReviewItemDbRow): ReviewItem {
    let payload: ReviewItemPayload | null = null;
    if (row.payload_json) {
      try {
        payload = JSON.parse(row.payload_json) as ReviewItemPayload;
      } catch {
        payload = null; // malformed payload — surface null rather than throw
      }
    }
    return {
      id: row.id,
      project_id: row.project_id,
      run_id: row.run_id,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      kind: row.kind,
      status: row.status,
      blocking: row.blocking === 1,
      title: row.title,
      body: row.body,
      severity: row.severity,
      source: row.source,
      payload,
      created_at: row.created_at,
      updated_at: row.updated_at,
      resolved_by: row.resolved_by,
      resolution: row.resolution,
    };
  }
}

/** Re-export the internal DB-row shape so the tRPC router can shape its reads. */
export type { ReviewItemDbRow };
