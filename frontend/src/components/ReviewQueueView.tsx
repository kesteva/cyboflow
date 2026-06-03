/**
 * ReviewQueueView — the unified human-attention inbox.
 *
 * Surfaces all FOUR review_item kinds alongside the existing real-time approval
 * (permission) gates:
 *   - permission — rendered from the legacy approval store (real-time PreToolUse
 *                  gates) via PendingApprovalCard, partitioned blocking/pending
 *                  by age. These ARE the permission kind; the review_items slice
 *                  folds them too, so we render permission review_items from the
 *                  approval path only (no double-render).
 *   - decision   — approve-idea / approve-plan gates. Resolving advances the flow
 *                  (aggregate-unblock auto-resume) via reviewItems.resolve.
 *   - human_task — free-form action items (blocking per-item).
 *   - finding    — non-blocking observations, in a SEPARATE collapsible section
 *                  so blocking items stay prominent.
 *
 * Project-scoped review_items come from {@link useReviewItemsSlice} (init on the
 * active projectId). The global approval queue ({@link useReviewQueueStore})
 * stays a singleton as before.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReviewQueueStore, useReviewQueueView } from '../stores/reviewQueueStore';
import { PendingApprovalCard } from './ReviewQueue/PendingApprovalCard';
import { ReviewItemCard } from './ReviewQueue/ReviewItemCard';
import { useReviewQueueKeyboard } from '../hooks/useReviewQueueKeyboard';
import type { QueueItem } from '../utils/reviewQueueSelectors';
import OnboardingCard, { dismissOnboarding } from './OnboardingCard';
import { useReviewQueueSlice } from '../stores/reviewQueueSlice';
import { useReviewItemsSlice } from '../stores/reviewItemsSlice';
import type { WorkflowRunStatus } from '../../../shared/types/cyboflow';
import type { ReviewItem } from '../../../shared/types/reviews';

// Type for IPC response
import type { IPCResponse } from '../utils/api';

function itemId(item: QueueItem): string {
  return item.kind === 'single' ? item.approval.id : item.items[0].id;
}

function itemRunId(item: QueueItem): string {
  return item.kind === 'single' ? item.approval.runId : item.runId;
}

interface ReviewQueueViewProps {
  /** Active project id (scopes the review_items inbox), or null when none. */
  projectId?: number | null;
}

/**
 * QueueRow wraps a single PendingApprovalCard and resolves its runStatus via
 * the useRunStatus selector (which reads from useReviewQueueSlice.runStatusMap).
 * Extracting this into a child component avoids calling useRunStatus inside a
 * .map() callback, which would violate the Rules of Hooks.
 */
function QueueRow({
  item,
  isFocused,
  runStatus,
  onDecide,
}: {
  item: QueueItem;
  isFocused: boolean;
  runStatus: WorkflowRunStatus | undefined;
  onDecide?: () => void;
}): React.JSX.Element {
  return <PendingApprovalCard item={item} isFocused={isFocused} runStatus={runStatus} onDecide={onDecide} />;
}

export default function ReviewQueueView({ projectId = null }: ReviewQueueViewProps) {
  const queue = useReviewQueueStore(s => s.queue);
  const { blocking, normal } = useReviewQueueView();
  const allItems = [...blocking, ...normal];

  // Project-scoped review_items (the non-permission kinds + findings).
  const reviewItems = useReviewItemsSlice((s) => s.items);

  // Read per-run status from the reviewQueueSlice.  Each card gets its runStatus
  // by looking up its runId in this map.  useRunStatus(runId) is the selector hook
  // that wraps this lookup — see frontend/src/stores/reviewQueueSlice.ts.
  const runStatusMap = useReviewQueueSlice((s) => s.runStatusMap);

  // Lifted dismissed state — controls OnboardingCard visibility from here so
  // both the "Got it" button and the card button / y/n keypress paths unmount
  // the card within the same React render cycle.
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  // Findings live in a separate, collapsed-by-default section so blocking items
  // stay prominent.
  const [findingsOpen, setFindingsOpen] = useState(false);

  // One-shot ref guards against writing the preference more than once.
  const onboardingDismissedRef = useRef(false);

  useEffect(() => useReviewQueueStore.getState().init(), []);

  // Init the project-scoped review_items slice (re-targets on projectId change).
  useEffect(() => {
    if (projectId === null) return;
    const unsubscribe = useReviewItemsSlice.getState().init(projectId);
    return unsubscribe;
  }, [projectId]);

  // Read the onboarding preference on mount to initialise lifted state.
  useEffect(() => {
    const electronInvoke = window.electron?.invoke;
    if (!electronInvoke) return;
    void (async () => {
      try {
        const result = (await electronInvoke(
          'preferences:get',
          'cyboflow_onboarding_dismissed',
        )) as IPCResponse<string>;
        if (result?.data === 'true') {
          setOnboardingDismissed(true);
          onboardingDismissedRef.current = true;
        }
      } catch {
        // Silently proceed — show card if the preference can't be read.
      }
    })();
  }, []);

  // Single shared dismiss callback — wired to keyboard shortcuts and card buttons.
  // Guards via onboardingDismissedRef so it is idempotent (no-op after first call).
  const handleDecide = useCallback(() => {
    if (onboardingDismissedRef.current) return;
    onboardingDismissedRef.current = true;
    setOnboardingDismissed(true);
    void dismissOnboarding();
  }, []);

  const { focusedIndex } = useReviewQueueKeyboard(allItems, handleDecide);

  // Partition the review_items by kind/status. Pending only — triaged items drop
  // out of the inbox. Permission items are rendered via the approval path above,
  // so they are excluded here to avoid a double-render.
  const { decisionItems, humanTaskItems, findingItems } = useMemo(() => {
    const pending = reviewItems.filter((it) => it.status === 'pending');
    return {
      decisionItems: pending.filter((it): it is ReviewItem => it.kind === 'decision'),
      humanTaskItems: pending.filter((it): it is ReviewItem => it.kind === 'human_task'),
      findingItems: pending.filter((it): it is ReviewItem => it.kind === 'finding'),
    };
  }, [reviewItems]);

  // Scroll the focused card into view whenever focusedIndex changes.
  useEffect(() => {
    const focused = allItems[focusedIndex];
    if (focused !== undefined) {
      document
        .querySelector(`[data-approval-id="${CSS.escape(itemId(focused))}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focusedIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  const reviewItemCount = decisionItems.length + humanTaskItems.length;
  const totalCount = queue.length + reviewItemCount;
  // Blocking = aged-blocking approvals + any blocking review_item (decision/human_task).
  const blockingReviewItems =
    decisionItems.filter((it) => it.blocking).length + humanTaskItems.filter((it) => it.blocking).length;
  const blockingCount = blocking.length + blockingReviewItems;
  const isEmpty = totalCount === 0 && findingItems.length === 0;

  return (
    <div className="w-full h-full flex flex-col bg-bg-primary overflow-hidden">
      {/* Protoflow human-review header */}
      <div className="flex-shrink-0 border-b border-border-primary bg-bg-secondary px-7 py-4">
        <div className="eyebrow text-text-tertiary">Pending checkpoints</div>
        <h2 className="mt-1 text-[22px] font-bold tracking-[-0.01em] text-text-primary">Human review</h2>
        <div className="mt-1 flex items-center gap-3.5 text-xs text-text-secondary">
          <span data-testid="review-total-count"><b className="font-bold text-text-primary">{totalCount}</b> total</span>
          <span data-testid="review-blocking-count"><b className="font-bold text-interactive">{blockingCount}</b> blocking a sprint</span>
          {findingItems.length > 0 && (
            <span data-testid="review-finding-count"><b className="font-bold text-text-primary">{findingItems.length}</b> findings</span>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-4">
        <div className="mx-auto w-full max-w-[860px]">
          <OnboardingCard
            dismissed={onboardingDismissed}
            onDismiss={handleDecide}
          />
          {isEmpty ? (
            <div className="py-16 text-center text-sm text-text-muted">
              <b className="mb-1.5 block text-base text-text-primary">No pending reviews</b>
              All workflows are unblocked. New checkpoints land here as agents pause.
            </div>
          ) : (
            <>
              {/* Blocking approvals (aged) + blocking decisions/human-tasks. */}
              {(blocking.length > 0 || decisionItems.length > 0 || humanTaskItems.length > 0) && (
                <section data-testid="review-blocking-section">
                  <h3 className="eyebrow mb-2 mt-3 text-status-error">Blocking</h3>
                  {blocking.map((item, i) => (
                    <QueueRow
                      key={itemId(item)}
                      item={item}
                      isFocused={i === focusedIndex}
                      runStatus={runStatusMap[itemRunId(item)]}
                      onDecide={handleDecide}
                    />
                  ))}
                  {decisionItems.map((it) => (
                    <ReviewItemCard key={it.id} item={it} />
                  ))}
                  {humanTaskItems.map((it) => (
                    <ReviewItemCard key={it.id} item={it} />
                  ))}
                </section>
              )}
              {/* Pending (un-aged) approvals. */}
              {normal.length > 0 && (
                <section data-testid="review-pending-section">
                  <h3 className="eyebrow mb-2 mt-3 text-text-tertiary">Pending</h3>
                  {normal.map((item, i) => (
                    <QueueRow
                      key={itemId(item)}
                      item={item}
                      isFocused={blocking.length + i === focusedIndex}
                      runStatus={runStatusMap[itemRunId(item)]}
                      onDecide={handleDecide}
                    />
                  ))}
                </section>
              )}
            </>
          )}

          {/* Findings — a SEPARATE, collapsible section (non-blocking). Kept out
              of the main flow so blocking items stay prominent. */}
          {findingItems.length > 0 && (
            <section className="mt-6" data-testid="review-findings-section">
              <button
                type="button"
                onClick={() => setFindingsOpen((v) => !v)}
                aria-expanded={findingsOpen}
                data-testid="findings-toggle"
                className="eyebrow mb-2 inline-flex items-center gap-1.5 text-text-tertiary hover:text-text-secondary"
              >
                {findingsOpen ? '▾' : '▸'} Findings ({findingItems.length})
              </button>
              {findingsOpen &&
                findingItems.map((it) => <ReviewItemCard key={it.id} item={it} />)}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
