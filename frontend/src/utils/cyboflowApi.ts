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
 * Alias of the shared `StreamEnvelope` discriminant in
 * shared/types/claudeStream.ts. Discriminate on `event.type`. Never re-declare
 * the `StreamEnvelopePayload` arms here — a parallel union silently routes new
 * SDK variants to `UnknownEventRow` if any arm is forgotten (FIND-SPRINT-031-4).
 *
 * The run is already discriminated by the `cyboflow:stream:<runId>` channel, so
 * the envelope carries no top-level `runId` (FIND-SPRINT-016-3).
 */
export type StreamEvent = StreamEnvelope;

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
 * Subscribe to the RAW interactive-PTY byte stream for a run.
 *
 * Registers a listener on the dedicated `cyboflow:pty:<runId>` channel and
 * returns a cleanup function that removes it on unmount / runId change.
 *
 * This is a RAW byte channel — NOT the structured `cyboflow:stream:<runId>`
 * envelope. The backend `ptyPublisher` (TASK-814) sends each chunk as the
 * verbatim PTY ANSI string, so the payload is typed as a plain `string`:
 *   - it is NOT a tRPC/AppRouter output, so it does NOT reuse the
 *     AppRouter-coupled `StreamEvent` discriminated union, and
 *   - it is NOT wrapped in an `IPCResponse`.
 * The bytes feed `xterm.Terminal.write()` DIRECTLY (see
 * `InteractiveTerminalView`) and must NEVER enter `cyboflowStore.streamEvents`
 * (Q3 panel-preservation / store-isolation). The structured `runEventBridge`
 * drops this channel by construction (its `type !== 'json'` filter), so the two
 * pipelines never cross-contaminate.
 */
export function subscribeToPtyBytes({
  runId,
  onData,
}: {
  runId: string;
  onData: (chunk: string) => void;
}): () => void {
  const electron = requireElectron();
  const channel = `cyboflow:pty:${runId}`;
  // The IPC preload bridges events as (...args) where args[0] is the raw chunk.
  const handler = (...args: unknown[]) => {
    onData(args[0] as string);
  };
  electron.on(channel, handler);
  return () => electron.off(channel, handler);
}

/**
 * Subscribe to the RAW user-shell byte stream for a run (worktree-terminal).
 *
 * Twin of {@link subscribeToPtyBytes} but for the PLAIN worktree shell behind the
 * run "Shell" tab (RunShellManager), on the dedicated `cyboflow:shell:<runId>`
 * channel. Same contract: raw ANSI `string` chunks fed straight to
 * `xterm.Terminal.write()`, NOT an `IPCResponse`, NEVER routed into the structured
 * cyboflow stream store (Q3 store-isolation). This is the USER's shell, wholly
 * separate from the agent PTY on `cyboflow:pty:<runId>`.
 */
export function subscribeToShellBytes({
  runId,
  onData,
}: {
  runId: string;
  onData: (chunk: string) => void;
}): () => void {
  const electron = requireElectron();
  const channel = `cyboflow:shell:${runId}`;
  // The IPC preload bridges events as (...args) where args[0] is the raw chunk.
  const handler = (...args: unknown[]) => {
    onData(args[0] as string);
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
  subscribeToPtyBytes,
  subscribeToShellBytes,
  approveRun,
};
