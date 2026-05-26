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
  | 'canceled'
  | 'awaiting_input';

/**
 * Terminal workflow_runs statuses — runs in these states cannot transition
 * further. Used by every cancel/finalize path that needs to reject re-entry.
 *
 * The SQL literal is derived from the array so a future status addition is
 * a single edit. Both `services/cyboflow/*` and `orchestrator/trpc/routers/*`
 * import from this module, so this constant is the canonical source.
 */
export const TERMINAL_RUN_STATUSES = ['canceled', 'failed', 'completed'] as const;
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];
export const TERMINAL_RUN_STATUSES_SQL_IN = `('${TERMINAL_RUN_STATUSES.join(
  "','",
)}')`;

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
