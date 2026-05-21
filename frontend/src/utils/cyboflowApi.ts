/**
 * cyboflowApi — typed wrappers over the IPC surface for the cyboflow orchestrator.
 *
 * Currently routes through the raw-IPC bridge; tRPC migration is a separate
 * future task (see docs/ARCHITECTURE.md "cyboflow.* transport status").
 * Component call sites are unchanged when the internals are swapped.
 *
 * IPC channels:
 *   cyboflow:listWorkflows  — list workflows for a project (+ auto-seed)
 *   cyboflow:startRun       — launch a new workflow run
 *   cyboflow:stream:<runId> — push channel for stream events (renderer-side only)
 *   cyboflow:approveRun     — approve / deny a day-3 gate approval request
 *   cyboflow:mcp-health     — polled by mcpHealthStore (removed from this util in TASK-626)
 */
import type { WorkflowRow } from '../../../shared/types/workflows';
import type { WorkflowRunStatus } from '../../../shared/types/cyboflow';
import type { IPCResponse } from './api';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface StartRunResult {
  runId: string;
  worktreePath: string;
  branchName: string;
}

/**
 * Subset of `WorkflowRunRow` (shared/types/cyboflow.ts) returned by cyboflow:listRuns.
 * Intentionally excludes `policy_json` (not needed by the sidebar list view).
 */
export interface WorkflowRunListRow {
  id: string;
  workflow_id: string;
  project_id: number;
  status: WorkflowRunStatus;
  worktree_path: string | null;
  branch_name: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
  stuck_reason: string | null;
}

/**
 * Discriminator values emitted by main/src/services/streamParser/derivers.ts:deriveEventType.
 * The five SDK-shaped values mirror shared/types/claudeStream.ts ClaudeStreamEvent.type.
 * 'unknown' is the catch-all produced when the main-process narrower cannot classify an event.
 */
export type StreamEventType =
  | 'system'
  | 'assistant'
  | 'user'
  | 'result'
  | 'stream_event'
  | 'unknown';

export interface StreamEvent {
  runId: string;
  type: StreamEventType;
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
  const res = await electron.invoke('cyboflow:listWorkflows', { projectId }) as IPCResponse<WorkflowRow[]>;
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
  workflowId: string;
  projectId: number;
}): Promise<StartRunResult> {
  const electron = requireElectron();
  const res = await electron.invoke('cyboflow:startRun', { workflowId, projectId }) as IPCResponse<StartRunResult>;
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

/**
 * List the workflow runs for a project, newest first.
 * Returns a lightweight row (policy_json excluded).
 */
export async function listRuns({ projectId }: { projectId: number }): Promise<WorkflowRunListRow[]> {
  const electron = requireElectron();
  const res = await electron.invoke('cyboflow:listRuns', { projectId }) as IPCResponse<WorkflowRunListRow[]>;
  if (!res.success) throw new Error(res.error ?? 'listRuns failed');
  return res.data ?? [];
}

// ---------------------------------------------------------------------------
// Convenience object — re-exports the named functions for callers that prefer
// a namespace import (`cyboflowApi.startRun(...)`)
// ---------------------------------------------------------------------------

export const cyboflowApi = {
  listWorkflows,
  listRuns,
  startRun,
  subscribeToStreamEvents,
  approveRun,
};
