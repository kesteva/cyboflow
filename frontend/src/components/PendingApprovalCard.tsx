import React, { useState } from 'react';
import { Button } from './ui/Button';
import { formatAge, truncatePayload } from '../utils/approvalFormatters';
import { trpc } from '../utils/trpcClient';
import type { Approval } from '../../../shared/types/approvals';
import type { QueueItem } from '../utils/reviewQueueSelectors';

interface PendingApprovalCardProps {
  item: QueueItem;
  /** When true, renders a visible focus ring for keyboard-navigation highlighting. */
  isFocused?: boolean;
}

// ---------------------------------------------------------------------------
// Internal subcomponent — shared card chrome
// ---------------------------------------------------------------------------

interface CardChromeProps {
  /** The approval whose metadata (workflowName, createdAt, rationale, payload) drives the card. */
  representative: Approval;
  /** Label shown in the header, e.g. "Bash" or "Bash (×7 in this run)". */
  label: string;
  /** When true, renders the "blocked Nm" badge. */
  isBlocking: boolean;
  /** When true, Approve/Reject buttons are disabled (mutation in flight). */
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  isFocused: boolean;
}

function CardChrome({
  representative,
  label,
  isBlocking,
  busy,
  onApprove,
  onReject,
  isFocused,
}: CardChromeProps): React.ReactElement {
  const focusClass = isFocused
    ? ' ring-2 ring-interactive'
    : ' focus-within:ring-2 focus-within:ring-interactive';

  const truncated = truncatePayload(representative.payloadPreview);

  return (
    <div
      data-approval-id={representative.id}
      role="listitem"
      className={`px-4 py-3 border-b border-border-primary hover:bg-surface-hover cursor-default${focusClass}`}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-text-muted">{representative.workflowName}</span>
        <span className="text-sm font-semibold text-text-primary">{label}</span>
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
          onClick={onApprove}
        >
          Approve
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={onReject}
        >
          Reject
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

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

  if (item.kind === 'group') {
    const { runId, toolName, items, isBlocking } = item;
    const representative = items[0];
    const label = `${toolName} (×${items.length} in this run)`;

    function handleApprove(): void {
      setBusy(true);
      void trpc.cyboflow.approvals.approveRestOfRun.mutate({ runId })
        .finally(() => { setBusy(false); });
    }

    function handleReject(): void {
      setBusy(true);
      void trpc.cyboflow.approvals.rejectRestOfRun.mutate({ runId })
        .finally(() => { setBusy(false); });
    }

    return (
      <CardChrome
        representative={representative}
        label={label}
        isBlocking={isBlocking}
        busy={busy}
        onApprove={handleApprove}
        onReject={handleReject}
        isFocused={isFocused}
      />
    );
  }

  // kind === 'single'
  const { approval, isBlocking } = item;
  const label = approval.toolName;

  function handleApprove(): void {
    setBusy(true);
    void trpc.cyboflow.approvals.approve.mutate({ approvalId: approval.id })
      .finally(() => { setBusy(false); });
  }

  function handleReject(): void {
    setBusy(true);
    void trpc.cyboflow.approvals.reject.mutate({ approvalId: approval.id })
      .finally(() => { setBusy(false); });
  }

  return (
    <CardChrome
      representative={approval}
      label={label}
      isBlocking={isBlocking}
      busy={busy}
      onApprove={handleApprove}
      onReject={handleReject}
      isFocused={isFocused}
    />
  );
}
