/**
 * approvalCreatedBridge — resolves workflowName for SSE approval events.
 *
 * Extracts the JOIN logic that maps a workflow_run row to its human-readable
 * workflow name so the SSE-pushed ApprovalCreatedEvent carries the same
 * workflowName field that listPending returns for the same approval.
 *
 * Design notes:
 *  - JOIN at bridge (not inside ApprovalRouter.requestApproval) so the
 *    in-memory ApprovalRequest shape stays lean for the SDK PreToolUse hook,
 *    which never reads workflowName.
 *  - Missing-row fallback: emit with workflowName='' and log a console.warn
 *    rather than throwing, because silent-drop creates an invisible discard
 *    mode that is harder to debug than a warn.
 *  - Inlines the 512-char truncation literal; TASK-721 (B4) will extract this
 *    constant into shared/utils/approvals.ts and update the import here.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*.
 */
import type { ApprovalRequest } from '../../../shared/types/approval';
import type { ApprovalCreatedEvent } from '../../../shared/types/approvals';
import type { DatabaseLike } from './types';

/** Maximum payload preview length in characters (matches listPending). */
const PAYLOAD_PREVIEW_MAX_LEN = 512;

/**
 * Build an ApprovalCreatedEvent from an in-memory ApprovalRequest by
 * resolving the human-readable workflow name via a SELECT JOIN.
 *
 * @param request - The in-process approval request emitted by ApprovalRouter.
 * @param db      - Narrow DatabaseLike interface (real or test).
 * @returns An ApprovalCreatedEvent ready for approvalEvents.emit('created', …).
 */
export function buildApprovalCreatedEvent(
  request: ApprovalRequest,
  db: DatabaseLike,
): ApprovalCreatedEvent {
  let workflowName = '';

  try {
    const row = db
      .prepare(
        `SELECT w.name AS name
         FROM workflow_runs r
         JOIN workflows w ON w.id = r.workflow_id
         WHERE r.id = ?`,
      )
      .get(request.runId) as { name: string } | undefined;

    if (row && typeof row.name === 'string') {
      workflowName = row.name;
    } else {
      console.warn(
        `[approvalCreatedBridge] No workflow row found for runId=${request.runId}`,
      );
    }
  } catch (err) {
    console.warn(
      `[approvalCreatedBridge] workflowName lookup threw for runId=${request.runId}: ${err}`,
    );
  }

  const payloadJson = JSON.stringify(request.input);
  const payloadPreview =
    payloadJson.length > PAYLOAD_PREVIEW_MAX_LEN
      ? payloadJson.slice(0, PAYLOAD_PREVIEW_MAX_LEN)
      : payloadJson;

  return {
    approval: {
      id: request.id,
      runId: request.runId,
      workflowName,
      toolName: request.toolName,
      payloadPreview,
      rationale: null,
      createdAt: new Date(request.timestamp).toISOString(),
      status: 'pending',
    },
  };
}
