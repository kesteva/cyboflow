import React, { useState } from 'react';
import { Button } from './ui/Button';
import { formatAge, truncatePayload } from '../utils/approvalFormatters';
import { trpc } from '../trpc/client';
import type { Approval } from '../../../shared/types/approvals';

interface PendingApprovalCardProps {
  approval: Approval;
}

/**
 * Card for a single pending approval gate in the review queue.
 *
 * Renders five context fields so the user can approve confidently without
 * reading raw payloads (per user-needs research §4 — rationale + tool name
 * + payload preview is the friction reducer for the 93%-rote-approval flow).
 *
 * Carries data-approval-id and role="listitem" for keyboard-nav targeting
 * (TASK-404).
 */
export function PendingApprovalCard({ approval }: PendingApprovalCardProps): React.ReactElement {
  const [busy, setBusy] = useState(false);

  const truncated = truncatePayload(approval.payloadPreview);

  async function handleApprove(): Promise<void> {
    setBusy(true);
    try {
      await trpc.cyboflow.approvals.approve.mutate({ approvalId: approval.id });
    } finally {
      setBusy(false);
    }
  }

  async function handleReject(): Promise<void> {
    setBusy(true);
    try {
      await trpc.cyboflow.approvals.reject.mutate({ approvalId: approval.id });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-approval-id={approval.id}
      role="listitem"
      className="px-4 py-3 border-b border-border-primary hover:bg-surface-hover focus-within:ring-2 focus-within:ring-accent-primary cursor-default"
    >
      {/* Header: workflow name + tool name + age */}
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-text-muted">{approval.workflowName}</span>
        <span className="text-sm font-semibold text-text-primary">{approval.toolName}</span>
        <span className="ml-auto text-xs text-text-muted">{formatAge(approval.createdAt)}</span>
      </div>

      {/* Rationale (conditional) — rendered above payload in muted italic style */}
      {approval.rationale != null && approval.rationale !== '' && (
        <p className="text-xs italic text-text-muted my-2">{approval.rationale}</p>
      )}

      {/* Payload preview */}
      <pre className="text-xs font-mono bg-bg-tertiary px-2 py-1 rounded overflow-hidden">
        {truncated.text}{truncated.truncated && '…'}
      </pre>

      {/* Action row */}
      <div className="flex gap-2 mt-3">
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={() => { void handleApprove(); }}
        >
          Approve
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => { void handleReject(); }}
        >
          Reject
        </Button>
      </div>
    </div>
  );
}
