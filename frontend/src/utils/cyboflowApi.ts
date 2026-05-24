/**
 * cyboflowApi — typed wrappers over the raw-IPC surface for the cyboflow orchestrator.
 *
 * IPC channels retained here:
 *   cyboflow:stream:<runId> — push channel for stream events (renderer-side only)
 *   cyboflow:approveRun     — approve / deny a day-3 gate approval request
 *
 * Migrated to tRPC (use the trpc client instead):
 *   cyboflow:startRun   → trpc.cyboflow.runs.start (TASK-715)
 *   cyboflow:mcp-health → trpc.cyboflow.health.mcpServer (TASK-715)
 *   listWorkflows       → trpc.cyboflow.workflows.list (TASK-714)
 *   listRuns            → trpc.cyboflow.runs.list (TASK-714)
 */
import type { IPCResponse } from './api';
import type {
  SystemInitEvent,
  SystemApiRetryEvent,
  SystemCompactEvent,
  SystemCompactBoundaryEvent,
  SystemHookStartedEvent,
  SystemHookResponseEvent,
  SystemStatusEvent,
  AssistantEvent,
  UserEvent,
  ResultEvent,
  SessionInfoEvent,
  RateLimitEvent,
  RunStartedEvent,
  StreamEnvelope,
} from '../../../shared/types/claudeStream';

// Re-export StreamEventType from shared so consumers get the canonical union.
export type { StreamEventType } from '../../../shared/types/claudeStream';

// Re-export individual event shapes for consumers that need them.
export type {
  SystemInitEvent,
  SystemApiRetryEvent,
  SystemCompactEvent,
  SystemCompactBoundaryEvent,
  SystemHookStartedEvent,
  SystemHookResponseEvent,
  SystemStatusEvent,
  AssistantEvent,
  UserEvent,
  ResultEvent,
  SessionInfoEvent,
  RateLimitEvent,
  RunStartedEvent,
};

/**
 * Discriminated union over all IPC envelope `type` values the renderer can receive.
 *
 * Derived from the shared `StreamEnvelope` discriminant in
 * shared/types/claudeStream.ts by intersecting with the renderer-only `runId`
 * field. Discriminate on `event.type`. Never re-declare the
 * `StreamEnvelopePayload` arms here — a parallel union silently routes new
 * SDK variants to `UnknownEventRow` if any arm is forgotten (FIND-SPRINT-031-4).
 */
export type StreamEvent = StreamEnvelope & { runId: string };

// ---------------------------------------------------------------------------
// Guard: ensure window.electron is present before every IPC call
// ---------------------------------------------------------------------------

function requireElectron(): NonNullable<Window['electron']> {
  if (!window.electron) {
    throw new Error('cyboflowApi: window.electron is not available');
  }
  return window.electron;
}

// ---------------------------------------------------------------------------
// Named function exports
// ---------------------------------------------------------------------------

/**
 * Subscribe to stream events for a run.
 *
 * Registers a listener on `cyboflow:stream:<runId>` and returns a cleanup
 * function that removes the listener when the subscriber unmounts or the
 * runId changes.
 *
 * When tRPC migration lands (TBD-tRPC-cutover): migrate to `trpc.cyboflow.events.onStreamEvent({ runId })`.
 */
export function subscribeToStreamEvents({
  runId,
  onEvent,
}: {
  runId: string;
  onEvent: (e: StreamEvent) => void;
}): () => void {
  const electron = requireElectron();
  const channel = `cyboflow:stream:${runId}`;
  let received = 0;
  // The IPC preload bridges events as (...args) where args[0] is the payload.
  const handler = (...args: unknown[]) => {
    const payload = args[0] as StreamEvent;
    received += 1;
    if (received <= 3 || received % 25 === 0) {
      console.info(`[cyboflowApi] stream event #${received} for ${runId.slice(0, 8)}:`, payload?.type);
    }
    onEvent(payload);
  };
  electron.on(channel, handler);
  return () => electron.off(channel, handler);
}

/**
 * Approve or deny a day-3 gate approval request.
 *
 * NOTE: The main-process handler is currently a NOT_IMPLEMENTED stub.
 * The day-3 gate test (TASK-355) bypasses this call and drives the
 * orchestrator directly.  Epic 7 wires the real approval flow.
 */
export async function approveRun({
  runId,
  approvalId,
  decision,
}: {
  runId: string;
  approvalId: string;
  decision: 'allow' | 'deny';
}): Promise<void> {
  const electron = requireElectron();
  const res = await electron.invoke('cyboflow:approveRun', {
    runId,
    approvalId,
    decision,
  }) as IPCResponse<unknown>;
  if (!res.success) throw new Error(res.error ?? 'approveRun failed');
}

// ---------------------------------------------------------------------------
// Convenience object — re-exports the named functions for callers that prefer
// a namespace import (`cyboflowApi.approveRun(...)`)
// ---------------------------------------------------------------------------

export const cyboflowApi = {
  subscribeToStreamEvents,
  approveRun,
};
