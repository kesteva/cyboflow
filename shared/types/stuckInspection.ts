/**
 * Shared types for the stuck-run inspector query and modal.
 *
 * These types are the wire contract between:
 *   - main/src/orchestrator/inspectorQueries.ts (getStuckInspectionHandler)
 *   - main/src/orchestrator/trpc/routers/runs.ts (cyboflow.runs.getStuckInspection procedure)
 *   - frontend/src/components/ReviewQueue/StuckInspectorModal.tsx (modal)
 *
 * Pure type module: NO runtime imports.
 */

// Re-export WorkflowRunStatus from the canonical location so consumers
// can import it from this module without a second import path.
export type { WorkflowRunStatus } from './cyboflow';

// ---------------------------------------------------------------------------
// Inspection result types
// ---------------------------------------------------------------------------

/** A single raw event row as returned by getStuckInspectionHandler. */
export interface RawEvent {
  id: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

/** A pending approval row as returned by getStuckInspectionHandler. */
export interface PendingApproval {
  toolName: string;
  input: unknown;
  createdAt: string;
}

/** Full result type for getStuckInspectionHandler. */
export interface StuckInspectionResult {
  runId: string;
  stuckReason: string | null;
  stuckDetectedAt: string | null;
  pendingApproval: PendingApproval | null;
  recentEvents: RawEvent[];
}
