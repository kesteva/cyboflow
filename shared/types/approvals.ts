// PARALLEL-STUB: replaced at merge by TASK-401's full implementation
// Minimal Approval interface stub for parallel execution in TASK-402.
// Fields are taken from the plan and the existing shared/types/approval.ts shape.

export interface Approval {
  id: string;
  runId: string;
  toolName: string;
  input: Record<string, unknown>;
  timestamp: number;
}
