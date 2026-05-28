/**
 * PendingApprovalsForRun — inline pending-approval strip for a single run.
 *
 * Renders the ReviewQueue PendingApprovalCard(s) for approvals whose runId
 * matches, so permission prompts surface inline in the conversation (the
 * quick-session panel surface and the workflow-run chat) instead of only in
 * the detached Review Queue side panel. Returns null when there is no run or
 * no pending approval for it.
 */
import type { ReactElement } from 'react';
import { useReviewQueueStore } from '../../stores/reviewQueueStore';
import { PendingApprovalCard } from './PendingApprovalCard';
import type { Approval } from '../../../../shared/types/approvals';
import type { QueueItem } from '../../utils/reviewQueueSelectors';

function approvalToQueueItem(approval: Approval): QueueItem {
  return { kind: 'single', approval, isBlocking: false };
}

export function PendingApprovalsForRun({
  runId,
  className = '',
}: {
  runId: string | null;
  className?: string;
}): ReactElement | null {
  const queue = useReviewQueueStore((s) => s.queue);
  const runApprovals = runId === null ? [] : queue.filter((a) => a.runId === runId);
  if (runApprovals.length === 0) return null;
  return (
    <div className={`rounded border border-border-primary bg-bg-secondary p-2 ${className}`.trim()}>
      <p className="mb-2 text-xs font-semibold text-text-primary">Pending approvals</p>
      <div>
        {runApprovals.map((approval) => (
          <PendingApprovalCard key={approval.id} item={approvalToQueueItem(approval)} />
        ))}
      </div>
    </div>
  );
}
