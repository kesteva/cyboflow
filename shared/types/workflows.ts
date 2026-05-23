/**
 * Shared types for the workflow registry and workflow run subsystem.
 *
 * These types are consumed by both the main process (WorkflowRegistry) and
 * the renderer (workflow picker, run-status views).  Keep this file free of
 * Node.js built-ins so it can be imported in any environment.
 */

export type PermissionMode = 'default' | 'acceptEdits' | 'dontAsk';

export interface WorkflowRow {
  id: string;
  project_id: number;
  name: string;
  workflow_path: string | null;
  permission_mode: PermissionMode;
  created_at: string;
}

export interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  project_id: number;
  status:
    | 'queued'
    | 'starting'
    | 'running'
    | 'awaiting_review'
    | 'stuck'
    | 'completed'
    | 'failed'
    | 'canceled';
  permission_mode_snapshot: PermissionMode;
  worktree_path: string | null;
  branch_name: string | null;
  policy_json?: string | null;
  stuck_at?: string | null;
  stuck_reason?: string | null;
  error_message?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Subset of WorkflowRunRow returned by cyboflow.runs.list (and the raw-IPC
 * cyboflow:listRuns handler). The heavy snapshot column is excluded.
 * Centralized so the tRPC procedure and the legacy cyboflowApi wrapper
 * share one shape.
 */
export interface WorkflowRunListRow {
  id: string;
  workflow_id: string;
  project_id: number;
  status: WorkflowRunRow['status'];
  worktree_path: string | null;
  branch_name: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
  stuck_reason: string | null;
}

export const SOLOFLOW_WORKFLOW_NAMES = [
  'soloflow',
  'planner',
  'sprint',
  'compound',
  'prune',
] as const;

export type SoloFlowWorkflowName = (typeof SOLOFLOW_WORKFLOW_NAMES)[number];
