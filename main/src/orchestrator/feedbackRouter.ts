/**
 * FeedbackRouter — the SINGLE write chokepoint for the two in-artifact
 * feedback tables (feedback_batches / feedback_comments, migration 075,
 * IDEA-033).
 *
 * Users highlight sections of the idea-spec / arch-design artifact tabs while
 * a planner/ship run is parked at a human gate, save draft comments, and
 * "send" the batch. Sending is the durable "changes requested" event: a
 * host-driven scoped revision agent rewrites the target document (the idea's
 * markdown body) through TaskChangeRouter while the gate stays open, then the
 * batch flips to 'applied' and its comments to 'addressed' (consumed — comments
 * are per-round, not threaded). Content identity mirrors the per-entity
 * artifact identity (migration 073): (run_id, atype, source_ref), where
 * source_ref is the owning idea id.
 *
 * Mirrors the per-project PQueue serialization pattern in reviewItemRouter.ts /
 * artifactRouter.ts (feedback is project-scoped, via the owning run). UNLIKE
 * those two chokepoints, feedback writes do NOT append to the polymorphic
 * `entity_events` audit log — feedback comments/batches are review-side
 * annotations, not entity mutations. The eventual body write a batch produces
 * (once a revision agent applies it) IS audited, but that audit trail lives on
 * the idea entity via TaskChangeRouter, not here.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*. The DB is
 * injected as the narrow DatabaseLike interface. The feedbackEvents emitter is
 * hosted in trpc/routers/events.ts (see that file for why) — importing it here
 * is safe under the invariant because events.ts itself only imports zod, the
 * tRPC procedure factories, and type-only shared-type imports.
 */
import { randomBytes } from 'node:crypto';
import PQueue from 'p-queue';
import type { DatabaseLike } from './types';
import { feedbackEvents, feedbackProjectChannel } from './trpc/routers/events';
import {
  isFeedbackAtype,
  type CommentAnchor,
  type FeedbackAtype,
  type FeedbackBatch,
  type FeedbackBatchStatus,
  type FeedbackChangedEvent,
  type FeedbackComment,
  type FeedbackCommentStatus,
} from '../../../shared/types/feedback';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type FeedbackErrorCode =
  | 'not_found'
  | 'invalid_atype'
  | 'invalid_body'
  /** update-comment / delete-comment target a non-draft (sent/addressed) comment. */
  | 'not_draft'
  /** send-batch: a pending batch already exists for this (runId, atype, sourceRef). */
  | 'busy'
  /** send-batch: no draft comments exist for this document. */
  | 'no_comments'
  /** Exhaustiveness-guard fallback — unreachable at runtime, TS enforces it at compile time. */
  | 'invalid_op';

/** Discriminated error for all chokepoint rejections. */
export class FeedbackError extends Error {
  constructor(
    public readonly code: FeedbackErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FeedbackError';
  }
}

// ---------------------------------------------------------------------------
// Change request shapes
// ---------------------------------------------------------------------------

/** Create a new draft comment. Omit `commentId` (it is minted). */
export interface FeedbackCreateComment {
  op: 'create-comment';
  runId: string;
  atype: FeedbackAtype;
  sourceRef: string;
  anchor: CommentAnchor;
  body: string;
}

/** Edit a draft comment's body and/or anchor. Rejected once the comment is sent/addressed. */
export interface FeedbackUpdateComment {
  op: 'update-comment';
  commentId: string;
  body?: string;
  anchor?: CommentAnchor;
}

/** Hard-delete a draft comment. Rejected once the comment is sent/addressed. */
export interface FeedbackDeleteComment {
  op: 'delete-comment';
  commentId: string;
}

/** "Send feedback": mint a batch from every draft comment on a document. */
export interface FeedbackSendBatch {
  op: 'send-batch';
  runId: string;
  atype: FeedbackAtype;
  sourceRef: string;
}

/** The revision agent landed the batch's changes — flip it (and its comments) to applied/addressed. */
export interface FeedbackBatchApplied {
  op: 'batch-applied';
  batchId: string;
}

/** The revision agent failed — flip the batch to failed and revert its comments to editable drafts. */
export interface FeedbackBatchFailed {
  op: 'batch-failed';
  batchId: string;
  error: string;
}

export type FeedbackChange =
  | FeedbackCreateComment
  | FeedbackUpdateComment
  | FeedbackDeleteComment
  | FeedbackSendBatch
  | FeedbackBatchApplied
  | FeedbackBatchFailed;

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface FeedbackCommentDbRow {
  id: string;
  project_id: number;
  run_id: string;
  atype: FeedbackAtype;
  source_ref: string;
  batch_id: string | null;
  anchor_json: string;
  body: string;
  status: FeedbackCommentStatus;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  addressed_at: string | null;
}

interface FeedbackBatchDbRow {
  id: string;
  project_id: number;
  run_id: string;
  atype: FeedbackAtype;
  source_ref: string;
  round: number;
  status: FeedbackBatchStatus;
  error: string | null;
  created_at: string;
  applied_at: string | null;
}

// ---------------------------------------------------------------------------
// Exhaustiveness guard for the FeedbackChange dispatch switch. A new op added
// to the union without a switch case is a compile error here (TS2345), never a
// silent fall-through.
// ---------------------------------------------------------------------------

function assertNeverChange(change: never): never {
  throw new FeedbackError('invalid_op', `unhandled feedback change op: ${JSON.stringify(change)}`);
}

// ---------------------------------------------------------------------------
// FeedbackRouter
// ---------------------------------------------------------------------------

export class FeedbackRouter {
  private static instance: FeedbackRouter | null = null;

  /** Per-project serialization queues (feedback is project-scoped, via the owning run). */
  private projectQueues = new Map<number, PQueue>();

  constructor(private readonly db: DatabaseLike) {}

  // --------------------------------------------------------------------------
  // Lifecycle (singleton, mirroring ReviewItemRouter / ArtifactRouter)
  // --------------------------------------------------------------------------

  static initialize(db: DatabaseLike): FeedbackRouter {
    FeedbackRouter.instance = new FeedbackRouter(db);
    return FeedbackRouter.instance;
  }

  static getInstance(): FeedbackRouter {
    if (!FeedbackRouter.instance) {
      throw new Error('FeedbackRouter has not been initialized. Call FeedbackRouter.initialize() from main/src/index.ts.');
    }
    return FeedbackRouter.instance;
  }

  /** Reset singleton — intended for tests only. */
  static _resetForTesting(): void {
    FeedbackRouter.instance = null;
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
  // Core API — apply() overloads give each op its own precise return shape.
  // --------------------------------------------------------------------------

  async apply(projectId: number, change: FeedbackCreateComment): Promise<{ commentId: string }>;
  async apply(projectId: number, change: FeedbackUpdateComment): Promise<{ commentId: string }>;
  async apply(projectId: number, change: FeedbackDeleteComment): Promise<{ commentId: string }>;
  async apply(
    projectId: number,
    change: FeedbackSendBatch,
  ): Promise<{ batchId: string; round: number; commentIds: string[] }>;
  async apply(projectId: number, change: FeedbackBatchApplied): Promise<{ batchId: string; applied: boolean }>;
  async apply(projectId: number, change: FeedbackBatchFailed): Promise<{ batchId: string; failed: boolean }>;
  async apply(
    projectId: number,
    change: FeedbackChange,
  ): Promise<
    | { commentId: string }
    | { batchId: string; round: number; commentIds: string[] }
    | { batchId: string; applied: boolean }
    | { batchId: string; failed: boolean }
  > {
    return this.getProjectQueue(projectId).add(() => {
      switch (change.op) {
        case 'create-comment':
          return this.runCreateComment(projectId, change);
        case 'update-comment':
          return this.runUpdateComment(projectId, change);
        case 'delete-comment':
          return this.runDeleteComment(projectId, change);
        case 'send-batch':
          return this.runSendBatch(projectId, change);
        case 'batch-applied':
          return this.runBatchApplied(projectId, change);
        case 'batch-failed':
          return this.runBatchFailed(projectId, change);
        default:
          return assertNeverChange(change);
      }
    }) as Promise<
      | { commentId: string }
      | { batchId: string; round: number; commentIds: string[] }
      | { batchId: string; applied: boolean }
      | { batchId: string; failed: boolean }
    >;
  }

  // --------------------------------------------------------------------------
  // create-comment
  // --------------------------------------------------------------------------

  private runCreateComment(projectId: number, change: FeedbackCreateComment): { commentId: string } {
    if (!isFeedbackAtype(change.atype)) {
      throw new FeedbackError('invalid_atype', `unknown feedback atype '${String(change.atype)}'`);
    }
    const body = change.body.trim();
    if (body.length === 0) {
      throw new FeedbackError('invalid_body', 'comment body must not be empty');
    }

    const now = new Date().toISOString();
    const commentId = `fbc_${randomBytes(10).toString('hex')}`;

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO feedback_comments
             (id, project_id, run_id, atype, source_ref, batch_id, anchor_json, body, status,
              created_at, updated_at, sent_at, addressed_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'draft', ?, ?, NULL, NULL)`,
        )
        .run(
          commentId,
          projectId,
          change.runId,
          change.atype,
          change.sourceRef,
          JSON.stringify(change.anchor),
          body,
          now,
          now,
        );
    });
    (txn as () => void)();

    this.emitChange(projectId, change.runId, change.atype, change.sourceRef);
    return { commentId };
  }

  // --------------------------------------------------------------------------
  // update-comment (draft-only)
  // --------------------------------------------------------------------------

  private runUpdateComment(projectId: number, change: FeedbackUpdateComment): { commentId: string } {
    const now = new Date().toISOString();
    const current = this.readComment(projectId, change.commentId);
    if (!current) {
      throw new FeedbackError('not_found', `feedback comment ${change.commentId} not found`);
    }
    if (current.status !== 'draft') {
      throw new FeedbackError(
        'not_draft',
        `feedback comment ${change.commentId} is not a draft (status='${current.status}')`,
      );
    }

    let nextBody = current.body;
    if (change.body !== undefined) {
      nextBody = change.body.trim();
      if (nextBody.length === 0) {
        throw new FeedbackError('invalid_body', 'comment body must not be empty');
      }
    }
    const nextAnchorJson = change.anchor !== undefined ? JSON.stringify(change.anchor) : current.anchor_json;

    const txn = this.db.transaction(() => {
      this.db
        .prepare('UPDATE feedback_comments SET body = ?, anchor_json = ?, updated_at = ? WHERE id = ?')
        .run(nextBody, nextAnchorJson, now, change.commentId);
    });
    (txn as () => void)();

    this.emitChange(projectId, current.run_id, current.atype, current.source_ref);
    return { commentId: change.commentId };
  }

  // --------------------------------------------------------------------------
  // delete-comment (draft-only, hard delete)
  // --------------------------------------------------------------------------

  private runDeleteComment(projectId: number, change: FeedbackDeleteComment): { commentId: string } {
    const current = this.readComment(projectId, change.commentId);
    if (!current) {
      throw new FeedbackError('not_found', `feedback comment ${change.commentId} not found`);
    }
    if (current.status !== 'draft') {
      throw new FeedbackError(
        'not_draft',
        `feedback comment ${change.commentId} is not a draft (status='${current.status}')`,
      );
    }

    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM feedback_comments WHERE id = ?').run(change.commentId);
    });
    (txn as () => void)();

    this.emitChange(projectId, current.run_id, current.atype, current.source_ref);
    return { commentId: change.commentId };
  }

  // --------------------------------------------------------------------------
  // send-batch — mint a batch from every draft comment on the document
  // --------------------------------------------------------------------------

  private runSendBatch(
    projectId: number,
    change: FeedbackSendBatch,
  ): { batchId: string; round: number; commentIds: string[] } {
    if (!isFeedbackAtype(change.atype)) {
      throw new FeedbackError('invalid_atype', `unknown feedback atype '${String(change.atype)}'`);
    }

    const now = new Date().toISOString();
    const batchId = `fbb_${randomBytes(10).toString('hex')}`;
    let round = 0;
    let commentIds: string[] = [];

    const txn = this.db.transaction(() => {
      const busy = this.db
        .prepare(
          `SELECT 1 AS ok FROM feedback_batches
            WHERE run_id = ? AND atype = ? AND source_ref = ? AND status = 'pending'`,
        )
        .get(change.runId, change.atype, change.sourceRef) as { ok: number } | undefined;
      if (busy) {
        throw new FeedbackError(
          'busy',
          `a feedback batch is already pending for run ${change.runId} atype ${change.atype} sourceRef ${change.sourceRef}`,
        );
      }

      const drafts = this.db
        .prepare(
          `SELECT id FROM feedback_comments
            WHERE run_id = ? AND atype = ? AND source_ref = ? AND status = 'draft'
            ORDER BY created_at ASC`,
        )
        .all(change.runId, change.atype, change.sourceRef) as Array<{ id: string }>;
      if (drafts.length === 0) {
        throw new FeedbackError(
          'no_comments',
          `no draft comments for run ${change.runId} atype ${change.atype} sourceRef ${change.sourceRef}`,
        );
      }
      commentIds = drafts.map((d) => d.id);

      const maxRoundRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(round), 0) AS maxRound FROM feedback_batches
            WHERE run_id = ? AND atype = ? AND source_ref = ?`,
        )
        .get(change.runId, change.atype, change.sourceRef) as { maxRound: number };
      round = maxRoundRow.maxRound + 1;

      this.db
        .prepare(
          `INSERT INTO feedback_batches
             (id, project_id, run_id, atype, source_ref, round, status, error, created_at, applied_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
        )
        .run(batchId, projectId, change.runId, change.atype, change.sourceRef, round, now);

      const placeholders = commentIds.map(() => '?').join(', ');
      this.db
        .prepare(`UPDATE feedback_comments SET status = 'sent', batch_id = ?, sent_at = ? WHERE id IN (${placeholders})`)
        .run(batchId, now, ...commentIds);
    });
    (txn as () => void)();

    this.emitChange(projectId, change.runId, change.atype, change.sourceRef);
    return { batchId, round, commentIds };
  }

  // --------------------------------------------------------------------------
  // batch-applied — pending -> applied; comments sent -> addressed
  // --------------------------------------------------------------------------

  private runBatchApplied(projectId: number, change: FeedbackBatchApplied): { batchId: string; applied: boolean } {
    const now = new Date().toISOString();
    const batch = this.readBatch(projectId, change.batchId);
    if (!batch) {
      throw new FeedbackError('not_found', `feedback batch ${change.batchId} not found`);
    }

    let applied = false;
    const txn = this.db.transaction(() => {
      if (batch.status !== 'pending') return; // idempotent no-op — already terminal
      this.db
        .prepare(`UPDATE feedback_batches SET status = 'applied', applied_at = ? WHERE id = ? AND status = 'pending'`)
        .run(now, change.batchId);
      this.db
        .prepare(
          `UPDATE feedback_comments SET status = 'addressed', addressed_at = ?
            WHERE batch_id = ? AND status = 'sent'`,
        )
        .run(now, change.batchId);
      applied = true;
    });
    (txn as () => void)();

    if (applied) this.emitChange(projectId, batch.run_id, batch.atype, batch.source_ref);
    return { batchId: change.batchId, applied };
  }

  // --------------------------------------------------------------------------
  // batch-failed — pending -> failed; comments sent -> draft (editable retry)
  // --------------------------------------------------------------------------

  private runBatchFailed(
    projectId: number,
    change: FeedbackBatchFailed,
  ): { batchId: string; failed: boolean } {
    const batch = this.readBatch(projectId, change.batchId);
    if (!batch) {
      throw new FeedbackError('not_found', `feedback batch ${change.batchId} not found`);
    }

    let failed = false;
    const txn = this.db.transaction(() => {
      if (batch.status !== 'pending') return; // idempotent no-op — already terminal
      this.db
        .prepare(`UPDATE feedback_batches SET status = 'failed', error = ? WHERE id = ? AND status = 'pending'`)
        .run(change.error, change.batchId);
      // Revert sent comments to editable drafts (batch_id/sent_at cleared) so the
      // user can edit and retry; the failed batch row remains as the durable record.
      this.db
        .prepare(
          `UPDATE feedback_comments SET status = 'draft', batch_id = NULL, sent_at = NULL
            WHERE batch_id = ? AND status = 'sent'`,
        )
        .run(change.batchId);
      failed = true;
    });
    (txn as () => void)();

    if (failed) this.emitChange(projectId, batch.run_id, batch.atype, batch.source_ref);
    return { batchId: change.batchId, failed };
  }

  // --------------------------------------------------------------------------
  // Read helpers (no queue — plain reads)
  // --------------------------------------------------------------------------

  /** List a document's comments, newest-anchor-first-inserted (created_at ASC). */
  listComments(runId: string, atype?: FeedbackAtype, sourceRef?: string): FeedbackComment[] {
    const conditions = ['run_id = ?'];
    const params: unknown[] = [runId];
    if (atype !== undefined) {
      conditions.push('atype = ?');
      params.push(atype);
    }
    if (sourceRef !== undefined) {
      conditions.push('source_ref = ?');
      params.push(sourceRef);
    }
    const rows = this.db
      .prepare(`SELECT * FROM feedback_comments WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`)
      .all(...params) as FeedbackCommentDbRow[];

    const result: FeedbackComment[] = [];
    for (const row of rows) {
      const shaped = FeedbackRouter.shapeCommentRow(row);
      if (shaped) result.push(shaped); // fail-soft: a malformed anchor_json row is skipped
    }
    return result;
  }

  /** List a document's batches in round order. */
  listBatches(runId: string, atype?: FeedbackAtype, sourceRef?: string): FeedbackBatch[] {
    const conditions = ['run_id = ?'];
    const params: unknown[] = [runId];
    if (atype !== undefined) {
      conditions.push('atype = ?');
      params.push(atype);
    }
    if (sourceRef !== undefined) {
      conditions.push('source_ref = ?');
      params.push(sourceRef);
    }
    const rows = this.db
      .prepare(`SELECT * FROM feedback_batches WHERE ${conditions.join(' AND ')} ORDER BY round ASC`)
      .all(...params) as FeedbackBatchDbRow[];
    return rows.map((row) => FeedbackRouter.shapeBatchRow(row));
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private readComment(projectId: number, commentId: string): FeedbackCommentDbRow | undefined {
    return this.db
      .prepare('SELECT * FROM feedback_comments WHERE id = ? AND project_id = ?')
      .get(commentId, projectId) as FeedbackCommentDbRow | undefined;
  }

  private readBatch(projectId: number, batchId: string): FeedbackBatchDbRow | undefined {
    return this.db
      .prepare('SELECT * FROM feedback_batches WHERE id = ? AND project_id = ?')
      .get(batchId, projectId) as FeedbackBatchDbRow | undefined;
  }

  private emitChange(projectId: number, runId: string, atype: FeedbackAtype, sourceRef: string): void {
    const event: FeedbackChangedEvent = {
      projectId,
      runId,
      atype,
      sourceRef,
      comments: this.listComments(runId, atype, sourceRef),
      batches: this.listBatches(runId, atype, sourceRef),
    };
    feedbackEvents.emit(feedbackProjectChannel(projectId), event);
  }

  /**
   * Map a raw feedback_comments row to the API shape, parsing anchor_json
   * FAIL-SOFT: a malformed/incomplete anchor is surfaced as `null` here so the
   * caller (listComments) can skip the row rather than throw and take down an
   * entire document's read.
   */
  static shapeCommentRow(row: FeedbackCommentDbRow): FeedbackComment | null {
    let anchor: CommentAnchor;
    try {
      const parsed = JSON.parse(row.anchor_json) as Partial<CommentAnchor>;
      if (
        typeof parsed.quote !== 'string' ||
        typeof parsed.occurrence !== 'number' ||
        typeof parsed.bodyHash !== 'string'
      ) {
        return null;
      }
      anchor = { quote: parsed.quote, occurrence: parsed.occurrence, bodyHash: parsed.bodyHash };
    } catch {
      return null;
    }
    return {
      id: row.id,
      projectId: row.project_id,
      runId: row.run_id,
      atype: row.atype,
      sourceRef: row.source_ref,
      batchId: row.batch_id,
      anchor,
      body: row.body,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sentAt: row.sent_at,
      addressedAt: row.addressed_at,
    };
  }

  /** Map a raw feedback_batches row to the API shape (no JSON columns — never fails). */
  static shapeBatchRow(row: FeedbackBatchDbRow): FeedbackBatch {
    return {
      id: row.id,
      projectId: row.project_id,
      runId: row.run_id,
      atype: row.atype,
      sourceRef: row.source_ref,
      round: row.round,
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
      appliedAt: row.applied_at,
    };
  }
}
