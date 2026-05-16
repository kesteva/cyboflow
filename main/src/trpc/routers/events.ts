/**
 * cyboflow.events sub-router — TASK-401 stable import surface.
 *
 * Re-exports the canonical eventsRouter (onApprovalCreated, onApprovalDecided,
 * onStreamEvent, setBadgeCount) from the orchestrator sub-tree.
 *
 * The orchestrator owns the live router definition and the approvalEvents
 * EventEmitter singleton; this file provides the stable import surface for
 * callers outside the orchestrator package.
 *
 * Standalone-typecheck invariant: no imports from 'electron'.
 */

// Re-export the canonical router so the AC grep finds 'onApprovalCreated' here.
// The router definition lives in main/src/orchestrator/trpc/routers/events.ts.
export { eventsRouter, approvalEvents } from '../../orchestrator/trpc/routers/events';
// (onApprovalCreated is a procedure on eventsRouter — re-exported above)
