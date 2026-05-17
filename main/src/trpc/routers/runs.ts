/**
 * cyboflow.runs sub-router handler implementations.
 *
 * Exports testable handler functions that can be called directly in unit tests
 * without the tRPC wrapper. The orchestrator's runsRouter stubs delegate here
 * once ctx.db is wired.
 *
 * Following the same pattern as main/src/trpc/routers/approvals.ts, which hosts
 * approveRestOfRunHandler alongside a re-export of the live approvalsRouter.
 *
 * Standalone-typecheck invariant: no imports from 'electron'.
 */

// Re-export the canonical router so callers can import both the router and
// handler functions from a single location.
export { runsRouter } from '../../orchestrator/trpc/routers/runs';

// ---------------------------------------------------------------------------
// Output types — imported for local use and re-exported from the shared module
// so downstream consumers can import from a single location without creating
// an import cycle.
// ---------------------------------------------------------------------------

import type {
  RawEvent,
  PendingApproval,
  StuckInspectionResult,
} from '../../../../shared/types/stuckInspection';

export type { RawEvent, PendingApproval, StuckInspectionResult };

// ---------------------------------------------------------------------------
// Narrow DB types for direct testing
// ---------------------------------------------------------------------------

interface PreparedStatement<Row> {
  get: (...params: unknown[]) => Row | undefined;
  all: (...params: unknown[]) => Row[];
}

interface InspectorDb {
  prepare<Row = unknown>(sql: string): PreparedStatement<Row>;
}

// ---------------------------------------------------------------------------
// Row types (internal)
// ---------------------------------------------------------------------------

interface RunRow {
  id: string;
  status: string;
  stuck_reason: string | null;
  stuck_detected_at: string | null;
}

interface ApprovalRow {
  tool_name: string;
  tool_input_json: string;
  created_at: string;
}

interface EventRow {
  id: number;
  event_type: string;
  payload_json: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// getStuckInspectionHandler
// ---------------------------------------------------------------------------

/**
 * Core implementation of the stuck-inspection read query — extracted for
 * direct testing without the tRPC wrapper.
 *
 * Returns diagnostic data for a single stuck run:
 *   - Run metadata: stuckReason, stuckDetectedAt
 *   - The first pending approval for the run (if any)
 *   - The latest 10 raw_events rows ordered by id DESC
 *
 * Principal scoping is enforced by the caller (tRPC procedure or test shim).
 *
 * @param db       - Narrow DatabaseLike surface.
 * @param runId    - The workflow_runs.id to inspect.
 * @returns Full inspection payload or null if the run does not exist.
 */
export function getStuckInspectionHandler(
  db: InspectorDb,
  runId: string,
): StuckInspectionResult | null {
  // 1. Fetch run metadata.
  const run = db
    .prepare<RunRow>(
      `SELECT id, status, stuck_reason, stuck_detected_at
       FROM workflow_runs
       WHERE id = ?`,
    )
    .get(runId);

  if (run === undefined) {
    return null;
  }

  // 2. Fetch the first pending approval for this run.
  const approvalRow = db
    .prepare<ApprovalRow>(
      `SELECT tool_name, tool_input_json, created_at
       FROM approvals
       WHERE run_id = ? AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get(runId);

  let pendingApproval: PendingApproval | null = null;
  if (approvalRow !== undefined) {
    let input: unknown;
    try {
      input = JSON.parse(approvalRow.tool_input_json) as unknown;
    } catch {
      input = approvalRow.tool_input_json;
    }
    pendingApproval = {
      toolName: approvalRow.tool_name,
      input,
      createdAt: approvalRow.created_at,
    };
  }

  // 3. Fetch the latest 10 raw_events ordered by id DESC.
  const eventRows = db
    .prepare<EventRow>(
      `SELECT id, event_type, payload_json, created_at
       FROM raw_events
       WHERE run_id = ?
       ORDER BY id DESC
       LIMIT 10`,
    )
    .all(runId);

  const recentEvents: RawEvent[] = eventRows.map((row) => {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload_json) as unknown;
    } catch {
      payload = row.payload_json;
    }
    return {
      id: row.id,
      eventType: row.event_type,
      payload,
      createdAt: row.created_at,
    };
  });

  return {
    runId: run.id,
    stuckReason: run.stuck_reason,
    stuckDetectedAt: run.stuck_detected_at,
    pendingApproval,
    recentEvents,
  };
}
