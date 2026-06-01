import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useReviewQueueStore, useReviewQueueView } from '../stores/reviewQueueStore';
import { PendingApprovalCard } from './ReviewQueue/PendingApprovalCard';
import { useReviewQueueKeyboard } from '../hooks/useReviewQueueKeyboard';
import type { QueueItem } from '../utils/reviewQueueSelectors';
import OnboardingCard, { dismissOnboarding } from './OnboardingCard';
import { useReviewQueueSlice } from '../stores/reviewQueueSlice';
import type { WorkflowRunStatus } from '../../../shared/types/cyboflow';

// Type for IPC response
import type { IPCResponse } from '../utils/api';

function itemId(item: QueueItem): string {
  return item.kind === 'single' ? item.approval.id : item.items[0].id;
}

function itemRunId(item: QueueItem): string {
  return item.kind === 'single' ? item.approval.runId : item.runId;
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

export default function ReviewQueueView() {
  const queue = useReviewQueueStore(s => s.queue);
  const { blocking, normal } = useReviewQueueView();
  const allItems = [...blocking, ...normal];

  // Read per-run status from the reviewQueueSlice.  Each card gets its runStatus
  // by looking up its runId in this map.  useRunStatus(runId) is the selector hook
  // that wraps this lookup — see frontend/src/stores/reviewQueueSlice.ts.
  const runStatusMap = useReviewQueueSlice((s) => s.runStatusMap);

  // Lifted dismissed state — controls OnboardingCard visibility from here so
  // both the "Got it" button and the card button / y/n keypress paths unmount
  // the card within the same React render cycle.
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);

  // One-shot ref guards against writing the preference more than once.
  const onboardingDismissedRef = useRef(false);

  useEffect(() => useReviewQueueStore.getState().init(), []);

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

  // Scroll the focused card into view whenever focusedIndex changes.
  useEffect(() => {
    const focused = allItems[focusedIndex];
    if (focused !== undefined) {
      document
        .querySelector(`[data-approval-id="${CSS.escape(itemId(focused))}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focusedIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalCount = queue.length;

  return (
    <div className="w-full h-full flex flex-col bg-bg-primary overflow-hidden">
      {/* Protoflow human-review header */}
      <div className="flex-shrink-0 border-b border-border-primary bg-bg-secondary px-7 py-4">
        <div className="eyebrow text-text-tertiary">Pending checkpoints</div>
        <h2 className="mt-1 text-[22px] font-bold tracking-[-0.01em] text-text-primary">Human review</h2>
        <div className="mt-1 flex items-center gap-3.5 text-xs text-text-secondary">
          <span data-testid="review-total-count"><b className="font-bold text-text-primary">{totalCount}</b> total</span>
          <span data-testid="review-blocking-count"><b className="font-bold text-interactive">{blocking.length}</b> blocking a sprint</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-4">
        <div className="mx-auto w-full max-w-[860px]">
          <OnboardingCard
            dismissed={onboardingDismissed}
            onDismiss={handleDecide}
          />
          {totalCount === 0 ? (
            <div className="py-16 text-center text-sm text-text-muted">
              <b className="mb-1.5 block text-base text-text-primary">No pending reviews</b>
              All workflows are unblocked. New checkpoints land here as agents pause.
            </div>
          ) : (
            <>
              {blocking.length > 0 && (
                <section>
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
                </section>
              )}
              <section>
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}
