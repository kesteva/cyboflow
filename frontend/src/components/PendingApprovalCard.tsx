import React, { useState } from 'react';
import { Button } from './ui/Button';
import { formatAge, truncatePayload } from '../utils/approvalFormatters';
import { trpc } from '../trpc/client';
import type { QueueItem } from '../utils/reviewQueueSelectors';

interface PendingApprovalCardProps {
  item: QueueItem;
  /** When true, renders a visible focus ring for keyboard-navigation highlighting. */
  isFocused?: boolean;
}

/**
 * Card for a single pending approval gate (or a group of repeated approvals)
 * in the review queue.
 *
 * Supports two variants:
 *  - `kind: 'single'` — renders one approval with optional "blocked Nm" badge.
 *  - `kind: 'group'` — renders a collapsed card for N same-signature approvals
 *    from the same run; a single Approve/Reject pair fires all N mutations.
 *
 * Carries data-approval-id and role="listitem" for keyboard-nav targeting
 * (TASK-404). For groups, data-approval-id is the first item's id.
 */
export function PendingApprovalCard({ item, isFocused = false }: PendingApprovalCardProps): React.ReactElement {
  const [busy, setBusy] = useState(false);

  const focusClass = isFocused
    ? ' ring-2 ring-interactive'
    : ' focus-within:ring-2 focus-within:ring-interactive';

  if (item.kind === 'group') {
    const { toolName, items, isBlocking } = item;
    const representative = items[0];
    const truncated = truncatePayload(representative.payloadPreview);

    async function handleGroupApprove(): Promise<void> {
      setBusy(true);
      try {
        await Promise.all(
          items.map((a) => trpc.cyboflow.approvals.approve.mutate({ approvalId: a.id })),
        );
      } finally {
        setBusy(false);
      }
    }

    async function handleGroupReject(): Promise<void> {
      setBusy(true);
      try {
        await Promise.all(
          items.map((a) => trpc.cyboflow.approvals.reject.mutate({ approvalId: a.id })),
        );
      } finally {
        setBusy(false);
      }
    }

    return (
      <div
        data-approval-id={representative.id}
        role="listitem"
        className={`px-4 py-3 border-b border-border-primary hover:bg-surface-hover cursor-default${focusClass}`}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-text-muted">{representative.workflowName}</span>
          <span className="text-sm font-semibold text-text-primary">
            {toolName} (×{items.length} in this run)
          </span>
          {isBlocking && (
            <span className="ml-1 text-xs font-medium text-status-error">
              blocked {formatAge(representative.createdAt)}
            </span>
          )}
          <span className="ml-auto text-xs text-text-muted">{formatAge(representative.createdAt)}</span>
        </div>

        {representative.rationale != null && representative.rationale !== '' && (
          <p className="text-xs italic text-text-muted my-2">{representative.rationale}</p>
        )}

        <pre className="text-xs font-mono bg-bg-tertiary px-2 py-1 rounded overflow-hidden">
          {truncated.text}{truncated.truncated && '…'}
        </pre>

        <div className="flex gap-2 mt-3">
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => { void handleGroupApprove(); }}
          >
            Approve
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => { void handleGroupReject(); }}
          >
            Reject
          </Button>
        </div>
      </div>
    );
  }

  // kind === 'single'
  const { approval, isBlocking } = item;
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
      className={`px-4 py-3 border-b border-border-primary hover:bg-surface-hover cursor-default${focusClass}`}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-text-muted">{approval.workflowName}</span>
        <span className="text-sm font-semibold text-text-primary">{approval.toolName}</span>
        {isBlocking && (
          <span className="ml-1 text-xs font-medium text-status-error">
            blocked {formatAge(approval.createdAt)}
          </span>
        )}
        <span className="ml-auto text-xs text-text-muted">{formatAge(approval.createdAt)}</span>
      </div>

      {approval.rationale != null && approval.rationale !== '' && (
        <p className="text-xs italic text-text-muted my-2">{approval.rationale}</p>
      )}

      <pre className="text-xs font-mono bg-bg-tertiary px-2 py-1 rounded overflow-hidden">
        {truncated.text}{truncated.truncated && '…'}
      </pre>

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
