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
  FindingPayload,
  FindingPriority,
  FindingProposedTarget,
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

/**
 * Re-tag and/or re-prioritize an untriaged finding (applied-not-consumed — the
 * finding stays status='pending' AND staged_at IS NULL). Either or both of
 * `proposedTarget` (re-tag, patched into payload_json) and `priority` (re-set on
 * the column) may be present. Finding-scoped (migration 032; OD-5).
 */
export interface ReviewItemMutate {
  op: 'mutate';
  actor: ReviewActor;
  reviewItemId: string;
  /** New routing tag — merged into payload_json.proposedTarget (siblings preserved). */
  proposedTarget?: FindingProposedTarget;
  /** New first-class priority (P0/P1/P2). */
  priority?: FindingPriority;
  /** The run that triggered this triage, recorded on the entity_events row. */
  runId?: string | null;
}

/**
 * Approve an untriaged finding into READY (migration 032): sets staged_at +
 * pre-checks selected=1 in one UPDATE. Guarded to untriaged findings
 * (status='pending' AND staged_at IS NULL).
 */
export interface ReviewItemApprove {
  op: 'approve';
  actor: ReviewActor;
  reviewItemId: string;
  /** The run that triggered this triage, recorded on the entity_events row. */
  runId?: string | null;
}

/**
 * Batch-toggle the "compound this" checkbox over an explicit id list (migration
 * 032). Only READY findings (staged_at IS NOT NULL) are selectable. Also the
 * terminal-seam close-out path (actor:'orchestrator') that clears selected on
 * un-resolved seeded findings at compound-run end.
 */
export interface ReviewItemSetSelected {
  op: 'set-selected';
  actor: ReviewActor;
  reviewItemIds: string[];
  selected: boolean;
  /** The run that triggered this toggle, recorded on the entity_events rows. */
  runId?: string | null;
}

export type ReviewItemChange =
  | ReviewItemCreate
  | ReviewItemTriage
  | ReviewItemMutate
  | ReviewItemApprove
  | ReviewItemSetSelected;

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
  // Finding-scoped triage columns (migration 032). NULL/0 for non-finding kinds.
  priority: 'P0' | 'P1' | 'P2' | null;
  staged_at: string | null;
  selected: number; // 0 | 1
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
// Exhaustiveness guard for the ReviewItemChange dispatch switch. A new op added
// to the union without a switch case is a compile error here (TS2345), never a
// silent fall-through.
// ---------------------------------------------------------------------------

function assertNeverChange(change: never): never {
  throw new ReviewItemError(
    'invalid_payload',
    `unhandled review-item change op: ${JSON.stringify(change)}`,
  );
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
   * Findings-triage paths (migration 032), each finding-scoped, each atomic:
   *  - mutate (re-tag and/or re-prioritize): untriaged-only. Re-tag merges
   *    payload_json.proposedTarget (siblings preserved); re-prioritize sets the
   *    priority column. Action 'mutated'. Rejects a staged/non-pending finding
   *    (invalid_status) or a non-finding kind (invalid_payload).
   *  - approve (untriaged → ready): sets staged_at + selected=1. Action
   *    'staged'. Rejects a non-untriaged finding (invalid_status).
   *  - set-selected (batch toggle of the compound-this checkbox): UPDATEs
   *    selected over the explicit id list (only staged findings selectable),
   *    emitting ONE 'selection-changed' event per affected id. Rejects an
   *    unstaged id (invalid_status). Also the orchestrator close-out path.
   *
   * For set-selected the returned id/event is the LAST affected id (the
   * per-id events are all emitted on the project channel).
   *
   * @returns the affected review-item id + the inserted entity_events row id/seq.
   */
  async applyReviewItem(
    projectId: number,
    change: ReviewItemChange,
  ): Promise<{ reviewItemId: string; event: { id: number; seq: number } }> {
    return this.getProjectQueue(projectId).add(() => {
      // Exhaustive dispatch — a widened ReviewItemChange union with the old
      // `create ? runCreate : runTriage` ternary would silently mis-route every
      // new op into runTriage (treating reviewItemId as a resolve/dismiss) with
      // NO compile error. The switch + assertNever default makes a future op a
      // compile error until it is wired here.
      switch (change.op) {
        case 'create':
          return this.runCreate(projectId, change);
        case 'resolve':
        case 'dismiss':
          return this.runTriage(projectId, change);
        case 'mutate':
          return this.runMutate(projectId, change);
        case 'approve':
          return this.runApprove(projectId, change);
        case 'set-selected':
          return this.runSetSelected(projectId, change);
        default:
          return assertNeverChange(change);
      }
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
  // Triage path — mutate (re-tag / re-prioritize, applied-not-consumed)
  // --------------------------------------------------------------------------

  private runMutate(
    projectId: number,
    change: ReviewItemMutate,
  ): { reviewItemId: string; event: { id: number; seq: number } } {
    const reviewItemId = change.reviewItemId;
    const now = new Date().toISOString();

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
      // Re-tag/re-prioritize is only meaningful for findings.
      if (current.kind !== 'finding') {
        throw new ReviewItemError(
          'invalid_payload',
          `cannot re-tag/re-prioritize a '${current.kind}' review item (findings only)`,
        );
      }
      // Untriaged-only (OD-5): a still-pending finding that has NOT been staged.
      if (current.status !== 'pending' || current.staged_at !== null) {
        throw new ReviewItemError(
          'invalid_status',
          `review item ${reviewItemId} is not untriaged (status='${current.status}', staged_at=${
            current.staged_at === null ? 'NULL' : 'set'
          })`,
        );
      }

      const deltas: FieldDelta[] = [];

      // ----- re-tag: parse-merge-stringify payload_json (siblings preserved) -----
      let nextPayloadJson = current.payload_json;
      if (change.proposedTarget !== undefined) {
        const prevTarget = this.parseProposedTarget(current.payload_json);
        const merged = this.mergeProposedTarget(current.payload_json, change.proposedTarget);
        nextPayloadJson = JSON.stringify(merged);
        deltas.push({ field: 'proposedTarget', from: prevTarget, to: change.proposedTarget });
      }

      // ----- re-prioritize: set the priority column -----
      let nextPriority = current.priority;
      if (change.priority !== undefined) {
        nextPriority = change.priority;
        deltas.push({ field: 'priority', from: current.priority, to: change.priority });
      }

      this.db
        .prepare(
          `UPDATE review_items
              SET payload_json = ?, priority = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(nextPayloadJson, nextPriority, now, reviewItemId);

      const ev = this.insertEvent(reviewItemId, 'mutated', change.actor, change.runId ?? null, deltas, now);
      eventId = ev.id;
      eventSeq = ev.seq;
    });
    (txn as () => void)();

    this.emitChange(projectId, reviewItemId, 'mutated');
    return { reviewItemId, event: { id: eventId, seq: eventSeq } };
  }

  // --------------------------------------------------------------------------
  // Triage path — approve (untriaged → ready, pre-selected)
  // --------------------------------------------------------------------------

  private runApprove(
    projectId: number,
    change: ReviewItemApprove,
  ): { reviewItemId: string; event: { id: number; seq: number } } {
    const reviewItemId = change.reviewItemId;
    const now = new Date().toISOString();

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
      // Untriaged-only: a still-pending finding that has NOT already been staged.
      if (current.status !== 'pending' || current.staged_at !== null) {
        throw new ReviewItemError(
          'invalid_status',
          `review item ${reviewItemId} is not untriaged (status='${current.status}', staged_at=${
            current.staged_at === null ? 'NULL' : 'set'
          })`,
        );
      }

      this.db
        .prepare(
          `UPDATE review_items
              SET staged_at = CURRENT_TIMESTAMP, selected = 1, updated_at = ?
            WHERE id = ?`,
        )
        .run(now, reviewItemId);

      const deltas: FieldDelta[] = [
        { field: 'staged_at', from: null, to: 'set' },
        { field: 'selected', from: false, to: true },
      ];

      const ev = this.insertEvent(reviewItemId, 'staged', change.actor, change.runId ?? null, deltas, now);
      eventId = ev.id;
      eventSeq = ev.seq;
    });
    (txn as () => void)();

    this.emitChange(projectId, reviewItemId, 'staged');
    return { reviewItemId, event: { id: eventId, seq: eventSeq } };
  }

  // --------------------------------------------------------------------------
  // Triage path — set-selected (batch toggle of the compound-this checkbox)
  // --------------------------------------------------------------------------

  private runSetSelected(
    projectId: number,
    change: ReviewItemSetSelected,
  ): { reviewItemId: string; event: { id: number; seq: number } } {
    const now = new Date().toISOString();
    const nextSelected = change.selected ? 1 : 0;

    // The public result is one {reviewItemId, event}; an empty batch is a
    // caller bug (the tRPC layer enforces .min(1); the close-out filters to
    // non-empty before calling). Fail loudly rather than read undefined.
    if (change.reviewItemIds.length === 0) {
      throw new ReviewItemError('invalid_payload', 'set-selected requires at least one review item id');
    }

    // Track the per-id event ids so the public single-result contract can return
    // the LAST affected id; emit one 'selection-changed' event per affected id.
    const affected: Array<{ reviewItemId: string; eventId: number; eventSeq: number }> = [];

    const txn = this.db.transaction(() => {
      for (const reviewItemId of change.reviewItemIds) {
        const current = this.readRow(projectId, reviewItemId);
        if (!current) {
          throw new ReviewItemError(
            'not_found',
            `review item ${reviewItemId} not found for project ${projectId}`,
          );
        }
        // Only READY findings (staged_at set) are selectable.
        if (current.staged_at === null) {
          throw new ReviewItemError(
            'invalid_status',
            `review item ${reviewItemId} is not staged (only ready findings are selectable)`,
          );
        }

        // No-op rows still emit (the close-out can re-clear an already-cleared
        // finding harmlessly) so the renderer's reconciler stays in sync.
        this.db
          .prepare(`UPDATE review_items SET selected = ?, updated_at = ? WHERE id = ?`)
          .run(nextSelected, now, reviewItemId);

        const deltas: FieldDelta[] = [
          { field: 'selected', from: current.selected === 1, to: change.selected },
        ];
        const ev = this.insertEvent(
          reviewItemId,
          'selection-changed',
          change.actor,
          change.runId ?? null,
          deltas,
          now,
        );
        affected.push({ reviewItemId, eventId: ev.id, eventSeq: ev.seq });
      }
    });
    (txn as () => void)();

    // One 'selection-changed' event per affected id (single-item event shape).
    for (const a of affected) {
      this.emitChange(projectId, a.reviewItemId, 'selection-changed');
    }

    const last = affected[affected.length - 1];
    return {
      reviewItemId: last.reviewItemId,
      event: { id: last.eventId, seq: last.eventSeq },
    };
  }

  // --------------------------------------------------------------------------
  // payload_json proposedTarget merge helpers (re-tag, siblings preserved)
  // --------------------------------------------------------------------------

  /** Read the current proposedTarget off payload_json (null when absent/unparseable). */
  private parseProposedTarget(payloadJson: string | null): FindingProposedTarget | null {
    if (!payloadJson) return null;
    try {
      const parsed = JSON.parse(payloadJson) as Partial<FindingPayload>;
      return parsed.proposedTarget ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Merge a new proposedTarget into payload_json WITHOUT clobbering siblings
   * (category/suggestedFix/locations/impact). Synthesizes a minimal finding
   * payload when the row has no parseable payload yet.
   */
  private mergeProposedTarget(
    payloadJson: string | null,
    proposedTarget: FindingProposedTarget,
  ): FindingPayload {
    let base: FindingPayload = { kind: 'finding' };
    if (payloadJson) {
      try {
        const parsed = JSON.parse(payloadJson) as FindingPayload;
        if (parsed && parsed.kind === 'finding') base = parsed;
      } catch {
        // malformed payload — fall back to a fresh finding payload
      }
    }
    return { ...base, kind: 'finding', proposedTarget };
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
      priority: row.priority,
      staged_at: row.staged_at,
      selected: row.selected === 1,
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
