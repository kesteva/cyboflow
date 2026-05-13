// Row types for the Cyboflow orchestrator schema (migration 006).
// JSON columns are kept as `string` here — parsing/validation happens at
// the service boundary with the corresponding Zod schemas.

export type WorkflowRunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'awaiting_review'
  | 'stuck'
  | 'completed'
  | 'failed'
  | 'canceled';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timed_out';

export interface WorkflowRow {
  id: string;
  project_id: number;
  name: string;
  description: string | null;
  spec_json: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  project_id: number;
  worktree_path: string;
  status: WorkflowRunStatus;
  policy_json: string;
  stuck_at: string | null;
  stuck_reason: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface RawEventRow {
  id: number;
  run_id: string;
  event_type: string;
  payload_json: string;
  created_at: string;
}

export interface MessageRow {
  id: string;
  run_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content_json: string;
  created_at: string;
}

export interface ApprovalRow {
  id: string;
  run_id: string;
  tool_name: string;
  tool_input_json: string;
  tool_use_id: string;
  rationale: string | null;
  status: ApprovalStatus;
  decided_at: string | null;
  decided_by: string | null;
  created_at: string;
}
