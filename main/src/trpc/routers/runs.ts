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

// The stuck-inspection handler has been relocated to
// main/src/orchestrator/inspectorQueries.ts (TASK-709).
// The full legacy tree (including this file) will be deleted in TASK-717.
