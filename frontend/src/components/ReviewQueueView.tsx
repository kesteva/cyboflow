import { useEffect, useRef, useState } from 'react';
import { useReviewQueueStore, useReviewQueueView } from '../stores/reviewQueueStore';
import { PendingApprovalCard } from './PendingApprovalCard';
import { useReviewQueueKeyboard } from '../hooks/useReviewQueueKeyboard';
import type { QueueItem } from '../utils/reviewQueueSelectors';
import OnboardingCard, { dismissOnboarding } from './OnboardingCard';

// Type for IPC response
import type { IPCResponse } from '../utils/api';

function itemId(item: QueueItem): string {
  return item.kind === 'single' ? item.approval.id : item.items[0].id;
}

export default function ReviewQueueView() {
  const queue = useReviewQueueStore(s => s.queue);
  const { blocking, normal } = useReviewQueueView();
  const allItems = [...blocking, ...normal];
  const { focusedIndex } = useReviewQueueKeyboard(allItems);

  // Lifted dismissed state — controls OnboardingCard visibility from here so
  // both the "Got it" button and the y/n keypress path unmount the card within
  // the same React render cycle.
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

  // Register a keydown listener for y/n that dismisses the onboarding card once.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== 'y' && event.key !== 'n') return;
      if (onboardingDismissedRef.current) return;

      // Guard: only fire if there's something in the queue to act on.
      if (allItems.length === 0) return;

      const target = event.target;
      if (target instanceof HTMLInputElement) return;
      if (target instanceof HTMLTextAreaElement) return;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.contentEditable === 'true')
      ) return;

      onboardingDismissedRef.current = true;
      setOnboardingDismissed(true);
      void dismissOnboarding();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [allItems.length]);

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
    <div className="w-[360px] h-full flex flex-col border-r border-border-primary bg-bg-secondary overflow-y-auto">
      <div className="px-4 py-3 border-b border-border-primary">
        <h2 className="text-sm font-semibold text-text-primary">Review Queue</h2>
        <span className="text-xs text-text-muted">{totalCount} pending</span>
      </div>
      <OnboardingCard
        dismissed={onboardingDismissed}
        onDismiss={() => {
          onboardingDismissedRef.current = true;
          setOnboardingDismissed(true);
          void dismissOnboarding();
        }}
      />
      {totalCount === 0 ? (
        <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
          No pending approvals
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {blocking.length > 0 && (
            <section>
              <h3 className="px-4 py-1 text-xs font-semibold text-status-error bg-bg-tertiary">
                Blocking
              </h3>
              {blocking.map((item, i) => (
                <PendingApprovalCard
                  key={itemId(item)}
                  item={item}
                  isFocused={i === focusedIndex}
                />
              ))}
            </section>
          )}
          <section>
            <h3 className="px-4 py-1 text-xs font-semibold text-text-muted bg-bg-tertiary">
              Pending
            </h3>
            {normal.map((item, i) => (
              <PendingApprovalCard
                key={itemId(item)}
                item={item}
                isFocused={blocking.length + i === focusedIndex}
              />
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
