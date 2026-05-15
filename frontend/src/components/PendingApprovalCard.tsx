// PARALLEL-STUB: replaced at merge by TASK-403's full implementation
// Minimal placeholder card for parallel execution in TASK-402.
import type { Approval } from '../../../shared/types/approvals';

interface PendingApprovalCardProps {
  approval: Approval;
}

export default function PendingApprovalCard({ approval }: PendingApprovalCardProps) {
  return (
    <div className="px-4 py-3 border-b border-border-primary" data-testid="pending-approval-card">
      {approval.toolName}
    </div>
  );
}
