/**
 * ReviewItemCard — kind-polymorphic card for the unified review_items inbox.
 *
 * Renders one of the four review-item kinds (finding | permission | decision |
 * human_task) with kind-specific chrome and triage actions:
 *
 *   - finding    — a non-blocking observation. Triage: Dismiss / Promote to task.
 *                  When the reporting agent carries an accept-routing hint
 *                  (payload.proposedTarget), the card renders a '→ TARGET' chip
 *                  and makes the primary action CONTEXTUAL: 'backlog' keeps
 *                  Promote-to-task (relabelled 'Accept → task'); 'docs'/'prompt'
 *                  surface an 'Accept' that resolves with 'triaged:accepted-<target>'
 *                  (the human applies the edit). No hint = today's exact actions.
 *   - permission — a real-time PreToolUse/approval gate (blocking). Reuses the
 *                  APPROVAL resolution path: Approve / Reject route to
 *                  cyboflow.approvals.approve / reject via the folded approvalId.
 *   - decision   — an approve-idea / approve-plan gate (blocking). Resolving it
 *                  via reviewItems.resolve triggers aggregate-unblock → the
 *                  paused run auto-resumes (FLOW ADVANCEMENT). Surfaces "Approve"
 *                  (resolve) / "Reject" (dismiss).
 *   - human_task — a free-form action item (blocking per-item). Triage:
 *                  Resolve / Dismiss / Promote to task.
 *
 * A blocking badge renders on any item with `blocking === true`. The card owns
 * no validation — every action delegates to a chokepoint via the actions hook
 * (review-item triage) or the approvals router (permission gates).
 */
import React from 'react';
import { Button } from '../ui/Button';
import { formatAge } from '../../utils/approvalFormatters';
import { trpc } from '../../trpc/client';
import type { ReviewItem, ReviewItemKind, FindingProposedTarget } from '../../../../shared/types/reviews';
import { useReviewItemActions } from '../../hooks/useReviewItemActions';

// ---------------------------------------------------------------------------
// Accept-routing target chip — keyed on the discriminant so a new target breaks
// the map at compile time (per docs/CODE-PATTERNS.md "Label maps for shared-type
// discriminants").
// ---------------------------------------------------------------------------

const TARGET_CHIP_LABEL: Record<FindingProposedTarget, string> = {
  backlog: '→ Backlog',
  docs: '→ Docs',
  prompt: '→ Prompt',
};

// ---------------------------------------------------------------------------
// Kind label map — keyed on the discriminant so a new kind breaks the map at
// compile time (per docs/CODE-PATTERNS.md "Label maps for shared-type discriminants").
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<ReviewItemKind, string> = {
  finding: 'Finding',
  permission: 'Permission',
  decision: 'Decision',
  human_task: 'Action',
};

const KIND_ACCENT: Record<ReviewItemKind, string> = {
  finding: 'text-text-secondary',
  permission: 'text-status-error',
  decision: 'text-interactive',
  human_task: 'text-status-warning',
};

interface ReviewItemCardProps {
  item: ReviewItem;
  /** When true, renders a visible focus ring for keyboard-navigation highlighting. */
  isFocused?: boolean;
  /** Called once after a successful triage (resolve / dismiss / promote / approve / reject). */
  onResolved?: () => void;
}

/**
 * The folded approvalId for a permission item (or null when not present). Used
 * to route Approve / Reject through the approval resolution path.
 */
function permissionApprovalId(item: ReviewItem): string | null {
  if (item.kind !== 'permission') return null;
  const payload = item.payload;
  if (payload && payload.kind === 'permission' && typeof payload.approvalId === 'string') {
    return payload.approvalId;
  }
  return null;
}

/**
 * The accept-routing hint for a finding (or null when absent / malformed).
 * Parsed defensively (unknown + guards) so a payload missing or carrying a
 * non-union proposedTarget behaves EXACTLY like no payload — the card then keeps
 * its legacy Dismiss / Promote-to-task actions with zero behavior change.
 */
function findingProposedTarget(item: ReviewItem): FindingProposedTarget | null {
  if (item.kind !== 'finding') return null;
  const payload: unknown = item.payload;
  if (payload === null || typeof payload !== 'object') return null;
  const target = (payload as { proposedTarget?: unknown }).proposedTarget;
  if (target === 'backlog' || target === 'docs' || target === 'prompt') return target;
  return null;
}

export function ReviewItemCard({ item, isFocused = false, onResolved }: ReviewItemCardProps): React.ReactElement {
  const { pendingItemId, error, resolve, acceptFinding, dismiss, promoteToTask } = useReviewItemActions();
  const [approvalBusy, setApprovalBusy] = React.useState(false);

  const busy = pendingItemId === item.id || approvalBusy;
  // Accept-routing hint (findings only); null = legacy actions, zero change.
  const proposedTarget = findingProposedTarget(item);
  const focusClass = isFocused
    ? ' ring-2 ring-interactive'
    : ' focus-within:ring-2 focus-within:ring-interactive';

  // -- Action handlers ------------------------------------------------------

  const handleResolve = (): void => {
    void resolve(item.project_id, item.id).then((r) => {
      if (r !== null) onResolved?.();
    });
  };

  const handleDismiss = (): void => {
    void dismiss(item.project_id, item.id).then((ok) => {
      if (ok) onResolved?.();
    });
  };

  const handlePromote = (): void => {
    void promoteToTask(item.project_id, item.id).then((r) => {
      if (r !== null) onResolved?.();
    });
  };

  // Accept a docs/prompt finding: resolve with 'triaged:accepted-<target>' (the
  // human applies the edit). 'backlog' never reaches here — it uses handlePromote.
  const handleAccept = (target: Exclude<FindingProposedTarget, 'backlog'>): void => {
    void acceptFinding(item.project_id, item.id, target).then((r) => {
      if (r !== null) onResolved?.();
    });
  };

  // Permission items reuse the real-time approval resolution path.
  const handleApprovalDecision = (decision: 'approve' | 'reject'): void => {
    const approvalId = permissionApprovalId(item);
    if (approvalId === null) {
      // No folded approval (e.g. a synthetic permission item) — fall back to the
      // review-item triage path so the item still leaves the inbox.
      if (decision === 'approve') handleResolve();
      else handleDismiss();
      return;
    }
    setApprovalBusy(true);
    const mutation =
      decision === 'approve'
        ? trpc.cyboflow.approvals.approve.mutate({ approvalId })
        : trpc.cyboflow.approvals.reject.mutate({ approvalId });
    void mutation
      .then(() => { onResolved?.(); })
      .catch(() => { /* leave card visible on error */ })
      .finally(() => { setApprovalBusy(false); });
  };

  // -- Kind-specific action row ---------------------------------------------

  function actions(): React.ReactElement {
    switch (item.kind) {
      case 'permission':
        return (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => handleApprovalDecision('approve')}>
              Approve
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => handleApprovalDecision('reject')}>
              Reject
            </Button>
          </>
        );
      case 'decision':
        // Resolving auto-resumes the paused run (aggregate-unblock).
        return (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={handleResolve} data-testid="decision-resolve">
              Approve &amp; resume
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={handleDismiss}>
              Reject
            </Button>
          </>
        );
      case 'human_task':
        return (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={handleResolve}>
              Resolve
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={handleDismiss}>
              Dismiss
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={handlePromote} data-testid="promote-to-task">
              Promote to task
            </Button>
          </>
        );
      case 'finding':
      default:
        // Contextual primary action driven by the accept-routing hint:
        //   - no hint            → legacy Dismiss / Promote to task (unchanged).
        //   - 'backlog'          → Promote-to-task, relabelled 'Accept → task'.
        //   - 'docs' | 'prompt'  → 'Accept' resolves with 'triaged:accepted-<target>'.
        return (
          <>
            <Button variant="secondary" size="sm" disabled={busy} onClick={handleDismiss}>
              Dismiss
            </Button>
            {proposedTarget === 'docs' || proposedTarget === 'prompt' ? (
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => handleAccept(proposedTarget)}
                data-testid="accept-finding"
              >
                Accept
              </Button>
            ) : (
              <Button variant={proposedTarget === 'backlog' ? 'primary' : 'secondary'} size="sm" disabled={busy} onClick={handlePromote} data-testid="promote-to-task">
                {proposedTarget === 'backlog' ? 'Accept → task' : 'Promote to task'}
              </Button>
            )}
          </>
        );
    }
  }

  return (
    <div
      data-review-item-id={item.id}
      data-kind={item.kind}
      role="listitem"
      className={`px-4 py-3 border-b border-border-primary hover:bg-surface-hover cursor-default${focusClass}`}
    >
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className={`text-xs font-semibold uppercase tracking-wide ${KIND_ACCENT[item.kind]}`} data-testid="review-item-kind">
          {KIND_LABEL[item.kind]}
        </span>
        <span className="text-sm font-semibold text-text-primary">{item.title}</span>
        {item.kind === 'finding' && item.severity && (
          <span className="text-[10px] font-medium uppercase text-text-tertiary">{item.severity}</span>
        )}
        {proposedTarget && (
          <span
            className="rounded-full border border-border-primary bg-bg-secondary px-1.5 py-px text-[10px] font-medium text-text-secondary"
            data-testid="proposed-target-chip"
            data-target={proposedTarget}
          >
            {TARGET_CHIP_LABEL[proposedTarget]}
          </span>
        )}
        {item.blocking && (
          <span
            className="ml-1 rounded-full border border-status-error/40 bg-status-error/10 px-1.5 py-px text-[10px] font-bold text-status-error"
            data-testid="blocking-badge"
          >
            Blocking
          </span>
        )}
        <span className="ml-auto text-xs text-text-muted">{formatAge(item.created_at)}</span>
      </div>

      {item.body != null && item.body !== '' && (
        <p className="my-2 text-xs text-text-secondary whitespace-pre-wrap">{item.body}</p>
      )}

      {item.source && (
        <p className="text-[10px] text-text-tertiary">{item.source}</p>
      )}

      <div className="flex gap-2 mt-3 flex-wrap">{actions()}</div>

      {error && pendingItemId === item.id && (
        <p className="mt-2 text-xs text-status-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
