/**
 * approvalListing — shared SELECT JOIN helper for pending approvals.
 *
 * Exports `selectPendingApprovals(db)` so the tRPC listPending procedure and
 * bridge parity tests share a single implementation of the query.  Previously
 * the tRPC router inlined this SQL and the bridge test duplicated it verbatim,
 * causing silent drift whenever the schema or projection changed.
 *
 * Standalone-typecheck invariant: NO imports from 'electron', 'better-sqlite3',
 * or main/src/services/*. Only narrow interfaces and shared utilities.
 */
import type { Approval } from '../../../shared/types/approvals';
import { truncatePayloadPreview } from '../../../shared/utils/approvals';
import type { DatabaseLike } from './types';

// ---------------------------------------------------------------------------
// Internal DB row shape for the SELECT JOIN below
// ---------------------------------------------------------------------------

interface DbApprovalRow {
  id: string;
  runId: string;
  workflowName: string;
  toolName: string;
  payloadPreviewRaw: string;
  rationale: string | null;
  createdAt: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return all pending approvals ordered oldest-first, projected into the
 * shared `Approval` type with `truncatePayloadPreview` applied.
 *
 * Reads from the `approvals` table where `status = 'pending'`, joined to
 * `workflow_runs` and `workflows` for the human-readable workflow name.
 *
 * @param db - Narrow DatabaseLike interface (real or test).
 * @returns Approval[] sorted by created_at ASC.
 */
export function selectPendingApprovals(db: DatabaseLike): Approval[] {
  const rows = db.prepare(
    `SELECT
       a.id          AS id,
       a.run_id      AS runId,
       w.name        AS workflowName,
       a.tool_name   AS toolName,
       a.tool_input_json AS payloadPreviewRaw,
       a.rationale   AS rationale,
       a.created_at  AS createdAt,
       a.status      AS status
     FROM approvals a
     JOIN workflow_runs r ON r.id = a.run_id
     JOIN workflows     w ON w.id = r.workflow_id
     WHERE a.status = 'pending'
     ORDER BY a.created_at ASC`,
  ).all() as DbApprovalRow[];

  return rows.map((row): Approval => ({
    id: row.id,
    runId: row.runId,
    workflowName: row.workflowName,
    toolName: row.toolName,
    payloadPreview: truncatePayloadPreview(row.payloadPreviewRaw),
    rationale: row.rationale,
    createdAt: new Date(row.createdAt).toISOString(),
    status: row.status as Approval['status'],
  }));
}
