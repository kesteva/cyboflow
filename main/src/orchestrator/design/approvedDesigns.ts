/**
 * approvedDesigns — the Approve read model (design-mode.md "Idea-bound artifact +
 * read path"). "The current approved design for an idea" is the single
 * approved_designs row WHERE idea_id=? AND superseded_at IS NULL; a re-approve
 * supersedes the prior row (stamps superseded_at) and inserts a fresh current row
 * in the SAME transaction (see designHandoffService.ts Step 3). Superseded rows
 * are retained as history.
 *
 * These accessors back the cyboflow.design tRPC router now and the later
 * cyboflow_get_task idea-exposure lane — so they are exported cleanly and take the
 * narrow DatabaseLike (no service imports; standalone-typecheck-safe).
 */
import type { DatabaseLike } from '../types';
import type { ApprovedDesignRow } from '../../database/models';

/** All approved_designs columns, oldest-first-safe ordered where relevant. */
const COLUMNS =
  'id, idea_id AS ideaId, project_id AS projectId, handoff_id AS handoffId, session_id AS sessionId, ' +
  'draft_revision AS draftRevision, prototype_artifact_id AS prototypeArtifactId, ' +
  'prototype_revision AS prototypeRevision, snapshot_path AS snapshotPath, ' +
  'approved_at AS approvedAt, superseded_at AS supersededAt, ' +
  'source AS source, source_run_id AS sourceRunId';

/**
 * The camelCase read-model shape returned to callers (the DB row is snake_case).
 * A superseded row carries a non-null `supersededAt`; the current row's is null.
 */
export interface ApprovedDesign {
  id: string;
  ideaId: string;
  projectId: number;
  /** NULL for a `source:'flow'` row — a flow approval has no design handoff (migration 134). */
  handoffId: string | null;
  /** NULL for a `source:'flow'` row — a flow approval has no Design Mode session. */
  sessionId: string | null;
  draftRevision: number;
  prototypeArtifactId: string;
  prototypeRevision: number;
  snapshotPath: string;
  approvedAt: string;
  supersededAt: string | null;
  /**
   * Which pathway approved this design (migration 134). A 'design-mode' row
   * OUTRANKS a flow prototype: flowDesignBinding skips an idea whose current row
   * is design-mode rather than superseding it ("arrived with an approved design →
   * leave it alone").
   */
  source: ApprovedDesignSource;
  /** The workflow run that bound a 'flow' row; null for 'design-mode'. */
  sourceRunId: string | null;
}

/** The two pathways that can publish an approved design (migration 134). */
export type ApprovedDesignSource = 'design-mode' | 'flow';

/** Row shape as SELECTed with the aliased columns above. */
type ApprovedDesignSelectRow = ApprovedDesign;

/** Map a snake_case row to the camelCase read-model shape. */
function shape(row: ApprovedDesignSelectRow): ApprovedDesign {
  return {
    id: row.id,
    ideaId: row.ideaId,
    projectId: typeof row.projectId === 'number' ? row.projectId : Number(row.projectId),
    handoffId: row.handoffId,
    sessionId: row.sessionId,
    draftRevision: row.draftRevision,
    prototypeArtifactId: row.prototypeArtifactId,
    prototypeRevision: row.prototypeRevision,
    snapshotPath: row.snapshotPath,
    approvedAt: row.approvedAt,
    supersededAt: row.supersededAt ?? null,
    // Defensive defaults: a pre-134 row read through a stale connection would
    // carry neither column. 'design-mode' is the safe reading — it makes the
    // binder LEAVE the row alone rather than overwrite an approval it cannot
    // classify.
    source: row.source === 'flow' ? 'flow' : 'design-mode',
    sourceRunId: row.sourceRunId ?? null,
  };
}

/**
 * The current approved design for an idea (superseded_at IS NULL), or null when
 * the idea has never been approved (or its last approval was somehow superseded
 * without a replacement — which the Step 3 supersede+insert transaction prevents).
 */
export function getCurrentApprovedDesign(db: DatabaseLike, ideaId: string): ApprovedDesign | null {
  const row = db
    .prepare(`SELECT ${COLUMNS} FROM approved_designs WHERE idea_id = ? AND superseded_at IS NULL LIMIT 1`)
    .get(ideaId) as ApprovedDesignSelectRow | undefined;
  return row ? shape(row) : null;
}

/**
 * The full approval history for an idea, newest first (the current row — if any —
 * leads, then superseded rows in reverse-approval order). Used for a
 * design-history surface + audit.
 */
export function listApprovedDesignHistory(db: DatabaseLike, ideaId: string): ApprovedDesign[] {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM approved_designs WHERE idea_id = ?
        ORDER BY (superseded_at IS NULL) DESC, approved_at DESC, id DESC`,
    )
    .all(ideaId) as ApprovedDesignSelectRow[];
  return rows.map(shape);
}

/** Re-export the DB row type so consumers can reference either shape. */
export type { ApprovedDesignRow };
