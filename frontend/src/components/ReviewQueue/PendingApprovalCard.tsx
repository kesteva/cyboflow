/**
 * ReviewQueue/PendingApprovalCard — enhanced approval card with stuck-run features.
 *
 * Extends the base PendingApprovalCard with:
 *  - StuckBadge when runStatus === 'stuck' (TASK-502)
 *  - "Why stuck?" button that opens StuckInspectorModal (TASK-504)
 *  - "Cancel and restart" button when runStatus === 'stuck' (TASK-502)
 *
 * This file lives in ReviewQueue/ as part of the stuck-detection epic
 * (TASK-502 + TASK-504). The root-level PendingApprovalCard.tsx remains
 * in frontend/src/components/ as the base implementation.
 *
 * Read-only diagnostic invariant: StuckInspectorModal contains NO action
 * buttons (Approve / Reject / Cancel). It is purely diagnostic.
 */
import React, { useState } from 'react';
import { Button } from '../ui/Button';
import { formatAge, truncatePayload } from '../../utils/approvalFormatters';
import { trpc } from '../../trpc/client';
import type { Approval } from '../../../../shared/types/approvals';
import type { QueueItem } from '../../utils/reviewQueueSelectors';
import type { WorkflowRunStatus } from '../../../../shared/types/stuckInspection';
import { StuckBadge } from './StuckBadge';
import { StuckInspectorModal } from './StuckInspectorModal';
import { useRunStuckDetails } from '../../stores/reviewQueueSlice';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PendingApprovalCardProps {
  item: QueueItem;
  /** When true, renders a visible focus ring for keyboard-navigation highlighting. */
  isFocused?: boolean;
  /**
   * Current run status for the run this approval belongs to.
   * When 'stuck', renders the stuck-run UI (StuckBadge, Why stuck?, Cancel and restart).
   */
  runStatus?: WorkflowRunStatus;
  /**
   * Human-readable explanation of why the run is stuck.
   * Forwarded to <StuckBadge reason=…> as the hover tooltip.
   * Only meaningful when runStatus === 'stuck'.
   *
   * @deprecated Prefer letting the card resolve reason+detectedAt from
   * useRunStuckDetails by runId. This prop is kept for backward compatibility
   * with test mocks and any future explicit pass-through.
   */
  stuckReason?: string | null;
  /**
   * Called once after a successful approve or reject mutation. Optional.
   * Not invoked on mutation error or on cancel-and-restart.
   */
  onDecide?: () => void;
}

// ---------------------------------------------------------------------------
// Internal subcomponent — shared card chrome
// ---------------------------------------------------------------------------

interface CardChromeProps {
  /** The approval whose metadata drives the card. */
  representative: Approval;
  /** Label shown in the header. */
  label: string;
  /** When true, renders the "blocked Nm" badge. */
  isBlocking: boolean;
  /** When true, approval buttons are disabled (mutation in flight). */
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  isFocused: boolean;
  /** When 'stuck', renders stuck-run UI. */
  runStatus?: WorkflowRunStatus;
  /** The runId for stuck-run actions. */
  runId: string;
  /**
   * Human-readable explanation of why the run is stuck.
   * Passed as the tooltip on <StuckBadge>. When null/undefined, no tooltip
   * is shown but the badge still renders.
   */
  stuckReason?: string | null;
}

function CardChrome({
  representative,
  label,
  isBlocking,
  busy,
  onApprove,
  onReject,
  isFocused,
  runStatus,
  runId,
  stuckReason,
}: CardChromeProps): React.ReactElement {
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const isStuck = runStatus === 'stuck';

  // Resolve reason + detectedAt from the slice.  Only active when stuck.
  const { reason: stuckReasonObj, detectedAt } = useRunStuckDetails(isStuck ? runId : undefined);
  // Prefer the slice's StuckReason.kind; fall back to the legacy stuckReason prop.
  const stuckReasonLabel = stuckReasonObj ? stuckReasonObj.kind : stuckReason;

  const focusClass = isFocused
    ? ' ring-2 ring-interactive'
    : ' focus-within:ring-2 focus-within:ring-interactive';

  const stuckClass = isStuck ? ' border-red-500' : '';

  const truncated = truncatePayload(representative.payloadPreview);

  function handleCancelAndRestart(): void {
    setCancelBusy(true);
    void trpc.cyboflow.runs.cancelAndRestart.mutate({ runId })
      .finally(() => { setCancelBusy(false); });
  }

  return (
    <div
      data-approval-id={representative.id}
      role="listitem"
      className={`px-4 py-3 border-b border-border-primary hover:bg-surface-hover cursor-default${focusClass}${stuckClass}`}
    >
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-xs text-text-muted">{representative.workflowName}</span>
        <span className="text-sm font-semibold text-text-primary">{label}</span>
        {isStuck && <StuckBadge reason={stuckReasonLabel} detectedAt={detectedAt} />}
        {isBlocking && (
          <span className="ml-1 text-xs font-medium text-status-error">
            blocked {formatAge(representative.createdAt)}
          </span>
        )}
        <span className="ml-auto text-xs text-text-muted">{formatAge(representative.createdAt)}</span>
      </div>

      {isStuck && (
        <div className="mt-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setInspectorOpen(true)}
          >
            Why stuck?
          </Button>
        </div>
      )}

      {representative.rationale != null && representative.rationale !== '' && (
        <p className="text-xs italic text-text-muted my-2">{representative.rationale}</p>
      )}

      <pre className="text-xs font-mono bg-bg-tertiary px-2 py-1 rounded overflow-hidden">
        {truncated.text}{truncated.truncated && '…'}
      </pre>

      <div className="flex gap-2 mt-3 flex-wrap">
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
        {isStuck && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || cancelBusy}
            onClick={handleCancelAndRestart}
            title="Stops the Claude run and starts a new one with the same workflow + worktree. Note: until TASK-304 ships, pending approvals are not yet denied on the permission socket — Claude may need to time out on its side before the new run can proceed cleanly."
          >
            Cancel and restart
          </Button>
        )}
      </div>

      {inspectorOpen && (
        <StuckInspectorModal
          runId={runId}
          onClose={() => setInspectorOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/**
 * ReviewQueue-variant of PendingApprovalCard.
 *
 * Adds stuck-run features on top of the base card:
 *  - StuckBadge when runStatus === 'stuck'
 *  - "Why stuck?" button that opens StuckInspectorModal
 *  - "Cancel and restart" button that calls cyboflow.runs.cancelAndRestart
 */
export function PendingApprovalCard({
  item,
  isFocused = false,
  runStatus,
  stuckReason,
  onDecide,
}: PendingApprovalCardProps): React.ReactElement {
  const [busy, setBusy] = useState(false);

  if (item.kind === 'group') {
    const { runId, toolName, items, isBlocking } = item;
    const representative = items[0];
    const label = `${toolName} (×${items.length} in this run)`;

    function handleApprove(): void {
      setBusy(true);
      void trpc.cyboflow.approvals.approveRestOfRun.mutate({ runId })
        .then(() => { onDecide?.(); })
        .catch(() => { /* mutation error: leave card visible, do not call onDecide */ })
        .finally(() => { setBusy(false); });
    }

    function handleReject(): void {
      setBusy(true);
      void Promise.all(
        items.map((a) => trpc.cyboflow.approvals.reject.mutate({ approvalId: a.id })),
      ).then(() => { onDecide?.(); })
        .catch(() => { /* mutation error: leave card visible, do not call onDecide */ })
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
        runStatus={runStatus}
        runId={runId}
        stuckReason={stuckReason}
      />
    );
  }

  // kind === 'single'
  const { approval, isBlocking } = item;
  const label = approval.toolName;

  function handleApprove(): void {
    setBusy(true);
    void trpc.cyboflow.approvals.approve.mutate({ approvalId: approval.id })
      .then(() => { onDecide?.(); })
      .catch(() => { /* mutation error: leave card visible, do not call onDecide */ })
      .finally(() => { setBusy(false); });
  }

  function handleReject(): void {
    setBusy(true);
    void trpc.cyboflow.approvals.reject.mutate({ approvalId: approval.id })
      .then(() => { onDecide?.(); })
      .catch(() => { /* mutation error: leave card visible, do not call onDecide */ })
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
      runStatus={runStatus}
      runId={approval.runId}
      stuckReason={stuckReason}
    />
  );
}
