/**
 * ReviewItemCard — kind-polymorphic card for the unified review_items inbox.
 *
 * Renders one of the five review-item kinds (finding | permission | decision |
 * human_task | notification) with kind-specific chrome and triage actions:
 *
 *   - finding      — a non-blocking observation. Triage: Dismiss / Promote to task.
 *                    When the reporting agent carries an accept-routing hint
 *                    (payload.proposedTarget), the card renders a '→ TARGET' chip
 *                    and makes the primary action CONTEXTUAL: 'backlog' keeps
 *                    Promote-to-task (relabelled 'Accept → task'); 'docs'/'prompt'
 *                    surface an 'Accept' that resolves with 'triaged:accepted-<target>'
 *                    (the human applies the edit). No hint = today's exact actions.
 *   - permission   — a real-time PreToolUse/approval gate (blocking). Reuses the
 *                    APPROVAL resolution path: Approve / Reject route to
 *                    cyboflow.approvals.approve / reject via the folded approvalId.
 *   - decision     — an approve-idea / approve-plan gate (blocking). Resolving it
 *                    via reviewItems.resolve triggers aggregate-unblock → the
 *                    paused run auto-resumes (FLOW ADVANCEMENT). Surfaces "Approve"
 *                    (resolve) / "Reject" (dismiss).
 *   - human_task   — a free-form action item (blocking per-item). Triage:
 *                    Resolve / Dismiss / Promote to task.
 *   - notification — an informational FYI (e.g. a dynamic workflow finished /
 *                    stalled). The work already ran, so its only triage is
 *                    Dismiss — no Resolve, no Promote-to-task.
 *
 * A blocking badge renders on any item with `blocking === true`. The card owns
 * no validation — every action delegates to a chokepoint via the actions hook
 * (review-item triage) or the approvals router (permission gates).
 */
import React from 'react';
import { Button } from '../ui/Button';
import { formatAge } from '../../utils/approvalFormatters';
import { trackEvent } from '../../utils/telemetry';
import { trpc } from '../../trpc/client';
import type { ReviewItem, ReviewItemKind, FindingProposedTarget } from '../../../../shared/types/reviews';
import type { QuestionPayload } from '../../../../shared/types/questions';
import { useReviewItemActions } from '../../hooks/useReviewItemActions';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';

// ---------------------------------------------------------------------------
// Accept-routing target chip — keyed on the discriminant so a new target breaks
// the map at compile time (per docs/CODE-PATTERNS.md "Label maps for shared-type
// discriminants").
// ---------------------------------------------------------------------------

const TARGET_CHIP_LABEL: Record<FindingProposedTarget, string> = {
  backlog: '→ Backlog',
  docs: '→ Docs',
  prompt: '→ Prompt',
  fix: '→ Quick fix',
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
  notification: 'Notice',
};

const KIND_ACCENT: Record<ReviewItemKind, string> = {
  finding: 'text-text-secondary',
  permission: 'text-status-error',
  decision: 'text-interactive',
  human_task: 'text-status-warning',
  notification: 'text-text-tertiary',
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
 * True for a durable `ask-user-question-recovery` decision gate — keyed on the
 * payload discriminant, INDEPENDENT of whether any options were recovered. A
 * recovery gate MUST be answered via `runs.answerRecoveryGate` (which delivers the
 * answer as a `--resume` turn); the generic resolve/dismiss route only flips run
 * status and would strand a drained SDK session unanswered. So even an option-less
 * (malformed-payload) recovery gate stays on the recovery answer path, never the
 * generic Approve/Reject — the backend rejects generic triage on these too.
 */
function isRecoveryGate(item: ReviewItem): boolean {
  if (item.kind !== 'decision') return false;
  const payload = item.payload;
  return Boolean(payload && payload.kind === 'decision' && payload.gate === 'ask-user-question-recovery');
}

/**
 * The recovered AskUserQuestion options for a durable `ask-user-question-recovery`
 * decision gate (empty for any other item). Parsed defensively so a malformed
 * payload degrades to no options — the card then offers a FREE-TEXT answer (still
 * routed through answerRecoveryGate), never a plain resolve/dismiss.
 */
function recoveredQuestions(item: ReviewItem): QuestionPayload[] {
  if (!isRecoveryGate(item)) return [];
  const payload = item.payload;
  if (payload && payload.kind === 'decision' && Array.isArray(payload.recoveredQuestions)) {
    return payload.recoveredQuestions;
  }
  return [];
}

/**
 * A human-readable explanation for a REFUSED recovery-gate resume, so the card
 * can stay visible with actionable context instead of silently swallowing the
 * answer. `nudge` is the runs.answerRecoveryGate result's nudge outcome.
 */
function recoveryResumeErrorMessage(nudge: { noOp?: true; reason?: string } | { delivered?: true }): string {
  const reason = 'reason' in nudge ? nudge.reason : undefined;
  switch (reason) {
    case 'no_session':
      return "This run has no saved session to resume — it can't be answered from here.";
    case 'not_idle':
      return 'The run is busy right now — wait for it to settle, then try again.';
    case 'blocked':
      return 'Another blocking item must be cleared before this run can resume.';
    case 'race':
      return 'The run just changed state — please try again.';
    case 'execute_failed':
      return 'The run failed to resume — check the run and try again.';
    case 'terminal':
      return 'This run has already ended.';
    default:
      return 'Could not resume the run — the gate is still open, try again.';
  }
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
  if (target === 'backlog' || target === 'docs' || target === 'prompt' || target === 'fix') return target;
  return null;
}

/**
 * A/B testing slice C: the experimentId when this decision item is a
 * `gate:'experiment-comparison'` pairwise-verdict notification (minted by
 * PairwiseJudgeWorker), or null for every other decision (approve-idea /
 * approve-plan / a malformed payload) — which keep the legacy resolve/dismiss
 * actions unchanged. Parsed defensively so an absent/foreign payload shape
 * behaves exactly like no payload.
 */
function experimentComparisonId(item: ReviewItem): string | null {
  if (item.kind !== 'decision') return null;
  const payload: unknown = item.payload;
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as { gate?: unknown; experimentId?: unknown };
  if (p.gate !== 'experiment-comparison' || typeof p.experimentId !== 'string') return null;
  return p.experimentId;
}

export function ReviewItemCard({ item, isFocused = false, onResolved }: ReviewItemCardProps): React.ReactElement {
  const { pendingItemId, error, resolve, acceptFinding, dismiss, promoteToTask } = useReviewItemActions();
  const [approvalBusy, setApprovalBusy] = React.useState(false);
  // Set when a recovery-gate resume was REFUSED — the gate stays open and this
  // explains why, so the answer is never silently lost.
  const [recoveryError, setRecoveryError] = React.useState<string | null>(null);
  // Free-text answer for an OPTION-LESS recovery gate (malformed AskUserQuestion
  // payload → no recovered options). Still delivered via answerRecoveryGate.
  const [recoveryText, setRecoveryText] = React.useState('');

  const busy = pendingItemId === item.id || approvalBusy;
  // Accept-routing hint (findings only); null = legacy actions, zero change.
  const proposedTarget = findingProposedTarget(item);
  // A/B testing slice C: an experiment-comparison decision routes to the
  // comparison view instead of the legacy resolve/dismiss actions.
  const comparisonExperimentId = experimentComparisonId(item);
  const focusClass = isFocused
    ? ' ring-2 ring-interactive'
    : ' focus-within:ring-2 focus-within:ring-interactive';

  // -- Action handlers ------------------------------------------------------

  const handleResolve = (): void => {
    void resolve(item.project_id, item.id).then((r) => {
      if (r !== null) {
        trackEvent('review_item_resolved', { kind: item.kind, action: 'resolve', blocking: item.blocking });
        onResolved?.();
      }
    });
  };

  // Explicit programmatic human-gate verdict (approve-plan / approve-idea /
  // approve-design). 'approve' resolves + reveals the run's drafts and resumes;
  // 'reject' tears down rejected drafts and lets the controller end the run
  // 'rejected'. Both route through reviewItems.resolve via the `outcome` field so
  // the WorkflowController's parseGateVerdict is deterministic, not a free-text sniff.
  const handleGateDecision = (outcome: 'approve' | 'reject'): void => {
    void resolve(item.project_id, item.id, { outcome }).then((r) => {
      if (r !== null) {
        trackEvent('review_item_resolved', { kind: item.kind, action: outcome, blocking: item.blocking });
        onResolved?.();
      }
    });
  };

  const handleDismiss = (): void => {
    void dismiss(item.project_id, item.id).then((ok) => {
      if (ok) {
        trackEvent('review_item_resolved', { kind: item.kind, action: 'dismiss', blocking: item.blocking });
        onResolved?.();
      }
    });
  };

  const handlePromote = (): void => {
    void promoteToTask(item.project_id, item.id).then((r) => {
      if (r !== null) {
        trackEvent('review_item_resolved', { kind: item.kind, action: 'promote_to_task', blocking: item.blocking });
        onResolved?.();
      }
    });
  };

  // Accept a docs/prompt finding: resolve with 'triaged:accepted-<target>' (the
  // human applies the edit). 'backlog' never reaches here — it uses handlePromote;
  // 'fix' never reaches here either — a quick-fix finding is COMPOUNDED, not
  // human-applied-as-docs, so the param is pinned to the manual-accept literals
  // (matching acceptedResolution in shared/types/reviews.ts) — a tripwire that
  // forces a compile error if a 'fix' caller is ever added.
  const handleAccept = (target: 'docs' | 'prompt'): void => {
    void acceptFinding(item.project_id, item.id, target).then((r) => {
      if (r !== null) onResolved?.();
    });
  };

  // A/B testing slice C: jump straight to the pairwise comparison view.
  const handleViewComparison = (): void => {
    if (comparisonExperimentId === null) return;
    useNavigationStore.getState().openExperimentComparison(comparisonExperimentId);
  };

  // A question-sourced decision can only be settled by ANSWERING the question
  // in the session chat — jump there (mirrors TypeGroupedQueue's openRunSession).
  const handleAnswerInSession = (): void => {
    if (item.run_id === null) return;
    useCyboflowStore.getState().setActiveRun(item.run_id);
    useNavigationStore.getState().setActiveProjectId(item.project_id);
    useNavigationStore.getState().goToSession();
  };

  // Answer a durable ask-user-question-recovery gate: the chosen option label is
  // delivered to the run as a resumed turn AND the gate is resolved — but ONLY if
  // the resume actually lands (the backend leaves the gate PENDING on a refused
  // resume so the answer is never lost). So the card is removed only on a
  // confirmed `resolved`; otherwise it stays visible with the failure reason.
  const handleRecoveryAnswer = (answerText: string): void => {
    setApprovalBusy(true);
    setRecoveryError(null);
    void trpc.cyboflow.runs.answerRecoveryGate
      .mutate({ projectId: item.project_id, reviewItemId: item.id, answerText })
      .then((result) => {
        if (result.resolved) {
          trackEvent('review_item_resolved', { kind: item.kind, action: 'resolve', blocking: item.blocking });
          onResolved?.();
        } else {
          setRecoveryError(recoveryResumeErrorMessage(result.nudge));
        }
      })
      .catch(() => { setRecoveryError('Could not answer the gate — please try again.'); })
      .finally(() => { setApprovalBusy(false); });
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
      case 'decision': {
        // A durable ask-user-question-recovery gate: the in-session gate dropped
        // or its SDK session expired, so re-offer the ORIGINAL options here. Every
        // exit routes through answerRecoveryGate (resolve-first/resume-on-delivered)
        // — NEVER the generic resolve/dismiss, which only flips status and would
        // strand a drained SDK session unanswered (the false-complete this gate
        // exists to prevent; the backend rejects generic triage on these too).
        if (isRecoveryGate(item)) {
          const recovered = recoveredQuestions(item);
          if (recovered.length > 0) {
            // Options survived: re-offer each label; a click answers + resumes.
            const options = recovered.flatMap((q) => q.options.map((o) => o.label));
            const unique = Array.from(new Set(options));
            return (
              <>
                {unique.map((label) => (
                  <Button
                    key={label}
                    variant="primary"
                    size="sm"
                    disabled={busy}
                    onClick={() => handleRecoveryAnswer(label)}
                    data-testid="recovery-gate-answer"
                  >
                    {label}
                  </Button>
                ))}
              </>
            );
          }
          // Option-less (malformed payload): still keep the human on the answer
          // path with a free-text reply delivered via answerRecoveryGate. Falling
          // back to generic resolve/dismiss here is exactly the data-loss hole.
          const submit = (): void => {
            const text = recoveryText.trim();
            if (text !== '') handleRecoveryAnswer(text);
          };
          return (
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <input
                type="text"
                value={recoveryText}
                onChange={(e) => setRecoveryText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit();
                }}
                placeholder="Type your answer…"
                disabled={busy}
                data-testid="recovery-gate-input"
                className="min-w-[12rem] flex-1 rounded border border-border-primary bg-bg-secondary px-2 py-1 text-xs text-text-primary"
              />
              <Button
                variant="primary"
                size="sm"
                disabled={busy || recoveryText.trim() === ''}
                onClick={submit}
                data-testid="recovery-gate-free-answer"
              >
                Answer &amp; resume
              </Button>
            </div>
          );
        }
        // A/B testing slice C: an experiment-comparison verdict-ready item routes
        // straight to the comparison view (promote/discard/rerun/switch-to-
        // rotation all live there) — resolve/dismiss would just drop the card
        // without recording any decision.
        if (comparisonExperimentId !== null) {
          return (
            <Button
              variant="primary"
              size="sm"
              onClick={handleViewComparison}
              data-testid="decision-view-comparison"
            >
              View comparison →
            </Button>
          );
        }
        // A question-sourced decision is an OPEN AskUserQuestion: the run is
        // awaiting_input on a specific answer, so plain resolve/dismiss would
        // strand the waiting agent (the backend rejects it too). The only
        // honest action is answering the question card in the session chat.
        if (item.source === 'question') {
          return (
            <Button
              variant="primary"
              size="sm"
              disabled={item.run_id === null}
              onClick={handleAnswerInSession}
              data-testid="decision-answer-in-session"
            >
              Answer in session →
            </Button>
          );
        }
        // Explicit gate verdict via reviewItems.resolve `outcome`. Approve reveals
        // the run's drafts (approve-plan) + auto-resumes; Reject tears down rejected
        // drafts and ends the run 'rejected' (no resume).
        return (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => handleGateDecision('approve')} data-testid="decision-resolve">
              Approve &amp; resume
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => handleGateDecision('reject')} data-testid="decision-reject">
              Reject
            </Button>
          </>
        );
      }
      case 'notification':
        // An informational FYI — the work already ran, so there is no follow-up
        // to track. Acknowledging (Dismiss) is the only triage.
        return (
          <Button variant="secondary" size="sm" disabled={busy} onClick={handleDismiss}>
            Dismiss
          </Button>
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
        // A BLOCKING finding parked a programmatic run (Fix: blocking findings must
        // block). It needs a resolve affordance that clears it from the run's
        // pending-blocking count and auto-resumes: Resolve (resolve → aggregate-
        // unblock resume) + Dismiss (dismiss → aggregate-unblock resume). Non-blocking
        // findings keep the legacy accept-routing actions below.
        if (item.blocking) {
          return (
            <>
              <Button variant="primary" size="sm" disabled={busy} onClick={handleResolve} data-testid="finding-resolve">
                Resolve &amp; resume
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={handleDismiss}>
                Dismiss
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={handlePromote} data-testid="promote-to-task">
                Promote to task
              </Button>
            </>
          );
        }
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

      {recoveryError && (
        <p className="mt-2 text-xs text-status-error" role="alert" data-testid="recovery-gate-error">
          {recoveryError}
        </p>
      )}
    </div>
  );
}
