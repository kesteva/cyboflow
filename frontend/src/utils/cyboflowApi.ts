/**
 * cyboflowApi — typed wrappers over the IPC surface for the cyboflow orchestrator.
 *
 * Currently routes through the existing `window.electron` IPC bridge.
 * When tRPC lands in epic 6, swap the internals of each function; component
 * call sites are unchanged.
 *
 * IPC channels:
 *   cyboflow:listWorkflows  — list workflows for a project (+ auto-seed)
 *   cyboflow:startRun       — launch a new workflow run
 *   cyboflow:stream:<runId> — push channel for stream events (renderer-side only)
 *   cyboflow:approveRun     — approve / deny a day-3 gate approval request
 */
import type { WorkflowRow } from '../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface StartRunResult {
  runId: string;
  worktreePath: string;
  branchName: string;
}

export interface StreamEvent {
  runId: string;
  type: string;
  payload: unknown;
  timestamp: string;
}

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
// Named function exports (AC5: at least 4 named exports matching the contract)
// ---------------------------------------------------------------------------

/**
 * List the workflows registered for a project.
 * The main-process handler auto-seeds the 5 SoloFlow defaults on first call.
 */
export async function listWorkflows({ projectId }: { projectId: number }): Promise<WorkflowRow[]> {
  const electron = requireElectron();
  const res = await electron.invoke('cyboflow:listWorkflows', { projectId }) as {
    success: boolean;
    data?: WorkflowRow[];
    error?: string;
  };
  if (!res.success) throw new Error(res.error ?? 'listWorkflows failed');
  return res.data ?? [];
}

/**
 * Launch a new workflow run for the given workflow.
 * Returns the runId, worktree path, and branch name.
 */
export async function startRun({
  workflowId,
  projectId,
}: {
  workflowId: number;
  projectId: number;
}): Promise<StartRunResult> {
  const electron = requireElectron();
  const res = await electron.invoke('cyboflow:startRun', { workflowId, projectId }) as {
    success: boolean;
    data?: StartRunResult;
    error?: string;
  };
  if (!res.success) throw new Error(res.error ?? 'startRun failed');
  if (!res.data) throw new Error('startRun: no data in response');
  return res.data;
}

/**
 * Subscribe to stream events for a run.
 *
 * Registers a listener on `cyboflow:stream:<runId>` and returns a cleanup
 * function that removes the listener when the subscriber unmounts or the
 * runId changes.
 *
 * When tRPC lands: migrate to `trpc.cyboflow.events.onStreamEvent({ runId })`.
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
  // The IPC preload bridges events as (...args) where args[0] is the payload.
  const handler = (...args: unknown[]) => {
    const payload = args[0] as StreamEvent;
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
  }) as {
    success: boolean;
    error?: string;
  };
  if (!res.success) throw new Error(res.error ?? 'approveRun failed');
}

// ---------------------------------------------------------------------------
// Convenience object — re-exports the named functions for callers that prefer
// a namespace import (`cyboflowApi.startRun(...)`)
// ---------------------------------------------------------------------------

export const cyboflowApi = {
  listWorkflows,
  startRun,
  subscribeToStreamEvents,
  approveRun,
};
